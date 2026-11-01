import { digest, LibraryDisk, validId } from '../generation/core/disk';
import { requireTextBook } from '../distribution/library';
import { kakuyomuWorkUrl } from './parser';
import type { LocalTextBook, LocalTextBookSummary } from './contracts';
import { aozoraUrlInput, noteUrlInput } from '../url-import/urls';

/** Cloudflare Static Assets per-file limit; used as a local preflight too. */
export const MAX_TEXT_BOOK_BYTES = 25 * 1024 * 1024;

function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function validSource(book: LocalTextBook): void {
  const source = book.source;
  if (source?.kind === 'note') {
    const article = typeof source.workUrl === 'string' ? noteUrlInput(source.workUrl) : undefined;
    if (!article || article.url !== source.workUrl || article.key !== source.workId || source.partOrder !== 1 || source.access !== 'free-public'
      || !validHash(source.htmlSha256) || !validHash(source.bodySha256) || !validHash(source.responseSha256)
      || !Number.isSafeInteger(source.bytes) || source.bytes < 1 || !validTimestamp(source.fetchedAt) || book.document.format !== 'html'
      || book.document.provenance?.sourceUrl !== source.workUrl || book.document.provenance.sourceSha256 !== source.htmlSha256
      || digest(book.document.rawText) !== source.htmlSha256) throw new Error('noteの取得元情報が正しくありません。');
    return;
  }
  if (source?.kind === 'aozora') {
    const card = typeof source.workUrl === 'string' ? aozoraUrlInput(source.workUrl) : undefined;
    const html = typeof source.htmlUrl === 'string' ? aozoraUrlInput(source.htmlUrl) : undefined;
    if (!card || !html || card.url !== card.cardUrl || card.url !== source.workUrl || html.url !== source.htmlUrl
      || html.url === html.cardUrl || html.cardUrl !== card.cardUrl || source.workId !== card.workId
      || !Number.isSafeInteger(source.partOrder) || source.partOrder < 1 || (source.chapter !== undefined && typeof source.chapter !== 'string')
      || !validHash(source.htmlSha256) || !validHash(source.cardSha256) || !Number.isSafeInteger(source.bytes) || source.bytes < 1
      || !validTimestamp(source.fetchedAt) || book.document.format !== 'aozora'
      || book.document.provenance?.sourceUrl !== source.htmlUrl || book.document.provenance.cardUrl !== source.workUrl
      || book.document.provenance.sourceSha256 !== source.htmlSha256) throw new Error('青空文庫の取得元情報が正しくありません。');
    return;
  }
  if (!source || source.kind !== 'kakuyomu' || !/^\d{19,20}$/.test(source.workId) || source.workUrl !== kakuyomuWorkUrl(source.workUrl)
    || !validHash(source.indexSha256) || !Number.isSafeInteger(source.partOrder) || source.partOrder < 1
    || typeof source.chapter !== 'string' || (source.section !== undefined && typeof source.section !== 'string')
    || !Array.isArray(source.episodes) || !source.episodes.length || source.episodes.length > 100_000) {
    throw new Error('テキスト本の取得元情報が正しくありません。');
  }
  const ids = new Set<string>();
  for (const episode of source.episodes) {
    if (!episode || !/^\d{19,20}$/.test(episode.id) || ids.has(episode.id) || !Number.isSafeInteger(episode.order) || episode.order < 1
      || typeof episode.title !== 'string' || !episode.title.trim() || episode.url !== `${source.workUrl}/episodes/${episode.id}`
      || !validHash(episode.sha256) || !Number.isSafeInteger(episode.bytes) || episode.bytes < 1 || !validTimestamp(episode.fetchedAt)) {
      throw new Error('テキスト本の話の取得元情報が正しくありません。');
    }
    ids.add(episode.id);
  }
}
export function requireLocalTextBook(value: unknown): asserts value is LocalTextBook {
  requireTextBook(value as Parameters<typeof requireTextBook>[0]);
  const book = value as LocalTextBook;
  if (book.kind !== 'text' || !validTimestamp(book.updatedAt) || book.document.contentHash !== book.revision) throw new Error('テキスト本の保存形式が正しくありません。');
  validSource(book);
}
function summary(book: LocalTextBook): LocalTextBookSummary {
  return {
    kind: 'text', id: book.id, revision: book.revision, title: book.title, updatedAt: book.updatedAt,
    totalCharacters: book.document.totalCharacters, attribution: book.attribution,
    workUrl: book.source.workUrl, partOrder: book.source.partOrder, episodeCount: book.source.kind === 'kakuyomu' ? book.source.episodes.length : 1,
  };
}
function sameDocument(a: LocalTextBook, b: LocalTextBook): boolean {
  return JSON.stringify(a.document) === JSON.stringify(b.document);
}
function sameSource(a: LocalTextBook, b: LocalTextBook): boolean {
  const left = a.source, right = b.source;
  if (left.kind === 'note' && right.kind === 'note') return left.workUrl === right.workUrl && left.htmlSha256 === right.htmlSha256;
  if (left.kind === 'aozora' && right.kind === 'aozora') return left.workUrl === right.workUrl && left.partOrder === right.partOrder && left.htmlUrl === right.htmlUrl && left.htmlSha256 === right.htmlSha256;
  return left.kind === 'kakuyomu' && right.kind === 'kakuyomu' && left.workId === right.workId && left.partOrder === right.partOrder
    && left.indexSha256 === right.indexSha256
    && left.episodes.length === right.episodes.length
    && left.episodes.every((episode, index) => episode.id === right.episodes[index]?.id && episode.sha256 === right.episodes[index]?.sha256);
}

export interface SavedTextBook { book: LocalTextBook; created: boolean; bytes: number }

/** Text books live beside generated audio under RSVP_LIBRARY_DIR, in their own explicit directory. */
export class LocalTextBookStore {
  private readonly disk: LibraryDisk;
  constructor(root: string, private readonly maximum = MAX_TEXT_BOOK_BYTES) {
    this.disk = new LibraryDisk(root);
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('テキスト本の容量上限が正しくありません。');
  }
  private filename(id: string, revision: string): string {
    if (!validId(id) || !validHash(revision)) throw new Error('テキスト本のIDまたは版が正しくありません。');
    return `${id}_${revision}.json`;
  }
  async save(value: LocalTextBook): Promise<SavedTextBook> {
    requireLocalTextBook(value);
    return this.disk.withLock(`text-book-${digest(`${value.id}:${value.revision}`).slice(0, 40)}`, () => this.saveUnlocked(value));
  }
  private async saveUnlocked(value: LocalTextBook): Promise<SavedTextBook> {
    const filename = this.filename(value.id, value.revision);
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > this.maximum) {
      throw new Error(`テキスト本が保存上限（${Math.floor(this.maximum / 1024 / 1024)} MiB）を超えています。章・節を分けて取り込んでください。`);
    }
    const previousBytes = await this.disk.readBytes(['text-books', filename]);
    if (previousBytes) {
      let previous: LocalTextBook;
      try { previous = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previousBytes)) as LocalTextBook; requireLocalTextBook(previous); }
      catch { throw new Error('保存済みテキスト本の形式が正しくありません。上書きしません。'); }
      if (previous.document.contentHash !== value.document.contentHash || !sameDocument(previous, value) || !sameSource(previous, value)) {
        throw new Error('同じID・版のテキスト本が異なる内容で保存されています。上書きせず停止しました。');
      }
      return { book: previous, created: false, bytes: previousBytes.byteLength };
    }
    await this.disk.writeBytes(['text-books', filename], bytes);
    return { book: value, created: true, bytes: bytes.byteLength };
  }
  /** Source-map sidecar; it is local provenance, never published by stage-text-library. */
  async saveSourceMap(id: string, revision: string, mapping: unknown): Promise<void> {
    this.filename(id, revision);
    return this.disk.withLock(`text-map-${digest(`${id}:${revision}`).slice(0, 40)}`, () => this.saveSourceMapUnlocked(id, revision, mapping));
  }
  private async saveSourceMapUnlocked(id: string, revision: string, mapping: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(mapping)}\n`);
    if (bytes.byteLength > this.maximum) throw new Error('原本対応記録が保存上限を超えています。');
    const path = ['text-source-maps', `${id}_${revision}.json`];
    const previous = await this.disk.readBytes(path);
    if (previous) {
      if (previous.byteLength === bytes.byteLength && previous.every((byte, index) => byte === bytes[index])) return;
      throw new Error('同じID・版の原本対応記録が異なる内容で保存されています。上書きせず停止しました。');
    }
    await this.disk.writeBytes(path, bytes);
  }
  async get(id: string, revision?: string): Promise<LocalTextBook> {
    if (!validId(id)) throw new Error('テキスト本のIDが正しくありません。');
    if (revision) {
      const bytes = await this.disk.readBytes(['text-books', this.filename(id, revision)]);
      if (!bytes) throw new Error('保存済みテキスト本が見つかりません。');
      const book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as LocalTextBook;
      requireLocalTextBook(book);
      if (book.id !== id || book.revision !== revision) throw new Error('保存済みテキスト本のIDが一致しません。');
      return book;
    }
    const books = await this.listBooks();
    const found = books.find(book => book.id === id);
    if (!found) throw new Error('保存済みテキスト本が見つかりません。');
    return found;
  }
  async listBooks(): Promise<LocalTextBook[]> {
    const books: LocalTextBook[] = [];
    for (const file of await this.disk.list('text-books')) {
      try {
        const bytes = await this.disk.readBytes(['text-books', file]);
        if (!bytes) continue;
        const book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as LocalTextBook;
        requireLocalTextBook(book);
        if (`${book.id}_${book.revision}.json` !== file) continue;
        books.push(book);
      } catch {
        // Never surface a corrupt book as readable. It remains on disk for manual inspection.
      }
    }
    return books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async list(): Promise<LocalTextBookSummary[]> {
    return (await this.listBooks()).map(summary);
  }
}
