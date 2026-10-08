import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjacentAudioPhrase, audioDisplayAt, audioPhraseTargets, audioSegments, audioTimeLabel, locateAudioTime, mediaPosition, type AudioSegment, type PlayableAudioBook } from '../src/reader/audio-clock.ts';
import type { AudioBookManifest, SavedAlignment } from '../src/generation/contracts.ts';
import type { ReadingUnit } from '../src/reader/model.ts';

const segments: AudioSegment[] = [2, 3, 5].map((duration, index) => ({
  chunk: { id: String(index), speechKey: String(index), audioUrl: '', mimeType: 'audio/wav', durationSeconds: duration, timeline: [] },
  startSeconds: [0, 2, 5][index], endSeconds: [2, 5, 10][index], text: '', displayCues: [],
}));

test('audio seeking uses actual media seconds across sentence boundaries and clamps invalid values', () => {
  assert.deepEqual(locateAudioTime(segments, 1.5), { index: 0, localSeconds: 1.5 });
  assert.deepEqual(locateAudioTime(segments, 2), { index: 1, localSeconds: 0 });
  assert.deepEqual(locateAudioTime(segments, 7), { index: 2, localSeconds: 2 });
  assert.deepEqual(locateAudioTime(segments, 100), { index: 2, localSeconds: 5 });
  assert.deepEqual(locateAudioTime(segments, -1), { index: 0, localSeconds: 0 });
  assert.deepEqual(locateAudioTime(segments, NaN), { index: 0, localSeconds: 0 });
  assert.deepEqual(locateAudioTime([], 10), { index: 0, localSeconds: 0 });
});

test('paused or buffering display is anchored to the media clock rather than wall time or playback rate', () => {
  assert.equal(mediaPosition(segments[1], 1.25), 3.25);
  assert.equal(mediaPosition(segments[1], 1.25), 3.25);
  assert.equal(mediaPosition(segments[1], 100), 5);
  assert.equal(mediaPosition(segments[1], -1), 2);
  assert.equal(mediaPosition(undefined, 10), 0);
});

test('natural completion keeps the exact saved boundary when MP3 duration is rounded by the browser', () => {
  const duration = 14.325333333333333;
  const segment: AudioSegment = { ...segments[2], chunk: { ...segments[2].chunk, mimeType: 'audio/mpeg', durationSeconds: duration }, endSeconds: segments[2].startSeconds + duration };
  const decoderTime = 14.325333;
  assert.ok(mediaPosition(segment, decoderTime) < segment.endSeconds);
  assert.equal(mediaPosition(segment, decoderTime, true), segment.endSeconds);
  assert.equal(mediaPosition(segment, decoderTime - 5, false), segment.startSeconds + decoderTime - 5);
});

test('saved audio uses original manuscript sentence offsets and ignores unusable durations', () => {
  const book = {
    document: { blocks: [{ id: 'b', text: '朝です。窓を開く。' }] },
    chunks: [
      { ...segments[0].chunk, timeline: [{ blockId: 'b', start: 0, end: 4 }] },
      { ...segments[1].chunk, timeline: [{ blockId: 'b', start: 4, end: 9 }] },
      { ...segments[2].chunk, durationSeconds: NaN },
    ],
  } as unknown as AudioBookManifest;
  const mapped = audioSegments(book);
  assert.deepEqual(mapped.map(segment => segment.text), ['朝です。', '窓を開く。']);
  assert.deepEqual(mapped.map(segment => [segment.startSeconds, segment.endSeconds]), [[0, 2], [2, 5]]);
  assert.equal(audioTimeLabel(3671), '1:01:11');
});

function readingUnit(id: string, text: string, start: number): ReadingUnit {
  return { id, text, start, end: start + text.length, blockId: 'b', kind: 'text', characters: text.length, cumulativeCharacters: start,
    mapping: 'exact', ruby: [], pause: 'none', sources: [{ kind: 'text', start, end: start + text.length }] };
}
function alignedBook(): PlayableAudioBook {
  const units = [readingUnit('u0', '私は', 0), readingUnit('u1', '図書館へ。', 2), readingUnit('u2', '次の', 7), readingUnit('u3', '文。', 9)];
  units[1].ruby = [{ start: 0, end: 3, reading: 'としょかん' }];
  const alignment = (from: number, to: number, times: number[][]): SavedAlignment => ({
    schemaVersion: 1, key: 'k', audioHash: 'h', normalizeVersion: 'n', alignerVersion: 'a', precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .92,
    cues: units.slice(from, to).map((unit, index) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end, startSeconds: times[index][0], endSeconds: times[index][1], score: .92 })), units: [], warnings: [],
  });
  return { id: 'book', revision: 'r', title: '自作文', completedChunks: 2, totalChunks: 2, warnings: [],
    document: { blocks: [{ id: 'b', text: '私は図書館へ。次の文。', kind: 'paragraph', ruby: [], runs: [] }], units },
    chunks: [
      { id: 'c0', audioUrl: '/c0.wav', durationSeconds: 4, timeline: [{ blockId: 'b', start: 0, end: 7 }], alignment: alignment(0, 2, [[.2, 1.3], [1.5, 3.8]]) },
      { id: 'c1', audioUrl: '/c1.wav', durationSeconds: 3, timeline: [{ blockId: 'b', start: 7, end: 11 }], alignment: alignment(2, 4, [[0, 1.2], [1.2, 2.8]]) },
    ] };
}

test('an exact phrase seek survives microsecond media truncation and chunk offset cancellation', () => {
  const book = alignedBook(); const cut = .5653333333333334;
  book.chunks[0].alignment!.cues[0].endSeconds = cut;
  book.chunks[0].alignment!.cues[1].startSeconds = cut;
  const segment = audioSegments(book)[0]; const localSeconds = 3.168 + cut - 3.168;
  assert.ok(localSeconds < cut);
  assert.equal(audioDisplayAt(segment, localSeconds).text, '図書館へ。');
  assert.equal(audioDisplayAt(segment, Math.floor(cut * 1e6) / 1e6).text, '図書館へ。');
  assert.equal(audioDisplayAt(segment, cut - 0.0001).text, '私は');
});

test('the media clock changes original BudouX units inside one audio file while preserving ruby and UTF-16 source mapping', () => {
  const book = alignedBook();
  const mapped = audioSegments(book);
  const first = audioDisplayAt(mapped[0], .4);
  const second = audioDisplayAt(mapped[0], 2);
  assert.equal(first.precision, 'phrase'); assert.equal(first.text, '私は');
  assert.equal(second.text, '図書館へ。');
  assert.strictEqual(second.units[0], book.document.units![1]);
  assert.deepEqual(second.units[0].ruby, [{ start: 0, end: 3, reading: 'としょかん' }]);
  assert.deepEqual(second.units[0].sources, [{ kind: 'text', start: 2, end: 7 }]);
  assert.equal(mapped[0].chunk.audioUrl, '/c0.wav');
  assert.deepEqual(locateAudioTime(mapped, 2), { index: 0, localSeconds: 2 });
  assert.equal(audioDisplayAt(mapped[1], 0).text, '次の');
  assert.deepEqual(locateAudioTime(mapped, 4), { index: 1, localSeconds: 0 });
});

test('gaps, silence, mismatched readings and low scores retain every phrase with explicitly estimated timing', () => {
  const book = alignedBook();
  let mapped = audioSegments(book);
  assert.equal(audioDisplayAt(mapped[0], .1).method, 'estimated');
  assert.equal(audioDisplayAt(mapped[0], 1.4).method, 'estimated');
  assert.equal(audioDisplayAt(mapped[0], 3.9).method, 'estimated');
  book.chunks[0].alignment!.cues[0].score = .4;
  mapped = audioSegments(book);
  assert.equal(audioDisplayAt(mapped[0], .4).method, 'estimated');
  assert.equal(audioDisplayAt(mapped[0], .4).text, '私は');
  assert.equal(audioDisplayAt(mapped[0], .4).score, undefined);
  assert.equal(book.chunks[0].alignment!.cues[0].score, .4);
  assert.equal(audioDisplayAt(mapped[0], 2).precision, 'phrase');
  book.chunks[0].alignment = { ...book.chunks[0].alignment!, status: 'fallback', precision: 'sentence', method: 'sentence-fallback', score: 0, reason: '無音のため整列できません。', cues: [] };
  mapped = audioSegments(book);
  assert.equal(audioDisplayAt(mapped[0], 2).text, '図書館へ。');
  assert.equal(book.chunks[0].alignment!.reason, '無音のため整列できません。');
  assert.equal(audioDisplayAt(mapped[0], 2).score, undefined);
  book.chunks[0].alignment!.reason = '読みが一致せず、フレーズ時刻を確定できません。';
  assert.equal(audioDisplayAt(audioSegments(book)[0], 2).method, 'estimated');
});

test('cue IDs, contiguous source ranges and timing bounds are validated before phrase playback', () => {
  const book = alignedBook();
  const cue = book.chunks[0].alignment!.cues[1];
  cue.unitIds = ['does-not-exist'];
  assert.equal(audioDisplayAt(audioSegments(book)[0], 2).method, 'estimated');
  cue.unitIds = ['u1']; cue.start = 1;
  assert.equal(audioDisplayAt(audioSegments(book)[0], 2).method, 'estimated');
  cue.start = 2; cue.endSeconds = 100;
  assert.equal(audioDisplayAt(audioSegments(book)[0], 2).method, 'estimated');
  cue.endSeconds = 3.8; cue.startSeconds = .1;
  assert.equal(audioDisplayAt(audioSegments(book)[0], 2).method, 'estimated');
});

test('many-to-many reading cues preserve each original unit and phrase navigation seeks the same or next media file', () => {
  const book = alignedBook();
  const alignment = book.chunks[0].alignment!;
  alignment.cues = [{ ...alignment.cues[0], unitIds: ['u0', 'u1'], start: 0, end: 7, startSeconds: .2, endSeconds: 3.8 }];
  const mapped = audioSegments(book);
  const display = audioDisplayAt(mapped[0], 2);
  assert.deepEqual(display.unitIndices, [1]);
  assert.equal(display.method, 'estimated');
  assert.equal(display.text, '図書館へ。');
  assert.strictEqual(display.units[0], book.document.units![1]);
  const targets = audioPhraseTargets(mapped);
  assert.equal(adjacentAudioPhrase(targets, 2, 1)?.segmentIndex, 1);
  assert.equal(adjacentAudioPhrase(targets, 4, -1)?.segmentIndex, 0);
  assert.equal(adjacentAudioPhrase(targets, 6.9, -1)?.cue.unitId, 'u3');
  assert.equal(adjacentAudioPhrase(targets, 6.9, 1), undefined);
});

test('the original UTF-16 offsets survive emoji and normalized speech without splitting a surrogate sequence', () => {
  const book = alignedBook();
  const unit = readingUnit('unicode', '👩‍💻は', 0);
  book.document.blocks[0].text = '👩‍💻は'; book.document.units = [unit];
  book.chunks = [{ ...book.chunks[0], timeline: [{ blockId: 'b', start: 0, end: 6 }], alignment: { ...book.chunks[0].alignment!, cues: [{ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: 0, end: 6, startSeconds: 0, endSeconds: 3, score: .9 }] } }];
  assert.equal(audioDisplayAt(audioSegments(book)[0], 1).text, '👩‍💻は');
  book.chunks[0].alignment!.cues[0].start = 1;
  assert.equal(audioDisplayAt(audioSegments(book)[0], 1).method, 'estimated');
});


test('all phrases stay reachable once and in source order, including unaligned chunks and natural completion', () => {
  const book = alignedBook();
  book.chunks[0].alignment = undefined;
  const mapped = audioSegments(book);
  assert.deepEqual(audioPhraseTargets(mapped).map(target => target.cue.unitId), ['u0', 'u1', 'u2', 'u3']);
  for (const segment of mapped) {
    for (const cue of segment.displayCues!) {
      const display = audioDisplayAt(segment, (cue.startSeconds + cue.endSeconds) / 2);
      assert.deepEqual(display.units.map(unit => unit.id), [cue.unitId]);
      assert.equal(display.text, cue.units[0].text);
    }
    assert.equal(audioDisplayAt(segment, segment.chunk.durationSeconds).text, segment.displayCues!.at(-1)!.units[0].text);
  }
});

test('a sub-frame acoustic cue is preserved as evidence but estimated for visible phrase playback', () => {
  const book = alignedBook();
  book.chunks[0].alignment!.cues[0].endSeconds = .22;
  const mapped = audioSegments(book);
  assert.equal(mapped[0].cues![0].endSeconds, .22);
  const cue = mapped[0].displayCues![0];
  assert.equal(cue.timingMethod, 'estimated');
  assert.ok(cue.endSeconds - cue.startSeconds >= .12);
  assert.equal(cue.score, undefined);
  assert.deepEqual(mapped[0].displayCues!.map(value => value.unitId), ['u0', 'u1']);
});


test('a transient negative local clock at a chunk transition holds the first source phrase', () => {
  const segment = audioSegments(alignedBook())[1];
  assert.equal(audioDisplayAt(segment, -0.001).text, '次の');
  assert.equal(audioDisplayAt(segment, -0.001).precision, 'phrase');
  assert.equal(audioDisplayAt(segment, 100).text, '文。');
});


test('next phrase at leading silence advances beyond the first source phrase', () => {
  const book = alignedBook();
  const segments = audioSegments(book);
  assert.ok(segments[0].displayCues[0].startSeconds > 0);
  const targets = audioPhraseTargets(segments);
  assert.equal(targets[0].seconds, 0);
  assert.equal(adjacentAudioPhrase(targets, 0, 1)?.cue.unitId, 'u1');
});
