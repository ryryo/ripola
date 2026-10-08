import type { ReadingUnit } from './model';

export interface DisplayGroup { units: ReadingUnit[]; startIndex: number; endIndex: number; unit: ReadingUnit }
export interface GroupOptions { target: number; minimum: number }
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const count = (text: string) => Array.from(graphemes.segment(text)).length;

/** A presentation view only: source units, offsets, ruby and audio cues stay unchanged. */
export function groupReadingUnits(units: ReadingUnit[], options: GroupOptions, cuts: ReadonlySet<number> = new Set()): DisplayGroup[] {
  const target = Math.max(0, Math.min(24, Math.round(options.target)));
  const minimum = Math.max(0, Math.min(12, Math.round(options.minimum)));
  if (target === 0 && minimum === 0) return units.map((unit, index) => ({ units: [unit], startIndex: index, endIndex: index, unit }));
  const result: DisplayGroup[] = [];
  let index = 0;
  while (index < units.length) {
    const startIndex = index;
    const members = [units[index++]];
    let length = count(members[0].text);
    while ((target > 0 || minimum > 0) && index < units.length) {
      const previous = members.at(-1)!;
      const next = units[index];
      const sourceKinds = new Set([...previous.sources, ...next.sources].map(source => source.kind));
      const pdfPages = new Set([...previous.sources, ...next.sources].flatMap(source => source.kind === 'pdf' ? [source.page] : []));
      if (previous.kind !== 'text' || next.kind !== 'text' || previous.blockId !== next.blockId
        || previous.end !== next.start || ['sentence', 'paragraph', 'heading'].includes(previous.pause)
        || cuts.has(index) || sourceKinds.size > 1 || pdfPages.size > 1) break;
      const nextLength = count(next.text);
      if (length >= minimum && (target === 0 || length + nextLength > target)) break;
      members.push(next); index++; length += nextLength;
      if (length >= Math.max(target, minimum)) break;
    }
    let shift = 0;
    const ruby = members.flatMap(unit => {
      const result = unit.ruby.map(span => ({ ...span, start: span.start + shift, end: span.end + shift }));
      shift += unit.text.length;
      return result;
    });
    const first = members[0]; const last = members.at(-1)!;
    result.push({ units: members, startIndex, endIndex: index - 1, unit: members.length === 1 ? first : {
      ...first, id: `view:${members.map(unit => unit.id).join('|')}`, end: last.end,
      text: members.map(unit => unit.text).join(''), ruby,
      sources: members.flatMap(unit => unit.sources),
      mapping: members.some(unit => unit.mapping === 'approximate') ? 'approximate' : members.some(unit => unit.mapping === 'transformed') ? 'transformed' : 'exact',
      characters: members.reduce((sum, unit) => sum + unit.characters, 0), pause: last.pause,
    } });
  }
  return result;
}

export function groupIndexAt(groups: DisplayGroup[], sourceIndex: number): number {
  let low = 0; let high = groups.length;
  while (low < high) { const mid = (low + high) >>> 1; if (groups[mid].endIndex < sourceIndex) low = mid + 1; else high = mid; }
  return Math.min(low, Math.max(0, groups.length - 1));
}
