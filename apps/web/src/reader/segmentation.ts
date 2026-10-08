import { jaModel, Parser } from 'budoux';
import { MAX_TEXT_LENGTH } from './model';
import type { DraftDocument, ReadingDocument, ReadingUnit, RubySpan, SourceRange, SourceRun, TextBlock } from './model';

const parser = new Parser(jaModel);
export const SEGMENTATION_VERSIONS = {
  parser: 'budoux@0.9.3',
  model: 'ja@budoux-0.9.3',
  rules: 'rsvp-boundaries@1',
};
let graphemes: Intl.Segmenter | undefined;
let modelHash: Promise<string> | undefined;
const closing = /^[\s\p{Punctuation}]+$/u;
const openingTail = /[「『（([【〈《〔｛{“‘]+$/u;
const punctuationHead = /^[、。，．！？!?;；:：」』）)\]】〉》〕｝}”’…]/u;
const content = /[^\s\p{Punctuation}]/u;

function segmenter(): Intl.Segmenter {
  if (typeof Intl.Segmenter !== 'function') throw new Error('このブラウザは文字境界解析に対応していません。原文を静的表示して確認してください。');
  return graphemes ??= new Intl.Segmenter('ja', { granularity: 'grapheme' });
}

export function countCharacters(text: string): number {
  let count = 0;
  for (const part of segmenter().segment(text)) if (content.test(part.segment)) count++;
  return count;
}

function protectedSpans(text: string, ruby: RubySpan[]): Array<[number, number]> {
  const spans: Array<[number, number]> = ruby.map((span) => [span.start, span.end]);
  // URLs are ASCII-only by design: trailing Japanese particles are never swallowed.
  const patterns = [
    /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    /[0-9０-９]{4}年[0-9０-９]{1,2}月[0-9０-９]{1,2}日/g,
    /[0-9０-９]{4}[-/／][0-9０-９]{1,2}[-/／][0-9０-９]{1,2}/g,
    /[0-9０-９]{1,2}[:：][0-9０-９]{2}(?:[:：][0-9０-９]{2})?/g,
    /(?:[vV])?[0-9０-９]+(?:[.,，．][0-9０-９]+)*(?:[%％円]|[A-Za-z]+)?/g,
    /[A-Za-z_][A-Za-z0-9_.-]*/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    let end = match.index + match[0].length;
    if (pattern === patterns[0]) while (end > match.index && /[.,;!?)]/.test(text[end - 1])) end--;
    spans.push([match.index, end]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

export function boundariesFor(block: Pick<TextBlock, 'text' | 'ruby'>): number[] {
  const { text, ruby } = block;
  if (!text.length) return [];
  const graphemeCuts = new Set<number>([0, text.length]);
  for (const part of segmenter().segment(text)) graphemeCuts.add(part.index);
  const protectedRanges = protectedSpans(text, ruby);
  let protectedIndex = 0;
  const cuts = parser.parseBoundaries(text).filter((cut) => {
    if (cut <= 0 || cut >= text.length || !graphemeCuts.has(cut)) return false;
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex][1] <= cut) protectedIndex++;
    for (let index = protectedIndex; index < protectedRanges.length && protectedRanges[index][0] < cut; index++) if (cut < protectedRanges[index][1]) return false;
    return true;
  });
  let result = [0, ...cuts, text.length];
  // A cut before closing punctuation, after opening brackets, or around a bare punctuation
  // fragment cannot be a useful RSVP step. Removing cuts never changes the original text.
  result = result.filter((cut, index) => {
    if (index === 0 || index === result.length - 1) return true;
    const left = text.slice(result[index - 1], cut);
    const right = text.slice(cut, result[index + 1]);
    if (punctuationHead.test(right.trimStart()) || openingTail.test(left.trimEnd())) return false;
    if (closing.test(right) && !openingTail.test(right.trimEnd())) return false;
    return true;
  });
  // A leading bare punctuation/space segment joins the following readable phrase too.
  if (result.length > 2 && closing.test(text.slice(0, result[1]))) result.splice(1, 1);
  return result;
}

function sliceSource(run: SourceRun, start: number, end: number): SourceRange[] {
  const overlapStart = Math.max(start, run.start);
  const overlapEnd = Math.min(end, run.end);
  if (overlapStart >= overlapEnd) return [];
  return run.sources.map((source) => {
    if (run.mapping !== 'exact' || run.sources.length !== 1 || source.end - source.start !== run.end - run.start) return { ...source };
    return { ...source, start: source.start + overlapStart - run.start, end: source.start + overlapEnd - run.start };
  });
}

function unitSources(block: TextBlock, start: number, end: number, firstRun: number): { sources: SourceRange[]; mapping: SourceRun['mapping']; nextRun: number } {
  let cursor = firstRun;
  while (cursor < block.runs.length && block.runs[cursor].end <= start) cursor++;
  const sources: SourceRange[] = [];
  let mapping: SourceRun['mapping'] = 'exact';
  for (let index = cursor; index < block.runs.length && block.runs[index].start < end; index++) {
    const run = block.runs[index];
    if (run.mapping === 'approximate') mapping = 'approximate';
    else if (run.mapping === 'transformed' && mapping === 'exact') mapping = 'transformed';
    sources.push(...sliceSource(run, start, end));
  }
  return { sources, mapping, nextRun: cursor };
}

function pauseFor(text: string, kind: TextBlock['kind'], isLast: boolean): ReadingUnit['pause'] {
  if (isLast && kind === 'heading') return 'heading';
  if (isLast) return 'paragraph';
  if (/[。.!?！？](?:[」』）)\]】”’…\s])*$/u.test(text)) return 'sentence';
  if (/[、,，;；:：](?:[」』）)\]】”’\s])*$/u.test(text)) return 'comma';
  return 'none';
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareDocument(draft: DraftDocument, onProgress?: (progress: number) => void): Promise<ReadingDocument> {
  if (!draft.blocks.length) throw new Error('再生できる本文がありません。');
  if (draft.blocks.reduce((sum, block) => sum + block.text.length, 0) > MAX_TEXT_LENGTH) throw new Error('抽出本文は100万文字以内にしてください。');
  const contentHash = await hash(`${draft.format}\u0000${draft.rawText}\u0000${JSON.stringify(draft.blocks.map((block) => [block.kind, block.text, block.ruby]))}`);
  const id = `document-${contentHash}`;
  const modelFingerprint = await (modelHash ??= hash(JSON.stringify(jaModel)));
  const units: ReadingUnit[] = [];
  let totalCharacters = 0;
  onProgress?.(0);
  let reportedProgress = 0;
  for (let blockIndex = 0; blockIndex < draft.blocks.length; blockIndex++) {
    const block = draft.blocks[blockIndex];
    const isStatic = block.kind === 'code' || block.kind === 'table';
    const boundaries = isStatic ? [0, block.text.length] : boundariesFor(block);
    let runCursor = 0;
    let rubyCursor = 0;
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      if (start === end) continue;
      const text = block.text.slice(start, end);
      const characters = isStatic ? 0 : countCharacters(text);
      const cumulativeCharacters = totalCharacters;
      totalCharacters += characters;
      const { sources, mapping, nextRun } = unitSources(block, start, end, runCursor);
      runCursor = nextRun;
      while (rubyCursor < block.ruby.length && block.ruby[rubyCursor].end <= start) rubyCursor++;
      const unitRuby: RubySpan[] = [];
      for (let rubyIndex = rubyCursor; rubyIndex < block.ruby.length && block.ruby[rubyIndex].start < end; rubyIndex++) {
        const span = block.ruby[rubyIndex];
        if (span.start >= start && span.end <= end) unitRuby.push({ ...span, start: span.start - start, end: span.end - start });
      }
      units.push({
        id: `${contentHash.slice(0, 16)}:${block.id}:${start}-${end}`,
        blockId: block.id, kind: isStatic ? 'static' : 'text', start, end, text, sources, mapping,
        ruby: unitRuby,
        characters, cumulativeCharacters,
        pause: pauseFor(text, block.kind, index === boundaries.length - 2),
      });
    }
    const progress = (blockIndex + 1) / draft.blocks.length;
    if (progress >= reportedProgress + 0.01 || progress === 1) { onProgress?.(progress); reportedProgress = progress; }
  }
  if (!units.length) throw new Error('再生できる本文がありません。');
  return { ...draft, id, contentHash, units, totalCharacters, versions: { ...SEGMENTATION_VERSIONS, model: `${SEGMENTATION_VERSIONS.model}:sha256-${modelFingerprint}` } };
}
