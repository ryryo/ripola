import type { PlayableAudioBook } from './audio-clock';
import type { ReadingUnit } from './model';

/** Sorted, non-overlapping source ranges: avoid rescanning a whole long block for each sentence. */
export function unitsInAudioRange(units: ReadingUnit[], start: number, end: number): ReadingUnit[] {
  let low = 0; let high = units.length;
  while (low < high) { const middle = (low + high) >>> 1; if (units[middle].end <= start) low = middle + 1; else high = middle; }
  const result: ReadingUnit[] = [];
  for (let index = low; index < units.length && units[index].start < end; index++) result.push(units[index]);
  return result;
}

/** Old BudouX units can cross a sentence/audio boundary. Split a visual copy, never the saved source or audio. */
export function audioSourceUnits(book: PlayableAudioBook): { units: ReadingUnit[]; splitSourceUnits: number; issues: Array<{ code: string; unitId: string }> } {
  const cuts = new Map<string, Set<number>>();
  for (const chunk of book.chunks) for (const mark of Array.isArray(chunk.timeline) ? chunk.timeline : []) {
    const values = cuts.get(mark.blockId) ?? new Set<number>(); values.add(mark.start); values.add(mark.end); cuts.set(mark.blockId, values);
  }
  const sorted = new Map([...cuts].map(([id, values]) => [id, [...values].sort((a, b) => a - b)]));
  const issues: Array<{ code: string; unitId: string }> = [];
  let splitSourceUnits = 0;
  const units = (book.document.units ?? []).flatMap(unit => {
    const values = sorted.get(unit.blockId) ?? [];
    let low = 0; let high = values.length;
    while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= unit.start) low = middle + 1; else high = middle; }
    const inside: number[] = [];
    for (let index = low; index < values.length && values[index] < unit.end; index++) inside.push(values[index]);
    if (!inside.length || unit.kind !== 'text') return [unit];
    if (inside.some(cut => unit.ruby.some(ruby => unit.start + ruby.start < cut && cut < unit.start + ruby.end))) {
      issues.push({ code: 'audio-boundary-splits-ruby', unitId: unit.id }); return [unit];
    }
    splitSourceUnits++;
    return [unit.start, ...inside, unit.end].slice(0, -1).map((start, index) => {
      const end = [...inside, unit.end][index];
      const shift = start - unit.start;
      return { ...unit, id: `${unit.id}@${start}-${end}`, start, end, text: unit.text.slice(shift, end - unit.start),
        sources: unit.sources.map(source => unit.mapping === 'exact' && unit.sources.length === 1 && source.end - source.start === unit.end - unit.start
          ? { ...source, start: source.start + shift, end: source.start + end - unit.start } : { ...source }),
        ruby: unit.ruby.filter(ruby => ruby.start >= shift && ruby.end <= end - unit.start).map(ruby => ({ ...ruby, start: ruby.start - shift, end: ruby.end - shift })) };
    });
  });
  return { units, splitSourceUnits, issues };
}
