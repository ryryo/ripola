import { AUDIO_CLOCK_TOLERANCE, audioDisplayAt, type AudioSegment } from './audio-clock';
import type { ReadingMarker } from './display-sets';
import type { SourceAnchor, TextBlock } from './model';

export interface AudioSourceTarget { blockId: string; start: number; end: number; seconds: number; endSeconds: number; segmentId: string }

/** Accepted cues remain indivisible. Estimated display subdivisions are navigation fallbacks only. */
export function audioSourceTargets(segments: readonly AudioSegment[]): AudioSourceTarget[] {
  return segments.flatMap(segment => {
    const accepted = segment.cues ?? [];
    const values = [...accepted, ...segment.displayCues.filter(cue => !accepted.some(value => value.blockId === cue.blockId && value.start <= cue.start && value.end >= cue.end))];
    return values.sort((a, b) => a.startSeconds - b.startSeconds).filter(cue => cue.estimatedReason !== 'silence-hold').map(cue => ({
      blockId: cue.blockId, start: cue.start, end: cue.end, seconds: segment.startSeconds + cue.startSeconds,
      endSeconds: segment.startSeconds + cue.endSeconds, segmentId: segment.chunk.id,
    }));
  });
}

export function audioReadingMarker(segment: AudioSegment | undefined, seconds: number): ReadingMarker | undefined {
  if (!segment) return undefined;
  const local = seconds - segment.startSeconds + AUDIO_CLOCK_TOLERANCE;
  const cue = segment.cues?.find(cue => cue.startSeconds <= local && local < cue.endSeconds);
  if (cue) return { blockId: cue.blockId, start: cue.start, end: cue.end, precision: 'spoken' };
  const estimate = segment.displayCues.find(cue => cue.startSeconds <= local && local < cue.endSeconds);
  if (!estimate || estimate.estimatedReason === 'silence-hold') return undefined;
  return { blockId: estimate.blockId, start: estimate.start, end: estimate.end, precision: 'estimated' };
}

export function audioSetSource(blocks: readonly TextBlock[], targets: readonly AudioSourceTarget[], availableIds: ReadonlySet<string>, position: SourceAnchor) {
  const index = targets.findIndex(target => availableIds.has(target.segmentId) && target.blockId === position.blockId && target.start <= position.offset && target.end > position.offset);
  if (index < 0) return undefined;
  const first = targets[index]; const block = blocks.find(block => block.id === first.blockId);
  if (!block) return undefined;
  let last = index;
  while (last + 1 < targets.length && availableIds.has(targets[last + 1].segmentId) && targets[last + 1].blockId === first.blockId && targets[last + 1].start === targets[last].end) last++;
  const after = targets[last + 1];
  return { block, start: first.start, end: targets[last].end, boundaries: targets.slice(index, last + 1).map(target => target.end),
    next: after && availableIds.has(after.segmentId) ? { blockId: after.blockId, offset: after.start } : undefined };
}

/** A visual cursor inside an existing display interval, not new acoustic evidence. */
export function audioDisplayPosition(segment: AudioSegment | undefined, seconds: number): SourceAnchor | undefined {
  if (!segment) return undefined;
  const local = seconds - segment.startSeconds;
  const cue = audioDisplayAt(segment, local).cue;
  if (!cue) return undefined;
  const fraction = Math.max(0, Math.min(1, (local + AUDIO_CLOCK_TOLERANCE - cue.startSeconds) / (cue.endSeconds - cue.startSeconds)));
  return { blockId: cue.blockId, offset: Math.min(cue.end - 1e-6, cue.start + (cue.end - cue.start) * fraction) };
}

/** Exact interval starts where possible; subdivision uses the existing visual interval estimate. */
export function audioSetSeek(targets: readonly AudioSourceTarget[], position: SourceAnchor, visualTargets: readonly AudioSourceTarget[] = targets): AudioSourceTarget | undefined {
  const exact = targets.find(target => target.blockId === position.blockId && target.start === position.offset);
  if (exact) return exact;
  const target = visualTargets.find(target => target.blockId === position.blockId && target.start <= position.offset && target.end > position.offset);
  return target ? { ...target, seconds: target.seconds + (target.endSeconds - target.seconds) * (position.offset - target.start) / (target.end - target.start) } : undefined;
}

export function audioVisualTargets(segments: readonly AudioSegment[]): AudioSourceTarget[] {
  return segments.flatMap(segment => segment.displayCues.map(cue => ({ blockId: cue.blockId, start: cue.start, end: cue.end,
    seconds: segment.startSeconds + cue.startSeconds, endSeconds: segment.startSeconds + cue.endSeconds, segmentId: segment.chunk.id })));
}
