import { digest } from '../generation/core/disk';
import { importArticle } from '../reader/article-import';
import { prepareDocument } from '../reader/segmentation';
import { LocalTextBookStore, MAX_TEXT_BOOK_BYTES, requireLocalTextBook } from '../kakuyomu/text-books';
import type { LocalTextBook } from '../kakuyomu/contracts';
import type { UrlImportResult } from './contracts';
import { noteUrlInput, type NoteUrl } from './urls';
import { SequentialPageFetcher } from './fetch-html.server';

interface NoteArticle { title: string; author: string; body: string; publishedAt?: string }
type Options = NonNullable<ConstructorParameters<typeof SequentialPageFetcher>[1]> & { save?: (book: LocalTextBook) => Promise<LocalTextBook> };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('noteの記事データを確認できませんでした。');
  return value as Record<string, unknown>;
}

/** Validate access before looking at body HTML. A paid preview never becomes a full text book. */
export function parseFreeNote(value: unknown, source: NoteUrl): NoteArticle {
  const data = record(record(value).data);
  if (data.status !== 'published' || data.is_published !== true || data.is_draft !== false || data.price !== 0
    || data.can_read !== true || data.is_limited !== false || data.separator !== null || data.is_published_preview_note === true
    || data.is_r18 === true || data.is_r18_confirmation_needed === true || data.is_temporary_frozen === true
    || ['remained_char_num', 'remained_figure_num', 'remained_image_num', 'remained_file_num', 'remained_sound_num'].some(key => data[key] !== 0)) {
    throw new Error('noteは無料で全文公開されている記事に対応しています。有料・会員限定・プレビュー・閲覧制限のある記事は取り込めません。');
  }
  const paywall = data.paywall ? record(data.paywall) : undefined;
  if (paywall && record(paywall.context).is_show_limited_pay_note_paywall === true) throw new Error('この記事には閲覧制限があります。');
  if (data.type !== 'TextNote') throw new Error('noteのテキスト記事のURLを入力してください。');
  const user = record(data.user);
  if (data.key !== source.key || typeof data.note_url !== 'string' || noteUrlInput(data.note_url)?.url !== source.url || user.urlname !== source.author) {
    throw new Error('noteの記事URLと取得した記事が一致しません。');
  }
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 500
    || typeof user.nickname !== 'string' || !user.nickname.trim() || user.nickname.length > 500
    || typeof data.body !== 'string' || !data.body.trim()) throw new Error('noteの記事タイトル・著者・本文を確認できませんでした。');
  return { title: data.name, author: user.nickname, body: data.body,
    ...(typeof data.publish_at === 'string' && Number.isFinite(Date.parse(data.publish_at)) ? { publishedAt: data.publish_at } : {}),
  };
}
function escape(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

/** Keep article metadata in the inert HTML source so title/author changes also create a new revision. */
export function noteArticleHtml(article: NoteArticle, url: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(article.title)}</title><meta name="author" content="${escape(article.author)}"><link rel="canonical" href="${escape(url)}">${article.publishedAt ? `<meta name="date" content="${escape(article.publishedAt)}">` : ''}</head><body>${article.body}</body></html>`;
}

export class NoteImporter {
  private readonly transport: SequentialPageFetcher;
  private readonly pending = new Map<string, Promise<UrlImportResult>>();
  constructor(private readonly libraryDir: string, private readonly options: Options = {}) {
    this.transport = new SequentialPageFetcher(url => /^https:\/\/note\.com\/api\/v3\/notes\/n[a-f0-9]{12}$/.test(url), { ...options, responseType: 'json' });
  }
  import(input: string): Promise<UrlImportResult> {
    const source = noteUrlInput(input);
    if (!source) return Promise.reject(new Error('noteの記事URLを入力してください。'));
    const previous = this.pending.get(source.url);
    if (previous) return previous;
    const run = this.importOnce(source).finally(() => this.pending.delete(source.url));
    this.pending.set(source.url, run); return run;
  }
  private async importOnce(source: NoteUrl): Promise<UrlImportResult> {
    const page = await this.transport.fetch(`https://note.com/api/v3/notes/${source.key}`);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(page.bytes)); }
    catch { throw new Error('noteの記事データの形式を確認できませんでした。'); }
    const article = parseFreeNote(value, source), html = noteArticleHtml(article, source.url), htmlSha256 = digest(html);
    const draft = importArticle(html, { title: article.title, author: article.author, sourceUrl: source.url, sourceSha256: htmlSha256, publishedAt: article.publishedAt });
    const document = await prepareDocument(draft);
    const book: LocalTextBook = {
      schemaVersion: 1, kind: 'text', id: `text-note-${source.key}`, revision: document.contentHash, title: document.title, updatedAt: page.fetchedAt, document,
      chunks: [], completedChunks: 0, totalChunks: 0, durationSeconds: 0, precision: 'sentence',
      attribution: `${article.author}『${article.title}』／note ${source.url}。無料公開記事を個人で読むためのコピー。本文の権利は著者に帰属します。`,
      warnings: [...document.warnings],
      source: { kind: 'note', workId: source.key, workUrl: source.url, partOrder: 1, access: 'free-public',
        htmlSha256, bodySha256: digest(article.body), responseSha256: digest(page.bytes), bytes: page.bytes.byteLength, fetchedAt: page.fetchedAt },
    };
    requireLocalTextBook(book);
    if (new TextEncoder().encode(JSON.stringify(book) + '\n').byteLength > MAX_TEXT_BOOK_BYTES) throw new Error('この記事は保存上限（25 MiB）を超えています。');
    const saved = this.options.save ? await this.options.save(book) : (await new LocalTextBookStore(this.libraryDir).save(book)).book;
    return { books: [{ id: saved.id, revision: saved.revision, title: saved.title, totalCharacters: saved.document.totalCharacters }] };
  }
}
