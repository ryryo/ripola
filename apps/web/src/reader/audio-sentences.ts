import type { AudioSegment, PlayableAudioBook, PlayablePhraseCue } from './audio-clock';
import type { SentenceLocation } from './sentences';

export interface AudioSentenceTarget extends SentenceLocation {
  seconds: number;
  segmentIndex: number;
  timingMethod: NonNullable<PlayablePhraseCue['timingMethod']>;
}

/** Source sentences are navigation destinations; audio files only supply their clocks. */
export function audioSentenceTargets(book: PlayableAudioBook, segments: AudioSegment[]): AudioSentenceTarget[] {
  const byBlock = new Map<string, Array<{ cue: PlayablePhraseCue; segment: AudioSegment; segmentIndex: number; cueIndex: number }>>();
  segments.forEach((segment, segmentIndex) => segment.displayCues.forEach((cue, cueIndex) => {
    const values = byBlock.get(cue.blockId) ?? [];
    values.push({ cue, segment, segmentIndex, cueIndex }); byBlock.set(cue.blockId, values);
  }));
  const sentences = new Intl.Segmenter('ja', { granularity: 'sentence' });
  const result: AudioSentenceTarget[] = [];
  for (const block of book.document.blocks) {
    const cues = byBlock.get(block.id);
    if (!cues?.length) continue;
    let cursor = 0;
    for (const sentence of sentences.segment(block.text)) {
      const start = sentence.index; const end = start + sentence.segment.length;
      while (cursor < cues.length && cues[cursor].cue.end <= start) cursor++;
      const clock = cues[cursor];
      if (!sentence.segment.trim() || !clock || clock.cue.start >= end) continue;
      const { cue, segment, segmentIndex, cueIndex } = clock;
      // A stored phrase may cross a sentence boundary. Interpolation is only a
      // navigation estimate; do not rewrite the phrase or its acoustic evidence.
      const offset = Math.max(cue.start, start);
      const insideCue = offset > cue.start;
      const fraction = insideCue ? Array.from(block.text.slice(cue.start, offset)).length / Array.from(block.text.slice(cue.start, cue.end)).length : 0;
      const localSeconds = insideCue ? cue.startSeconds + fraction * (cue.endSeconds - cue.startSeconds) : cueIndex === 0 ? 0 : cue.startSeconds;
      result.push({ id: `${block.id}:${start}`, text: sentence.segment, target: result.length, blockId: block.id, start, end,
        seconds: segment.startSeconds + localSeconds, segmentIndex,
        timingMethod: insideCue || localSeconds !== cue.startSeconds ? 'estimated' : cue.timingMethod ?? 'estimated' });
    }
  }
  return result;
}

export function audioSentenceIndexAt(targets: AudioSentenceTarget[], seconds: number): number {
  let low = 0; let high = targets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (targets[middle].seconds <= seconds + 2e-6) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
