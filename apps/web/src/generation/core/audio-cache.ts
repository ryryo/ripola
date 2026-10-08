import type { MediaTimingMeasurement } from '../../distribution/library';
import { digest, LibraryDisk, requireKey } from './disk';

/** The original WAV hash and clock remain the generation/alignment identity. */
export interface AudioCacheRecord {
  schemaVersion: 1;
  status: 'sending' | 'audio-ready' | 'ready' | 'failed' | 'outcome-unknown';
  provider: 'voicevox' | 'gemini';
  hash?: string;
  durationSeconds?: number;
  error?: string;
}
export interface CompressedAudioRecord {
  schemaVersion: 1;
  speechKey: string;
  format: 'mp3';
  mimeType: 'audio/mpeg';
  hash: string;
  bytes: number;
  sourceAudioHash: string;
  sourceBytes: number;
  durationSeconds: number;
  createdAt: string;
  verification: {
    kind: 'gapless-identity-v1';
    sampleRate: 24000;
    sourceFrames: number;
    decodedFrames: number;
    sourcePcmHash: string;
    decodedPcmHash: string;
    containerDurationSeconds: number;
    encoderSkipSamples: number;
    encoderPaddingSamples: number;
    timing: MediaTimingMeasurement;
  };
}
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function validateCompressedAudio(record: CompressedAudioRecord, key: string, cache: AudioCacheRecord): void {
  const v = record?.verification, t = v?.timing;
  if (record?.schemaVersion !== 1 || record.speechKey !== key || record.format !== 'mp3' || record.mimeType !== 'audio/mpeg'
    || cache.status !== 'ready' || !hash(cache.hash) || record.sourceAudioHash !== cache.hash || !hash(record.hash)
    || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || !Number.isSafeInteger(record.sourceBytes) || record.sourceBytes < 1
    || !positive(record.durationSeconds) || !positive(cache.durationSeconds) || Math.abs(record.durationSeconds - cache.durationSeconds) > 1e-6
    || v?.kind !== 'gapless-identity-v1' || v.sampleRate !== 24000 || !hash(v.sourcePcmHash) || !hash(v.decodedPcmHash)
    || !Number.isSafeInteger(v.sourceFrames) || v.sourceFrames < 1 || !Number.isSafeInteger(v.decodedFrames) || Math.abs(v.decodedFrames - v.sourceFrames) > 1
    || Math.abs(v.sourceFrames / v.sampleRate - record.durationSeconds) > .002 || !positive(v.containerDurationSeconds)
    || !Number.isSafeInteger(v.encoderSkipSamples) || v.encoderSkipSamples <= 0 || !Number.isSafeInteger(v.encoderPaddingSamples) || v.encoderPaddingSamples < 0
    || t?.verification !== 'pcm-correlated' || t.algorithm !== 'pcm-normalized-xcorr-v1' || t.sampleRate !== 24000
    || (t.windowSeconds !== undefined && (!Number.isFinite(t.windowSeconds) || t.windowSeconds < .08 || t.windowSeconds > .32))
    || !Number.isFinite(t.offsetSeconds) || !positive(t.scale) || !Number.isFinite(t.maxResidualSeconds) || t.maxResidualSeconds < 0 || t.maxResidualSeconds > .002
    || !Number.isFinite(t.score) || t.score < .8 || t.score > 1 || !Array.isArray(t.anchors) || t.anchors.length < 3
    || t.anchors.some(a => ![a.sourceSeconds, a.mediaSeconds, a.lagSeconds, a.correlation, a.peakMargin].every(Number.isFinite)
      || a.sourceSeconds < 0 || a.sourceSeconds > record.durationSeconds || a.mediaSeconds < 0 || a.mediaSeconds > record.durationSeconds
      || a.correlation < .8 || a.correlation > 1 || a.peakMargin < .015
      || Math.abs(a.mediaSeconds - a.sourceSeconds - a.lagSeconds) > 1e-6
      || Math.abs(a.lagSeconds - t.offsetSeconds - (t.scale - 1) * a.sourceSeconds) > t.maxResidualSeconds + 1e-6)
    || Math.abs(t.offsetSeconds) + Math.abs(t.scale - 1) * record.durationSeconds > .002
    || Math.abs(t.sourcePcmDurationSeconds - v.sourceFrames / v.sampleRate) > 1e-6
    || Math.abs(t.decodedPcmDurationSeconds - v.decodedFrames / v.sampleRate) > 1e-6) {
    throw new Error('MP3の元音声・gapless時刻の検証情報が一致しません。自動再生成は行いません。');
  }
}
export async function compressedAudioRecord(disk: LibraryDisk, key: string, cache?: AudioCacheRecord): Promise<CompressedAudioRecord | undefined> {
  requireKey(key);
  const record = await disk.read<CompressedAudioRecord>(['audio-media', `${key}.json`]);
  if (!record) return undefined;
  cache ??= await disk.read<AudioCacheRecord>(['cache', `${key}.json`]);
  if (!cache) throw new Error('MP3に対応する元音声のcacheがありません。');
  validateCompressedAudio(record, key, cache);
  return record;
}
export async function readReadyAudio(disk: LibraryDisk, key: string, requested?: 'wav' | 'mp3') {
  requireKey(key);
  const cache = await disk.read<AudioCacheRecord>(['cache', `${key}.json`]);
  const media = await compressedAudioRecord(disk, key, cache);
  if (cache?.status !== 'ready') return undefined;
  if (requested === 'mp3' && !media) throw new Error('検証済みMP3がありません。');
  let format: 'wav' | 'mp3' = media && requested !== 'wav' ? 'mp3' : 'wav';
  let bytes = await disk.readBytes(['audio', `${key}.${format}`]);
  // Previously saved WAV URLs can redirect to verified MP3 after reversible archival.
  if (!bytes && format === 'wav' && media) { format = 'mp3'; bytes = await disk.readBytes(['audio', `${key}.mp3`]); }
  const expected = format === 'mp3' ? media?.hash : cache.hash;
  if (!bytes || digest(bytes) !== expected || (format === 'mp3' && bytes.length !== media!.bytes)) {
    throw new Error('保存音声の整合性検査に失敗しました。自動再生成は行いません。');
  }
  return { bytes, cache, format, mimeType: format === 'mp3' ? 'audio/mpeg' as const : 'audio/wav' as const, sourceAudioHash: cache.hash!, media };
}
