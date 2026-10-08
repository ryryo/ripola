import type { AcousticTimingEstimate } from '../generation/contracts';
import type { PlayablePhraseCue } from './audio-clock';

/** Correct only estimated runs; accepted CTC/engine cues and their scores stay unchanged. */
export function applyAcousticTiming(cues: PlayablePhraseCue[], timing: AcousticTimingEstimate | undefined, duration: number): PlayablePhraseCue[] {
  if (!timing || timing.version !== 'ctc-energy-v1' || timing.minimumTokenScore !== .75 || !Number.isSafeInteger(timing.anchorCount) || timing.anchorCount < 2 || !Array.isArray(timing.units)) return cues;
  const source = new Map(cues.map(cue => [cue.unitId, cue.units[0]]));
  const estimates = new Map<string, AcousticTimingEstimate['units'][number]>();
  for (const unit of timing.units) {
    const expected = source.get(unit.unitId);
    if (!expected || estimates.has(unit.unitId) || unit.blockId !== expected.blockId || unit.start !== expected.start || unit.end !== expected.end
      || !Number.isFinite(unit.startSeconds) || !Number.isFinite(unit.endSeconds) || unit.startSeconds < 0 || unit.endSeconds <= unit.startSeconds || unit.endSeconds > duration + 1e-6) return cues;
    estimates.set(unit.unitId, unit);
  }
  const result = [...cues];
  for (let from = 0; from < cues.length;) {
    if (cues[from].timingMethod !== 'estimated') { from++; continue; }
    let to = from + 1;
    while (to < cues.length && cues[to].timingMethod === 'estimated') to++;
    const run = cues.slice(from, to);
    const measured = run.map(cue => estimates.get(cue.unitId));
    if (measured.some(unit => !unit)) { from = to; continue; }
    const lower = run[0].startSeconds, upper = run.at(-1)!.endSeconds;
    const dwell = Math.min(.12, (upper - lower) / (run.length + 1));
    const starts: number[] = [];
    for (const [index, unit] of measured.entries()) {
      const first = index ? starts[index - 1] + dwell : lower;
      const last = upper - (run.length - index) * dwell;
      starts.push(Math.max(first, Math.min(last, unit!.startSeconds)));
    }
    for (const [index, cue] of run.entries()) {
      const end = index + 1 < run.length ? starts[index + 1] : Math.max(starts[index] + dwell, Math.min(upper, measured[index]!.endSeconds));
      result[from + index] = { ...cue, startSeconds: starts[index], endSeconds: end, timingMethod: 'acoustic-estimated', estimatedReason: 'ctc-landmarks-and-pcm-activity' };
    }
    from = to;
  }
  return result;
}
