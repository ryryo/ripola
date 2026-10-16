import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioPositionStore } from '../src/reader/audio-position-store';
import { audioPositionKey, type AudioPosition } from '../src/reader/audio-position';

const first = { id: 'first', revision: 'a' }, second = { id: 'second', revision: 'b' };
test('shared position subscriptions read each book once and publish only changed snapshots', () => {
  const values = new Map<string, AudioPosition>(); let reads = 0, updates = 0;
  const store = new AudioPositionStore(book => { reads++; return values.get(audioPositionKey(book)) ?? { status: 'empty' }; });
  const stop = store.subscribe([first, second], () => updates++);
  assert.equal(reads, 2); assert.equal(updates, 1);
  const snapshot = store.getSnapshot();
  const stopOther = store.subscribe([first], () => {});
  assert.equal(reads, 2);
  store.refresh(`${audioPositionKey(first)}:source`);
  store.refresh('unrelated-setting');
  assert.equal(reads, 2);
  store.refresh(audioPositionKey(first));
  assert.equal(store.getSnapshot(), snapshot); assert.equal(updates, 1);
  values.set(audioPositionKey(first), { status: 'saved', seconds: 30 });
  store.refresh(audioPositionKey(first));
  assert.equal(reads, 4); assert.equal(updates, 2);
  assert.deepEqual(store.getSnapshot().get(audioPositionKey(first)), { status: 'saved', seconds: 30 });
  stopOther(); assert.equal(store.getSnapshot().size, 2);
  stop(); assert.equal(store.getSnapshot().size, 0);
  store.refresh(); assert.equal(reads, 4);
});

test('clear, storage failures and remounts refresh the current positions without retaining books', () => {
  let position: AudioPosition = { status: 'saved', seconds: 12 }, reads = 0;
  const store = new AudioPositionStore(() => { reads++; return position; });
  let updates = 0;
  const stop = store.subscribe([first, first], () => updates++);
  assert.equal(reads, 1);
  position = { status: 'empty' }; store.refresh();
  assert.deepEqual(store.getSnapshot().get(audioPositionKey(first)), position);
  position = { status: 'unavailable' }; store.refresh();
  assert.deepEqual(store.getSnapshot().get(audioPositionKey(first)), position);
  assert.equal(updates, 3);
  stop(); position = { status: 'saved', seconds: 24 };
  const again = store.subscribe([first], () => {});
  assert.deepEqual(store.getSnapshot().get(audioPositionKey(first)), position);
  assert.equal(store.getServerSnapshot().size, 0);
  again(); assert.equal(store.getSnapshot().size, 0);
});
