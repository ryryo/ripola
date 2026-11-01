import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { InlineBuilder, validateText } from './text-import';
import type { DraftDocument, TextBlock } from './model';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const unsafe = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math']);
const media = new Set(['iframe', 'object', 'embed', 'audio', 'video']);
const inline = new Set(['a', 'span', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'code', 'cite', 'q', 'abbr', 'time', 'wbr', 'rb']);
function children(node: Node): Node[] { return 'childNodes' in node ? node.childNodes : []; }
function isElement(node: Node): node is Element { return 'tagName' in node; }
function attr(node: Element, name: string): string | undefined { return node.attrs.find(value => value.name === name)?.value; }
function nodes(node: Node): Node[] { return [node, ...children(node).flatMap(nodes)]; }
function text(node: Node): string {
  if ('value' in node) return node.value;
  if (isElement(node) && (unsafe.has(node.tagName) || media.has(node.tagName) || node.tagName === 'rp')) return '';
  return children(node).map(text).join('');
}
function range(node: Node): { start: number; end: number } {
  return { start: node.sourceCodeLocation?.startOffset ?? 0, end: node.sourceCodeLocation?.endOffset ?? 0 };
}
function trim(builder: InlineBuilder): InlineBuilder {
  const start = builder.text.length - builder.text.trimStart().length, end = builder.text.trimEnd().length;
  const result = new InlineBuilder(); result.text = builder.text.slice(start, end);
  result.runs = builder.runs.filter(run => run.end > start && run.start < end).map(run => {
    const begin = Math.max(start, run.start), finish = Math.min(end, run.end);
    return { ...run, start: begin - start, end: finish - start, sources: run.sources.map(source => run.mapping === 'exact' && source.kind === 'text'
      ? { ...source, start: source.start + begin - run.start, end: source.start + finish - run.start } : source) };
  });
  result.ruby = builder.ruby.filter(ruby => ruby.start >= start && ruby.end <= end).map(ruby => ({ ...ruby, start: ruby.start - start, end: ruby.end - start }));
  return result;
}

export interface ArticleMetadata { title: string; author: string; sourceUrl: string; sourceSha256: string; publishedAt?: string }

/** Converts an already selected article body to inert reader blocks. It does not fetch links or select articles from arbitrary pages. */
export function importArticle(raw: string, metadata: ArticleMetadata): DraftDocument {
  validateText(raw);
  const body = nodes(parse(raw, { sourceCodeLocationInfo: true })).find(node => isElement(node) && node.tagName === 'body');
  if (!body) throw new Error('記事の本文を確認できませんでした。');
  const blocks: TextBlock[] = [];
  let builder = new InlineBuilder(), kind: TextBlock['kind'] = 'paragraph', level: number | undefined;
  let images = 0, embeds = 0, tables = 0;
  const flush = () => {
    const value = kind === 'code' ? builder : trim(builder);
    if (value.text.trim()) blocks.push({ id: `article-${value.runs[0]?.sources[0]?.start ?? 0}-${blocks.length}`, kind, text: value.text, runs: value.runs, ruby: value.ruby, ...(level ? { level } : {}) });
    builder = new InlineBuilder();
  };
  const inBlock = (node: Node, next: TextBlock['kind'], nextLevel?: number, pre = false) => {
    flush(); const previous = kind, previousLevel = level;
    kind = next; level = nextLevel;
    for (const child of children(node)) visit(child, next, pre);
    flush(); kind = previous; level = previousLevel;
  };
  const visit = (node: Node, context: TextBlock['kind'] = 'paragraph', pre = false) => {
    if ('value' in node) {
      const source = range(node), value = raw.slice(source.start, source.end);
      if (pre) builder.decoded(value, source.start, false);
      else for (const match of value.matchAll(/[^\t\r\n\f ]+|[\t\r\n\f ]+/g)) {
        const offset = source.start + match.index;
        if (/^[\t\r\n\f ]+$/.test(match[0])) {
          if (!builder.text.endsWith(' ')) builder.append(' ', offset, offset + match[0].length, match[0] === ' ' ? 'exact' : 'transformed');
        } else builder.decoded(match[0], offset, false);
      }
      return;
    }
    if (!isElement(node) || unsafe.has(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node, 'style') ?? '')) return;
    const tag = node.tagName, source = range(node);
    if (tag === 'img' || tag === 'picture') { images++; return; }
    if (media.has(tag)) { embeds++; return; }
    if (tag === 'hr') { flush(); return; }
    if (tag === 'br') { builder.append('\n', source.start, source.end, 'transformed'); return; }
    if (tag === 'ruby') {
      const parts = children(node), readings = parts.filter(child => isElement(child) && child.tagName === 'rt');
      if (readings.length !== 1 || nodes(node).slice(1).some(child => isElement(child) && child.tagName === 'ruby')) throw new Error('この記事のルビ構造には対応していません。');
      const reading = text(readings[0]).trim(), start = builder.text.length;
      let afterReading = false;
      for (const child of parts) {
        if (isElement(child) && child.tagName === 'rt') { afterReading = true; continue; }
        if (isElement(child) && child.tagName === 'rp') continue;
        if (afterReading && text(child).trim()) throw new Error('この記事のルビ構造には対応していません。');
        if (!afterReading) visit(child, context, pre);
      }
      if (!reading || builder.text.length === start) throw new Error('記事に読みまたは親文字のないルビがあります。');
      builder.ruby.push({ start, end: builder.text.length, reading, source, annotationKind: /^(?:ママ|まま|sic)$/i.test(reading) ? 'editorial' : /^[\p{Script=Hiragana}\p{Script=Katakana}ーゝゞヽヾ\s・]+$/u.test(reading) ? 'reading' : 'unknown' });
      return;
    }
    if (/^h[1-6]$/.test(tag)) { inBlock(node, 'heading', Number(tag[1])); return; }
    if (tag === 'blockquote') { inBlock(node, 'quote'); return; }
    if (tag === 'li') { inBlock(node, 'listItem'); return; }
    if (tag === 'pre') { inBlock(node, 'code', undefined, true); return; }
    if (tag === 'table') { tables++; inBlock(node, 'table'); return; }
    if (tag === 'tr') { inBlock(node, 'table'); return; }
    if (tag === 'td' || tag === 'th') {
      for (const child of children(node)) visit(child, 'table', pre);
      builder.append('\t', Math.max(source.start, source.end - 1), source.end, 'transformed'); return;
    }
    if (['p', 'div', 'section', 'article', 'figure', 'figcaption', 'ul', 'ol', 'thead', 'tbody', 'tfoot'].includes(tag)) {
      if (tag === 'figure' && attr(node, 'embedded-service')) embeds++;
      inBlock(node, context); return;
    }
    if (!inline.has(tag)) throw new Error(`この記事には未対応の本文要素があります（${tag}）。`);
    for (const child of children(node)) visit(child, context, pre);
  };
  for (const node of children(body)) visit(node); flush();
  if (!blocks.some(block => !['code', 'table'].includes(block.kind) && block.text.trim())) throw new Error('この記事には読むテキスト本文がありません。');
  const warnings: string[] = [];
  if (images || embeds) warnings.push(`画像${images}件・埋め込み${embeds}件は取得せず、文字の本文とキャプションを取り込みました。図や動画は掲載元で確認できます。`);
  if (tables) warnings.push('表はテキストの静止表示として保持しています。');
  return { title: metadata.title, format: 'html', rawText: raw, blocks, warnings, provenance: {
    title: metadata.title, author: metadata.author, sourceUrl: metadata.sourceUrl, sourceSha256: metadata.sourceSha256,
    bibliography: `${metadata.author}『${metadata.title}』\n${metadata.sourceUrl}${metadata.publishedAt ? `\n公開日：${metadata.publishedAt}` : ''}`,
    notationNotes: '本文の段落・見出し・引用・箇条書き・ルビを保持しています。本文の利用条件は著者・掲載元に従います。', annotations: [],
    chapters: blocks.filter(block => block.kind === 'heading').map(block => ({ title: block.text, blockId: block.id })),
    counts: { ruby: blocks.reduce((sum, block) => sum + block.ruby.length, 0), gaiji: 0, notes: 0 },
  } };
}
