import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReadingDocument } from '../src/reader/model';
import { processDraft } from '../src/reader/text-service';

test('restoration transfers draft source and provenance, leaving regenerated units out of the worker message', async () => {
  const previous = globalThis.Worker;
  const draft = { title: '保存本文', format: 'pdf', rawText: '本文', blocks: [], warnings: [], pages: [{ number: 1, width: 100, height: 200 }], provenance: { title: '出典' } };
  const document = { ...draft, units: [{ text: 'recomputed' }], id: 'doc', totalCharacters: 2 } as unknown as ReadingDocument;
  let sent: unknown, terminated = false;
  class FakeWorker {
    onmessage?: (event: { data: { type: 'result'; document: ReadingDocument } }) => void;
    postMessage(value: unknown) { sent = value; queueMicrotask(() => this.onmessage?.({ data: { type: 'result', document } })); }
    terminate() { terminated = true; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    assert.equal(await processDraft(document), document);
    assert.deepEqual(sent, { type: 'draft', draft });
    assert.equal(terminated, true);
    assert.deepEqual(document.units, [{ text: 'recomputed' }]);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'Worker'); else globalThis.Worker = previous;
  }
});
