/**
 * Kakuyomu graph traversal adapted from ayati/novel_downloader (MIT).
 * Upstream: 011a3c8d60fad25909839498b8e2694e62ca2cc8, kky_get_episode_urls.
 * Full notice: docs/licenses/upstream/novel-downloader-LICENSE.
 * Fetching, HTML projection and Ripola validation are implemented locally.
 *
 * The adapter is deliberately local-only. It accepts a public work URL and the
 * episode pages that belong to it; it never follows redirects or other hosts.
 */
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';
import { importText } from '../reader/text-import';
import type { DraftDocument } from '../reader/model';
import { kakuyomuWorkUrlInput, type NovelIndex, type NovelPart } from './contracts';

export type { NovelEpisode, NovelIndex, NovelPart } from './contracts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type RecordValue = Record<string, unknown>;

export interface RubyExpectation { start: number; end: number; reading: string }
export interface ExtractedParagraph {
  text: string;
  markdown: string;
  source: [number, number];
  /** Derived independently from the source HTML ruby tree. */
  ruby: RubyExpectation[];
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('作品の目次データを解釈できません。');
  return value as RecordValue;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('作品の必須項目がありません。');
  return value;
}
function headingTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('目次見出しが空です。');
  if (!value.trim()) throw new Error('目次見出しが空です。');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('作品の話数が正しくありません。');
  return Number(value);
}
function children(node: Node): Node[] { return 'childNodes' in node ? node.childNodes : []; }
function elements(node: Node, match: (node: Element) => boolean): Element[] {
  return [...('tagName' in node && match(node) ? [node] : []), ...children(node).flatMap(child => elements(child, match))];
}
function text(node: Node, readings = false): string {
  if ('value' in node) return node.value;
  if ('tagName' in node && !readings && ['rt', 'rp'].includes(node.tagName)) return '';
  if ('tagName' in node && node.tagName === 'br') return '\n';
  return children(node).map(child => text(child, readings)).join('');
}
function attr(node: Element, name: string): string | undefined {
  return node.attrs.find(attribute => attribute.name === name)?.value;
}

export function kakuyomuWorkUrl(input: string): string {
  // CLI/parser compatibility: a bare 19/20-digit work id is still accepted.
  if (/^\d{19,20}$/.test(input.trim())) return `https://kakuyomu.jp/works/${input.trim()}`;
  const url = kakuyomuWorkUrlInput(input);
  if (!url) throw new Error('カクヨムの作品トップURLを指定してください。');
  return url;
}

/** Episode URLs are constructed from a verified index; arbitrary episode paths never pass. */
export function kakuyomuEpisodeUrl(workUrl: string, episodeId: string): string {
  const work = kakuyomuWorkUrl(workUrl);
  if (!/^\d{19,20}$/.test(episodeId)) throw new Error('話IDが正しくありません。');
  return `${work}/episodes/${episodeId}`;
}

export interface SourceAccess {
  workId: string;
  workUrl: string;
  allowedEpisodeUrl: (episodeId: string) => string;
}
export function assertAllowedKakuyomuUrl(value: string, access: SourceAccess): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('取得先URLが正しくありません。'); }
  if (url.protocol !== 'https:' || url.host !== 'kakuyomu.jp' || url.username || url.password || url.search || url.hash) {
    throw new Error('取得先はカクヨムの公開HTTPS URLに限定されています。');
  }
  if (url.pathname === `/works/${access.workId}`) return access.workUrl;
  const match = /^\/works\/(\d{19,20})\/episodes\/(\d{19,20})$/.exec(url.pathname);
  if (!match || match[1] !== access.workId) throw new Error('この作品に属さないページは取得しません。');
  const expected = access.allowedEpisodeUrl(match[2]);
  if (new URL(expected).href !== url.href) throw new Error('取得先URLが目次の話と一致しません。');
  return expected;
}

function canonicalLink(html: string, expectedBase: string): string {
  const ast = parse(html);
  const heads = elements(ast, node => node.tagName === 'head');
  if (heads.length !== 1) throw new Error('ページのheadを確認できません。');
  const links = elements(heads[0], node => node.tagName === 'link' && (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  if (links.length !== 1) throw new Error('canonicalが1つに定まりません。');
  const href = attr(links[0], 'href');
  if (!href) throw new Error('canonicalのURLがありません。');
  let url: URL;
  try { url = new URL(href, expectedBase); } catch { throw new Error('canonicalのURLが正しくありません。'); }
  if (url.protocol !== 'https:' || url.host !== 'kakuyomu.jp' || url.username || url.password || url.search || url.hash) {
    throw new Error('canonicalがカクヨムの公開URLではありません。');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export function requireWorkCanonical(html: string, workUrl: string): string {
  const canonical = canonicalLink(html, workUrl);
  if (canonical !== kakuyomuWorkUrl(workUrl)) throw new Error('作品ページのcanonicalがURLと一致しません。');
  return canonical;
}
export function requireEpisodeCanonical(html: string, episodeUrl: string): string {
  const canonical = canonicalLink(html, episodeUrl);
  if (canonical !== episodeUrl) throw new Error('話ページのcanonicalが出典URLと一致しません。');
  return canonical;
}

function resolve(state: RecordValue, ref: unknown): RecordValue {
  const value = object(ref);
  const key = requiredString(value.__ref);
  return object(state[key]);
}

/**
 * Resolve the Apollo table-of-contents graph. Levels outside chapter=1/section=2
 * are rejected instead of silently flattening the hierarchy.
 */
export function parseNovelIndex(html: string, workUrl: string): NovelIndex {
  const url = kakuyomuWorkUrl(workUrl), id = url.split('/').at(-1)!;
  const scripts = elements(parse(html), node => node.tagName === 'script' && node.attrs.some(attribute => attribute.name === 'id' && attribute.value === '__NEXT_DATA__'));
  if (scripts.length !== 1) throw new Error('公開目次のデータがありません。認証・アクセス制限は回避しません。');
  let data: RecordValue;
  try { data = object(JSON.parse(text(scripts[0], true))); } catch { throw new Error('公開目次のデータを解釈できません。'); }
  const state = object(object(object(data.props).pageProps).__APOLLO_STATE__);
  const work = object(state[`Work:${id}`]);
  if (work.kakuyomuNextWork) throw new Error('この取り込みは公開作品だけが対象です。');
  const title = requiredString(work.title), author = resolve(state, work.author);
  const refs = work.tableOfContentsV2 ?? work.tableOfContents;
  if (!Array.isArray(refs) || !refs.length) throw new Error('対応していない目次形式です。');
  const publicEpisodeCount = integer(work.publicEpisodeCount);
  const parts: NovelPart[] = [], ids = new Set<string>();
  let chapter = '', section: string | undefined, order = 0, current: NovelPart | undefined;
  for (const ref of refs) {
    const toc = resolve(state, ref);
    const heading = toc.chapter === undefined || toc.chapter === null ? undefined : resolve(state, toc.chapter);
    const level = heading?.level;
    if (heading) {
      // An explicit heading always starts a new boundary, even when it has no
      // episodes of its own or repeats the previous title.
      current = undefined;
      if (level === 1) {
        chapter = headingTitle(heading.title);
        section = undefined;
      } else if (level === 2) {
        if (!chapter) throw new Error('章のない節が目次にあります。');
        section = headingTitle(heading.title);
      } else {
        throw new Error('対応していない目次の階層です。');
      }
    }
    if (!Array.isArray(toc.episodeUnions)) throw new Error('話一覧がありません。');
    if (!toc.episodeUnions.length) continue;
    // Consecutive headingless records are continuations of one chapter/section.
    if (!current) {
      current = {
        order: parts.length + 1, chapter, ...(section ? { section } : {}),
        title: [chapter, section].filter(Boolean).join(' ') || '本編', episodes: [],
      };
      parts.push(current);
    }
    for (const episodeRef of toc.episodeUnions) {
      const episode = resolve(state, episodeRef), episodeId = requiredString(episode.id);
      if (episode.__typename !== 'Episode' || !/^\d{19,20}$/.test(episodeId) || ids.has(episodeId)) throw new Error('非公開・重複・未知の話が含まれています。');
      ids.add(episodeId);
      current.episodes.push({ id: episodeId, title: requiredString(episode.title), order: ++order, url: kakuyomuEpisodeUrl(url, episodeId) });
    }
  }
  if (!parts.length || order !== publicEpisodeCount) throw new Error('公開話数と取得した目次の話数が一致しません。');
  return { id, title, author: requiredString(author.activityName ?? author.name), url, parts };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[&<>\\`*_{}[\]()#+\-.!|:]/g, char => `&#${char.codePointAt(0)};`)
    .replace(/^ +/, spaces => '&#32;'.repeat(spaces.length));
}
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function plainContent(node: Node, label: string): string {
  if ('value' in node) return node.value;
  if (!('tagName' in node)) return children(node).map(child => plainContent(child, label)).join('');
  throw new Error(`${label}に未対応の要素があります: ${node.tagName}`);
}
function plainOnly(node: Element, label: string): string {
  return children(node).map(child => plainContent(child, label)).join('');
}

interface InlineBuilder { text: string; markdown: string; ruby: RubyExpectation[] }

/**
 * Parse one source ruby element into a safe, minimal Markdown form while
 * recording the independent base range and reading. Anything whose scope
 * cannot be represented exactly stops the import.
 */
function renderRuby(node: Element, builder: InlineBuilder): void {
  let stage: 'base' | 'before-reading' | 'after-reading' = 'base';
  let base = '', reading = '';
  let rtCount = 0, rbCount = 0, rpBefore = false, rpAfter = false;
  for (const child of children(node)) {
    if ('value' in child) {
      if (stage === 'base') base += child.value;
      else if (stage === 'before-reading') {
        // rp contents live inside the rp element. Sibling text here is visible
        // ruby content we cannot place, so fail instead of silently dropping it.
        throw new Error('ルビの親文字と読みの間に未対応の文字があります。');
      }
      else throw new Error('ルビの読みの後に文字が続いています。');
      continue;
    }
    if (!('tagName' in child)) throw new Error('ルビに未対応のノードがあります。');
    if (child.tagName === 'rb') {
      if (stage !== 'base' || rbCount > 0) throw new Error('複合ルビの親文字は1つに限定しています。');
      rbCount++;
      base += plainOnly(child, 'ルビの親文字');
      continue;
    }
    if (child.tagName === 'rp') {
      if (rtCount === 0) {
        if (stage !== 'base' && stage !== 'before-reading') throw new Error('ルビの括弧の位置が正しくありません。');
        if (rpBefore) throw new Error('ルビの括弧が重複しています。');
        rpBefore = true; stage = 'before-reading';
      } else {
        if (stage !== 'after-reading') throw new Error('ルビの括弧の位置が正しくありません。');
        if (rpAfter) throw new Error('ルビの括弧が重複しています。');
        rpAfter = true;
      }
      plainOnly(child, 'ルビの括弧');
      continue;
    }
    if (child.tagName === 'rt') {
      if (rtCount > 0) throw new Error('複数の読みを持つルビは個別確認が必要です。');
      rtCount++;
      reading = plainOnly(child, 'ルビの読み');
      stage = 'after-reading';
      continue;
    }
    if (child.tagName === 'ruby') throw new Error('入れ子のルビには対応していません。');
    throw new Error(`ルビ内に未対応の要素があります: ${child.tagName}`);
  }
  if (rtCount !== 1) throw new Error('読みのないルビには対応していません。');
  if (!base.trim()) throw new Error('ルビの親文字が空です。');
  if (!reading.trim()) throw new Error('ルビの読みが空です。');
  if (reading !== reading.trim()) throw new Error('ルビの読みの前後に空白があり、原文のまま保持できません。');
  const start = builder.text.length;
  builder.text += base;
  builder.markdown += `<ruby>${escapeMarkdown(base)}<rt>${xml(reading)}</rt></ruby>`;
  builder.ruby.push({ start, end: builder.text.length, reading });
}

const INLINE = new Set(['span', 'em', 'strong', 'b', 'i', 'a']);
function renderInline(node: Node, builder: InlineBuilder): void {
  if ('value' in node) {
    builder.text += node.value;
    builder.markdown += escapeMarkdown(node.value);
    return;
  }
  if (!('tagName' in node)) {
    for (const child of children(node)) renderInline(child, builder);
    return;
  }
  if (node.tagName === 'br') {
    builder.text += '\n';
    builder.markdown += '  \n';
    return;
  }
  if (node.tagName === 'ruby') { renderRuby(node, builder); return; }
  if (INLINE.has(node.tagName)) {
    for (const child of children(node)) renderInline(child, builder);
    return;
  }
  throw new Error(`未対応の本文要素: ${node.tagName}`);
}

function renderParagraph(node: Element): { text: string; markdown: string; ruby: RubyExpectation[] } {
  const builder: InlineBuilder = { text: '', markdown: '', ruby: [] };
  for (const child of children(node)) renderInline(child, builder);
  // Independent source view: every visible character except rt/rp must survive.
  // This catches a dropped sibling space even if the Markdown parser would
  // otherwise agree with the renderer's own (possibly lossy) output.
  const visible = text(node);
  if (builder.text !== visible) throw new Error('ルビ・本文の可視文字が原本と一致しません。');
  return builder;
}

/**
 * Validate the whole episode body, not only descendant paragraphs. Text outside
 * a paragraph, wrappers and unknown elements are rejected before conversion.
 */
export function extractEpisode(html: string): ExtractedParagraph[] {
  const ast = parse(html, { sourceCodeLocationInfo: true });
  const bodies = elements(ast, node => node.tagName === 'div' && (attr(node, 'class') ?? '').split(/\s+/).includes('widget-episodeBody'));
  if (bodies.length !== 1) throw new Error('公開本文を確認できません。認証・アクセス制限は回避しません。');
  const paragraphs: ExtractedParagraph[] = [];
  for (const child of children(bodies[0])) {
    if ('value' in child) {
      if (child.value.trim()) throw new Error('段落外に未取得の本文があります。');
      continue;
    }
    if (!('tagName' in child)) continue; // comments never contribute visible text
    if (child.tagName !== 'p') throw new Error(`本文に未対応の要素があります: ${child.tagName}`);
    const rendered = renderParagraph(child);
    if (!rendered.text.trim()) continue;
    const location = child.sourceCodeLocation;
    if (!location) throw new Error('段落の原本位置を確認できません。');
    paragraphs.push({ ...rendered, source: [location.startOffset, location.endOffset] });
  }
  if (!paragraphs.length) throw new Error('本文が空です。');
  return paragraphs;
}

export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }

export function prepareNovelPart(index: NovelIndex, part: NovelPart, html: ReadonlyMap<string, string>): { draft: DraftDocument; mapping: unknown; ruby: number } {
  const title = `${index.title} ${String(part.order).padStart(2, '0')} ${part.title}`;
  let md = `---\ntitle: ${JSON.stringify(title)}\nauthor: ${JSON.stringify(index.author)}\nsource: ${JSON.stringify(index.url)}\n---\n\n# ${escapeMarkdown(title)}\n\n著者：${escapeMarkdown(index.author)}\n\n`;
  const expected = [title, `著者：${index.author}`], expectedRuby: RubyExpectation[][] = [[], []], mapping = [];
  let ruby = 0;
  for (const episode of part.episodes) {
    const raw = html.get(episode.id);
    if (raw === undefined) throw new Error(`未取得の話: ${episode.order}`);
    const paragraphs = extractEpisode(raw), ranges = [];
    md += `## [${escapeMarkdown(episode.title)}](${episode.url})\n\n`;
    expected.push(episode.title); expectedRuby.push([]);
    for (const paragraph of paragraphs) {
      const start = md.length;
      md += paragraph.markdown + '\n\n'; expected.push(paragraph.text); expectedRuby.push(paragraph.ruby); ruby += paragraph.ruby.length;
      ranges.push({ source: paragraph.source, output: [start, md.length], textSha256: hash(paragraph.text), ruby: paragraph.ruby });
    }
    let cursor = 0;
    const exclusions = [];
    for (const range of ranges) {
      if (range.source[0] < cursor) throw new Error('原本範囲が重複しています。');
      if (cursor < range.source[0]) exclusions.push([cursor, range.source[0]]);
      cursor = range.source[1];
    }
    if (cursor < raw.length) exclusions.push([cursor, raw.length]);
    mapping.push({ episode, sha256: hash(raw), bytes: new TextEncoder().encode(raw).byteLength, paragraphs: ranges, exclusions });
  }
  const draft = importText(md, 'md', title);
  if (draft.blocks.length !== expected.length || draft.blocks.some((block, i) => block.text !== expected[i])) throw new Error('変換後の本文が原本と一致しません。');
  if (draft.blocks.some((block, i) => JSON.stringify(block.ruby.map(span => ({ start: span.start, end: span.end, reading: span.reading }))) !== JSON.stringify(expectedRuby[i]))) {
    throw new Error('変換後のルビ範囲または読みが原本と一致しません。');
  }
  if (draft.blocks.reduce((sum, block) => sum + block.ruby.length, 0) !== ruby) throw new Error('ルビ数が一致しません。');
  if (draft.warnings.some(warning => warning !== 'frontmatter・リンク定義・脚注本文は再生本文から除外しています。')) throw new Error('未解決の取り込み警告があります。');
  draft.provenance = {
    title: index.title, author: index.author, sourceUrl: index.url, sourceSha256: hash(md),
    bibliography: `${index.title}／${index.author}／カクヨム`, notationNotes: '本文・ルビは原文のまま。見出しに各話の出典URLを保持。',
    counts: { ruby, gaiji: 0, notes: 0 }, annotations: [],
    chapters: draft.blocks.filter(block => block.kind === 'heading' && block.level === 2).map(block => ({ title: block.text, blockId: block.id })),
  };
  return {
    draft, ruby,
    mapping: {
      coordinateSystem: 'UTF-16; zero-based half-open offsets', episodes: mapping,
      changes: ['本文外のHTMLを除外', '空白段落をMarkdownの段落間隔へ変換', 'ルビを許可HTMLへ変換、その他の装飾を通常文字へ変換', '章・著者表記を追加、話見出しに出典URLを付与'],
      unresolved: [],
    },
  };
}
