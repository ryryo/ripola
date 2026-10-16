import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMarkerRects } from '../src/reader/marker-rects';

test('vertical marker joins combined cells, overlap and letter spacing without crossing columns', () => {
  const rects = [
    { left: 100, top: 56, width: 56, height: 116 },
    { left: 20, top: 0, width: 56, height: 56 },
    { left: 100, top: 0, width: 56, height: 56 },
    { left: 100, top: 170, width: 56, height: 56 },
    { left: 100, top: 228, width: 56, height: 56 },
    { left: 100, top: 300, width: 56, height: 56 },
  ];
  const copy = structuredClone(rects);
  assert.deepEqual(mergeMarkerRects(rects, true, 2.5), [
    { left: 20, top: 0, width: 56, height: 56 },
    { left: 100, top: 0, width: 56, height: 284 },
    { left: 100, top: 300, width: 56, height: 56 },
  ]);
  assert.deepEqual(rects, copy);
});

test('horizontal marker joins adjacent fragments while keeping rows and ruby-height fragments separate', () => {
  assert.deepEqual(mergeMarkerRects([
    { left: 30, top: 0, width: 40, height: 20 },
    { left: 0, top: 40, width: 30, height: 20 },
    { left: 0, top: 0, width: 30, height: 20 },
    { left: 70, top: 1, width: 10, height: 18 },
    { left: 80, top: 0, width: 0, height: 20 },
  ], false, .5), [
    { left: 0, top: 40, width: 30, height: 20 },
    { left: 0, top: 0, width: 70, height: 20 },
    { left: 70, top: 1, width: 10, height: 18 },
  ]);
});
