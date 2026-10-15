import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AudioPrefetch, audioBufferReadyForAhead } from '../src/reader/audio-prefetch';
import type { PlayableAudioChunk } from '../src/reader/audio-clock';

const chunks = (count: number, durationSeconds = 1): PlayableAudioChunk[] => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, audioUrl: `/c${i}.mp3`, durationSeconds, mimeType: 'audio/mpeg', timeline: [] }));
function harness(environment = {}) {
  const requests: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
  const revoked: string[] = []; let urls = 0;
  const owner = new AudioPrefetch(environment, { fetch: ((url: string, options: RequestInit) => new Promise<Response>(resolve => requests.push({ url, signal: options.signal as AbortSignal, resolve }))) as typeof fetch,
    createURL: () => `blob:${++urls}`, revokeURL: url => revoked.push(url), now: () => 0 });
  const complete = async (index: number, size = 10) => { requests[index].resolve(new Response(new Uint8Array(size))); await delay(0); };
  return { owner, requests, revoked, complete };
}

test('future fetches wait for the current native buffer to finish', async t => {
  const h = harness(); const source = chunks(4);
  t.after(async () => { h.owner.dispose(); for (let i = 0; i < h.requests.length; i++) await h.complete(i); });
  h.owner.update(source, 0, 0, 1, true, false);
  h.owner.update(source, 0, .25, 1, true, false);
  assert.equal(h.requests.length, 0);
  h.owner.update(source, 0, .25, 1, true, true);
  assert.deepEqual(h.requests.map(request => request.url), ['/c1.mp3', '/c2.mp3']);
});

test('losing current-buffer readiness aborts unfinished speculation and retains bounded completed URLs', async t => {
  const h = harness(); const source = chunks(4);
  t.after(async () => { h.owner.dispose(); for (let i = 0; i < h.requests.length; i++) await h.complete(i); });
  h.owner.update(source, 0, 0, 1, true, true);
  await h.complete(0);
  const completed = h.owner.source(source[1]); assert.equal(completed, 'blob:1');
  h.owner.update(source, 0, .25, 1, true, false);
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.requests[2].signal.aborted, true);
  await h.complete(1); await h.complete(2);
  assert.equal(h.owner.source(source[1]), completed);
  assert.equal(h.owner.source(source[2]), source[2].audioUrl);
  assert.deepEqual(h.revoked, []);
  assert.equal(h.requests.length, 3);
  h.owner.update(source, 0, .5, 1, true, true);
  assert.deepEqual(h.requests.slice(3).map(request => request.url), ['/c2.mp3', '/c3.mp3']);
});

test('a new unbuffered current chunk still takes unfinished prefetch ownership without fetching ahead', async t => {
  const h = harness({ saveData: true }); const source = chunks(3);
  t.after(async () => { h.owner.dispose(); for (let i = 0; i < h.requests.length; i++) await h.complete(i); });
  h.owner.update(source, 0, 0, 1, true);
  h.owner.update(source.slice(1), 0, .25, 1, true, false);
  assert.equal(h.requests[0].signal.aborted, true);
  await h.complete(0);
  assert.equal(h.owner.source(source[1]), source[1].audioUrl);
  assert.equal(h.requests.length, 1);
  h.owner.update(source.slice(1), 0, .5, 1, true, true);
  assert.deepEqual(h.requests.map(request => request.url), ['/c1.mp3', '/c2.mp3']);
});

test('ahead readiness requires one full finite buffer covering both immutable and native duration', () => {
  const ready = (duration: number, end: number, immutable = 10, length = 1, start = 0) => audioBufferReadyForAhead({ duration, buffered: { length, start: () => start, end: () => end } }, immutable);
  assert.equal(ready(10, 9.97), true);
  assert.equal(ready(10, 9.9), false);
  assert.equal(ready(8, 8), false);
  assert.equal(ready(12, 10), false);
  assert.equal(ready(12, 12), true);
  for (const invalid of [NaN, Infinity, 0]) {
    assert.equal(ready(invalid, 10), false);
    assert.equal(ready(10, 10, invalid), false);
  }
  assert.equal(ready(10, 10, 10, 0), false);
  assert.equal(ready(10, NaN), false);
  assert.equal(ready(10, Infinity), false);
  assert.equal(ready(10, 10, 10, 1, 5), false);
  assert.equal(audioBufferReadyForAhead({ duration: 10, buffered: { length: 2, start: index => index === 0 ? 0 : 6, end: index => index === 0 ? 4 : 10 } }, 10), false);
  assert.equal(ready(10, 10, 10, 1, NaN), false);
  assert.equal(ready(10, 10, 10, 1, Infinity), false);
  assert.equal(ready(10, 10, 10, 1, .03), true);
});

test('default fetch uses the global receiver and publishes a playable prefetch URL', async t => {
  const calls: Array<{ globalReceiver: boolean; url: string; credentials?: RequestCredentials }> = [];
  t.mock.method(globalThis, 'fetch', async function (this: unknown, input: RequestInfo | URL, options?: RequestInit) {
    const globalReceiver = this === globalThis;
    calls.push({ globalReceiver, url: String(input), credentials: options?.credentials });
    if (!globalReceiver) throw new TypeError('Illegal invocation');
    return new Response(new Uint8Array(10));
  });
  const revoked: string[] = [];
  const owner = new AudioPrefetch({ saveData: true }, { createURL: () => 'blob:default-fetch', revokeURL: url => revoked.push(url), now: () => 0 });
  t.after(() => owner.dispose());
  const source = chunks(2); owner.update(source, 0, 0, 1, true);
  await delay(0);
  assert.deepEqual(calls, [{ globalReceiver: true, url: '/c1.mp3', credentials: 'same-origin' }]);
  assert.equal(owner.source(source[1]), 'blob:default-fetch');
  owner.dispose();
  assert.deepEqual(revoked, ['blob:default-fetch']);
});

test('short files at the default playback rate provide about twenty seconds of runway', async t => {
  const h = harness(); const source = chunks(100, 2);
  t.after(() => h.owner.dispose());
  h.owner.update(source, 0, 0, 2.5, true);
  for (let i = 0; i < h.requests.length; i++) await h.complete(i);
  const bufferedSeconds = (h.requests.length + 1) * 2 / 2.5;
  assert.ok(bufferedSeconds >= 20, `Only ${bufferedSeconds} seconds buffered`);
  assert.ok(h.requests.length < source.length - 1, 'Do not fetch the entire book');
});

test('prefetch starts successors before switching, bounds concurrency and source order', async () => {
  const { owner, requests, complete } = harness(); const source = chunks(100, .5);
  owner.update(source, 0, 0, 1, true);
  assert.deepEqual(requests.map(value => value.url), ['/c1.mp3', '/c2.mp3']);
  await complete(1); assert.equal(requests[2].url, '/c3.mp3');
  assert.equal(owner.source(source[1]), '/c1.mp3');
  await complete(0); assert.match(owner.source(source[1]), /^blob:/);
  for (let i = 2; i < requests.length; i++) await complete(i);
  assert.equal(requests.length, 32); // Very short chunks reach the count cap.
  owner.dispose();
});

test('seconds and rate determine the window; save-data limits speculative transfer', async () => {
  const source = chunks(40, 4); const normal = harness();
  normal.owner.update(source, 0, 0, 1, true);
  for (let i = 0; i < normal.requests.length; i++) await normal.complete(i);
  assert.equal(normal.requests.length, 4);
  const fast = harness(); fast.owner.update(source, 0, 0, 5, true);
  for (let i = 0; i < fast.requests.length; i++) await fast.complete(i);
  assert.ok(fast.requests.length > normal.requests.length);
  assert.ok((fast.requests.length + 1) * 4 / 5 >= 20);
  const constrained = harness({ saveData: true }); constrained.owner.update(source, 0, 0, 5, true);
  assert.equal(constrained.requests.length, 1);
  normal.owner.dispose(); fast.owner.dispose(); constrained.owner.dispose();
});

test('seek, pause, book disposal and replaced asset reject delayed results and revoke URLs', async () => {
  const h = harness(); const source = chunks(5);
  h.owner.update(source, 0, 0, 1, true); await h.complete(0);
  const url = h.owner.source(source[1]);
  h.owner.update(source, 1, 0, 1, false);
  assert.equal(h.owner.source(source[1]), url); // The paused active URL is still in use.
  assert.equal(h.requests[1].signal.aborted, true);
  await h.complete(1); assert.equal(h.owner.source(source[2]), source[2].audioUrl);
  h.owner.update([{ ...source[1], audioUrl: '/new.mp3' }], 0, 0, 1, false);
  assert.deepEqual(h.revoked, [url]);
  h.owner.dispose(); await h.complete(2);
  assert.equal(h.owner.source(source[3]), source[3].audioUrl);
});

test('unknown content length cannot exceed byte budget; failure falls back to original media', async () => {
  const h = harness({ saveData: true }); const source = chunks(3);
  h.owner.update(source, 0, 0, 1, true); await h.complete(0, 1024 * 1024 + 1);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.owner.source(source[1]), source[1].audioUrl);
  h.owner.update(source, 0, 0, 1, true); assert.equal(h.requests.length, 1);
  h.owner.dispose();
});

for (const enabled of [true, false]) test(`unfinished successor transfers to native media when active (${enabled ? 'playing' : 'paused'})`, async t => {
  const h = harness({ saveData: true }); const source = chunks(2);
  t.after(async () => { h.owner.dispose(); for (let i = 0; i < h.requests.length; i++) await h.complete(i); });
  h.owner.update(source, 0, 0, 1, true);
  assert.equal(h.requests[0].url, '/c1.mp3');
  assert.equal(h.owner.source(source[1]), '/c1.mp3');

  h.owner.update(source.slice(1), 0, .25, 1, enabled);
  assert.equal(h.requests[0].signal.aborted, true);
  h.owner.update(source.slice(1), 0, .5, 1, false);
  assert.equal(h.requests.length, 1);

  h.owner.update(source, 0, 0, 1, true); // A later seek can prefetch this asset again.
  await h.complete(0); // Even after re-seek, a fetch that ignores abort must not publish a URL.
  assert.equal(h.owner.source(source[1]), '/c1.mp3');
  assert.deepEqual(h.revoked, []);
  assert.equal(h.requests.length, 2);
  await h.complete(1);
  assert.equal(h.owner.source(source[1]), 'blob:1');
});

test('partially received successor is aborted on activation and rejects its delayed body', async t => {
  const h = harness({ saveData: true }); const source = chunks(2);
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; controller.enqueue(new Uint8Array(128)); } });
  t.after(() => { h.owner.dispose(); body.error(new Error('Test cleanup')); });
  h.owner.update(source, 0, 0, 1, true);
  h.requests[0].resolve(new Response(stream));
  await delay(0);
  h.owner.update(source.slice(1), 0, .25, 1, false);
  assert.equal(h.requests[0].signal.aborted, true);
  body.enqueue(new Uint8Array(128));
  await delay(0);
  assert.equal(h.owner.source(source[1]), '/c1.mp3');
  assert.deepEqual(h.revoked, []);
});

test('completed active blob survives pause and same-asset seek until leaving or closing', async t => {
  const h = harness({ saveData: true }); const source = chunks(2);
  t.after(async () => { h.owner.dispose(); for (let i = 0; i < h.requests.length; i++) await h.complete(i); });
  h.owner.update(source, 0, 0, 1, true);
  await h.complete(0);
  const url = h.owner.source(source[1]); assert.equal(url, 'blob:1');
  h.owner.update(source.slice(1), 0, 0, 1, true, false);
  h.owner.update(source.slice(1), 0, .5, 1, false);
  h.owner.update(source.slice(1), 0, .25, 1.5, false);
  assert.equal(h.owner.source(source[1]), url);
  assert.deepEqual(h.revoked, []);
  h.owner.update(source, 0, 0, 1, false);
  assert.deepEqual(h.revoked, [url]);
  h.owner.update(source, 0, 0, 1, true);
  await h.complete(1);
  h.owner.update(source.slice(1), 0, 0, 1, false);
  assert.equal(h.owner.source(source[1]), 'blob:2');
  h.owner.dispose();
  assert.deepEqual(h.revoked, ['blob:1', 'blob:2']);
  assert.equal(h.owner.source(source[1]), '/c1.mp3');
});

test('observed transfer/processing time expands the seconds window within count and memory bounds', async () => {
  let clock = 0; const requests: string[] = [];
  const owner = new AudioPrefetch({}, { now: () => clock, createURL: () => 'blob:latency', revokeURL: () => undefined,
    fetch: (async (url: string) => { requests.push(url); clock += 20000; return new Response(new Uint8Array(10)); }) as typeof fetch });
  const source = chunks(40, 4);
  owner.update(source, 0, 0, 1, true); await delay(0);
  assert.equal(requests.length, 4);
  owner.update(source, 0, 0, 1, true); await delay(0);
  assert.ok(requests.length > 4);
  assert.ok(requests.length <= 32);
  owner.dispose();
});
