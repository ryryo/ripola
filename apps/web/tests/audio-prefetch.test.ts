import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AudioPrefetch } from '../src/reader/audio-prefetch';
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

test('prefetch starts successors before switching, bounds concurrency and source order', async () => {
  const { owner, requests, complete } = harness(); const source = chunks(20);
  owner.update(source, 0, 0, 1, true);
  assert.deepEqual(requests.map(value => value.url), ['/c1.mp3', '/c2.mp3']);
  await complete(1); assert.equal(requests[2].url, '/c3.mp3');
  assert.equal(owner.source(source[1]), '/c1.mp3');
  await complete(0); assert.match(owner.source(source[1]), /^blob:/);
  for (let i = 2; i < 6; i++) await complete(i);
  assert.equal(requests.length, 6); // Short chunks reach the count cap.
  owner.dispose();
});

test('seconds and rate determine the window; save-data limits speculative transfer', async () => {
  const source = chunks(20, 4); const normal = harness();
  normal.owner.update(source, 0, 0, 1, true); await normal.complete(0);
  assert.equal(normal.requests.length, 1);
  const fast = harness(); fast.owner.update(source, 0, 0, 5, true);
  await fast.complete(0); await fast.complete(1); assert.equal(fast.requests.length, 4);
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

test('observed transfer/processing time expands the seconds window within count and memory bounds', async () => {
  let clock = 0; const requests: string[] = [];
  const owner = new AudioPrefetch({}, { now: () => clock, createURL: () => 'blob:latency', revokeURL: () => undefined,
    fetch: (async (url: string) => { requests.push(url); clock += 20000; return new Response(new Uint8Array(10)); }) as typeof fetch });
  const source = chunks(20, 4);
  owner.update(source, 0, 0, 1, true); await delay(0);
  assert.equal(requests.length, 1);
  owner.update(source, 0, 0, 1, true); await delay(0);
  assert.equal(requests.length, 6);
  owner.dispose();
});
