import { ACOUSTIC_TIMING_VERSION, MIN_ALIGNMENT_SCORE, type AcousticTimingEstimate, type AlignmentUnitResult } from '../contracts';
import type { AlignmentRuntimeResult, SpeechActivity } from './alignment-adapter';

export function validSpeechActivity(value: SpeechActivity | undefined, duration: number): value is SpeechActivity {
  if (!value || value.version !== 'pcm-rms-v1' || value.frameSeconds !== .01 || !Number.isFinite(value.thresholdRms) || value.thresholdRms < .001 || value.thresholdRms > .02
    || !Array.isArray(value.intervals) || !value.intervals.length || value.intervals.length > 6000) return false;
  let previous = 0;
  return value.intervals.every(part => {
    const valid = Number.isFinite(part.startSeconds) && Number.isFinite(part.endSeconds) && part.startSeconds >= previous && part.endSeconds > part.startSeconds && part.endSeconds <= duration + 1e-6;
    previous = part.endSeconds; return valid;
  });
}

/** Interpolate through active audio time; pauses do not consume character progress. */
export function acousticTiming(units: AlignmentUnitResult[], result: AlignmentRuntimeResult): AcousticTimingEstimate | undefined {
  const activity = result.speechActivity;
  if (!validSpeechActivity(activity, result.durationSeconds)) return;
  const reliable = result.segments.filter(segment => segment.status === 'aligned' && segment.confidence >= MIN_ALIGNMENT_SCORE && segment.startSeconds !== undefined && segment.endSeconds !== undefined);
  const weight = result.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  const mean = weight ? result.segments.reduce((sum, segment) => sum + segment.confidence * (segment.end - segment.start), 0) / weight : 0;
  // Keep rejection of clearly mismatched transcripts; never lower the CTC threshold.
  if (reliable.length < 2 || mean < .5) return;
  const activeAt = (time: number) => activity.intervals.reduce((sum, part) => sum + Math.max(0, Math.min(part.endSeconds, time) - part.startSeconds), 0);
  const mediaAt = (amount: number) => {
    for (const part of activity.intervals) {
      const length = part.endSeconds - part.startSeconds;
      if (amount < length - 1e-8) return part.startSeconds + Math.max(0, amount);
      amount -= length;
    }
    return activity.intervals.at(-1)!.endSeconds;
  };
  const points = [{ position: 0, time: activity.intervals[0].startSeconds }];
  for (const segment of reliable) {
    const onset = segment.startSeconds!;
    const region = activity.intervals.find(part => onset >= part.startSeconds - .02 && onset <= part.endSeconds + .02);
    if (!region || segment.start <= points.at(-1)!.position) continue;
    const time = onset - region.startSeconds <= .2 ? region.startSeconds : onset;
    if (time < points.at(-1)!.time) continue;
    points.push({ position: segment.start, time });
  }
  points.push({ position: result.normalizedText.length, time: activity.intervals.at(-1)!.endSeconds });
  const clock = (position: number) => {
    const next = points.findIndex(point => point.position > position);
    if (next < 0) return points.at(-1)!.time;
    if (next === 0) return points[0].time;
    const left = points[next - 1], right = points[next];
    const fraction = (position - left.position) / (right.position - left.position);
    return mediaAt(activeAt(left.time) + Math.max(0, Math.min(1, fraction)) * (activeAt(right.time) - activeAt(left.time)));
  };
  const estimates = units.flatMap(unit => {
    if (!unit.normalizedRanges.length || unit.status === 'unmatched') return [];
    const startSeconds = clock(Math.min(...unit.normalizedRanges.map(range => range.start)));
    const endSeconds = clock(Math.max(...unit.normalizedRanges.map(range => range.end)));
    return endSeconds > startSeconds ? [{ unitId: unit.unitId, blockId: unit.blockId, start: unit.start, end: unit.end, startSeconds, endSeconds }] : [];
  });
  return estimates.length ? { version: ACOUSTIC_TIMING_VERSION, anchorCount: reliable.length, minimumTokenScore: MIN_ALIGNMENT_SCORE, units: estimates } : undefined;
}
