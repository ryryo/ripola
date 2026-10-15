import type { ReadingUnit } from './model';
import { protectedSpans } from './segmentation';

export type PhraseSlice = Pick<ReadingUnit, 'blockId' | 'start' | 'end' | 'text' | 'ruby'>;
export interface PhrasePage { unit: PhraseSlice; fontSize: number; wrapped: boolean }
export type PhraseFits = (unit: PhraseSlice, fontSize: number, wrap: boolean) => boolean;
const words = new Intl.Segmenter('ja', { granularity: 'word' });

/** A source-preserving view; persisted units, cues and source anchors are never replaced. */
export function slicePhrase(unit: ReadingUnit, from: number, to: number): PhraseSlice {
  if (from === 0 && to === unit.text.length) return unit;
  const text = unit.text.slice(from, to);
  return { blockId: unit.blockId, start: unit.start + from, end: unit.start + to, text,
    ruby: unit.ruby.filter(span => span.start >= from && span.end <= to).map(span => ({ ...span, start: span.start - from, end: span.end - from })) };
}

function naturalCuts(unit: ReadingUnit): number[] {
  const protectedRanges = protectedSpans(unit.text, unit.ruby);
  const parts = [...words.segment(unit.text)];
  let protectedIndex = 0;
  return parts.slice(1).map(part => part.index).filter(cut => {
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex][1] <= cut) protectedIndex++;
    for (let i = protectedIndex; i < protectedRanges.length && protectedRanges[i][0] < cut; i++) if (cut < protectedRanges[i][1]) return false;
    const left = unit.text.slice(Math.max(0, cut - 16), cut).trimEnd();
    const right = unit.text.slice(cut).trimStart();
    // Keep opening/closing punctuation and grammatical particles with their phrase.
    return !/[「『（([【〈《〔｛{“‘]$/u.test(left) && !/^[、。，．！？!?;；:：」』）)\]】〉》〕｝}”’…]/u.test(right)
      && !/^(?:は|が|を|に|で|と|へ|も|や|の|です|ます)(?:$|[^\p{Script=Hiragana}])/u.test(right);
  });
}

/** Try one line first; only indivisible protected runs can fall back to wrapping. */
export function planPhrasePages(unit: ReadingUnit, source: readonly ReadingUnit[], desired: number, fits: PhraseFits): PhrasePage[] {
  const maximum = Math.max(24, Math.floor(desired));
  const sized = (value: PhraseSlice, wrap: boolean): PhrasePage => {
    let low = 24; let high = maximum; let fontSize = 24;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      if (fits(value, size, wrap)) { fontSize = size; low = size + 1; } else high = size - 1;
    }
    return { unit: value, fontSize, wrapped: wrap };
  };
  if (unit.kind !== 'text' || fits(unit, 24, false)) return [sized(unit, false)];
  const end = unit.text.length;
  const preferred = [...new Set(source.filter(value => value.blockId === unit.blockId).map(value => value.end - unit.start)
    .filter(cut => cut > 0 && cut <= end).concat(end))].sort((a, b) => a - b);
  const cuts = [...new Set([...naturalCuts(unit), ...preferred])].sort((a, b) => a - b);
  const pages: PhrasePage[] = [];
  let start = 0;
  const afterStart = (cuts: number[]) => {
    let low = 0; let high = cuts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (cuts[middle] <= start) low = middle + 1; else high = middle; }
    return low;
  };
  const furthest = () => {
    let last = start;
    for (let i = afterStart(cuts); i < cuts.length; i++) {
      const cut = cuts[i];
      if (!fits(slicePhrase(unit, start, cut), 24, false)) break;
      last = cut;
    }
    return last;
  };
  while (start < end) {
    const limit = furthest();
    let next = limit;
    for (let i = afterStart(preferred); i < preferred.length && preferred[i] <= limit; i++) next = preferred[i];
    if (next === start) next = cuts[afterStart(cuts)] ?? end;
    const value = slicePhrase(unit, start, next);
    pages.push(sized(value, !fits(value, 24, false)));
    start = next;
  }
  return pages;
}

/** Subdivision samples the existing unit/cue clock; it never advances or seeks playback. */
export function phrasePageAt(pages: readonly PhrasePage[], active: ReadingUnit | undefined, progress: number): number {
  if (!active || pages.length < 2) return 0;
  const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const offset = Math.min(active.end - 1e-6, active.start + (active.end - active.start) * fraction);
  const at = pages.findIndex(page => page.unit.blockId === active.blockId && page.unit.end > offset);
  return at < 0 ? pages.length - 1 : at;
}
