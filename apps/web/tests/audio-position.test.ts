import assert from 'node:assert/strict';
import test from 'node:test';
import { audioPositionKey, audioPositionPercent, loadAudioPosition } from '../src/reader/audio-position';

test('音声の保存位置は本とrevisionごとに分離し、保存なし・不正値・保存拒否を区別する', () => {
  const book = { id: 'book-1', revision: 'revision-1' };
  assert.equal(audioPositionKey(book), 'rsvp-audio-position:book-1:revision-1');
  assert.notEqual(audioPositionKey(book), audioPositionKey({ ...book, revision: 'revision-2' }));
  const storage = (value: string | null) => ({ getItem: () => value });
  assert.deepEqual(loadAudioPosition(book, storage(null)), { status: 'empty' });
  assert.deepEqual(loadAudioPosition(book, storage('0')), { status: 'saved', seconds: 0 });
  assert.deepEqual(loadAudioPosition(book, storage('5.5')), { status: 'saved', seconds: 5.5 });
  for (const value of ['', ' ', '-1', 'NaN', 'Infinity', 'broken']) assert.deepEqual(loadAudioPosition(book, storage(value)), { status: 'unavailable' });
  assert.deepEqual(loadAudioPosition(book, { getItem: () => { throw new Error('storage blocked'); } }), { status: 'unavailable' });
});

test('読書位置の割合は保存音声時間を使い、終端前を100%に丸めず不明な時間を扱わない', () => {
  assert.equal(audioPositionPercent(5, 10), 50);
  assert.equal(audioPositionPercent(0, 10), 0);
  assert.equal(audioPositionPercent(9.999, 10), 99);
  assert.equal(audioPositionPercent(10, 10), 100);
  assert.equal(audioPositionPercent(100, 10), 100);
  assert.equal(audioPositionPercent(5, 14), 35);
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(audioPositionPercent(5, duration), undefined);
  for (const seconds of [-1, NaN, Infinity]) assert.equal(audioPositionPercent(seconds, 10), undefined);
});
