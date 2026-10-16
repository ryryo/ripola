import type { AudioBookManifest, AudioBookSummary } from '../contracts';
import { resolveDocumentTitle } from '../../reader/document-title';
import { LibraryDisk } from './disk';

interface Entry { version: string; summary: AudioBookSummary }
function validSummary(value: unknown, file: string): value is AudioBookSummary {
  if (!value || typeof value !== 'object') return false;
  const book = value as AudioBookSummary;
  return typeof book.id === 'string' && typeof book.revision === 'string' && file === `${book.id}_${book.revision}.json`
    && typeof book.title === 'string' && typeof book.updatedAt === 'string' && book.precision === 'sentence'
    && Number.isSafeInteger(book.completedChunks) && book.completedChunks >= 0 && Number.isSafeInteger(book.totalChunks) && book.totalChunks >= book.completedChunks
    && Number.isFinite(book.durationSeconds) && book.durationSeconds >= 0;
}
function optionalCacheFailure(error: unknown) {
  return error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EROFS', 'ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '');
}

/** Derived summaries only. Opening a book still reads and verifies its canonical manifest. */
export class LibraryCatalog {
  private entries = new Map<string, Entry>();
  private initialized?: Promise<void>;
  private pending?: Promise<AudioBookSummary[]>;
  constructor(private readonly disk: LibraryDisk) {}

  list(): Promise<AudioBookSummary[]> {
    if (this.pending) return this.pending;
    const pending = this.load(); this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }
  private async initialize() {
    try {
      const cached = await this.disk.read<{ schemaVersion: number; entries: Record<string, Entry> }>(['catalog', 'index.json']);
      if (cached?.schemaVersion !== 1 || !cached.entries || typeof cached.entries !== 'object') return;
      for (const [file, entry] of Object.entries(cached.entries)) {
        if (entry && typeof entry.version === 'string' && validSummary(entry.summary, file)) this.entries.set(file, entry);
      }
    } catch (error) { if (!optionalCacheFailure(error)) throw error; }
  }
  private async load(): Promise<AudioBookSummary[]> {
    await (this.initialized ??= this.initialize());
    const files = await this.disk.list('books');
    const names = new Set(await this.disk.list('book-names'));
    const current = new Map<string, Entry>();
    const summaries = new Array<AudioBookSummary | undefined>(files.length);
    let cursor = 0, changed = files.length !== this.entries.size;
    // Bound legacy-manifest migration's temporary memory and filesystem concurrency.
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      for (let index = cursor++; index < files.length; index = cursor++) {
        const file = files[index];
        let version = await this.disk.fileVersion(['books', file]);
        if (!version) { changed = true; continue; }
        let entry = this.entries.get(file);
        if (entry?.version !== version) {
          changed = true; entry = undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            const book = await this.disk.read<AudioBookManifest>(['books', file]);
            const after = await this.disk.fileVersion(['books', file]);
            if (!book || !after) break;
            if (version !== after) { version = after; continue; }
            const { id, revision, title, updatedAt, completedChunks, totalChunks, durationSeconds, precision } = book;
            const summary = { id, revision, title, updatedAt, completedChunks, totalChunks, durationSeconds, precision };
            if (!validSummary(summary, file)) throw new Error('保存済み音声の概要を確認できません。');
            entry = { version, summary }; break;
          }
          if (!entry) {
            if (await this.disk.fileVersion(['books', file])) throw new Error('本棚が更新中です。もう一度読み込んでください。');
            continue;
          }
        }
        current.set(file, entry);
        const name = names.has(file) ? await this.disk.read<{ schemaVersion: number; title: string }>(['book-names', file]) : undefined;
        summaries[index] = name?.schemaVersion === 1 && typeof name.title === 'string'
          ? { ...entry.summary, title: resolveDocumentTitle(name.title) } : { ...entry.summary };
      }
    }));
    this.entries = current;
    if (changed) {
      try { await this.disk.write(['catalog', 'index.json'], { schemaVersion: 1, entries: Object.fromEntries(current) }); }
      catch (error) { if (!optionalCacheFailure(error)) throw error; }
    }
    return summaries.filter((book): book is AudioBookSummary => Boolean(book)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
