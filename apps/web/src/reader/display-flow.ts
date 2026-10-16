import type { SourceAnchor, TextBlock } from './model';
import { layoutWindowEnd, naturalBoundaries, type LayoutText, type SourceRange, type TextPage } from './display-sets';

export interface SetSource { block: TextBlock; start: number; end: number; boundaries: readonly number[]; next?: SourceAnchor; joinsNext?: boolean }
interface FlowSpan { block: TextBlock; from: number; to: number; start: number }
export interface DisplayFlow extends LayoutText { spans: FlowSpan[]; boundaries: number[]; next?: SourceAnchor }
export interface DisplaySet { id: string; ranges: SourceRange[]; next?: SourceAnchor; fits: boolean; lines: number }

/** Only adjacent, available prose crosses paragraphs. The original clocks and offsets stay intact. */
export function displayFlow(sourceAt: (position: SourceAnchor) => SetSource | undefined, position: SourceAnchor): DisplayFlow | undefined {
  let source = sourceAt(position);
  if (!source) return undefined;
  // A restored/audio cursor can be deep inside one very long cue. Start its bounded window nearby.
  if (position.offset - source.start >= 1024) {
    const part = new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(source.block.text.slice(source.start)).containing(Math.floor(position.offset - source.start));
    let start = source.start + (part?.index ?? 0);
    for (const span of source.block.ruby) if (span.start < start && start < span.end) start = span.start;
    source = { ...source, start };
  }
  const flow: DisplayFlow = { text: '', ruby: [], spans: [], boundaries: [] };
  for (let count = 0; source && count < 64; count++) {
    const { block, start } = source;
    const end = layoutWindowEnd(block, start, source.end, Math.max(1, 2048 - flow.text.length));
    const from = flow.text.length;
    flow.text += block.text.slice(start, end);
    flow.spans.push({ block, from, to: flow.text.length, start });
    flow.ruby.push(...block.ruby.filter(span => span.start >= start && span.end <= end).map(span => ({ ...span, start: span.start - start + from, end: span.end - start + from })));
    flow.boundaries.push(...source.boundaries.filter(cut => cut > start && cut <= end).map(cut => cut - start + from));
    flow.next = end < source.end ? { blockId: block.id, offset: end } : source.next;
    if (end < source.end || flow.text.length >= 2048 || !source.joinsNext || !source.next) break;
    const next = sourceAt(source.next);
    if (!next || ['code', 'table'].includes(block.kind) || ['code', 'table'].includes(next.block.kind)) break;
    flow.text += '\n';
    source = next;
  }
  flow.boundaries = [...new Set([...flow.boundaries, ...naturalBoundaries(flow, 0, flow.text.length)])].sort((a, b) => a - b);
  return flow;
}

export function flowOffset(flow: DisplayFlow, position: SourceAnchor): number | undefined {
  const span = flow.spans.find(span => span.block.id === position.blockId && position.offset >= span.start && position.offset < span.start + span.to - span.from);
  return span && span.from + position.offset - span.start;
}

/** An oversized atomic ruby may consume a whole window before the preceding page is reached. */
export function previousDisplayFlow(sourceAt: (position: SourceAnchor) => SetSource | undefined, position: SourceAnchor, end: SourceAnchor): DisplayFlow | undefined {
  let start = position;
  for (let count = 0; count < 64; count++) {
    const flow = displayFlow(anchor => {
      const source = sourceAt(anchor);
      return source && anchor.blockId === start.blockId ? { ...source, start: Math.max(source.start, start.offset) } : source;
    }, start);
    if (!flow) return undefined;
    if (flowOffset(flow, end) !== undefined || (flow.next?.blockId === end.blockId && flow.next.offset === end.offset)) return flow;
    const next = flow.next;
    if (!next || next.blockId === start.blockId && next.offset === start.offset) return undefined;
    start = next;
  }
  return undefined;
}

export function sourceSlices(flow: DisplayFlow, page: Pick<TextPage, 'start' | 'end'>) {
  return flow.spans.filter(span => span.to > page.start && span.from < page.end).map(span => {
    const start = span.start + Math.max(page.start, span.from) - span.from;
    const end = span.start + Math.min(page.end, span.to) - span.from;
    return { blockId: span.block.id, start, end, text: span.block.text.slice(start, end),
      ruby: span.block.ruby.filter(ruby => ruby.start >= start && ruby.end <= end).map(ruby => ({ ...ruby, start: ruby.start - start, end: ruby.end - start })) };
  });
}

export function displaySet(flow: DisplayFlow, page: TextPage): DisplaySet {
  const ranges = sourceSlices(flow, page).map(({ blockId, start, end }) => ({ blockId, start, end }));
  const after = flow.spans.find(span => span.to > page.end);
  const next = after ? { blockId: after.block.id, offset: after.start + Math.max(0, page.end - after.from) } : flow.next;
  return { ranges, next, id: ranges.map(range => `${range.blockId}:${range.start}:${range.end}`).join('|'), fits: page.fits, lines: page.lines };
}

export function setContains(set: DisplaySet, position: SourceAnchor): boolean {
  return set.ranges.some(range => range.blockId === position.blockId && position.offset >= range.start && position.offset < range.end);
}
