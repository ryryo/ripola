import type { InspectionIssue, PcmMetrics, TimeRange } from './contracts';

/** Broad warning thresholds, not loudness mastering or a speech/activity timing estimate. */
export function inspectPcm(channels: readonly Float32Array[], sampleRate: number, characters: number, expectedDuration?: number): { metrics: PcmMetrics; issues: InspectionIssue[] } {
  const frames = channels[0]?.length ?? 0;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !frames || frames / sampleRate > 120
    || !channels.length || channels.length > 8 || channels.some(channel => channel.length !== frames)
    || !Number.isSafeInteger(characters) || characters < 0) throw new Error('invalid-pcm');
  const width = Math.max(1, Math.round(sampleRate * .02));
  const rmsFrames: number[] = [];
  const clippingFrames: boolean[] = [];
  let total = 0, peak = 0, clippedSamples = 0, run = 0, clippedFrame = false;
  for (let frame = 0; frame < frames; frame++) {
    let energy = 0, clipped = false;
    for (const channel of channels) {
      const sample = channel[frame];
      if (!Number.isFinite(sample) || Math.abs(sample) > 1.5) throw new Error('invalid-pcm-sample');
      energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
      if (Math.abs(sample) >= .999) { clipped = true; clippedSamples++; }
    }
    total += energy;
    const current = Math.floor(frame / width);
    rmsFrames[current] = (rmsFrames[current] ?? 0) + energy / channels.length;
    // Single near-full-scale samples do not establish clipping; require a plateau >= 0.5 ms.
    run = clipped ? run + 1 : 0;
    clippedFrame ||= run >= Math.max(3, Math.ceil(sampleRate * .0005));
    if ((frame + 1) % width === 0 || frame === frames - 1) { clippingFrames.push(clippedFrame); clippedFrame = false; }
  }
  const rmsValues = rmsFrames.map((energy, i) => Math.sqrt(energy / Math.min(width, frames - i * width)));
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const threshold = Math.max(.0005, Math.min(.003, sorted[Math.floor(sorted.length * .9)] * .04));
  const silent = rmsValues.map(value => value < threshold);
  const durationSeconds = frames / sampleRate;
  const ranges = (flags: boolean[]): TimeRange[] => {
    const result: TimeRange[] = []; let begin = -1;
    for (let i = 0; i <= flags.length; i++) {
      if (flags[i] && begin < 0) begin = i;
      if (!flags[i] && begin >= 0) {
        result.push({ startSeconds: begin * width / sampleRate, endSeconds: Math.min(durationSeconds, i * width / sampleRate) }); begin = -1;
      }
    }
    return result;
  };
  const silence = ranges(silent).filter(part => part.endSeconds - part.startSeconds >= .3);
  const clipped = ranges(clippingFrames);
  const metrics: PcmMetrics = { durationSeconds, sampleRate, channels: channels.length, rms: Math.sqrt(total / (frames * channels.length)), peak,
    clippingRatio: clippedSamples / (frames * channels.length), silentRatio: silent.reduce((sum, flag, i) => sum + (flag ? Math.min(width, frames - i * width) : 0), 0) / frames,
    silenceThresholdRms: threshold, characters, charactersPerSecond: characters / durationSeconds, silence: silence.slice(0, 100), clipped: clipped.slice(0, 100) };
  const issues: InspectionIssue[] = [];
  if (metrics.rms < .0005 || metrics.silentRatio > .98) issues.push({ severity: 'warning', code: 'silent-audio', message: '音声全体が無音または非常に小さい音です。', audio: { startSeconds: 0, endSeconds: durationSeconds } });
  else for (const part of silence.filter(part => part.endSeconds - part.startSeconds >= Math.max(2, durationSeconds * .35)).slice(0, 10)) issues.push({ severity: 'warning', code: 'long-silence', message: '長い無音区間があります。意図した間か確認してください。', audio: part });
  if (metrics.clippingRatio >= .001 && clipped.length) issues.push({ severity: 'warning', code: 'clipping', message: 'ピーク付近に連続した飽和があります。音割れの疑いを確認してください。', audio: clipped[0] });
  if (characters >= 8 && (metrics.charactersPerSecond > 18 || metrics.charactersPerSecond < .8)) issues.push({ severity: 'warning', code: 'extreme-rate', message: `本文${characters}文字に対して${durationSeconds.toFixed(2)}秒です。飛ばし・繰り返し・速度の疑いを確認してください。` });
  if (expectedDuration !== undefined && (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || Math.abs(expectedDuration - durationSeconds) > Math.max(.15, expectedDuration * .02))) issues.push({ severity: 'fatal', code: 'duration-mismatch', message: '保存された音声時計と復号したdurationが一致しません。' });
  return { metrics, issues };
}
