import { AUDIO_CLOCK_TOLERANCE, audioDisplayAt, type AudioSegment, type PlayablePhraseCue } from './audio-clock';
import type { ReadingMarker } from './display-sets';
import type { SourceAnchor, TextBlock } from './model';

export interface AudioSourceTarget { blockId: string; start: number; end: number; seconds: number; endSeconds: number; segmentId: string }

const spokenCues = new WeakMap<AudioSegment, ReadonlySet<PlayablePhraseCue>>();
const sourceClocks = new WeakMap<AudioSegment, AudioSegment>();

/** One source clock for page position, markers and seeks, without the phrase view's minimum dwell. */
function sourceClock(segment: AudioSegment): AudioSegment {
  const stored = sourceClocks.get(segment);
  if (stored) return stored;
  const accepted = segment.cues ?? [];
  const acceptedSet = new Set(accepted);
  const coverage = new Map<string, Array<{ start: number; end: number }>>();
  for (const cue of accepted) { const values = coverage.get(cue.blockId) ?? []; values.push(cue); coverage.set(cue.blockId, values); }
  for (const [id, values] of coverage) {
    const sorted = [...values].sort((a, b) => a.start - b.start); let end = 0;
    coverage.set(id, sorted.map(cue => ({ start: cue.start, end: end = Math.max(end, cue.end) })));
  }
  const covered = (cue: PlayablePhraseCue) => {
    const values = coverage.get(cue.blockId) ?? [];
    let low = 0, high = values.length;
    while (low < high) { const mid = (low + high) >>> 1; if (values[mid].start <= cue.start) low = mid + 1; else high = mid; }
    return low > 0 && values[low - 1].end >= cue.end;
  };
  const values = [...accepted, ...segment.displayCues.filter(cue => !covered(cue))];
  values.sort((a, b) => a.blockId === b.blockId ? a.start - b.start
    : (a.unitIndices[0] ?? segment.chunk.timeline.findIndex(mark => mark.blockId === a.blockId)) - (b.unitIndices[0] ?? segment.chunk.timeline.findIndex(mark => mark.blockId === b.blockId)));
  const cues: PlayablePhraseCue[] = [];
  let pending: PlayablePhraseCue[] = []; let previousEnd = 0; let untimedSource = false;
  const appendEstimates = (end: number) => {
    const available = Math.max(0, end - previousEnd);
    if (pending.length && available === 0) untimedSource = true;
    const bounded = pending.every(cue => cue.startSeconds >= previousEnd && cue.endSeconds <= end);
    const weight = pending.reduce((sum, cue) => sum + cue.end - cue.start, 0);
    let cursor = previousEnd;
    for (const [index, cue] of pending.entries()) {
      const next = index === pending.length - 1 ? end : cursor + available * (cue.end - cue.start) / weight;
      cues.push(bounded ? cue : { ...cue, startSeconds: cursor, endSeconds: next, timingMethod: 'estimated', estimatedReason: 'between-speech-cues', score: undefined });
      cursor = next;
    }
    pending = [];
  };
  for (const cue of values) {
    if (acceptedSet.has(cue)) { appendEstimates(cue.startSeconds); cues.push(cue); previousEnd = cue.endSeconds; }
    else if (cue.estimatedReason !== 'silence-hold') pending.push(cue);
  }
  appendEstimates(segment.chunk.durationSeconds);
  // Contradictory speech coverage cannot assign positive time to every source range.
  const clock = untimedSource ? { ...segment, cues: [], displayCues: segment.displayCues.filter(cue => cue.estimatedReason !== 'silence-hold') }
    : { ...segment, displayCues: cues };
  sourceClocks.set(segment, clock);
  spokenCues.set(clock, untimedSource ? new Set() : acceptedSet);
  return clock;
}

/** Accepted cues remain indivisible. Uncovered display estimates are navigation fallbacks only. */
export function audioSourceTargets(segments: readonly AudioSegment[]): AudioSourceTarget[] {
  return segments.flatMap(segment => sourceClock(segment).displayCues.map(cue => ({
    blockId: cue.blockId, start: cue.start, end: cue.end, seconds: segment.startSeconds + cue.startSeconds,
    endSeconds: segment.startSeconds + cue.endSeconds, segmentId: segment.chunk.id,
  })));
}

export function audioReadingMarker(segment: AudioSegment | undefined, seconds: number): ReadingMarker | undefined {
  if (!segment) return undefined;
  const clock = sourceClock(segment);
  const display = audioDisplayAt(clock, seconds - segment.startSeconds);
  const cue = display.cue;
  if (!cue) return undefined;
  const precision = display.reason === 'silence-hold' || cue.estimatedReason === 'silence-hold' ? 'position'
    : spokenCues.get(clock)?.has(cue) ? 'spoken' : 'estimated';
  return { blockId: cue.blockId, start: cue.start, end: cue.end, precision };
}

export function audioSetSource(blocks: readonly TextBlock[], targets: readonly AudioSourceTarget[], availableIds: ReadonlySet<string>, position: SourceAnchor) {
  const index = targets.findIndex(target => availableIds.has(target.segmentId) && target.blockId === position.blockId && target.start <= position.offset && target.end > position.offset);
  if (index < 0) return undefined;
  const first = targets[index]; const block = blocks.find(block => block.id === first.blockId);
  if (!block) return undefined;
  let last = index;
  while (last + 1 < targets.length && availableIds.has(targets[last + 1].segmentId) && targets[last + 1].blockId === first.blockId && targets[last + 1].start === targets[last].end) last++;
  const after = targets[last + 1];
  const joinsNext = Boolean(after && availableIds.has(after.segmentId) && targets[last].end === block.text.length && after.start === 0
    && blocks.findIndex(value => value.id === after.blockId) === blocks.indexOf(block) + 1);
  return { block, start: first.start, end: targets[last].end, joinsNext, boundaries: targets.slice(index, last + 1).map(target => target.end),
    next: after && availableIds.has(after.segmentId) ? { blockId: after.blockId, offset: after.start } : undefined };
}

/** Page position and source seeks interpolate the same intervals; phrase dwell estimates cannot override speech. */
export function audioDisplayPosition(segment: AudioSegment | undefined, seconds: number): SourceAnchor | undefined {
  if (!segment) return undefined;
  const local = seconds - segment.startSeconds;
  const cue = audioDisplayAt(sourceClock(segment), local).cue;
  if (!cue) return undefined;
  const fraction = cue.endSeconds > cue.startSeconds ? Math.max(0, Math.min(1, (local + AUDIO_CLOCK_TOLERANCE - cue.startSeconds) / (cue.endSeconds - cue.startSeconds))) : 0;
  return { blockId: cue.blockId, offset: Math.min(cue.end - 1e-6, cue.start + (cue.end - cue.start) * fraction) };
}

/** Exact interval starts where possible; internal page boundaries interpolate the same source cue. */
export function audioSetSeek(targets: readonly AudioSourceTarget[], position: SourceAnchor): AudioSourceTarget | undefined {
  const exact = targets.find(target => target.blockId === position.blockId && target.start === position.offset);
  if (exact) return exact;
  const target = targets.find(target => target.blockId === position.blockId && target.start <= position.offset && target.end > position.offset);
  return target ? { ...target, seconds: target.seconds + (target.endSeconds - target.seconds) * (position.offset - target.start) / (target.end - target.start) } : undefined;
}
