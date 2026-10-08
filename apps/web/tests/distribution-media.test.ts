import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateMediaTiming, estimateMp3Timing, MEDIA_TIMING_POLICY } from '../../../scripts/media-timing.ts';
import { publicAlignment } from '../../../scripts/public-alignment.ts';
import { validatePublicMediaMetadata } from '../../../scripts/distribution-utils.mjs';
import type { AudioTimelineEntry, SavedAlignment } from '../src/generation/contracts.ts';
import type { MediaTimingMeasurement } from '../src/distribution/library.ts';
import type { ReadingDocument } from '../src/reader/model.ts';

const rate = 24_000;
function signal(seconds = 5) {
  const samples = new Float32Array(Math.round(rate * seconds));
  let state = 12345; let filtered = 0;
  for (let index = 0; index < samples.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    filtered = filtered * .97 + (state / 2 ** 32 - .5) * .03;
    const time = index / rate;
    const envelope = .6 + .35 * Math.sin(time * 6.71) ** 2;
    samples[index] = (filtered + .01 * Math.sin(time * time * 37)) * envelope;
  }
  return samples;
}
function shifted(source: Float32Array, offset: number, scale = 1) {
  const samples = new Float32Array(Math.ceil(source.length * scale + Math.max(0, offset) * rate + rate * .05));
  for (let index = 0; index < samples.length; index++) {
    const position = (index - offset * rate) / scale;
    const left = Math.floor(position);
    if (left >= 0 && left + 1 < source.length) samples[index] = source[left] * (1 - position + left) + source[left + 1] * (position - left);
  }
  return samples;
}

test('PCM correlation measures an actual positive delay without using duration as a proxy', () => {
  const source = signal(); const result = estimateMediaTiming(source, shifted(source, .0475));
  assert.equal(result.verification, 'pcm-correlated');
  assert.ok(Math.abs(result.offsetSeconds - .0475) <= 1 / rate);
  assert.ok(Math.abs(result.driftPpm) < 1);
  assert.ok(result.anchors.length >= MEDIA_TIMING_POLICY.minimumAnchors);
  assert.ok(result.score > .99);
});

test('PCM correlation measures clock drift and rejects a transform outside the accepted drift policy', () => {
  const source = signal(8); const result = estimateMediaTiming(source, shifted(source, .025, 1.0006));
  assert.equal(result.verification, 'pcm-correlated');
  assert.ok(Math.abs(result.offsetSeconds - .025) < .002);
  assert.ok(Math.abs(result.driftPpm - 600) < 100);
  const rejected = estimateMediaTiming(source, shifted(source, .025, 1.004));
  assert.equal(rejected.verification, 'unverified');
});

test('a short utterance with a shared loud peak still provides three distinct active timing anchors', () => {
  const source = signal(1.45);
  for (let index = 0; index < source.length; index++) {
    const time = index / rate;
    source[index] *= .15 + 3 * Math.exp(-(((time - .55) / .15) ** 2));
  }
  const result = estimateMediaTiming(source, shifted(source, .032));
  assert.equal(result.verification, 'pcm-correlated');
  assert.ok(result.anchors.length >= 3);
  assert.ok(Math.abs(result.offsetSeconds - .032) <= 1 / rate);
  for (let index = 1; index < result.anchors.length; index++) {
    assert.ok(result.anchors[index].sourceSeconds - result.anchors[index - 1].sourceSeconds >= MEDIA_TIMING_POLICY.windowSeconds / 2 - 1 / rate);
  }
});

test('silence and repeated periodic waves do not create a claimed codec timing verification', () => {
  assert.equal(estimateMediaTiming(new Float32Array(rate * 3), new Float32Array(rate * 3)).verification, 'unverified');
  const tone = Float32Array.from({ length: rate * 3 }, (_, index) => Math.sin(index * Math.PI * 2 * 440 / rate) * .1);
  assert.equal(estimateMediaTiming(tone, shifted(tone, .06)).verification, 'unverified');
  assert.throws(() => estimateMediaTiming(new Float32Array([NaN]), new Float32Array([1])));
});

test('short MP3 windows still detect a displaced clock and reject silence and periodic ambiguity', () => {
  const source = signal(.75), sameFrames = shifted(source, .003).slice(0, source.length);
  const measured = estimateMp3Timing(source, sameFrames);
  assert.equal(measured.verification, 'pcm-correlated');
  assert.ok(Math.abs(measured.offsetSeconds - .003) <= 1 / rate);
  assert.equal(measured.windowSeconds, .08);
  const silence = new Float32Array(rate * .75);
  assert.equal(estimateMp3Timing(silence, silence).verification, 'unverified');
  const tone = Float32Array.from({ length: rate * .75 }, (_, index) => Math.sin(index * Math.PI * 2 * 440 / rate) * .1);
  assert.equal(estimateMp3Timing(tone, tone).verification, 'unverified');
});

const hash = 'a'.repeat(64);
const document: ReadingDocument = {
  id: 'book', contentHash: hash, title: '自作文', format: 'txt', rawText: '朝の光を見ます。',
  blocks: [{ id: 'b', kind: 'paragraph', text: '朝の光を見ます。', runs: [], ruby: [] }],
  units: ['朝の', '光を', '見ます。'].map((text, index) => ({
    id: `u${index}`, blockId: 'b', kind: 'text', start: [0, 2, 4][index], end: [2, 4, 8][index], text, sources: [], mapping: 'exact', ruby: [], characters: text.length, cumulativeCharacters: [0, 2, 4][index], pause: 'none',
  })), totalCharacters: 8, versions: { parser: 'test', model: 'test', rules: 'test' }, warnings: [],
};
const sentence: AudioTimelineEntry[] = [{ chunkId: 'c', blockId: 'b', start: 0, end: 8, unitIds: ['u0', 'u1', 'u2'], startSeconds: 0, endSeconds: 3, precision: 'sentence' }];
function alignment(): SavedAlignment {
  return { schemaVersion: 1, key: 'private-cache-key', audioHash: hash, normalizeVersion: 'ctc-ja-nfkc-v1', alignerVersion: 'test-v1',
    precision: 'phrase', method: 'forced-alignment', status: 'partial', score: .8, reason: '/private/raw/error', warnings: ['/private/log'],
    cues: [{ unitId: 'u0', unitIds: ['u0'], blockId: 'b', start: 0, end: 2, startSeconds: .3, endSeconds: .7, score: .95 },
      { unitId: 'u1', unitIds: ['u1'], blockId: 'b', start: 2, end: 4, startSeconds: .9, endSeconds: 1.3, score: .2 }],
    units: document.units.map((unit, index) => ({ unitId: unit.id, blockId: 'b', start: unit.start, end: unit.end, spokenRanges: [{ start: 100, end: 101 }], normalizedRanges: [{ start: 0, end: 1 }], score: index === 0 ? .95 : .2, status: index === 0 ? 'aligned' : index === 1 ? 'low-confidence' : 'unmatched', reason: '/private/reason' })),
  };
}
const timing: MediaTimingMeasurement = { verification: 'pcm-correlated', algorithm: 'pcm-normalized-xcorr-v1', sampleRate: rate,
  sourcePcmDurationSeconds: 3, decodedPcmDurationSeconds: 3.04, offsetSeconds: .02, scale: 1.0005, driftPpm: 500, maxResidualSeconds: .0005, score: .99, anchors: [] };

test('public cue projection applies measured offset and scale, excludes private metadata and preserves low-score fallback', () => {
  const result = publicAlignment(alignment(), document, sentence, hash, 3, 3.04, timing);
  assert.equal(result.precision, 'phrase'); assert.equal(result.status, 'partial'); assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].startSeconds, .3 * timing.scale + timing.offsetSeconds);
  assert.equal(result.cues[0].endSeconds, .7 * timing.scale + timing.offsetSeconds);
  assert.deepEqual(result.units.map(unit => unit.status), ['aligned', 'low-confidence', 'unmatched']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('spokenRanges'), false);
  assert.equal(JSON.stringify(result).includes('normalizedRanges'), false);
});

test('a stale audio hash, unverified codec mapping, invalid positions and overlapping cues preserve sentence fallback', () => {
  const saved = alignment();
  assert.equal(publicAlignment(saved, document, sentence, 'b'.repeat(64), 3, 3.04, timing).precision, 'sentence');
  assert.equal(publicAlignment(saved, document, sentence, hash, 3, 3.04, { ...timing, verification: 'unverified' }).precision, 'sentence');
  assert.equal(publicAlignment({ ...saved, cues: [{ ...saved.cues[0], unitIds: ['unknown'] }] }, document, sentence, hash, 3, 3.04, timing).precision, 'sentence');
  const overlapping = { ...saved, units: saved.units.map(unit => ({ ...unit, status: 'aligned' as const, score: .9 })),
    cues: [{ ...saved.cues[0], endSeconds: 1.1 }, { ...saved.cues[1], score: .9 }] };
  assert.equal(publicAlignment(overlapping, document, sentence, hash, 3, 3.04, timing).precision, 'sentence');
});

test('unit-level low confidence wins over a contradictory high-score cue', () => {
  const saved = alignment(); saved.units[0].status = 'low-confidence'; saved.units[0].score = .2;
  assert.equal(publicAlignment(saved, document, sentence, hash, 3, 3.04, timing).precision, 'sentence');
});

test('upload audit rejects unverified phrase timing, low-score cues and private alignment metadata', () => {
  const codec = { ...timing, sourceAudioHash: hash, sourcePcmHash: hash, decodedPcmHash: hash, durationDeltaSeconds: .04,
    anchors: [.5, 1.5, 2.5].map(sourceSeconds => ({ sourceSeconds, mediaSeconds: sourceSeconds * timing.scale + timing.offsetSeconds,
      lagSeconds: sourceSeconds * (timing.scale - 1) + timing.offsetSeconds, correlation: .99, peakMargin: .2 })) };
  const projected = publicAlignment(alignment(), document, sentence, hash, 3, 3.04, codec);
  const chunk = { timing: codec, alignment: projected, sourceDurationSeconds: 3, durationSeconds: 3.04 };
  assert.doesNotThrow(() => validatePublicMediaMetadata(chunk));
  assert.throws(() => validatePublicMediaMetadata({ ...chunk, timing: { ...codec, verification: 'unverified' } }), /measured PCM/);
  assert.throws(() => validatePublicMediaMetadata({ ...chunk, alignment: { ...projected, key: 'private-key' } }), /private/);
  assert.throws(() => validatePublicMediaMetadata({ ...chunk, alignment: { ...projected, cues: [{ ...projected.cues[0], score: .2 }] } }), /below/);
  assert.throws(() => validatePublicMediaMetadata({ ...chunk, timing: { ...codec, runtimePath: '/private/model' } }), /invalid/);
});


test('sound-assisted estimates survive measured AAC clock conversion without becoming aligned or exposing transcript', () => {
  const saved = alignment();
  saved.acoustic = { version: 'ctc-energy-v1', minimumTokenScore: .75, anchorCount: 3,
    units: [{ unitId: 'u1', blockId: 'b', start: 2, end: 4, startSeconds: 1.1, endSeconds: 1.6 }] };
  const result = publicAlignment(saved, document, sentence, hash, 3, 3.04, timing);
  assert.equal(result.acoustic!.units[0].startSeconds, 1.1 * timing.scale + timing.offsetSeconds);
  assert.equal(result.units[1].status, 'low-confidence');
  assert.equal('score' in result.acoustic!.units[0], false);
  assert.equal(JSON.stringify(result.acoustic).includes('normalized'), false);
  assert.equal(publicAlignment(saved, document, sentence, hash, 3, 3.04, { ...timing, verification: 'unverified' }).acoustic, undefined);
  saved.acoustic.units[0].start = 1;
  assert.equal(publicAlignment(saved, document, sentence, hash, 3, 3.04, timing).acoustic, undefined);
});
