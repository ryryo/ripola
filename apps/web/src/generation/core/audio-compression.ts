import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressedAudioRecord, readReadyAudio, validateCompressedAudio, type AudioCacheRecord, type CompressedAudioRecord } from './audio-cache';
import { digest, LibraryDisk } from './disk';
import { estimateMp3Timing } from './media-timing';
const run = promisify(execFile);
export async function audioCompressionAvailable(): Promise<boolean> {
  try { await Promise.all(['ffmpeg', 'ffprobe'].map(binary => run(binary, ['-version'], { timeout: 10000, maxBuffer: 256 * 1024 }))); return true; }
  catch { return false; }
}
export async function decodeTimingPcm(path: string): Promise<{ samples: Float32Array; hash: string }> {
  let bytes: Buffer;
  try {
    const result = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '24000', '-f', 'f32le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    bytes = result.stdout;
  } catch { throw new Error('PCM timing verification failed. Source audio is unchanged; no TTS was rerun.'); }
  if (!bytes.length || bytes.length % 4 !== 0) throw new Error('Decoded PCM is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.length / 4);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getFloat32(index * 4, true);
  return { samples, hash: digest(bytes) };
}
export async function encodeVerifiedMp3(disk: LibraryDisk, key: string, cache: AudioCacheRecord): Promise<CompressedAudioRecord> {
  const previous = await compressedAudioRecord(disk, key, cache);
  if (previous) { await readReadyAudio(disk, key, 'mp3'); return previous; }
  const input = await disk.existingPath(['audio', `${key}.wav`]);
  const source = await disk.readBytes(['audio', `${key}.wav`]);
  if (!source || digest(source) !== cache.hash) throw new Error('Original WAV does not match ready cache.');
  const temporary = await mkdtemp(join(tmpdir(), 'rsvp-mp3-'));
  try {
    const output = join(temporary, 'audio.mp3');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map_metadata', '-1', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', '-write_xing', '1', '-id3v2_version', '3', output], { timeout: 120000, maxBuffer: 256 * 1024 });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels:packet_side_data=skip_samples,discard_padding', '-of', 'json', output], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_name: string; sample_rate: string; channels: number }>; packets: Array<{ side_data_list?: Array<{ skip_samples?: number; discard_padding?: number }> }> };
    if (info.streams.length !== 1 || info.streams[0].codec_name !== 'mp3' || Number(info.streams[0].sample_rate) !== 24000 || info.streams[0].channels !== 1) throw new Error('MP3 codec profile differs.');
    const sourcePcm = await decodeTimingPcm(input), decoded = await decodeTimingPcm(output);
    const timing = estimateMp3Timing(sourcePcm.samples, decoded.samples);
    if (timing.verification !== 'pcm-correlated') throw new Error(`MP3 PCM timing verification failed: ${timing.reason}; window=${timing.windowSeconds}s, anchors=${timing.anchors.length}, correlation=${timing.score}.`);
    const sideData = info.packets.flatMap(p => p.side_data_list ?? []);
    const bytes = await readFile(output);
    if (bytes.length >= source.length) throw new Error('Compressed audio is not smaller than its source.');
    const record: CompressedAudioRecord = { schemaVersion: 1, speechKey: key, format: 'mp3', mimeType: 'audio/mpeg', hash: digest(bytes), bytes: bytes.length,
      sourceAudioHash: cache.hash!, sourceBytes: source.length, durationSeconds: cache.durationSeconds!, createdAt: new Date().toISOString(),
      verification: { kind: 'gapless-identity-v1', sampleRate: 24000, sourceFrames: sourcePcm.samples.length, decodedFrames: decoded.samples.length,
        sourcePcmHash: sourcePcm.hash, decodedPcmHash: decoded.hash, containerDurationSeconds: Number(info.format.duration),
        encoderSkipSamples: sideData.reduce((sum, s) => sum + (s.skip_samples ?? 0), 0), encoderPaddingSamples: sideData.reduce((sum, s) => sum + (s.discard_padding ?? 0), 0), timing } };
    validateCompressedAudio(record, key, cache);
    // A writer cannot mutate the source unnoticed while encoding/verifying it.
    if (digest((await disk.readBytes(['audio', `${key}.wav`]))!) !== cache.hash) throw new Error('WAV changed while verifying MP3.');
    const existing = await disk.readBytes(['audio', `${key}.mp3`]);
    if (existing && digest(existing) !== record.hash) throw new Error('An unmatched MP3 already exists; it is preserved.');
    if (!existing) await disk.writeBytes(['audio', `${key}.mp3`], bytes);
    await disk.write(['audio-media', `${key}.json`], record);
    return record;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
