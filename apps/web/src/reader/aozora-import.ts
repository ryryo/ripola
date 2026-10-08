import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { AozoraAnnotation, AozoraProvenance, DraftDocument, RubySpan, TextBlock } from './model';
import { InlineBuilder, validateText } from './text-import';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const unsafe = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template']);
function element(node: Node): node is Element { return 'tagName' in node; }
function children(node: Node): Node[] { return 'childNodes' in node ? node.childNodes : []; }
function attribute(node: Element, name: string): string { return node.attrs.find(attr => attr.name === name)?.value ?? ''; }
function hasClass(node: Node, name: string): boolean { return element(node) && attribute(node, 'class').split(/\s+/).includes(name); }
function all(node: Node, match: (node: Node) => boolean): Node[] {
  const result: Node[] = []; const visit = (value: Node) => { if (match(value)) result.push(value); for (const child of children(value)) visit(child); }; visit(node); return result;
}
function textOf(node: Node): string {
  if ('value' in node) return node.value;
  if (element(node) && unsafe.has(node.tagName)) return '';
  if (element(node) && ['br', 'li'].includes(node.tagName)) return '\n' + children(node).map(textOf).join('');
  return children(node).map(textOf).join('');
}
function bounds(node: Node): { start: number; end: number } {
  return { start: node.sourceCodeLocation?.startOffset ?? 0, end: node.sourceCodeLocation?.endOffset ?? 0 };
}
function readingKind(reading: string): RubySpan['annotationKind'] {
  if (/^(?:ママ|まま|sic)$/i.test(reading.trim())) return 'editorial';
  return /^[\p{Script=Hiragana}\p{Script=Katakana}ーゝゞヽヾ\s・]+$/u.test(reading) ? 'reading' : 'unknown';
}
function trimmed(builder: InlineBuilder): InlineBuilder {
  const start = builder.text.length - builder.text.trimStart().length; const end = builder.text.trimEnd().length;
  const result = new InlineBuilder(); result.text = builder.text.slice(start, end);
  result.runs = builder.runs.filter(run => run.end > start && run.start < end).map(run => {
    const begin = Math.max(start, run.start); const finish = Math.min(end, run.end);
    return { ...run, start: begin - start, end: finish - start, sources: run.sources.map(source => run.mapping === 'exact' && source.kind === 'text'
      ? { ...source, start: source.start + begin - run.start, end: source.start + finish - run.start } : source) };
  });
  result.ruby = builder.ruby.filter(span => span.start >= start && span.end <= end).map(span => ({ ...span, start: span.start - start, end: span.end - start }));
  return result;
}

/** HTML is parsed as data only: no DOM insertion, DTD resolution, script or image requests. */
export function importAozora(raw: string, fallbackTitle = '青空文庫の文章', attribution: Partial<Pick<AozoraProvenance, 'sourceUrl' | 'cardUrl' | 'sourceSha256'>> = {}): DraftDocument {
  validateText(raw);
  const tree = parse(raw, { sourceCodeLocationInfo: true });
  const main = all(tree, node => hasClass(node, 'main_text'));
  if (main.length !== 1) throw new Error('青空文庫HTMLの main_text を1つだけ含むファイルを選んでください。');
  const root = main[0]; const blocks: TextBlock[] = []; const annotations: AozoraAnnotation[] = [];
  const provenance: AozoraProvenance = {
    title: all(tree, node => hasClass(node, 'title')).map(textOf).join(' ').trim().slice(0, 500) || fallbackTitle,
    author: all(tree, node => hasClass(node, 'author')).map(textOf).join(' ').trim(),
    bibliography: all(tree, node => hasClass(node, 'bibliographical_information')).map(textOf).join('\n').trim(),
    notationNotes: all(tree, node => hasClass(node, 'notation_notes')).map(textOf).join('\n').trim(),
    annotations, chapters: [],
    ...(attribution.sourceUrl ? { sourceUrl: attribution.sourceUrl } : {}),
    ...(attribution.cardUrl ? { cardUrl: attribution.cardUrl } : {}),
    ...(attribution.sourceSha256 ? { sourceSha256: attribution.sourceSha256 } : {}),
    counts: { ruby: all(root, node => element(node) && node.tagName === 'ruby').length,
      gaiji: all(root, node => element(node) && node.tagName === 'img' && hasClass(node, 'gaiji')).length,
      notes: all(root, node => hasClass(node, 'notes')).length },
  };
  let builder = new InlineBuilder(); let pending: AozoraAnnotation[] = [];
  const flush = (kind: TextBlock['kind'] = 'paragraph', level?: number) => {
    const value = trimmed(builder); const leading = builder.text.length - builder.text.trimStart().length;
    if (value.text) {
      const block: TextBlock = { id: `aozora-${value.runs[0]?.sources[0]?.start ?? 0}-${blocks.length}`, kind, text: value.text, runs: value.runs, ruby: value.ruby, ...(level ? { level } : {}) };
      blocks.push(block); pending.forEach(note => { note.blockId = block.id; note.offset = Math.max(0, (note.offset ?? 0) - leading); });
    }
    builder = new InlineBuilder(); pending = [];
  };
  const gaiji = (node: Element, inNote: boolean) => {
    const note: AozoraAnnotation = { kind: 'gaiji', text: attribute(node, 'alt') || '外字', source: bounds(node), imageSource: attribute(node, 'src'), offset: builder.text.length };
    annotations.push(note); pending.push(note);
    // The descriptive alt is not a pronunciation. An enclosing reading ruby may supply one.
    if (!inNote) builder.append('〓', note.source.start, note.source.end, 'transformed');
  };
  const visit = (node: Node) => {
    if ('value' in node) {
      const source = bounds(node); const slice = raw.slice(source.start, source.end);
      // Source HTML formatting newlines do not introduce spoken characters.
      for (const part of slice.matchAll(/[^\r\n]+/g)) builder.decoded(part[0], source.start + part.index, false);
      return;
    }
    if (!element(node) || unsafe.has(node.tagName)) return;
    if (node.tagName === 'br') { flush(); return; }
    if (hasClass(node, 'notes')) {
      const note: AozoraAnnotation = { kind: 'note', text: textOf(node), source: bounds(node), offset: builder.text.length };
      annotations.push(note); pending.push(note);
      all(node, child => element(child) && child.tagName === 'img' && hasClass(child, 'gaiji')).forEach(child => gaiji(child as Element, true));
      return;
    }
    if (node.tagName === 'img') { if (hasClass(node, 'gaiji')) gaiji(node, false); return; }
    if (node.tagName === 'ruby') {
      const start = builder.text.length;
      for (const child of children(node)) if (!element(child) || !['rt', 'rp'].includes(child.tagName)) visit(child);
      const reading = children(node).filter(child => element(child) && child.tagName === 'rt').map(textOf).join('').trim();
      if (builder.text.length > start && reading) builder.ruby.push({ start, end: builder.text.length, reading, annotationKind: readingKind(reading), source: bounds(node) });
      return;
    }
    if (/^h[1-6]$/.test(node.tagName)) {
      flush(); for (const child of children(node)) visit(child); flush('heading', Number(node.tagName[1]));
      const block = blocks.at(-1); const anchor = all(node, child => hasClass(child, 'midashi_anchor'))[0];
      if (block?.kind === 'heading') provenance.chapters.push({ title: block.text, blockId: block.id, ...(anchor && element(anchor) ? { anchor: attribute(anchor, 'id') } : {}) });
      return;
    }
    for (const child of children(node)) visit(child);
  };
  for (const node of children(root)) visit(node); flush();
  if (!blocks.length) throw new Error('青空文庫HTMLに読む本文がありません。');
  const unknownRuby = blocks.flatMap(block => block.ruby).filter(span => span.annotationKind !== 'reading').length;
  const warnings = ['青空文庫の本文・見出しを読み込みました。書誌・入力者注・表記の注意は別に保持しています。'];
  if (provenance.counts.gaiji) warnings.push(`外字画像${provenance.counts.gaiji}件を記録し、本文の外字は〓で表示します。画像や説明文を読みとして代用しません。`);
  if (unknownRuby) warnings.push(`読みと確定できないルビ${unknownRuby}件は表示のみとし、読み上げでは親文字を使います。`);
  return { title: provenance.title || fallbackTitle, format: 'aozora', rawText: raw, blocks, warnings, provenance };
}

export function decodeAozoraHtml(bytes: ArrayBuffer): string {
  const prefix = new TextDecoder('ascii').decode(bytes.slice(0, 4096));
  const encoding = /charset\s*=\s*["']?\s*(?:shift[_-]?jis|sjis|windows-31j)/i.test(prefix) ? 'shift_jis' : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}
