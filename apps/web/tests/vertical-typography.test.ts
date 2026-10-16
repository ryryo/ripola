import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uprightRuns } from '../src/reader/vertical-typography';
import { layoutWindowEnd, planTextPage, planPreviousTextPage } from '../src/reader/display-sets';

test('upright typography preserves source offsets and keeps long numbers intact', () => {
  const text = '𠮷!? 7月12日 2026年 １２個！ ?? !!! 123';
  const runs = uprightRuns(text);
  assert.deepEqual(runs.map(run => [text.slice(run.start, run.end), run.combined]), [['!?', true], ['7', true], ['12', true], ['１２', true], ['！', true], ['??', true], ['!!!', false]]);
  assert.equal(runs[0].start, 2);
  assert.deepEqual(uprightRuns('1️⃣ 2\uFE0F !\u0301'), []);
});

test('fallback page boundaries keep combined glyphs together in both directions', () => {
  const block = { text: 'あ12!?い', ruby: [] };
  const measure = ({ start, end }: { start: number; end: number }) => ({ fits: end - start <= 2, lines: 1 });
  const forward = planTextPage(block, 0, block.text.length, [], measure, 1);
  assert.equal(forward.end, 1);
  const backward = planPreviousTextPage(block, block.text.length, [], measure, 1);
  assert.equal(backward.start, 5);
  assert.equal(layoutWindowEnd(block, 0, block.text.length, 2), 1);
});
