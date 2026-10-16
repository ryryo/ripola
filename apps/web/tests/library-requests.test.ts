import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDistributionLibrary } from '../src/distribution/library';

const library = { schemaVersion: 1, target: 'worker', createdAt: '2026-10-16', books: [] };
test('public catalogs share only concurrent requests and refresh after settlement', async () => {
  let calls = 0;
  let finish!: (value: Response) => void;
  const fetcher = (() => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
  const first = loadDistributionLibrary('/', fetcher);
  const same = loadDistributionLibrary('/', fetcher);
  assert.equal(first, same); assert.equal(calls, 1);
  finish(Response.json(library)); await first;
  const later = loadDistributionLibrary('/', fetcher);
  assert.notEqual(later, first); assert.equal(calls, 2);
  finish(Response.json(library)); await later;
});

test('catalog requests isolate base URLs and fetchers and allow retries after failures', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => { urls.push(String(url)); return Response.json(library); }) as typeof fetch;
  await Promise.all([loadDistributionLibrary('/', fetcher), loadDistributionLibrary('/samples/', fetcher)]);
  assert.deepEqual(urls, ['http://localhost/library/index.json', 'http://localhost/samples/library/index.json']);
  let calls = 0;
  const retry = (async () => { if (++calls === 1) throw new Error('offline'); return Response.json(library); }) as typeof fetch;
  const failed = loadDistributionLibrary('/', retry);
  assert.equal(failed, loadDistributionLibrary('/', retry));
  await assert.rejects(failed, /offline/);
  await loadDistributionLibrary('/', retry); assert.equal(calls, 2);
  let otherCalls = 0;
  const other = (async () => { otherCalls++; return Response.json(library); }) as typeof fetch;
  await Promise.all([loadDistributionLibrary('/', fetcher), loadDistributionLibrary('/', other)]);
  assert.equal(otherCalls, 1); assert.equal(urls.length, 3);
});
