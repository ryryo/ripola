import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import type { GenerationServerConfig } from '../core/config';
import type { AsrCandidate } from './contracts';
import { REAZON_ASR_VERSION } from './contracts';

export interface AsrAdapter { version: string; qualification: 'unvalidated' | 'test-only' | 'validated'; transcribe(audioPath: string, mediaHash: string): Promise<AsrCandidate> }
export class InspectionUnavailable extends Error {}

/** Decode uncompressed WAV directly: keep the original peaks and each channel. */
export function decodeWave(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length) throw new Error('invalid-wave-header');
  let format: { encoding: number; channels: number; rate: number; bits: number; align: number } | undefined;
  let data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= b.length;) {
    const name = b.toString('ascii', offset, offset + 4), size = b.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > b.length) throw new Error('truncated-wave');
    if (name === 'fmt ') {
      if (format || size < 16) throw new Error('invalid-wave-format');
      format = { encoding: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), rate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14), align: b.readUInt16LE(start + 12) };
      if (b.readUInt32LE(start + 8) !== format.rate * format.align) throw new Error('invalid-wave-rate');
    }
    if (name === 'data') { if (data) throw new Error('duplicate-wave-data'); data = b.subarray(start, start + size); }
    offset = start + size + (size % 2);
  }
  if (!format || !data?.length || format.channels < 1 || format.rate < 1 || format.align < 1 || data.length % format.align) throw new Error('invalid-wave');
  if (![1, 3].includes(format.encoding) || ![8, 16, 24, 32].includes(format.bits) || (format.encoding === 3 && format.bits !== 32)
    || format.channels > 8 || format.rate < 8000 || format.rate > 192000) throw new InspectionUnavailable('このWAV形式・sample rateは軽量検査の対象外です。');
  if (format.align !== format.channels * format.bits / 8) throw new Error('invalid-wave-frame-size');
  const frames = data.length / format.align;
  if (frames / format.rate > 120) throw new InspectionUnavailable('軽量検査の上限120秒を超えています。');
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < format.channels; c++) {
    const offset = i * format.align + c * format.bits / 8;
    channels[c][i] = format.encoding === 3 ? data.readFloatLE(offset) : format.bits === 8 ? (data[offset] - 128) / 128 : data.readIntLE(offset, format.bits / 8) / (2 ** (format.bits - 1));
  }
  return { channels, sampleRate: format.rate };
}
export async function decodeMp3(path: string): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  try {
    const probe = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mp3', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,duration', '-of', 'json', path], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const stream = JSON.parse(probe.stdout).streams?.[0];
    const rate = Number(stream?.sample_rate), count = Number(stream?.channels), duration = Number(stream?.duration);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(count) || count < 1 || count > 8 || !Number.isFinite(duration) || duration <= 0) throw new Error('invalid-media-metadata');
    if (duration > 120) throw new InspectionUnavailable('軽量検査の上限120秒を超えています。');
    if (duration * rate * count * 4 > 96 * 1024 * 1024) throw new InspectionUnavailable('PCM復号のメモリ上限を超えるため、軽量検査は判定不能です。');
    const { stdout } = await promisify(execFile)('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', 'mp3', '-i', path, '-t', '120.1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', timeout: 30_000, maxBuffer: 96 * 1024 * 1024 });
    if (stdout.length % (4 * count) || !stdout.length || stdout.length / (4 * count * rate) > 120) throw new Error('invalid-decoded-media');
    const frames = stdout.length / (4 * count), channels = Array.from({ length: count }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) channels[c][i] = stdout.readFloatLE((i * count + c) * 4);
    return { channels, sampleRate: rate };
  } catch (error) {
    if (error instanceof InspectionUnavailable) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InspectionUnavailable('MP3のPCM検査には手元のffmpeg/ffprobeが必要です。');
    const failure = error as { killed?: boolean; signal?: string; code?: string };
    if (failure.killed || failure.signal || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new InspectionUnavailable('復号ツールの中断・時間または出力上限により、PCM検査は判定不能です。');
    throw new Error('MP3を復号できません。', { cause: error });
  }
}
export function validCandidate(value: unknown, mediaHash: string, version: string): value is AsrCandidate {
  if (!value || typeof value !== 'object') return false;
  const v = value as AsrCandidate;
  return v.schemaVersion === 1 && v.method === 'audio-only-greedy-ctc' && v.version === version && v.mediaHash === mediaHash && typeof v.text === 'string' && v.text.length <= 4000
    && Number.isFinite(v.tokenScore) && v.tokenScore >= 0 && v.tokenScore <= 1;
}
export function localReazonAsr(config: GenerationServerConfig): AsrAdapter | undefined {
  if (!config.alignmentPython || !config.alignmentModelDir || !config.alignmentScript) return;
  const script = join(dirname(config.alignmentScript), 'inspect_audio_asr.py');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { RSVP_ALIGNMENT_MODEL_DIR: config.alignmentModelDir, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONDONTWRITEBYTECODE: '1' });
  return { version: REAZON_ASR_VERSION, qualification: 'unvalidated', transcribe(audioPath, mediaHash) {
    return new Promise<AsrCandidate>((resolve, reject) => {
      const child = spawn(config.alignmentPython!, [script], { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 120_000);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (part: string) => { output += part; if (Buffer.byteLength(output) > 64 * 1024) stop(); });
      child.stderr.on('data', () => { /* Drain diagnostics without exposing them. */ });
      child.stdin.on('error', () => { failed = true; });
      child.on('error', error => { clearTimeout(timer); reject(new InspectionUnavailable('手元のASR runtimeを起動できません。', { cause: error })); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          const value: unknown = JSON.parse(output);
          if (failed || code !== 0 || !validCandidate(value, mediaHash, REAZON_ASR_VERSION)) throw new Error('invalid-asr-response');
          resolve(value);
        } catch (error) { reject(new InspectionUnavailable('手元ASRの実行・hash検査に失敗、または30秒の上限を超えました。', { cause: error })); }
      });
      child.stdin.end(JSON.stringify({ schemaVersion: 1, audioPath, mediaHash }));
    });
  } };
}
