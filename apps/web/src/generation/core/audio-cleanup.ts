import type { AudioBookManifest, SavedAudioChunk, WavCleanupSummary } from '../contracts';
import { requireAudioPresentation } from '../../reader/audio-presentation';
import { BOOK_REFERENCES_LOCK, digest, LibraryDisk, requireId, requireKey } from './disk';
import { compressedAudioRecord, readReadyAudio } from './audio-cache';

/** Call under BOOK_REFERENCES_LOCK: book writes invalidate this index atomically. */
export class WavReferences {
  private version?: string;
  private readonly needed = new Set<string>();
  private readonly hashes = new Map<string, Set<string>>();
  constructor(private readonly disk: LibraryDisk) {}
  async permitsRemoval(key: string, hash: string): Promise<boolean> {
    const version = await this.disk.directoryVersion('books');
    if (version !== this.version) {
      this.needed.clear(); this.hashes.clear();
      for (const file of await this.disk.list('books')) {
        const book = await this.disk.read<AudioBookManifest>(['books', file]);
        if (!book || !Array.isArray(book.chunks)) throw new Error('保存済みの本の参照を検証できません。');
        for (const chunk of book.chunks) {
          if (!chunk.alignment) this.needed.add(chunk.speechKey);
          else {
            const hashes = this.hashes.get(chunk.speechKey) ?? new Set<string>();
            hashes.add(chunk.alignment.audioHash); this.hashes.set(chunk.speechKey, hashes);
          }
        }
      }
      this.version = version;
    }
    return !this.needed.has(key) && [...(this.hashes.get(key) ?? [])].every(value => value === hash);
  }
}
export interface WavCleanupInput { bookId: string; revision: string; operationId: string; selectedChunkIds?: string[]; apply?: boolean }
export interface WavCleanupFile {
  speechKey: string; status: 'planned' | 'removed' | 'absent' | 'retained' | 'in-use' | 'failed';
  bytes: number; sourceAudioHash?: string; mp3Hash?: string; removalPlanned?: boolean; reason?: string;
}
export interface WavCleanupReport extends WavCleanupSummary { schemaVersion: 1; bookId: string; revision: string; operationId: string; applied: boolean; files: WavCleanupFile[] }

/** No TTS, model, re-encoding or manifest mutation. Only verified WAV intermediates are removed. */
export async function cleanupSavedWavs(disk: LibraryDisk, input: WavCleanupInput): Promise<WavCleanupReport> {
  requireId(input.bookId); requireKey(input.revision); requireId(input.operationId);
  const key = digest(input.operationId);
  return disk.withLock(`wav-cleanup-${key}`, async () => {
    const book = await disk.read<AudioBookManifest>(['books', `${input.bookId}_${input.revision}.json`]);
    if (!book || book.id !== input.bookId || book.revision !== input.revision || book.completedChunks !== book.totalChunks) throw new Error('クリーニングには完成した保存済みの本が必要です。');
    requireAudioPresentation(book);
    if (input.selectedChunkIds && (!input.selectedChunkIds.length || input.selectedChunkIds.some(id => !book.chunks.some(c => c.id === id)))) throw new Error('クリーニング対象のchunkが正しくありません。');
    const ids = input.selectedChunkIds ? new Set(input.selectedChunkIds) : undefined;
    const chunks = [...new Map(book.chunks.filter(c => !ids || ids.has(c.id)).map(c => [c.speechKey, c])).values()];
    const requestHash = digest(JSON.stringify([book.id, book.revision, chunks.map(c => c.speechKey).sort()]));
    const recordPath = ['audio-cleanup-jobs', `${key}.json`];
    const prior = await disk.read<{ requestHash: string }>(recordPath);
    if (prior && prior.requestHash !== requestHash) throw new Error('同じクリーニング操作IDで別の対象は指定できません。');
    if (input.apply) await disk.write(recordPath, { schemaVersion: 1, requestHash, status: 'running', bookId: book.id, revision: book.revision });
    const references = new WavReferences(disk), files: WavCleanupFile[] = [];
    for (const chunk of chunks) {
      requireKey(chunk.speechKey);
      const row: WavCleanupFile = { speechKey: chunk.speechKey, status: 'retained', bytes: 0 };
      files.push(row);
      const release = await disk.lock(`speech-${chunk.speechKey}`);
      if (!release) { row.status = 'in-use'; row.reason = '音声を別の処理が使用中です。'; continue; }
      try {
        await disk.withLock(BOOK_REFERENCES_LOCK, async () => {
          const source = await disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
          const journalPath = ['audio-cleanup-files', `${digest(`${key}:${chunk.speechKey}`)}.json`];
          const previous = await disk.read<WavCleanupFile>(journalPath);
          if (!source && !previous?.removalPlanned) { row.status = 'absent'; return; }
          // Prefer WAV for alignment, but verify the actual persisted MP3 and its original clock here.
          if (!await compressedAudioRecord(disk, chunk.speechKey)) { row.bytes = source?.length ?? 0; row.reason = '検証済みMP3がありません。'; return; }
          const audio = await readReadyAudio(disk, chunk.speechKey, 'mp3');
          if (!audio?.media) { row.reason = '検証済みMP3がありません。'; return; }
          row.bytes = source?.length ?? audio.media.sourceBytes;
          row.sourceAudioHash = audio.media.sourceAudioHash; row.mp3Hash = audio.media.hash;
          if (!source && previous?.removalPlanned && previous.sourceAudioHash === row.sourceAudioHash && previous.mp3Hash === row.mp3Hash) { row.status = 'removed'; row.removalPlanned = true; return; }
          if (!source) { row.status = 'absent'; return; }
          if (!validCorrection(chunk, row.sourceAudioHash) || !await references.permitsRemoval(chunk.speechKey, row.sourceAudioHash)) { row.reason = '未補正または異なる元音声を参照する本があるためWAVを保持します。'; return; }
          if (digest(source) !== row.sourceAudioHash) throw new Error('元WAVのhashが一致しません。');
          row.status = 'planned';
          if (input.apply) {
            // Exact hash-bound intent survives interruption between unlink and completion recording.
            row.removalPlanned = true; await disk.write(journalPath, row);
            await disk.removeVerified(['audio', `${chunk.speechKey}.wav`], row.sourceAudioHash);
            row.status = 'removed'; await disk.write(journalPath, row);
          }
        });
      } catch (error) { row.status = 'failed'; row.reason = error instanceof Error ? error.message : 'WAVの検証に失敗しました。'; }
      finally { await release(); }
    }
    const retained = files.filter(f => ['retained', 'in-use', 'failed'].includes(f.status));
    const report: WavCleanupReport = { schemaVersion: 1, bookId: book.id, revision: book.revision, operationId: input.operationId, applied: input.apply === true,
      status: retained.length ? 'partial' : 'completed', removedFiles: files.filter(f => f.status === 'removed').length,
      removedWavBytes: files.filter(f => f.status === 'removed').reduce((n, f) => n + f.bytes, 0), retainedWavFiles: retained.length, files };
    if (input.apply) await disk.write(recordPath, { ...report, requestHash });
    return report;
  });
}
function validCorrection(chunk: SavedAudioChunk, hash: string): boolean { return chunk.alignment?.audioHash === hash; }
