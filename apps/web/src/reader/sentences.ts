import type { ReadingDocument } from './model';
export interface SentenceLocation { id: string; text: string; target: number; blockId: string; start: number; end: number }
export function readingSentences(document: ReadingDocument): SentenceLocation[] {
  const byBlock = new Map<string, Array<{ start: number; end: number; index: number }>>();
  document.units.forEach((unit, index) => { const values = byBlock.get(unit.blockId) ?? []; values.push({ start: unit.start, end: unit.end, index }); byBlock.set(unit.blockId, values); });
  const sentences = new Intl.Segmenter('ja', { granularity: 'sentence' }); const result: SentenceLocation[] = [];
  for (const block of document.blocks) {
    const units = byBlock.get(block.id); if (!units?.length || block.kind === 'heading') continue;
    let cursor = 0;
    for (const sentence of sentences.segment(block.text)) {
      while (cursor < units.length - 1 && units[cursor].end <= sentence.index) cursor++;
      if (sentence.segment.trim()) result.push({ id: `${block.id}:${sentence.index}`, text: sentence.segment, target: units[cursor].index,
        blockId: block.id, start: sentence.index, end: sentence.index + sentence.segment.length });
    }
  }
  return result;
}
export function sentenceIndexAt(sentences: SentenceLocation[], unitIndex: number): number {
  let low = 0; let high = sentences.length;
  while (low < high) { const mid = (low + high) >>> 1; if (sentences[mid].target <= unitIndex) low = mid + 1; else high = mid; }
  return Math.max(0, low - 1);
}
