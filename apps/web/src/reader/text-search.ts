import type { ReadingUnit, TextBlock } from './model';

/** One source-text occurrence. Offsets are UTF-16 indices inside the block. */
export interface TextSearchMatch {
  id: string;
  blockId: string;
  start: number;
  end: number;
  /** Index of the reading phrase containing `start`, used for display and playback. */
  unitIndex: number;
}

function caseInsensitiveOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const loweredText = text.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const offsets: number[] = [];
  // Lowercasing preserves Japanese and ordinary Latin length. Fall back to a
  // slice comparison for rare case-fold expansions where indices would shift.
  if (loweredText.length === text.length && loweredQuery.length === query.length) {
    let from = 0;
    while (from <= loweredText.length - loweredQuery.length) {
      const found = loweredText.indexOf(loweredQuery, from);
      if (found < 0) break;
      offsets.push(found);
      from = found + Math.max(1, query.length);
    }
    return offsets;
  }
  for (let from = 0; from <= text.length - query.length;) {
    if (text.slice(from, from + query.length).toLowerCase() === loweredQuery) {
      offsets.push(from);
      from += Math.max(1, query.length);
    } else from++;
  }
  return offsets;
}

function unitIndexAt(units: readonly { unit: ReadingUnit; index: number }[], offset: number): number | undefined {
  let low = 0;
  let high = units.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (units[middle].unit.end <= offset) low = middle + 1;
    else high = middle;
  }
  const value = units[low];
  return value && value.unit.start <= offset && offset < value.unit.end ? value.index : undefined;
}

/**
 * Finds literal, case-insensitive occurrences across every block. Each
 * occurrence is independent, including multiple hits in one phrase and hits
 * that cross a phrase boundary. A hit never crosses a paragraph/block boundary.
 */
export function searchText(blocks: readonly TextBlock[], units: readonly ReadingUnit[], query: string): TextSearchMatch[] {
  if (!query.trim()) return [];
  const byBlock = new Map<string, Array<{ unit: ReadingUnit; index: number }>>();
  units.forEach((unit, index) => {
    const values = byBlock.get(unit.blockId) ?? [];
    values.push({ unit, index });
    byBlock.set(unit.blockId, values);
  });
  const matches: TextSearchMatch[] = [];
  for (const block of blocks) {
    const blockUnits = byBlock.get(block.id);
    if (!blockUnits?.length) continue;
    for (const start of caseInsensitiveOffsets(block.text, query)) {
      const unitIndex = unitIndexAt(blockUnits, start);
      if (unitIndex === undefined) continue;
      const end = start + query.length;
      matches.push({ id: `${block.id}:${start}:${end}`, blockId: block.id, start, end, unitIndex });
    }
  }
  return matches;
}

/** The first hit in document order at or after the phrase where the search began. */
export function firstMatchAtOrAfter(matches: readonly TextSearchMatch[], unitIndex: number): TextSearchMatch | undefined {
  return matches.find(match => match.unitIndex >= unitIndex) ?? matches[0];
}
