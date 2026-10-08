import { importText } from '../reader/text-import';
import type { DraftDocument, TextBlock } from '../reader/model';
import type { ReadingOverride } from './contracts';
import { prepareSpeech } from './speech-source';

export interface EstimateRange { blockId: string; start: number; end: number }
export interface CostSource {
  raw: string;
  format: 'txt' | 'md';
  document?: Pick<DraftDocument, 'blocks'>;
  readings: ReadingOverride[];
  ranges?: EstimateRange[];
}

/** Uses the same ruby, dictionary, sentence trimming and static-block policy as TTS. */
export function countSpokenCharacters(source: CostSource): number {
  const blocks = source.document?.blocks ?? (source.raw.trim() ? importText(source.raw, source.format, '').blocks : []);
  const byId = new Map(blocks.map(block => [block.id, block]));
  const sentences = new Intl.Segmenter('ja', { granularity: 'sentence' });
  const count = (block: TextBlock, start: number, end: number) => [...prepareSpeech(block, start, end, source.readings).spokenText].length;
  if (source.ranges) return source.ranges.reduce((total, range) => {
    const block = byId.get(range.blockId);
    if (!block || block.kind === 'code' || block.kind === 'table') return total;
    return total + count(block, range.start, range.end);
  }, 0);
  let total = 0;
  for (const block of blocks) {
    if (block.kind === 'code' || block.kind === 'table') continue;
    for (const sentence of sentences.segment(block.text)) total += count(block, sentence.index, sentence.index + sentence.segment.length);
  }
  return total;
}
