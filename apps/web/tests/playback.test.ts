import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS as USER_DEFAULT_SETTINGS, type ReadingDocument, type ReadingUnit } from '../src/reader/model.ts';
import { durationMs, PlaybackController, sourceAnchorToIndex, type PlaybackScheduler } from '../src/reader/playback.ts';

// Clock regressions use an explicit speed independently of the new-user default.
const DEFAULT_SETTINGS = { ...USER_DEFAULT_SETTINGS, cpm: 600 };

class Clock implements PlaybackScheduler {
  time = 0;
  nextId = 0;
  tasks = new Map<number, { callback: () => void; due: number }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, due: this.time + delayMs });
    return id;
  };
  clearTimeout = (handle: unknown) => { this.tasks.delete(handle as number); };
  advance(ms: number) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.tasks.entries()].sort((left, right) => left[1].due - right[1].due)[0];
      if (!next || next[1].due > target) break;
      this.tasks.delete(next[0]);
      this.time = next[1].due;
      next[1].callback();
    }
    this.time = target;
  }
  fireLate(ms: number) {
    this.time += ms;
    const next = this.tasks.entries().next().value;
    if (!next) return;
    this.tasks.delete(next[0]);
    next[1].callback();
  }
}

function unit(text: string, overrides: Partial<ReadingUnit> = {}): ReadingUnit {
  return {
    id: text, blockId: 'block', kind: 'text', start: 0, end: text.length, text,
    sources: [{ kind: 'text', start: 0, end: text.length }], mapping: 'exact', ruby: [],
    characters: text.length, cumulativeCharacters: text.length, pause: 'none', ...overrides,
  };
}

test('duration uses characters, the minimum time and the longest classified pause', () => {
  const fast = { ...DEFAULT_SETTINGS, cpm: 2000 };
  assert.equal(durationMs(unit('一二三四五'), fast), 150);
  assert.equal(durationMs(unit('一二三四五。', { characters: 5, pause: 'sentence' }), fast), 400);
  assert.equal(durationMs(unit('あ', { pause: 'heading' }), fast), 700);
  assert.equal(durationMs(unit('あ', { pause: 'paragraph' }), { ...fast, punctuationPause: false }), 100);
  assert.equal(durationMs(unit('コード', { kind: 'static' }), fast), 0);
  assert.equal(durationMs(unit('あ'), { ...fast, cpm: 0 }), 600);
});

test('empty load and repeated controls keep a stable paused snapshot and no timers', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  const initial = controller.getSnapshot();
  controller.load([]);
  controller.play();
  controller.play();
  controller.pause();
  controller.seek(100);
  assert.equal(controller.getSnapshot(), initial);
  assert.equal(clock.tasks.size, 0);
});

test('the final unit stays visible for its full duration before completed', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('本', { pause: 'sentence' })]);
  controller.play();
  for (let count = 0; count < 10; count += 1) controller.play();
  assert.equal(clock.tasks.size, 1);
  clock.advance(349);
  assert.deepEqual(controller.getSnapshot(), { index: 0, status: 'playing' });
  clock.advance(1);
  assert.deepEqual(controller.getSnapshot(), { index: 0, status: 'completed' });
  controller.play();
  controller.pause();
  assert.equal(controller.getSnapshot().status, 'completed');
  assert.equal(clock.tasks.size, 0);
});

test('pause preserves the current unit and its elapsed time, then resumes the remainder', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二')]);
  controller.play();
  clock.advance(75);
  controller.pause();
  clock.advance(5000);
  assert.deepEqual(controller.getSnapshot(), { index: 0, status: 'paused' });
  controller.play();
  clock.advance(24);
  assert.equal(controller.getSnapshot().index, 0);
  clock.advance(1);
  assert.equal(controller.getSnapshot().index, 1);
});

test('time progress is linear within and across unequal phrases, including punctuation rests', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  const units = [unit('一', { pause: 'comma' }), unit('二三四五六', { pause: 'sentence' }), unit('七', { pause: 'paragraph' })];
  controller.load(units);
  const total = units.reduce((sum, item) => sum + durationMs(item, DEFAULT_SETTINGS), 0);
  controller.play();
  for (let time = 50; time < total; time += 50) {
    clock.advance(50);
    assert.ok(Math.abs(controller.getProgress().fraction - time / total) < 1e-10);
    assert.equal(controller.getProgress().remainingMs, total - time);
  }
  clock.advance(50);
  assert.equal(controller.getProgress().fraction, 1);
  assert.equal(controller.getProgress().remainingMs, 0);
});

test('time progress freezes while paused and resumes without jumping backwards', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一二'), unit('三四')]);
  controller.play(); clock.advance(75); controller.pause();
  const frozen = controller.getProgress();
  clock.advance(10_000); assert.deepEqual(controller.getProgress(), frozen);
  controller.play(); assert.deepEqual(controller.getProgress(), frozen);
  clock.advance(125); assert.equal(controller.getSnapshot().index, 1);
  assert.equal(controller.getProgress().fraction, .5);
});

test('speed changes preserve percentage and the visible phrase while replanning remaining time', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一二三四'), unit('五六七八九十')]);
  controller.play(); clock.advance(100);
  assert.equal(controller.getProgress().fraction, .1);
  controller.updateSettings({ ...DEFAULT_SETTINGS, cpm: 1200 });
  assert.equal(controller.getProgress().fraction, .1);
  assert.equal(controller.getProgress().remainingMs, 600);
  assert.equal(controller.getProgress().unitDurationMs, 400);
  clock.advance(50); assert.ok(Math.abs(controller.getProgress().fraction - .175) < 1e-10);
  controller.pause(); const frozen = controller.getProgress().fraction;
  controller.updateSettings({ ...DEFAULT_SETTINGS, cpm: 1200, punctuationPause: false });
  assert.equal(controller.getProgress().fraction, frozen);
  clock.advance(500); controller.play(); clock.advance(250);
  assert.equal(controller.getSnapshot().index, 1);
  assert.ok(Math.abs(controller.getProgress().fraction - .55) < 1e-10);
  clock.advance(300); assert.equal(controller.getProgress().fraction, 1);
});

test('load/seek/back set time position and clear elapsed time; settings before play apply immediately', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二三'), unit('四五六')], 1);
  assert.equal(controller.getProgress().fraction, 1 / 6);
  controller.play(); clock.advance(50); controller.seek(2);
  assert.equal(controller.getProgress().fraction, .5);
  assert.equal(controller.getProgress().unitElapsedMs, 0);
  controller.step(-2); assert.equal(controller.getProgress().fraction, 0);
  controller.updateSettings({ ...DEFAULT_SETTINGS, cpm: 1200 });
  assert.equal(controller.getProgress().remainingMs, 350);
  controller.play(); clock.advance(100); assert.equal(controller.getSnapshot().index, 1);
});

test('static blocks freeze time progress and explicit next preserves their time boundary', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('code', { kind: 'static' }), unit('二三')]);
  controller.play(); clock.advance(100);
  assert.equal(controller.getSnapshot().status, 'paused');
  assert.equal(controller.getProgress().fraction, 1 / 3);
  clock.advance(5000); assert.equal(controller.getProgress().fraction, 1 / 3);
  controller.play(); assert.equal(controller.getProgress().fraction, 1 / 3);
  controller.play(); clock.advance(200); assert.equal(controller.getProgress().fraction, 1);
});

test('late callbacks clamp progress to the visible unit and never pretend skipped text was shown', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二'), unit('三')]); controller.play();
  clock.time = 10_000;
  assert.equal(controller.getProgress().fraction, 1 / 3);
  clock.fireLate(0);
  assert.equal(controller.getSnapshot().index, 1);
  assert.equal(controller.getProgress().fraction, 1 / 3);
  clock.advance(50); assert.equal(controller.getProgress().fraction, .5);
});

test('speed changes affect the next unit and never shorten the one currently visible', () => {
  const clock = new Clock();
  const controller = new PlaybackController({ ...DEFAULT_SETTINGS, cpm: 600 }, clock);
  controller.load([unit('一二'), unit('三四')]);
  controller.play();
  clock.advance(50);
  controller.updateSettings({ ...DEFAULT_SETTINGS, cpm: 1200 });
  clock.advance(149);
  assert.equal(controller.getSnapshot().index, 0);
  clock.advance(1);
  assert.deepEqual(controller.getSnapshot(), { index: 1, status: 'playing' });
  clock.advance(99);
  assert.equal(controller.getSnapshot().status, 'playing');
  clock.advance(1);
  assert.equal(controller.getSnapshot().status, 'completed');
});

test('seek, reload and dispose invalidate even callbacks already queued by the browser', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二')]);
  controller.play();
  const oldCallback = [...clock.tasks.values()][0].callback;
  controller.seek(99);
  oldCallback();
  assert.deepEqual(controller.getSnapshot(), { index: 1, status: 'paused' });
  controller.play();
  const beforeLoad = [...clock.tasks.values()][0].callback;
  controller.load([unit('新')]);
  beforeLoad();
  assert.deepEqual(controller.getSnapshot(), { index: 0, status: 'paused' });
  controller.play();
  const beforeDispose = [...clock.tasks.values()][0].callback;
  let notifications = 0;
  controller.subscribe(() => { notifications += 1; });
  controller.dispose();
  beforeDispose();
  controller.seek(1);
  controller.play();
  assert.equal(notifications, 0);
  assert.equal(clock.tasks.size, 0);
});

test('long event-loop delays show every next unit for its own duration, with no catch-up skip', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二'), unit('三')]);
  controller.play();
  clock.fireLate(10_000);
  assert.deepEqual(controller.getSnapshot(), { index: 1, status: 'playing' });
  clock.advance(99);
  assert.equal(controller.getSnapshot().index, 1);
  clock.advance(1);
  assert.equal(controller.getSnapshot().index, 2);
});

test('an early timer callback is rescheduled against the monotonic deadline', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二')]);
  controller.play();
  clock.fireLate(20);
  assert.equal(controller.getSnapshot().index, 0);
  assert.equal(clock.tasks.size, 1);
  clock.advance(79);
  assert.equal(controller.getSnapshot().index, 0);
  clock.advance(1);
  assert.equal(controller.getSnapshot().index, 1);
});

test('code and table units stop automatic playback and an explicit play advances once while paused', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('本'), unit('const x = 1;', { kind: 'static' }), unit('続き')]);
  controller.play();
  clock.advance(100);
  assert.deepEqual(controller.getSnapshot(), { index: 1, status: 'paused' });
  assert.equal(clock.tasks.size, 0);
  clock.advance(10_000);
  assert.equal(controller.getSnapshot().index, 1);
  controller.play();
  assert.deepEqual(controller.getSnapshot(), { index: 2, status: 'paused' });
  controller.play();
  assert.equal(controller.getSnapshot().status, 'playing');
  controller.load([unit('表', { kind: 'static' })]);
  controller.play();
  assert.equal(controller.getSnapshot().status, 'completed');
});

test('subscriptions are stable and reentrant listener pause wins over advancing playback', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二')]);
  let count = 0;
  const unsubscribe = controller.subscribe(() => { count += 1; });
  controller.subscribe(() => {
    if (controller.getSnapshot().index === 1) controller.pause();
  });
  controller.play();
  assert.equal(controller.getSnapshot(), controller.getSnapshot());
  clock.advance(100);
  assert.deepEqual(controller.getSnapshot(), { index: 1, status: 'paused' });
  assert.equal(clock.tasks.size, 0);
  assert.equal(count, 3);
  unsubscribe();
  controller.step(-1);
  assert.equal(count, 3);
});

test('manual navigation is clamped and always pauses, including after completion', () => {
  const clock = new Clock();
  const controller = new PlaybackController(DEFAULT_SETTINGS, clock);
  controller.load([unit('一'), unit('二')], 100);
  assert.equal(controller.getSnapshot().index, 1);
  controller.play();
  controller.step(-100);
  assert.deepEqual(controller.getSnapshot(), { index: 0, status: 'paused' });
  assert.equal(clock.tasks.size, 0);
  controller.seek(Number.NaN);
  controller.step(Number.POSITIVE_INFINITY);
  assert.equal(controller.getSnapshot().index, 0);
  controller.seek(1);
  controller.play();
  clock.advance(100);
  controller.step(-1);
  assert.deepEqual(controller.getSnapshot(), { index: 0, status: 'paused' });
});

test('source anchors resolve containing UTF-16 range, exact boundary, clamped end and empty block', () => {
  const document = {
    blocks: [{ id: 'a', text: '私は' }, { id: 'empty', text: '' }, { id: 'b', text: '犬' }],
    units: [unit('私', { blockId: 'a', start: 0, end: 1 }), unit('は', { blockId: 'a', start: 1, end: 2 }), unit('犬', { blockId: 'b' })],
  } as ReadingDocument;
  assert.equal(sourceAnchorToIndex(document, { blockId: 'a', offset: 0 }), 0);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'a', offset: 0.5 }), 0);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'a', offset: 1 }), 1);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'a', offset: 99 }), 1);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'a', offset: -1 }), 0);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'b', offset: 0 }), 2);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'empty', offset: 0 }), 2);
  assert.equal(sourceAnchorToIndex(document, { blockId: 'missing', offset: 0 }), 0);
  assert.equal(sourceAnchorToIndex({ ...document, units: [] }, { blockId: 'a', offset: 0 }), 0);
});
