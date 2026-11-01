import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { digest } from '../generation/core/disk';
import { decodeAozoraHtml, importAozora } from '../reader/aozora-import';
import { prepareDocument } from '../reader/segmentation';
import { LocalTextBookStore, MAX_TEXT_BOOK_BYTES, requireLocalTextBook } from '../kakuyomu/text-books';
import type { LocalTextBook } from '../kakuyomu/contracts';
import type { DraftDocument } from '../reader/model';
import type { UrlImportResult } from './contracts';
import { aozoraUrlInput, type AozoraUrl } from './urls';
import { SequentialHtmlFetcher } from './fetch-html.server';

type Node = DefaultTreeAdapterMap['node'];
function all(node: Node): Node[] { return [node, ...('childNodes' in node ? node.childNodes.flatMap(all) : [])]; }
function text(node: Node): string { return 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : ''; }

/** The body must be a download explicitly linked by this work's official card. */
export function aozoraHtmlLink(raw: string, source: AozoraUrl): string {
  const nodes = all(parse(raw));
  const headings = nodes.filter(node => 'tagName' in node && node.tagName === 'h1').map(text);
  if (!headings.some(heading => new RegExp(`図書カード[：:]\\s*No\\.\\s*${source.workId}(?:\\D|$)`).test(heading))) throw new Error('図書カードの作品番号を確認できませんでした。');
  const links = new Set<string>();
  for (const node of nodes) {
    if (!('tagName' in node) || node.tagName !== 'a') continue;
    const href = node.attrs.find(attr => attr.name === 'href')?.value;
    if (!href) continue;
    let target: URL;
    try { target = new URL(href, source.cardUrl); } catch { continue; }
    const parsed = aozoraUrlInput(target.href);
    if (parsed && parsed.authorId === source.authorId && parsed.workId === source.workId && parsed.url !== parsed.cardUrl) links.add(parsed.url);
  }
  if (source.url !== source.cardUrl) {
    if (!links.has(source.url)) throw new Error('この本文HTMLは図書カードの配布ファイルに含まれていません。');
    return source.url;
  }
  if (links.size !== 1) throw new Error('図書カードから本文HTMLを1つに特定できませんでした。本文HTMLのURLを入力してください。');
  return [...links][0];
}

/** Split at the outermost repeated heading level; every block and its raw source range survives. */
export function splitAozoraDraft(draft: DraftDocument): { draft: DraftDocument; chapter?: string }[] {
  const headings = draft.blocks.filter(block => block.kind === 'heading');
  const level = Math.min(...headings.map(block => block.level ?? 1));
  const starts = draft.blocks.flatMap((block, index) => block.kind === 'heading' && (block.level ?? 1) === level ? [index] : []);
  if (starts.length < 2) return [{ draft }];
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, index) => {
    const blocks = draft.blocks.slice(start, starts[index + 1] ?? draft.blocks.length);
    const ids = new Set(blocks.map(block => block.id));
    const chapter = blocks[0].kind === 'heading' ? blocks[0].text : 'はじめに';
    const annotations = draft.provenance?.annotations.filter(note => !note.blockId || ids.has(note.blockId)) ?? [];
    return { chapter, draft: { ...draft, title: `${draft.title} ${String(index + 1).padStart(2, '0')} ${chapter}`, blocks,
      provenance: draft.provenance ? { ...draft.provenance, annotations,
        chapters: draft.provenance.chapters.filter(item => ids.has(item.blockId)),
        counts: { ruby: blocks.reduce((sum, block) => sum + block.ruby.length, 0),
          gaiji: annotations.filter(note => note.kind === 'gaiji').length, notes: annotations.filter(note => note.kind === 'note').length },
      } : undefined,
    } };
  });
}

export class AozoraImporter {
  private readonly transport: SequentialHtmlFetcher;
  private readonly pending = new Map<string, Promise<UrlImportResult>>();
  constructor(private readonly libraryDir: string, options: ConstructorParameters<typeof SequentialHtmlFetcher>[1] = {}) {
    this.transport = new SequentialHtmlFetcher(url => aozoraUrlInput(url)?.url === url, options);
  }
  import(input: string): Promise<UrlImportResult> {
    const source = aozoraUrlInput(input);
    if (!source) return Promise.reject(new Error('青空文庫の図書カード・本文HTMLのURLを入力してください。'));
    const previous = this.pending.get(source.url);
    if (previous) return previous;
    const run = this.importOnce(source).finally(() => this.pending.delete(source.url));
    this.pending.set(source.url, run);
    return run;
  }
  private async importOnce(source: AozoraUrl): Promise<UrlImportResult> {
    const card = await this.transport.fetch(source.cardUrl);
    const htmlUrl = aozoraHtmlLink(decodeAozoraHtml(card.bytes.slice().buffer), source);
    const page = await this.transport.fetch(htmlUrl);
    const htmlSha256 = digest(page.bytes);
    const draft = importAozora(decodeAozoraHtml(page.bytes.slice().buffer), '青空文庫の文章', {
      sourceUrl: htmlUrl, cardUrl: source.cardUrl, sourceSha256: htmlSha256,
    });
    const parts = splitAozoraDraft(draft), books: LocalTextBook[] = [];
    for (const [index, part] of parts.entries()) {
      const document = await prepareDocument(part.draft);
      const book: LocalTextBook = {
        schemaVersion: 1, kind: 'text', id: `text-aozora-${source.authorId}-${source.workId}${parts.length > 1 ? `-${String(index + 1).padStart(2, '0')}` : ''}`,
        revision: document.contentHash, title: document.title, updatedAt: page.fetchedAt, document,
        chunks: [], completedChunks: 0, totalChunks: 0, durationSeconds: 0, precision: 'sentence',
        attribution: `${draft.provenance?.author}『${draft.title}』／青空文庫 ${source.cardUrl}。本文・ルビ・見出しを抽出。書誌情報は文書内に保持。利用条件：https://www.aozora.gr.jp/guide/kijyunn.html`,
        warnings: [...document.warnings],
        source: {
          kind: 'aozora', workId: source.workId, workUrl: source.cardUrl, partOrder: index + 1, ...(part.chapter ? { chapter: part.chapter } : {}),
          htmlUrl, htmlSha256, cardSha256: digest(card.bytes), bytes: page.bytes.byteLength, fetchedAt: page.fetchedAt,
        },
      };
      requireLocalTextBook(book);
      if (new TextEncoder().encode(JSON.stringify(book) + '\n').byteLength > MAX_TEXT_BOOK_BYTES) throw new Error('この作品・章は1冊の保存上限（25 MiB）を超えています。ファイルを章・節に分けて取り込んでください。');
      books.push(book);
    }
    const store = new LocalTextBookStore(this.libraryDir), result: UrlImportResult = { books: [] };
    for (const book of books) {
      const saved = (await store.save(book)).book;
      result.books.push({ id: saved.id, revision: saved.revision, title: saved.title, totalCharacters: saved.document.totalCharacters });
    }
    return result;
  }
}
