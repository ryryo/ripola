import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import { loadReading, saveReading } from '../src/reader/storage';
import { DEFAULT_SETTINGS } from '../src/reader/model';

test('old six-field settings migrate without changing the saved source anchor; arbitrary font URLs are rejected', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const document = await prepareDocument(importText('私は本を読む。次の頁へ。', 'txt', '自作'));
  const anchor = { blockId: document.units[1].blockId, offset: document.units[1].start };
  const old = { cpm: 400, fontSize: 56, punctuationPause: true, ruby: true, guide: true, contrast: 'paper' as const };
  await saveReading({ document, anchor, settings: old });
  const restored = await loadReading();
  assert.deepEqual(restored?.anchor, anchor);
  assert.deepEqual(restored?.settings, DEFAULT_SETTINGS);
  await assert.rejects(saveReading({ document, anchor, settings: { ...old, fontFamily: 'https://example.com/font.css' } as unknown as typeof DEFAULT_SETTINGS }));
  await assert.rejects(saveReading({ document, anchor, settings: { ...old, groupTarget: 999 } }));
  await saveReading({ document, anchor, settings: { ...old, writingMode: 'vertical-rl' } });
  assert.equal((await loadReading())?.settings.writingMode, 'vertical-rl');
  assert.deepEqual((await loadReading())?.anchor, anchor);
  await assert.rejects(saveReading({ document, anchor, settings: { ...old, writingMode: 'sideways' } as unknown as typeof DEFAULT_SETTINGS }));
});

test('saved documents retain highlight choices and source anchors, and reject invalid choices', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const document = await prepareDocument(importText('私は本を読む。次の頁へ。', 'txt', '自作'));
  const anchor = { blockId: document.units[1].blockId, offset: document.units[1].start };
  for (const highlightColor of ['blue', 'yellow'] as const) {
    for (const highlightIntensity of ['light', 'normal', 'strong'] as const) {
      const settings = { ...DEFAULT_SETTINGS, highlightColor, highlightIntensity };
      await saveReading({ document, anchor, settings });
      const restored = await loadReading();
      assert.deepEqual(restored?.settings, settings);
      assert.deepEqual(restored?.anchor, anchor);
    }
  }
  for (const value of [null, 'unknown', 0, false, {}, [], ['blue']]) {
    for (const key of ['highlightColor', 'highlightIntensity']) {
      const settings = { ...DEFAULT_SETTINGS, [key]: value } as unknown as typeof DEFAULT_SETTINGS;
      await assert.rejects(saveReading({ document, anchor, settings }));
    }
  }
});

test('saved documents restore multiline spacing with the source anchor and reject invalid spacing', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const document = await prepareDocument(importText('私は本を読む。次の頁へ。', 'txt', '自作'));
  const anchor = { blockId: document.units[1].blockId, offset: document.units[1].start };
  for (const multilineSpacing of ['narrow', 'normal', 'wide'] as const) {
    await saveReading({ document, anchor, settings: { ...DEFAULT_SETTINGS, multilineSpacing } });
    const restored = await loadReading();
    assert.equal(restored?.settings.multilineSpacing, multilineSpacing);
    assert.deepEqual(restored?.anchor, anchor);
  }
  for (const multilineSpacing of [null, 'unknown', 1.6, false, {}, [], ['wide']]) {
    const settings = { ...DEFAULT_SETTINGS, multilineSpacing } as unknown as typeof DEFAULT_SETTINGS;
    await assert.rejects(saveReading({ document, anchor, settings }));
  }
});
