export const SPEECH_DURATION_EPSILON_MS = 1e-9;
const opening = new Set([...'「『（([【〈《〔｛{“‘']);
const closing = new Set([...'」』）)]】〉》〕｝}”’']);
const sentence = /^[。！？!?]$/u;
const clause = /^[、,，;；:：]$/u;
const whitespace = /^\s+$/u;
const latin = /^[\p{Script=Latin}\p{Mark}]+$/u;
const digit = /^[0-9０-９]$/u;
const punctuation = /^[\p{Punctuation}\p{Symbol}]+$/u;
const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** Additive, integer-ms surface estimate: no ruby, dictionary, tokenizer or TTS call. */
export function durationMs(character: string): number {
  if (/\r|\n/u.test(character)) return 350;
  if (whitespace.test(character)) return 20;
  if (sentence.test(character) || character === '.') return 350;
  if (clause.test(character)) return 180;
  if (opening.has(character) || closing.has(character)) return 0;
  if (digit.test(character)) return 250;
  if (latin.test(character)) return 80;
  if (punctuation.test(character)) return 100;
  return 170;
}

/** The comparison script uses exactly the same estimator for legacy and planned spans. */
export function estimateSpeechSeconds(text: string): number {
  let ms = 0;
  for (const part of graphemes.segment(text)) ms += durationMs(part.segment);
  return ms / 1000;
}

export function tokenBytes(grapheme: string): number {
  return Math.max(encoder.encode(grapheme).length, encoder.encode(grapheme.normalize('NFKC').replaceAll(' ', '▁').replaceAll('.', '…')).length);
}
/** Conservative byte fallback budget, including BOS; no model download needed. */
export function estimateTokenUpperBound(text: string): number {
  let bytes = 1;
  for (const part of graphemes.segment(text)) bytes += tokenBytes(part.segment);
  return bytes;
}

