import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, type ReadingUnit } from '../src/reader/model.ts';
import { buildPaceTimeline, durationMs, textLoad } from '../src/reader/pace.ts';
import { countCharacters } from '../src/reader/segmentation.ts';

const settings = { ...DEFAULT_SETTINGS, cpm: 600, punctuationPause: false, readingPace: 'text-load' as const };
function unit(text: string, overrides: Partial<ReadingUnit> = {}): ReadingUnit {
  return { id: text, blockId: 'b', kind: 'text', start: 0, end: text.length, text,
    sources: [], mapping: 'exact', ruby: [], characters: countCharacters(text), cumulativeCharacters: 0, pause: 'none', ...overrides };
}
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`); }

test('equal grapheme counts give numbers, Latin and brackets more time within the same budget', () => {
  const units = [unit('あいうえ'), unit('1234'), unit('ABCD'), unit('（あいうえ）')];
  const plan = buildPaceTimeline(units, settings);
  assert.ok(plan.durations[1] > plan.durations[0]);
  assert.ok(plan.durations[2] > plan.durations[0]);
  assert.ok(plan.durations[3] > plan.durations[0]);
  near(plan.totalMs, 1600);
  near(plan.effectiveCpm, 600);
  assert.equal(plan.minimumOverheadMs, 0);
});

test('long phrases receive a larger share per character; pauses keep their independent budget', () => {
  const units = [unit('あいうえ'), unit('あ'.repeat(24), { pause: 'paragraph' })];
  const plan = buildPaceTimeline(units, { ...settings, punctuationPause: true });
  assert.ok((plan.durations[1] - 400) / 24 > plan.durations[0] / 4);
  near(plan.totalMs, 3200);
  const noPause = buildPaceTimeline(units, settings);
  near(plan.durations[0], noPause.durations[0]);
  near(plan.durations[1] - noPause.durations[1], 400);
});

test('display floors re-normalize free units and explicitly expose an infeasible CPM budget', () => {
  const units = [unit('あ'), unit('12'), unit('あ'.repeat(10)), unit('。'), unit('code', { kind: 'static', characters: 0 })];
  const plan = buildPaceTimeline(units, { ...settings, cpm: 3000 });
  assert.equal(plan.requestedMs, 260);
  assert.equal(plan.infeasibleCpm, true);
  assert.equal(plan.minimumRequiredMs, 400);
  near(plan.totalMs, 500);
  near(plan.minimumOverheadMs, 240);
  assert.equal(plan.minimumUnits, 3);
  assert.deepEqual(plan.durations, [100, 100, 200, 100, 0]);
  assert.equal(buildPaceTimeline([unit('あ'), unit('1')], { ...settings, cpm: 3000 }).totalMs, 200);
  const feasible = buildPaceTimeline([unit('あ'), unit('字'.repeat(10))], { ...settings, cpm: 3000 });
  assert.equal(feasible.infeasibleCpm, false);
  assert.equal(feasible.requestedMs, 220);
  assert.equal(feasible.minimumOverheadMs, 80);
  near(feasible.totalMs, 300);
});

test('Unicode uses graphemes and Unicode numeric/Latin classes; ruby readings never affect weights', () => {
  const text = '𠮷が👩‍💻é１２（Ａ）';
  const load = textLoad(text);
  assert.deepEqual({ characters: load.characters, digits: load.digits, latin: load.latin, brackets: load.brackets },
    { characters: 7, digits: 2, latin: 2, brackets: 2 });
  const plain = unit('図書館');
  const ruby = unit('図書館', { ruby: [{ start: 0, end: 3, reading: 'としょかん'.repeat(1000) }] });
  assert.deepEqual(buildPaceTimeline([plain, unit('123')], settings), buildPaceTimeline([ruby, unit('123')], settings));
});

test('legacy defaults and missing mode retain every old duration, including CPM bounds', () => {
  const units = [unit('あ'), unit('abc'), unit('四。', { pause: 'sentence' }), unit('code', { kind: 'static' })];
  for (const cpm of [100, 600, 3000, 0, Number.NaN, Infinity]) {
    const legacy = { ...DEFAULT_SETTINGS, cpm };
    assert.deepEqual(buildPaceTimeline(units, legacy).durations, units.map(item => durationMs(item, legacy)));
  }
  assert.deepEqual(buildPaceTimeline([], settings).durations, []);
  assert.equal(buildPaceTimeline([unit('code', { kind: 'static' })], settings).effectiveCpm, 0);
});

test('very long Unicode units and many short units keep finite positive durations and the total budget', () => {
  const units = [unit('👩‍💻'.repeat(20_000)), ...Array.from({ length: 30_000 }, (_, i) => unit(i % 2 ? '１' : '字'))];
  const plan = buildPaceTimeline(units, { ...settings, cpm: 3000 });
  const legacy = units.reduce((sum, item) => sum + durationMs(item, { ...settings, cpm: 3000 }), 0);
  assert.ok(plan.durations.every(duration => Number.isFinite(duration) && duration >= 100));
  near(plan.totalMs, legacy);
  near(plan.durations.reduce((sum, duration) => sum + duration, 0), legacy);
});

test('both comparison summaries use exactly the same budget despite fractional allocations', () => {
  const units = Array.from({ length: 89 }, (_, i) => unit(i % 3 ? 'あいう' : '1234', { pause: i % 5 ? 'sentence' : 'none' }));
  for (const cpm of [400, 600, 850, 3000]) {
    const plan = buildPaceTimeline(units, { ...settings, cpm, punctuationPause: true });
    const legacy = buildPaceTimeline(units, { ...settings, cpm, punctuationPause: true, readingPace: 'legacy' });
    assert.equal(plan.totalMs, legacy.totalMs);
    assert.equal(plan.effectiveCpm, legacy.effectiveCpm);
    near(plan.durations.reduce((sum, duration) => sum + duration, 0), legacy.totalMs);
  }
});

test('without grapheme support legacy timing remains usable and evaluation fails explicitly', () => {
  const units = [unit('1234')];
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  try {
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    assert.equal(buildPaceTimeline(units, { ...settings, readingPace: 'legacy' }).totalMs, 400);
    assert.throws(() => buildPaceTimeline(units, settings), /文字境界解析に対応していません/);
  } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
});
