import type { ReadingUnit, SourceAnchor, TextBlock } from './model';
import { protectedSpans } from './segmentation';

export interface SourceRange { blockId: string; start: number; end: number }
export interface ReadingMarker extends SourceRange { precision: 'spoken' | 'estimated' | 'position' }
export interface TextPage { start: number; end: number; fits: boolean; lines: number }
export type LayoutText = Pick<TextBlock, 'text' | 'ruby'>;
export interface SetMeasurement { fits: boolean; lines: number }
const words = new Intl.Segmenter('ja', { granularity: 'word' });

const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
export function layoutWindowEnd(block: LayoutText, start: number, end: number, maximum = 2048): number {
  let finish = start;
  for (const part of graphemes.segment(block.text.slice(start, end))) {
    const next = start + part.index + part.segment.length;
    if (next > start + maximum && finish > start) break;
    finish = next;
    if (finish >= start + maximum) break;
  }
  for (const span of block.ruby) if (span.start < finish && finish < span.end) finish = span.start > start ? span.start : span.end;
  return Math.min(end, finish || end);
}

const boundaryCache = new WeakMap<LayoutText, Map<string, number[]>>();
export function naturalBoundaries(block: LayoutText, start: number, end: number): number[] {
  const stop = layoutWindowEnd(block, start, end);
  const key = `${start}:${stop}`;
  const cache = boundaryCache.get(block) ?? new Map<string, number[]>();
  boundaryCache.set(block, cache);
  const stored = cache.get(key);
  if (stored) return stored;
  const text = block.text.slice(start, stop);
  const ruby = block.ruby.filter(span => span.start >= start && span.end <= stop).map(span => ({ ...span, start: span.start - start, end: span.end - start }));
  const protectedRanges = protectedSpans(text, ruby);
  let protectedIndex = 0;
  const cuts = [...words.segment(text)].slice(1).map(part => part.index).filter(cut => {
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex][1] <= cut) protectedIndex++;
    for (let i = protectedIndex; i < protectedRanges.length && protectedRanges[i][0] < cut; i++) if (cut < protectedRanges[i][1]) return false;
    const left = text.slice(Math.max(0, cut - 16), cut).trimEnd(); const right = text.slice(cut, cut + 16).trimStart();
    return !/[「『（([【〈《〔｛{“‘]$/u.test(left) && !/^[、。，．！？!?;；:：」』）)\]】〉》〕｝}”’…]/u.test(right)
      && !/^(?:は|が|を|に|で|と|へ|も|や|の|です|ます)(?:$|[^\p{Script=Hiragana}])/u.test(right);
  }).map(cut => start + cut);
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, cuts);
  return cuts;
}

/** Layout offsets are independent of source blocks and timed ReadingUnits. */
export function planTextPage(block: LayoutText, start: number, end: number, boundaries: readonly number[],
  measure: (range: { start: number; end: number }) => SetMeasurement, requestedLines?: number): TextPage {
  // Bound source extent as well as candidate count, even for a single huge URL/word.
  const limit = layoutWindowEnd(block, start, end);
  const candidates = boundaries.filter(value => value > start && value <= limit);
  if (limit === end || candidates.length === 0) candidates.push(limit);
  let cuts = [...new Set(candidates)].sort((a, b) => a - b);
  const furthest = (values: readonly number[]) => {
    let low = 0; let high = values.length - 1; let selected = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (measure({ start, end: values[middle] }).fits) { selected = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return selected;
  };
  let selected = furthest(cuts);
  if (selected < 0 || (requestedLines && measure({ start, end: cuts[selected] }).lines < requestedLines && cuts[selected] < limit)) {
    // Last resort for a long unbroken word: visible pages, never a scroll requirement.
    const stop = selected >= 0 ? limit : cuts[0] ?? end;
    const natural = naturalBoundaries(block, start, stop).filter(cut => cut > start);
    const naturalIndex = furthest(natural);
    if (naturalIndex >= 0 && (!requestedLines || measure({ start, end: natural[naturalIndex] }).lines >= requestedLines)) { cuts = natural; selected = naturalIndex; }
    else {
      cuts = [...graphemes.segment(block.text.slice(start, stop))].map(part => start + part.index + part.segment.length)
      .filter(cut => !block.ruby.some(span => span.start < cut && cut < span.end));
      selected = furthest(cuts);
    }
  }
  // Ruby bases stay atomic; the view can reduce the font when even one base cannot fit.
  const finish = cuts[Math.max(0, selected)] ?? end;
  const result = measure({ start, end: finish });
  return { start, end: finish, fits: result.fits, lines: result.lines };
}

/** Source/PDF page boundaries, and static blocks, remain hard boundaries. */
export function silentSetSource(blocks: readonly TextBlock[], units: readonly ReadingUnit[], position: SourceAnchor) {
  const index = units.findIndex(unit => unit.blockId === position.blockId && unit.end > position.offset);
  if (index < 0) return undefined;
  const first = units[index]; const block = blocks.find(block => block.id === first.blockId);
  if (!block) return undefined;
  const page = first.sources.find(source => source.kind === 'pdf');
  let last = index;
  while (last + 1 < units.length) {
    const next = units[last + 1]; const nextPage = next.sources.find(source => source.kind === 'pdf');
    if (next.blockId !== first.blockId || next.kind !== first.kind || next.start !== units[last].end || (page?.kind === 'pdf' ? nextPage?.kind !== 'pdf' || page.page !== nextPage.page : nextPage?.kind === 'pdf')) break;
    last++;
  }
  const end = units[last].end; const after = units[last + 1];
  const nextPage = after?.sources.find(source => source.kind === 'pdf');
  const joinsNext = Boolean(after && after.kind === 'text' && first.kind === 'text' && end === block.text.length && after.start === 0
    && blocks.findIndex(value => value.id === after.blockId) === blocks.indexOf(block) + 1
    && (page?.kind === 'pdf' ? nextPage?.kind === 'pdf' && page.page === nextPage.page : nextPage?.kind !== 'pdf'));
  return { block, start: first.start, end, joinsNext, boundaries: naturalBoundaries(block, first.start, end),
    next: after ? { blockId: after.blockId, offset: after.start } : undefined };
}
