import type { TextBlock } from '../reader/model';
import type { AlignmentRange, ReadingOverride } from './contracts';

export interface SpeechSourceSpan {
  spokenStart: number;
  spokenEnd: number;
  start: number;
  end: number;
  kind: 'identity' | 'ruby' | 'dictionary';
}
export interface PreparedSpeech { spokenText: string; sourceSpans: SpeechSourceSpan[] }
export interface NormalizedSpeechSpan {
  start: number;
  end: number;
  spokenStart: number;
  spokenEnd: number;
}
export interface NormalizedSpeech { text: string; spans: NormalizedSpeechSpan[] }
interface Piece { text: string; start: number; end: number; kind: SpeechSourceSpan['kind'] }

function characterPieces(text: string, start: number, end: number, kind: Piece['kind']): Piece[] {
  if (kind !== 'identity') return [...text].map((character) => ({ text: character, start, end, kind }));
  let offset = start;
  return [...text].map((character) => { const piece = { text: character, start: offset, end: offset + character.length, kind }; offset += character.length; return piece; });
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Reproduce the exact persisted TTS transcript while carrying original UTF-16 ranges. */
export function prepareSpeech(block: TextBlock, start: number, end: number, readings: ReadingOverride[]): PreparedSpeech {
  const pieces: Piece[] = [];
  let cursor = start;
  for (const ruby of [...block.ruby].sort((a, b) => a.start - b.start)) {
    if (ruby.annotationKind && ruby.annotationKind !== 'reading') continue;
    if (ruby.start < cursor || ruby.end > end) continue;
    pieces.push(...characterPieces(block.text.slice(cursor, ruby.start), cursor, ruby.start, 'identity'));
    pieces.push(...characterPieces(ruby.reading, ruby.start, ruby.end, 'ruby'));
    cursor = ruby.end;
  }
  pieces.push(...characterPieces(block.text.slice(cursor, end), cursor, end, 'identity'));
  const beforeDictionary = pieces.map((piece) => piece.text).join('');
  const positions: Array<{ piece: Piece; start: number; end: number }> = [];
  let offset = 0;
  for (const piece of pieces) { positions.push({ piece, start: offset, end: offset + piece.text.length }); offset += piece.text.length; }
  const dictionary = [...readings].sort((a, b) => b.text.length - a.text.length);
  const byText = new Map(dictionary.map(({ text, reading }) => [text, reading]));
  const replacements = dictionary.length ? [...beforeDictionary.matchAll(new RegExp(dictionary.map(({ text }) => escapeRegex(text)).join('|'), 'gu'))] : [];
  const transformed: Piece[] = [];
  let position = 0;
  for (const replacement of replacements) {
    const begin = replacement.index;
    const finish = begin + replacement[0].length;
    while (position < positions.length && positions[position].end <= begin) transformed.push(positions[position++].piece);
    const overlapping: Piece[] = [];
    while (position < positions.length && positions[position].start < finish) overlapping.push(positions[position++].piece);
    if (!overlapping.length) continue;
    transformed.push(...characterPieces(byText.get(replacement[0])!, Math.min(...overlapping.map((piece) => piece.start)), Math.max(...overlapping.map((piece) => piece.end)), 'dictionary'));
  }
  while (position < positions.length) transformed.push(positions[position++].piece);
  // Match String.trim() without losing the offsets of the remaining characters.
  while (transformed.length && !transformed[0].text.trim()) transformed.shift();
  while (transformed.length && !transformed[transformed.length - 1].text.trim()) transformed.pop();
  const sourceSpans: SpeechSourceSpan[] = [];
  offset = 0;
  for (const piece of transformed) {
    sourceSpans.push({ spokenStart: offset, spokenEnd: offset + piece.text.length, start: piece.start, end: piece.end, kind: piece.kind });
    offset += piece.text.length;
  }
  return { spokenText: transformed.map((piece) => piece.text).join(''), sourceSpans };
}

/** No guessed numeric readings or ASR text replacement; normalization is a separate alignment view. */
export function normalizeSpeech(spokenText: string): NormalizedSpeech {
  const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  const spans: NormalizedSpeechSpan[] = [];
  let text = '';
  for (const grapheme of graphemes.segment(spokenText)) {
    for (const character of grapheme.segment.normalize('NFKC')) {
      if (/^[\p{White_Space}\p{Punctuation}]$/u.test(character)) continue;
      spans.push({ start: text.length, end: text.length + character.length, spokenStart: grapheme.index, spokenEnd: grapheme.index + grapheme.segment.length });
      text += character;
    }
  }
  return { text, spans };
}
export function mergedRanges(ranges: AlignmentRange[]): AlignmentRange[] {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: AlignmentRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
