import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { DEFAULT_SETTINGS, MAX_INPUT_BYTES, MAX_TEXT_LENGTH, type ReadingDocument } from '../src/reader/model.ts';
import { deleteReading, loadReading, ReadingStorageError, saveReading, validateSavedReading, type SavedReading } from '../src/reader/storage.ts';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';

function document(): ReadingDocument {
  return {
    id: 'example', contentHash: 'a'.repeat(64), title: '保存の自作例', format: 'md', rawText: '本を読む。', warnings: [],
    blocks: [{ id: 'b1', kind: 'paragraph', text: '本を読む。', ruby: [], runs: [{ start: 0, end: 5, mapping: 'exact', sources: [{ kind: 'text', start: 0, end: 5 }] }] }],
    units: [
      { id: 'u1', blockId: 'b1', kind: 'text', start: 0, end: 2, text: '本を', ruby: [], mapping: 'exact', sources: [{ kind: 'text', start: 0, end: 2 }], characters: 2, cumulativeCharacters: 0, pause: 'none' },
      { id: 'u2', blockId: 'b1', kind: 'text', start: 2, end: 5, text: '読む。', ruby: [], mapping: 'exact', sources: [{ kind: 'text', start: 2, end: 5 }], characters: 2, cumulativeCharacters: 2, pause: 'paragraph' },
    ],
    totalCharacters: 4, versions: { parser: 'remark-11', model: 'budoux-ja', rules: '1' },
  };
}

function saved(): SavedReading {
  return { schemaVersion: 1, savedAt: '2026-10-05T00:00:00.000Z', document: document(), anchor: { blockId: 'b1', offset: 2 }, settings: { ...DEFAULT_SETTINGS } };
}

function freshDatabase() {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: new IDBFactory() });
}

async function putUnvalidated(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('rsvp-reader-local', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('reading'); };
    request.onerror = () => { reject(request.error); };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('reading', 'readwrite');
      transaction.objectStore('reading').put(value, 'current');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

test('only explicit saves persist one book, its source anchor and settings, and deletion removes it', async () => {
  freshDatabase();
  assert.equal(await loadReading(), undefined);
  const input = saved();
  await saveReading(input);
  const restored = await loadReading();
  assert.ok(restored);
  assert.deepEqual(restored.document, input.document);
  assert.deepEqual(restored.anchor, { blockId: 'b1', offset: 2 });
  assert.deepEqual(restored.settings, DEFAULT_SETTINGS);
  assert.equal(restored.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(restored.savedAt)));
  input.document.title = '後から変更';
  assert.equal((await loadReading())?.document.title, '保存の自作例');
  await saveReading({ ...saved(), anchor: { blockId: 'b1', offset: 0 } });
  assert.deepEqual((await loadReading())?.anchor, { blockId: 'b1', offset: 0 });
  await deleteReading();
  assert.equal(await loadReading(), undefined);
});

test('the original PDF buffer and page anchors survive an IndexedDB roundtrip', async () => {
  freshDatabase();
  const input = saved();
  input.document.format = 'pdf';
  input.document.pages = [{ number: 1, width: 600, height: 800 }];
  input.document.units[0].sources = [{ kind: 'pdf', page: 1, item: 0, start: 0, end: 2, rect: [0, 1, 2, 3] }];
  input.pdfData = new Uint8Array([37, 80, 68, 70]).buffer;
  await saveReading(input);
  assert.deepEqual(new Uint8Array((await loadReading())?.pdfData ?? new ArrayBuffer(0)), new Uint8Array([37, 80, 68, 70]));
});

test('real Markdown import and BudouX output save with ruby, code and table units intact', async () => {
  freshDatabase();
  const raw = '# 自作の保存例\n\n<ruby>東京<rt>とうきょう</rt></ruby>へ行った。👩‍💻が書いたが、まだ読む。\n\n```ts\nconst x = 1;\n```\n\n| 本 | 頁 |\n| --- | --- |\n| 自作 | 1 |';
  const document = await prepareDocument(importText(raw, 'md', '自作'));
  await saveReading({ document, anchor: { blockId: document.units[0].blockId, offset: 0 }, settings: { ...DEFAULT_SETTINGS } });
  assert.deepEqual((await loadReading())?.document, document);
  assert.ok(document.units.some((unit) => unit.kind === 'static'));
  assert.ok(document.units.some((unit) => unit.ruby.length > 0));
});

test('unsupported schemas and unsafe settings are explained and remain deletable', async () => {
  freshDatabase();
  await putUnvalidated({ ...saved(), schemaVersion: 999 });
  await assert.rejects(loadReading(), (error) => error instanceof ReadingStorageError && error.code === 'invalid' && error.message.includes('削除'));
  await deleteReading();
  assert.equal(await loadReading(), undefined);
  const invalid = saved();
  invalid.settings.cpm = 0;
  await assert.rejects(saveReading(invalid), (error) => error instanceof ReadingStorageError && error.code === 'invalid');
});

test('validation rejects lost text, duplicate IDs, unsafe ranges and malformed ruby before rendering', () => {
  const cases: Array<(value: SavedReading) => void> = [
    (value) => { value.document.rawText = 'a'.repeat(MAX_TEXT_LENGTH + 1); },
    (value) => { value.settings.fontSize = 9999; },
    (value) => { value.document.units[1].start = 1; },
    (value) => { value.document.units[1].text = '別の文'; },
    (value) => { value.document.units[1].id = 'u1'; },
    (value) => { value.document.units[1].sources = [{ kind: 'text', start: 0, end: 99 }]; },
    (value) => { value.document.blocks[0].ruby = [{ start: 0, end: 99, reading: 'よむ' }]; },
    (value) => { value.document.units[1].ruby = [{ start: 0, end: 99, reading: 'よむ' }]; },
    (value) => { value.document.units.pop(); },
    (value) => { value.anchor.blockId = 'missing'; },
    (value) => { value.savedAt = 'invalid'; },
    (value) => { value.pdfData = new ArrayBuffer(MAX_INPUT_BYTES + 1); },
    (value) => { value.document.totalCharacters = Number.NaN; },
  ];
  for (const mutate of cases) {
    const value = saved();
    mutate(value);
    assert.throws(() => validateSavedReading(value), (error) => error instanceof ReadingStorageError && error.code === 'invalid');
  }
  validateSavedReading(saved());
  assert.throws(() => validateSavedReading(null), ReadingStorageError);
});

test('IndexedDB absence and security denial produce actionable errors without affecting reading data', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: undefined });
  await assert.rejects(loadReading(), (error) => error instanceof ReadingStorageError && error.code === 'unavailable');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: { open: () => { throw new DOMException('blocked', 'SecurityError'); } } });
  await assert.rejects(saveReading(saved()), (error) => error instanceof ReadingStorageError && error.code === 'unavailable');
  assert.equal(document().rawText, '本を読む。');
  freshDatabase();
});

test('quota errors advise continuing without saving, rather than exposing browser error text', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: { open: () => { throw new DOMException('test-only-details', 'QuotaExceededError'); } } });
  await assert.rejects(saveReading(saved()), (error) => error instanceof ReadingStorageError && error.code === 'quota'
    && error.message.includes('保存せず') && !error.message.includes('test-only-details'));
  freshDatabase();
});
