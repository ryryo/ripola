import type { AudioBookManifest, AudioBookSummary, GenerationJob, ReadingJob, ReadingUpdate } from '../contracts';
import { requireAudioPresentation } from '../../reader/audio-presentation';
import { resolveDocumentTitle } from '../../reader/document-title';
import { compressedAudioRecord, readReadyAudio } from './audio-cache';
import { digest, LibraryDisk, requireId, requireKey } from './disk';
import { LibraryCatalog } from './library-catalog';

/** Read-side state contains only derived identifiers, never retained manuscript payloads. */
export class ReadingLibrary {
  private readonly catalog: LibraryCatalog;
  private readonly watched = new Map<string, { stamp: string; keys: string[] }>();
  private readonly jobs = new Map<string, { stamp: string; value: ReadingJob }>();
  constructor(private readonly disk: LibraryDisk) { this.catalog = new LibraryCatalog(disk); }
  listLibrary(): Promise<AudioBookSummary[]> { return this.catalog.list(); }

  private async snapshot<T>(parts: string[]): Promise<{ value: T; stamp: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const stamp = await this.disk.fileVersion(parts);
      const value = await this.disk.read<T>(parts);
      if (!stamp || !value) throw new Error('保存済みデータが見つかりません。');
      if (stamp === await this.disk.fileVersion(parts)) return { value, stamp };
    }
    throw new Error('保存済みデータが更新中です。もう一度読み込んでください。');
  }
  private remember(file: string, stamp: string, book: AudioBookManifest) {
    this.watched.delete(file);
    this.watched.set(file, { stamp, keys: [...new Set(book.chunks.map(chunk => requireKey(chunk.speechKey)))] });
    if (this.watched.size > 32) this.watched.delete(this.watched.keys().next().value!);
  }
  async getBook(bookId: string, revision?: string): Promise<AudioBookManifest> {
    requireId(bookId);
    const selected = revision ?? (await this.listLibrary()).find(book => book.id === bookId)?.revision;
    requireKey(selected);
    const file = `${bookId}_${selected}.json`;
    const { value: book, stamp } = await this.snapshot<AudioBookManifest>(['books', file]);
    const name = await this.disk.read<{ schemaVersion: number; title: string }>(['book-names', file]);
    const title = name?.schemaVersion === 1 && typeof name.title === 'string' ? resolveDocumentTitle(name.title) : book.title;
    const chunks = await Promise.all(book.chunks.map(async chunk => {
      const media = await compressedAudioRecord(this.disk, chunk.speechKey);
      if (!media) return chunk;
      if (Math.abs(media.durationSeconds - chunk.durationSeconds) > 1e-6) throw new Error('MP3と保存済み文の時計が一致しません。');
      return { ...chunk, audioUrl: `/api/local-audio/${chunk.speechKey}.mp3`, mimeType: 'audio/mpeg' as const };
    }));
    const view = { ...book, chunks, title, document: { ...book.document, title } };
    const result = { ...view, presentation: requireAudioPresentation(view) };
    this.remember(file, stamp, book);
    return result;
  }
  async getAudio(key: string, requested?: 'wav' | 'mp3') {
    const audio = await readReadyAudio(this.disk, key, requested);
    if (!audio) throw new Error('検証済み音声がありません。');
    return audio;
  }
  private async version(bookId: string, revision: string): Promise<string> {
    const file = `${bookId}_${revision}.json`;
    const stamp = await this.disk.fileVersion(['books', file]);
    if (!stamp) throw new Error('保存済み音声が見つかりません。');
    let watched = this.watched.get(file);
    if (watched?.stamp !== stamp) {
      const snapshot = await this.snapshot<AudioBookManifest>(['books', file]);
      this.remember(file, snapshot.stamp, snapshot.value);
      watched = this.watched.get(file)!;
    }
    const name = await this.disk.fileVersion(['book-names', file]);
    const media: Array<string | undefined> = [];
    // Stat small metadata only. Even in-place compression/cache edits must invalidate the view.
    for (let index = 0; index < watched.keys.length; index += 16) {
      const batch = await Promise.all(watched.keys.slice(index, index + 16).map(key => Promise.all([
        this.disk.fileVersion(['audio-media', `${key}.json`]), this.disk.fileVersion(['cache', `${key}.json`]),
      ])));
      media.push(...batch.flat());
    }
    return digest(JSON.stringify([watched.stamp, name, media]));
  }
  async readingJob(jobId: string): Promise<ReadingJob> {
    requireId(jobId);
    const parts = ['jobs', `${jobId}.json`];
    const cached = this.jobs.get(jobId);
    if (cached && cached.stamp === await this.disk.fileVersion(parts)) return { ...cached.value };
    const { value, stamp } = await this.snapshot<GenerationJob>(parts);
    const { id, planId, bookId, revision, status, completedChunks, totalChunks, updatedAt } = value;
    const summary = { id, planId, bookId, revision, status, completedChunks, totalChunks, updatedAt };
    this.jobs.delete(jobId); this.jobs.set(jobId, { stamp, value: summary });
    if (this.jobs.size > 32) this.jobs.delete(this.jobs.keys().next().value!);
    return { ...summary };
  }
  async listReadingJobs(): Promise<ReadingJob[]> {
    const result: ReadingJob[] = [];
    for (const file of await this.disk.list('jobs')) result.push(await this.readingJob(file.slice(0, -5)));
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async update(bookId: string, revision: string, previous?: string, jobId?: string): Promise<ReadingUpdate> {
    requireId(bookId); requireKey(revision);
    if (previous !== undefined) requireKey(previous);
    const job = jobId ? await this.readingJob(jobId) : undefined;
    if (job && (job.bookId !== bookId || job.revision !== revision)) throw new Error('生成中の本の更新元が一致しません。');
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = await this.version(bookId, revision);
      if (version === previous) return { version, job };
      const book = await this.getBook(bookId, revision);
      if (version === await this.version(bookId, revision)) return { version, job, book };
    }
    throw new Error('保存済み音声が更新中です。もう一度読み込んでください。');
  }
}
