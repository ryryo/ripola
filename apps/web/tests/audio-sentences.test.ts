import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioSegments, type PlayableAudioBook } from '../src/reader/audio-clock';
import { audioSentenceIndexAt, audioSentenceTargets } from '../src/reader/audio-sentences';
import type { ReadingUnit } from '../src/reader/model';

function bookWithChunks(pieces: string[], ranges: Array<[number, number]>): PlayableAudioBook {
  let offset = 0;
  const units: ReadingUnit[] = pieces.map((text, index) => {
    const start = offset; offset += text.length;
    return { id: `u${index}`, blockId: 'b', kind: 'text', text, start, end: offset, ruby: [], sources: [{ kind: 'text', start, end: offset }],
      mapping: 'exact', characters: text.length, cumulativeCharacters: start, pause: 'none' };
  });
  return { id: 'book', revision: 'r1', title: '原文の文移動', document: { blocks: [{ id: 'b', text: pieces.join(''), kind: 'paragraph', ruby: [], runs: [] }], units },
    chunks: ranges.map(([start, end], index) => ({ id: `c${index}`, audioUrl: `/c${index}.wav`, durationSeconds: 9, timeline: [{ blockId: 'b', start, end }] })),
    warnings: [], completedChunks: ranges.length, totalChunks: ranges.length };
}

test('three source sentences inside one automatic audio chunk remain three navigation destinations', () => {
  const book = bookWithChunks(['朝です。', '窓を', '開く。', '最後です。'], [[0, 14]]);
  const segments = audioSegments(book);
  assert.equal(segments.length, 1);
  const targets = audioSentenceTargets(book, segments);
  assert.deepEqual(targets.map(target => target.text), ['朝です。', '窓を開く。', '最後です。']);
  assert.deepEqual(targets.map(target => target.segmentIndex), [0, 0, 0]);
  assert.equal(targets[0].seconds, 0);
  assert.ok(targets[1].seconds > targets[0].seconds);
  assert.ok(targets[2].seconds > targets[1].seconds);
});

test('one source sentence split across two automatic chunks is one navigation destination', () => {
  const book = bookWithChunks(['長い文を', '二つの音声で', '読みます。', '次です。'], [[0, 10], [10, 19]]);
  const targets = audioSentenceTargets(book, audioSegments(book));
  assert.deepEqual(targets.map(target => target.text), ['長い文を二つの音声で読みます。', '次です。']);
  assert.deepEqual(targets.map(target => target.segmentIndex), [0, 1]);
  assert.equal(audioSentenceIndexAt(targets, 9), 0);
  assert.equal(audioSentenceIndexAt(targets, targets[1].seconds), 1);
});

test('sentence destinations retain accepted cue times and explicitly estimated fallback times without changing alignment evidence', () => {
  const book = bookWithChunks(['朝です。', '窓を', '開く。', '最後です。'], [[0, 14]]);
  book.chunks[0].alignment = { precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .95,
    cues: book.document.units!.map((unit, index) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end,
      startSeconds: [0, 2.25, 4, 6][index], endSeconds: [2, 3.7, 5, 8][index], score: .95 })) };
  const evidence = JSON.stringify(book.chunks[0].alignment);
  const accepted = audioSentenceTargets(book, audioSegments(book));
  assert.deepEqual(accepted.map(target => target.seconds), [0, 2.25, 6]);
  assert.deepEqual(accepted.map(target => target.timingMethod), ['forced-alignment', 'forced-alignment', 'forced-alignment']);
  assert.equal(audioSentenceIndexAt(accepted, Math.floor(accepted[1].seconds * 1e6) / 1e6), 1);
  assert.equal(audioSentenceIndexAt(accepted, accepted[1].seconds - .0001), 0);
  assert.equal(JSON.stringify(book.chunks[0].alignment), evidence);
  book.chunks[0].alignment!.cues[1].score = .2;
  const estimated = audioSentenceTargets(book, audioSegments(book));
  assert.equal(estimated[1].timingMethod, 'estimated');
  assert.equal(book.chunks[0].alignment!.cues[1].score, .2);
});

test('a stored phrase crossing sentences supplies explicit navigation estimates, never new acoustic cues', () => {
  const book = bookWithChunks(['朝です。窓を開く。最後です。'], [[0, 14]]);
  const unit = book.document.units![0];
  book.chunks[0].alignment = { precision: 'phrase', method: 'forced-alignment', status: 'aligned', cues: [
    { unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: 0, end: 14, startSeconds: 0, endSeconds: 8.5, score: .95 },
  ] };
  const segments = audioSegments(book);
  const targets = audioSentenceTargets(book, segments);
  assert.deepEqual(targets.map(target => target.text), ['朝です。', '窓を開く。', '最後です。']);
  assert.deepEqual(targets.map(target => target.timingMethod), ['forced-alignment', 'estimated', 'estimated']);
  assert.ok(targets[1].seconds > 0 && targets[1].seconds < targets[2].seconds);
  assert.equal(segments[0].cues!.length, 1);
  assert.equal(segments[0].cues![0].endSeconds, 8.5);
  assert.equal(book.chunks[0].alignment!.cues.length, 1);
});

test('partial saves skip generation holes and retain source sentence IDs when earlier audio becomes available', () => {
  const full = bookWithChunks(['朝です。', '窓を開く。', '最後です。'], [[0, 4], [4, 9], [9, 14]]);
  const partial = { ...full, chunks: [full.chunks[0], full.chunks[2]], completedChunks: 2 };
  const partialSegments = audioSegments(partial);
  const targets = audioSentenceTargets(partial, partialSegments);
  assert.deepEqual(targets.map(target => [target.id, target.text]), [['b:0', '朝です。'], ['b:9', '最後です。']]);
  const fullSegments = audioSegments(full);
  const fullTargets = audioSentenceTargets(full, fullSegments);
  assert.equal(fullTargets[2].id, targets[1].id);
  assert.equal(targets[1].seconds, 9);
  assert.equal(fullTargets[2].seconds, 18);
});

test('the available second half of a long source sentence remains a single destination', () => {
  const book = bookWithChunks(['長い文を', '二つの音声で', '読みます。', '次です。'], [[10, 19]]);
  const targets = audioSentenceTargets(book, audioSegments(book));
  assert.deepEqual(targets.map(target => [target.text, target.seconds]), [['長い文を二つの音声で読みます。', 0], ['次です。', targets[1].seconds]]);
  assert.ok(targets[1].seconds > 0);
});
