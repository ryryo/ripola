import assert from 'node:assert/strict';
import { cpus, loadavg, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { estimateSpeechSeconds, planSpeechChunks, CHUNK_PLANNER_VERSION } from '../apps/web/src/generation/core/chunk-planner.ts';
import { fixturePolicy, plannerFixtures } from '../apps/web/tests/fixtures/speech-chunk-planner.ts';

// Planner CPU time only. No service, credentials, provider, TTS, ASR or model downloads.
const segmenter = new Intl.Segmenter('ja', { granularity: 'sentence' });
function legacy(text: string) {
  return [...segmenter.segment(text)].filter(part => part.segment.trim()).map(part => ({ start: part.index, end: part.index + part.segment.length, text: part.segment }));
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minimumMs: sorted[0], maximumMs: sorted[sorted.length - 1] };
}
function estimate(chunks: Array<{ text: string }>) {
  const seconds = chunks.reduce((sum, chunk) => sum + estimateSpeechSeconds(chunk.text.trim()), 0);
  return { requests: chunks.length, estimatedSpeechSeconds: seconds,
    estimatedFixedOverheadSeconds: chunks.length * fixturePolicy.estimatedRequestOverheadSeconds,
    estimatedSerialSynthesisSeconds: seconds + chunks.length * fixturePolicy.estimatedRequestOverheadSeconds };
}
const conditions = { node: process.version, icu: process.versions.icu, platform: platform(), arch: arch(), cpuCount: cpus().length, loadAverageBefore: loadavg() };
const cases = plannerFixtures.map(fixture => {
  const input = { blockId: fixture.id, text: fixture.text };
  const whitespaceOnly = [...segmenter.segment(fixture.text)].filter(part => !part.segment.trim()).map(part => ({ start: part.index, text: part.segment }));
  legacy(fixture.text); planSpeechChunks(input, fixturePolicy); // Warm up both sides.
  const beforeTimes: number[] = []; const afterTimes: number[] = [];
  let before = legacy(fixture.text); let after = planSpeechChunks(input, fixturePolicy);
  // Alternate which side goes first across five repetitions.
  for (let run = 0; run < 5; run++) {
    const measureBefore = () => { const start = performance.now(); before = legacy(fixture.text); beforeTimes.push(performance.now() - start); };
    const measureAfter = () => { const start = performance.now(); after = planSpeechChunks(input, fixturePolicy); afterTimes.push(performance.now() - start); };
    if (run % 2) { measureAfter(); measureBefore(); } else { measureBefore(); measureAfter(); }
    assert.equal([...before, ...whitespaceOnly].sort((a, b) => a.start - b.start).map(chunk => chunk.text).join(''), fixture.text);
    assert.equal(after.chunks.map(chunk => chunk.text).join(''), fixture.text);
    assert.equal(after.hash, planSpeechChunks(input, fixturePolicy).hash);
  }
  const rejected = before.some(chunk => chunk.text.length > 3000);
  return { id: fixture.id, sourceUtf16Length: fixture.text.length,
    legacy: { status: rejected ? 'rejected-by-legacy-3000-utf16-limit' : 'plannable', skippedWhitespaceUtf16: whitespaceOnly.reduce((sum, part) => sum + part.text.length, 0), ...estimate(before), cpu: distribution(beforeTimes) },
    automatic: { status: 'plannable', ...estimate(after.chunks), cpu: distribution(afterTimes), hash: after.hash },
    coverage: 'exact-ordered', errors: 0 };
});
console.log(JSON.stringify({ schemaVersion: 1, plannerVersion: CHUNK_PLANNER_VERSION,
  measurement: 'planner CPU only; estimated synthesis scenarios are not TTS measurements',
  scenario: { policy: fixturePolicy, assumedRealTimeFactor: 1, fixedRequestOverheadSeconds: fixturePolicy.estimatedRequestOverheadSeconds, samplesPerSide: 5, ordering: 'AB/BA alternating, warmup excluded', serviceCache: 'not used' },
  conditions: { ...conditions, loadAverageAfter: loadavg() }, cases }, null, 2));
