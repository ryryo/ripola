import type { MediaTimingAnchor, MediaTimingMeasurement } from '../../distribution/library';

export const MEDIA_TIMING_POLICY = {
  maximumOffsetSeconds: .25,
  maximumDriftPpm: 1000,
  minimumCorrelation: .8,
  minimumPeakMargin: .015,
  maximumResidualSeconds: .008,
  minimumAnchors: 3,
  minimumPower: 1e-7,
  windowSeconds: .32,
} as const;

function averaged(signal: Float32Array, step: number): Float32Array {
  const output = new Float32Array(Math.floor(signal.length / step));
  for (let index = 0; index < output.length; index++) {
    let sum = 0;
    for (let part = 0; part < step; part++) sum += signal[index * step + part];
    output[index] = sum / step;
  }
  return output;
}
function power(signal: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let index = start; index < start + length; index++) sum += signal[index] ** 2;
  return sum / length;
}
function correlation(source: Float32Array, target: Float32Array, start: number, length: number, lag: number): number {
  if (start + lag < 0 || start + lag + length > target.length) return -1;
  let dot = 0; let sourcePower = 0; let targetPower = 0;
  for (let index = start; index < start + length; index++) {
    const left = source[index]; const right = target[index + lag];
    dot += left * right; sourcePower += left * left; targetPower += right * right;
  }
  const denominator = Math.sqrt(sourcePower * targetPower);
  return denominator > 1e-12 ? Math.max(-1, Math.min(1, dot / denominator)) : -1;
}
function starts(signal: Float32Array, rate: number, length: number): number[] {
  const count = Math.min(5, Math.floor(signal.length / (length * 1.15)));
  if (count < MEDIA_TIMING_POLICY.minimumAnchors) return [];
  const output: number[] = [];
  const room = signal.length - length;
  const hop = Math.max(1, Math.floor(rate * .015));
  for (let bin = 0; bin < count; bin++) {
    // Choose among distinct windows instead of choosing a duplicate peak and
    // discarding the whole bin. Short utterances can otherwise lose an anchor
    // even when a quieter, active, sufficiently separated window is available.
    const first = Math.max(Math.floor(room * bin / count), output.length ? Math.ceil(output[output.length - 1] + length / 2) : 0);
    const last = Math.floor(room * (bin + 1) / count);
    let best = first; let bestPower = -1;
    for (let start = first; start <= last; start += hop) {
      const value = power(signal, start, length);
      if (value > bestPower) { best = start; bestPower = value; }
    }
    if (bestPower >= MEDIA_TIMING_POLICY.minimumPower) output.push(best);
  }
  return output;
}

/** Measure decoded AAC against the same source PCM. Positive offset means AAC speech occurs later. */
export function estimateMediaTiming(source: Float32Array, decoded: Float32Array, sampleRate = 24_000, windowSeconds: number = MEDIA_TIMING_POLICY.windowSeconds): MediaTimingMeasurement {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96_000) throw new Error('PCM sample rate is invalid.');
  if (!Number.isFinite(windowSeconds) || windowSeconds < .08 || windowSeconds > MEDIA_TIMING_POLICY.windowSeconds) throw new Error('PCM correlation window is invalid.');
  if (!source.length || !decoded.length || !source.every(Number.isFinite) || !decoded.every(Number.isFinite)) throw new Error('PCM samples are empty or non-finite.');
  const result: MediaTimingMeasurement = {
    verification: 'unverified', algorithm: 'pcm-normalized-xcorr-v1', sampleRate, windowSeconds,
    sourcePcmDurationSeconds: source.length / sampleRate, decodedPcmDurationSeconds: decoded.length / sampleRate,
    offsetSeconds: 0, scale: 1, driftPpm: 0, maxResidualSeconds: 0, score: 0, anchors: [],
  };
  const step = Math.max(1, Math.round(sampleRate / 3000));
  const coarseRate = sampleRate / step;
  const sourceCoarse = averaged(source, step); const decodedCoarse = averaged(decoded, step);
  const length = Math.round(windowSeconds * coarseRate);
  const anchorStarts = starts(sourceCoarse, coarseRate, length);
  if (anchorStarts.length < MEDIA_TIMING_POLICY.minimumAnchors) return { ...result, reason: 'insufficient-distinct-active-anchors' };
  const maximumLag = Math.round(MEDIA_TIMING_POLICY.maximumOffsetSeconds * coarseRate);
  const exclusion = Math.round(.02 * coarseRate);
  for (const start of anchorStarts) {
    const candidates: Array<{ lag: number; score: number }> = [];
    for (let lag = -maximumLag; lag <= maximumLag; lag++) candidates.push({ lag, score: correlation(sourceCoarse, decodedCoarse, start, length, lag) });
    candidates.sort((left, right) => right.score - left.score || Math.abs(left.lag) - Math.abs(right.lag));
    const best = candidates[0];
    const alternative = candidates.find(candidate => Math.abs(candidate.lag - best.lag) > exclusion);
    const coarseLag = best.lag * step;
    let lag = coarseLag; let score = -1;
    for (let candidate = coarseLag - step * 2; candidate <= coarseLag + step * 2; candidate++) {
      const value = correlation(source, decoded, start * step, length * step, candidate);
      if (value > score) { score = value; lag = candidate; }
    }
    const anchor: MediaTimingAnchor = {
      sourceSeconds: (start * step + length * step / 2) / sampleRate,
      mediaSeconds: (start * step + length * step / 2 + lag) / sampleRate,
      lagSeconds: lag / sampleRate, correlation: score, peakMargin: Math.max(0, best.score - (alternative?.score ?? -1)),
    };
    result.anchors.push(anchor);
  }
  result.score = Math.min(...result.anchors.map(anchor => anchor.correlation));
  if (result.anchors.some(anchor => anchor.correlation < MEDIA_TIMING_POLICY.minimumCorrelation || anchor.peakMargin < MEDIA_TIMING_POLICY.minimumPeakMargin
    || Math.abs(anchor.lagSeconds) >= MEDIA_TIMING_POLICY.maximumOffsetSeconds - .002)) {
    return { ...result, reason: 'low-or-ambiguous-correlation' };
  }
  const center = result.anchors.reduce((sum, anchor) => sum + anchor.sourceSeconds, 0) / result.anchors.length;
  const lagCenter = result.anchors.reduce((sum, anchor) => sum + anchor.lagSeconds, 0) / result.anchors.length;
  const slope = result.anchors.reduce((sum, anchor) => sum + (anchor.sourceSeconds - center) * (anchor.lagSeconds - lagCenter), 0)
    / result.anchors.reduce((sum, anchor) => sum + (anchor.sourceSeconds - center) ** 2, 0);
  result.offsetSeconds = lagCenter - slope * center;
  result.scale = 1 + slope;
  result.driftPpm = slope * 1_000_000;
  result.maxResidualSeconds = Math.max(...result.anchors.map(anchor => Math.abs(anchor.lagSeconds - result.offsetSeconds - slope * anchor.sourceSeconds)));
  if (Math.abs(result.driftPpm) > MEDIA_TIMING_POLICY.maximumDriftPpm || result.maxResidualSeconds > MEDIA_TIMING_POLICY.maximumResidualSeconds
    || Math.abs(result.offsetSeconds) > MEDIA_TIMING_POLICY.maximumOffsetSeconds) return { ...result, reason: 'unstable-or-excessive-clock-drift' };
  result.verification = 'pcm-correlated';
  return result;
}

/** Short headings cannot contain three 320 ms windows. Re-measure them with
 * 80 ms windows while keeping the same anchor, power, correlation and ambiguity
 * requirements. Gapless frame/clock identity is separately checked by the MP3
 * validator; a short duration alone never establishes synchronization. */
export function estimateMp3Timing(source: Float32Array, decoded: Float32Array): MediaTimingMeasurement {
  const measurement = estimateMediaTiming(source, decoded);
  return measurement.reason === 'insufficient-distinct-active-anchors'
    ? estimateMediaTiming(source, decoded, 24_000, .08)
    : measurement;
}
