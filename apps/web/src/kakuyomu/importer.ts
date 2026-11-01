import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LibraryDisk } from '../generation/core/disk';
import { prepareDocument } from '../reader/segmentation';
import { kakuyomuWorkUrl, parseNovelIndex, prepareNovelPart, type ExtractedParagraph } from './parser';
import { extractEpisode } from './parser';
import { KakuyomuCache } from './cache';
import { SequentialKakuyomuFetcher, type PageFetch } from './fetch';
import { LocalTextBookStore, MAX_TEXT_BOOK_BYTES, requireLocalTextBook } from './text-books';
import type {
  KakuyomuJobBook, KakuyomuJobView, KakuyomuPreview, KakuyomuSourceEpisode, LocalTextBook,
} from './contracts';

export interface KakuyomuImporterOptions {
  libraryDir: string;
  fetch?: PageFetch;
  /** Zero is reserved for deterministic tests; production uses the 1.2 s default. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxBookBytes?: number;
  now?: () => string;
}

interface JobState extends KakuyomuJobView {
  index: ReturnType<typeof parseNovelIndex>;
  selectedParts: number[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '取り込みに失敗しました。';
}
function validJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
function bookId(workId: string, partOrder: number): string {
  return `text-kakuyomu-${workId}-${String(partOrder).padStart(2, '0')}`;
}
function attribution(index: ReturnType<typeof parseNovelIndex>): string {
  return `${index.title}／${index.author}／カクヨム ${index.url}。本文の利用条件は作品ページで確認してください。`;
}
function previewOf(index: ReturnType<typeof parseNovelIndex>, cached: boolean, fetchedAt?: string): KakuyomuPreview {
  return {
    id: index.id, title: index.title, author: index.author, url: index.url, cached, ...(fetchedAt ? { fetchedAt } : {}),
    parts: index.parts.map(part => ({
      order: part.order, title: part.title, chapter: part.chapter, ...(part.section ? { section: part.section } : {}),
      episodeCount: part.episodes.length, firstEpisode: part.episodes[0]?.title, lastEpisode: part.episodes.at(-1)?.title,
    })),
  };
}
function view(job: JobState): KakuyomuJobView {
  return structuredClone({
    id: job.id, status: job.status, workId: job.workId, workUrl: job.workUrl, selectedParts: [...job.selectedParts],
    totalParts: job.totalParts, totalEpisodes: job.totalEpisodes, completedEpisodes: job.completedEpisodes,
    completedParts: job.completedParts, ...(job.current ? { current: { ...job.current } } : {}),
    books: job.books.map(book => ({ ...book })), ...(job.error ? { error: job.error } : {}),
    startedAt: job.startedAt, updatedAt: job.updatedAt,
  });
}

/**
 * Local-only acquisition coordinator. The server function and the CLI share
 * the parser/cache; this class adds sequential progress, a single-run lock and
 * complete-book publication. It never starts audio generation.
 */
export class KakuyomuImporter {
  private readonly libraryDir: string;
  private readonly fetchPage: PageFetch;
  private readonly jobs = new Map<string, JobState>();
  private active?: string;
  constructor(private readonly options: KakuyomuImporterOptions) {
    this.libraryDir = options.libraryDir;
    const fetcher = new SequentialKakuyomuFetcher({ minIntervalMs: options.minIntervalMs, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
    this.fetchPage = options.fetch ?? ((url, access) => fetcher.fetch(url, access));
  }
  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private cache(workUrl: string): KakuyomuCache {
    const url = kakuyomuWorkUrl(workUrl), workId = url.split('/').at(-1)!;
    return new KakuyomuCache({
      disk: new LibraryDisk(join(this.libraryDir, 'kakuyomu-cache', workId)),
      workId, workUrl: url, maxBytes: this.options.maxBytes,
    });
  }
  private store(): LocalTextBookStore { return new LocalTextBookStore(this.libraryDir, this.options.maxBookBytes ?? MAX_TEXT_BOOK_BYTES); }

  async preview(input: string): Promise<KakuyomuPreview> {
    const url = kakuyomuWorkUrl(input);
    const cache = this.cache(url);
    const page = await cache.getIndex(this.fetchPage, false);
    const index = parseNovelIndex(page.html, url);
    return previewOf(index, page.cached, page.record.fetchedAt);
  }

  async start(input: string, requestedParts: number[]): Promise<KakuyomuJobView> {
    const url = kakuyomuWorkUrl(input);
    if (this.active) throw new Error('このPCで別の取り込みが進行中です。完了を待ってください。');
    if (!Array.isArray(requestedParts) || !requestedParts.length || requestedParts.length > 10_000
      || new Set(requestedParts).size !== requestedParts.length
      || requestedParts.some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('取り込む章・節を1つ以上選んでください。');
    }
    const lock = new LibraryDisk(this.libraryDir);
    const release = await lock.lock('kakuyomu-acquisition');
    if (!release) throw new Error('このPCで別の取り込みが進行中です。完了を待ってください。');
    try {
      const cache = this.cache(url);
      const page = await cache.getIndex(this.fetchPage, false);
      const index = parseNovelIndex(page.html, url);
      const selected = [...requestedParts].sort((a, b) => a - b);
      if (selected.some(order => !index.parts.some(part => part.order === order))) throw new Error('選択した章・節が目次にありません。');
      const parts = index.parts.filter(part => selected.includes(part.order));
      const id = randomUUID(), startedAt = this.now();
      const job: JobState = {
        id, status: 'queued', workId: index.id, workUrl: index.url, selectedParts: selected,
        totalParts: parts.length, totalEpisodes: parts.reduce((sum, part) => sum + part.episodes.length, 0),
        completedEpisodes: 0, completedParts: 0, books: [], startedAt, updatedAt: startedAt, index,
      };
      this.jobs.set(id, job);
      this.active = id;
      void this.run(job, page.record.sha256).finally(() => { this.active = undefined; void release(); });
      return view(job);
    } catch (error) {
      await release();
      throw error;
    }
  }

  private async run(job: JobState, indexSha256: string): Promise<void> {
    job.status = 'running'; job.updatedAt = this.now();
    const cache = this.cache(job.workUrl), store = this.store();
    try {
      for (const order of job.selectedParts) {
        const part = job.index.parts.find(value => value.order === order)!;
        const html = new Map<string, string>(), sources: KakuyomuSourceEpisode[] = [];
        for (const episode of part.episodes) {
          job.current = { partOrder: part.order, partTitle: part.title, episodeOrder: episode.order, episodeTitle: episode.title };
          job.updatedAt = this.now();
          const page = await cache.getEpisode(episode, this.fetchPage, false);
          // Inspect each episode as soon as it is available; do not keep fetching
          // later episodes after an unsupported body was detected.
          const paragraphs: ExtractedParagraph[] = extractEpisode(page.html);
          if (!paragraphs.length) throw new Error(`第${episode.order}話の本文を確認できません。`);
          html.set(episode.id, page.html);
          sources.push({
            order: episode.order, id: episode.id, title: episode.title, url: episode.url,
            sha256: page.record.sha256, bytes: page.record.bytes, fetchedAt: page.record.fetchedAt,
          });
          job.completedEpisodes++;
          job.updatedAt = this.now();
        }
        const { draft, mapping } = prepareNovelPart(job.index, part, html);
        const document = await prepareDocument(draft);
        const updatedAt = sources.map(source => source.fetchedAt).sort().at(-1)!;
        const id = bookId(job.index.id, part.order);
        const book: LocalTextBook = {
          schemaVersion: 1, kind: 'text', id, revision: document.contentHash, title: document.title, updatedAt, document,
          chunks: [], completedChunks: 0, totalChunks: 0, durationSeconds: 0, precision: 'sentence',
          attribution: attribution(job.index),
          warnings: document.warnings.length ? [...document.warnings] : [],
          source: {
            kind: 'kakuyomu', workId: job.index.id, workUrl: job.index.url, indexSha256,
            partOrder: part.order, chapter: part.chapter, ...(part.section ? { section: part.section } : {}), episodes: sources,
          },
        };
        requireLocalTextBook(book);
        await store.saveSourceMap(id, book.revision, mapping);
        const saved = await store.save(book);
        const summary: KakuyomuJobBook = {
          id: saved.book.id, revision: saved.book.revision, title: saved.book.title,
          partOrder: part.order, episodeCount: sources.length, totalCharacters: saved.book.document.totalCharacters,
        };
        job.books.push(summary);
        job.completedParts++;
        job.current = undefined;
        job.updatedAt = this.now();
      }
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = message(error);
    } finally {
      job.updatedAt = this.now();
    }
  }

  async listBooks(): Promise<import('./contracts').LocalTextBookSummary[]> {
    return this.store().list();
  }
  async getBook(id: string, revision?: string): Promise<LocalTextBook> {
    return this.store().get(id, revision);
  }
  getJob(id: string): KakuyomuJobView {
    if (!validJobId(id)) throw new Error('取り込みジョブIDが正しくありません。');
    const job = this.jobs.get(id);
    if (!job) throw new Error('取り込みジョブが見つかりません。取得済みデータと本棚はそのまま残っています。');
    return view(job);
  }
}
