import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { groupIndexAt, groupReadingUnits } from '../src/reader/display-groups';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import { readingSentences } from '../src/reader/sentences';
import { loadReading, saveReading } from '../src/reader/storage';
import { DEFAULT_SETTINGS } from '../src/reader/model';

test('display groups retain exact coverage, protected ruby/Unicode, source offsets and hard boundaries', async () => {
  const document = await prepareDocument(importText('# 見出し\n\n私は<ruby>図書館<rt>としょかん</rt></ruby>へ。次に2026年10月6日の本を読む。👩‍💻とが、𠮷も。\n\n最後は短い。\n\n```ts\nconst answer = 42;\n```', 'md', '自作'));
  const original = JSON.stringify(document);
  const cuts = new Set(readingSentences(document).map(sentence => sentence.target));
  for (const target of [0, 8, 24]) for (const minimum of [0, 3, 12]) {
    const groups = groupReadingUnits(document.units, { target, minimum }, cuts);
    assert.deepEqual(groups.flatMap(group => group.units.map(unit => unit.id)), document.units.map(unit => unit.id));
    assert.equal(groups.map(group => group.unit.text).join(''), document.units.map(unit => unit.text).join(''));
    for (const group of groups) {
      assert.equal(new Set(group.units.map(unit => unit.blockId)).size, 1);
      assert.equal(group.unit.text, document.blocks.find(block => block.id === group.unit.blockId)!.text.slice(group.unit.start, group.unit.end));
      assert.equal(group.units.some(unit => unit.kind === 'static') && group.units.length > 1, false);
      assert.equal(group.units.slice(0, -1).some(unit => ['sentence', 'paragraph', 'heading'].includes(unit.pause)), false);
      for (let index = group.startIndex; index <= group.endIndex; index++) assert.equal(groups[groupIndexAt(groups, index)], group);
      for (const span of group.unit.ruby) assert.equal(group.unit.text.slice(span.start, span.end), '図書館');
    }
  }
  assert.equal(JSON.stringify(document), original);
});

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
