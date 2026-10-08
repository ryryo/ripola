import test from 'node:test';
import assert from 'node:assert/strict';
import { audioResponse } from '../src/server/audio-response';
test('audio supports byte Range, suffix, HEAD and explicit unsatisfiable responses', async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
  const partial = audioResponse(bytes, new Request('http://127.0.0.1/audio', { headers: { range: 'bytes=1-2' } }));
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 1-2/5');
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [1, 2]);
  const suffix = audioResponse(bytes, new Request('http://127.0.0.1/audio', { headers: { range: 'bytes=-2' } }));
  assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())], [3, 4]);
  assert.equal(audioResponse(bytes, new Request('http://127.0.0.1/audio', { headers: { range: 'bytes=7-' } })).status, 416);
  assert.equal(audioResponse(bytes, new Request('http://127.0.0.1/audio', { method: 'HEAD' })).body, null);
  assert.equal(audioResponse(bytes, new Request('http://127.0.0.1/audio', { headers: { range: 'bytes=0-1,3-4' } })).status, 416);
});
