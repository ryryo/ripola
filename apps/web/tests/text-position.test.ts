import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTextPosition, saveTextPosition, textPositionKey } from '../src/reader/text-position';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';

test('text positions persist per book/revision and retain subphrase offsets without saving manuscripts', async () => {
  const document = await prepareDocument(importText('最初の文章。次の文章。', 'txt', '自作'));
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const a = { id: 'a', revision: 'v1' }, b = { id: 'b', revision: 'v1' };
  const anchor = { blockId: document.blocks[0].id, offset: 7.25 };
  assert.equal(saveTextPosition(a, document, anchor, storage), true);
  assert.deepEqual(loadTextPosition(a, document, storage), anchor);
  assert.equal(loadTextPosition(b, document, storage), undefined);
  assert.equal(loadTextPosition({ ...a, revision: 'v2' }, document, storage), undefined);
  assert.equal(loadTextPosition(a, { ...document, contentHash: 'other' }, storage), undefined);
  assert.ok(!values.get(textPositionKey(a))?.includes('最初の文章'));
  assert.equal(saveTextPosition(a, document, { blockId: 'missing', offset: 1 }, storage), false);
  values.set(textPositionKey(a), '{broken'); assert.equal(loadTextPosition(a, document, storage), undefined);
  for (const offset of [-1, Infinity, document.blocks[0].text.length + 1]) assert.equal(saveTextPosition(a, document, { ...anchor, offset }, storage), false);
  const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(loadTextPosition(a, document, denied), undefined);
  assert.equal(saveTextPosition(a, document, anchor, denied), false);
});
