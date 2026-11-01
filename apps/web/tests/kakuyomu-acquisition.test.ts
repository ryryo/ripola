import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { openKakuyomuCache } from '../src/kakuyomu/cache';
import { SequentialKakuyomuFetcher, type PageFetch } from '../src/kakuyomu/fetch';
import { KakuyomuImporter } from '../src/kakuyomu/importer';
import { assertAllowedKakuyomuUrl, hash, type SourceAccess } from '../src/kakuyomu/parser';
import { LocalTextBookStore } from '../src/kakuyomu/text-books';
import { EPISODE_IDS, WORK_ID, WORK_URL, episodeHtml, episodeUrl, indexHtml, simpleBody } from './helpers/kakuyomu-fixtures.ts';

const access: SourceAccess = { workId: WORK_ID, workUrl: WORK_URL, allowedEpisodeUrl: id => episodeUrl(id) };
const pages = (): Map<string, string> => new Map([
  [WORK_URL, indexHtml({ records: [
    { heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }, { id: EPISODE_IDS[1], title: '第2話' }] },
    { heading: { level: 1, title: '第2章' }, episodes: [{ id: EPISODE_IDS[2], title: '第3話' }] },
  ] })],
  [episodeUrl(EPISODE_IDS[0]), episodeHtml(simpleBody, EPISODE_IDS[0])],
  [episodeUrl(EPISODE_IDS[1]), episodeHtml('<p>二話目の本文。</p>', EPISODE_IDS[1])],
  [episodeUrl(EPISODE_IDS[2]), episodeHtml('<p>三話目の本文。</p>', EPISODE_IDS[2])],
]);
function fakeFetch(map: Map<string, string>, counter?: { count: number }): PageFetch {
  return async (url, source) => {
    if (counter) counter.count++;
    const expected = assertAllowedKakuyomuUrl(url, source);
    const html = map.get(expected);
    if (!html) throw new Error(`unexpected fetch: ${expected}`);
    return { bytes: new TextEncoder().encode(html), url: expected, fetchedAt: '2026-10-31T00:00:00.000Z', contentType: 'text/html; charset=utf-8' };
  };
}
async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ripola-kakuyomu-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function waitFor(importer: KakuyomuImporter, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = importer.getJob(id);
    if (value.status === 'completed' || value.status === 'failed') return value;
    await pause(10);
  }
  throw new Error('job did not settle');
}

test('cache stores raw bytes with a ledger and regenerates them only after verifying the hash', async t => {
  const root = await temporary(t), cache = openKakuyomuCache(root, WORK_URL), map = pages();
  const index = await cache.getIndex(fakeFetch(map), false);
  assert.equal(index.cached, false);
  const episode = { id: EPISODE_IDS[0], title: '第1話', url: episodeUrl(EPISODE_IDS[0]), order: 1 };
  const first = await cache.getEpisode(episode, fakeFetch(map), false);
  assert.equal(first.cached, false);
  const second = await cache.getEpisode(episode, undefined, true);
  assert.equal(second.cached, true);
  assert.equal(second.html, first.html);
  const ledger = JSON.parse(await readFile(join(root, 'ledger.json'), 'utf8')) as { index: { sha256: string; bytes: number }; episodes: Record<string, { sha256: string; file: string }> };
  assert.equal(ledger.episodes[EPISODE_IDS[0]].file, `episodes/${EPISODE_IDS[0]}.html`);
  assert.equal((await readFile(join(root, 'episodes', `${EPISODE_IDS[0]}.html`), 'utf8')), first.html);
  const entries = await readdir(join(root, 'episodes'));
  assert.ok(entries.every(name => !name.endsWith('.tmp')));
  assert.equal(ledger.episodes[EPISODE_IDS[0]].sha256, hash(first.html));
});

test('cache rejects modified, truncated, wrong-work and missing raw records instead of refetching silently', async t => {
  const root = await temporary(t), cache = openKakuyomuCache(root, WORK_URL);
  const episode = { id: EPISODE_IDS[0], title: '第1話', url: episodeUrl(EPISODE_IDS[0]), order: 1 };
  await cache.getIndex(fakeFetch(pages()), false);
  await cache.getEpisode(episode, fakeFetch(pages()), false);
  const file = join(root, 'episodes', `${EPISODE_IDS[0]}.html`);
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('本文', '改変'));
  await assert.rejects(cache.getEpisode(episode, undefined, true), /hash/);
  await writeFile(file, original.slice(0, 20));
  await assert.rejects(cache.getEpisode(episode, undefined, true), /hash/);
  await writeFile(file, original);
  const ledgerFile = join(root, 'ledger.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as { episodes: Record<string, { url: string }> };
  ledger.episodes[EPISODE_IDS[0]].url = episodeUrl(EPISODE_IDS[1]);
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await assert.rejects(cache.getEpisode(episode, undefined, true), /台帳/);
  ledger.episodes[EPISODE_IDS[0]].url = episodeUrl(EPISODE_IDS[0]);
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await rm(file);
  await assert.rejects(cache.getEpisode(episode, undefined, true), /原本ファイル/);
  const missing = openKakuyomuCache(join(root, 'missing'), WORK_URL);
  await assert.rejects(missing.getEpisode(episode, undefined, true), /取得済み/);
});

test('cache rejects a wrong canonical and records legacy numeric files only after verification', async t => {
  const root = await temporary(t), map = pages();
  map.set(WORK_URL, indexHtml({ records: [{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }] }).replace(`href="${WORK_URL}"`, `href="${WORK_URL}/episodes/${EPISODE_IDS[0]}"`));
  const broken = openKakuyomuCache(root, WORK_URL);
  await assert.rejects(broken.getIndex(fakeFetch(map), false), /canonical/);
  await assert.rejects(readFile(join(root, 'ledger.json'), 'utf8'));

  const legacy = join(root, 'legacy');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'index.html'), indexHtml({ records: [{ heading: { level: 1, title: '第1章' }, episodes: [{ id: EPISODE_IDS[0], title: '第1話' }] }] }));
  await writeFile(join(legacy, '001.html'), episodeHtml(simpleBody, EPISODE_IDS[0]));
  const adopted = openKakuyomuCache(legacy, WORK_URL, { allowLegacyAdoption: true });
  const index = await adopted.getIndex(undefined, true);
  assert.equal(index.adopted, true);
  const episode = await adopted.getEpisode({ id: EPISODE_IDS[0], title: '第1話', url: episodeUrl(EPISODE_IDS[0]), order: 1 }, undefined, true);
  assert.equal(episode.adopted, true);
  assert.equal(await readFile(join(legacy, 'episodes', `${EPISODE_IDS[0]}.html`), 'utf8'), episode.html);
  const ledger = JSON.parse(await readFile(join(legacy, 'ledger.json'), 'utf8')) as { episodes: Record<string, { adopted?: boolean }> };
  assert.equal(ledger.episodes[EPISODE_IDS[0]].adopted, true);
});

test('the fetcher serializes concurrent callers and enforces the interval and byte bound', async () => {
  let active = 0, maximum = 0;
  const starts: number[] = [];
  const fetcher = new SequentialKakuyomuFetcher({ minIntervalMs: 40, fetch: async () => {
    active++; maximum = Math.max(maximum, active); starts.push(Date.now());
    await pause(20);
    active--;
    return new Response('<html><head><link rel="canonical" href="x"></head></html>', { headers: { 'content-type': 'text/html' } });
  } });
  await Promise.all([fetcher.fetch(WORK_URL, access), fetcher.fetch(episodeUrl(EPISODE_IDS[0]), access), fetcher.fetch(episodeUrl(EPISODE_IDS[1]), access)]);
  assert.equal(maximum, 1);
  assert.ok(starts[1] - starts[0] >= 35, `second request waited ${starts[1] - starts[0]}ms`);
  assert.ok(starts[2] - starts[1] >= 35, `third request waited ${starts[2] - starts[1]}ms`);
  let called = 0;
  const bounded = new SequentialKakuyomuFetcher({ minIntervalMs: 0, maxBytes: 8, fetch: async () => { called++; return new Response('0123456789'); } });
  await assert.rejects(bounded.fetch(WORK_URL, access), /容量/);
  const rejected = new SequentialKakuyomuFetcher({ minIntervalMs: 0, fetch: async () => { called++; return new Response('ok'); } });
  await assert.rejects(rejected.fetch('https://evil.test/works/' + WORK_ID, access), /カクヨム/);
  assert.equal(called, 1);

  // The CLI passes a method reference into the cache; it must remain bound.
  const bound = new SequentialKakuyomuFetcher({ minIntervalMs: 0, fetch: async () => new Response('<html></html>') });
  const extracted = bound.fetch;
  const page = await extracted(WORK_URL, access);
  assert.equal(page.url, WORK_URL);
});

test('local service previews the index, imports complete parts, and retries from verified cache', async t => {
  const root = await temporary(t), counter = { count: 0 };
  const importer = new KakuyomuImporter({ libraryDir: root, fetch: fakeFetch(pages(), counter), minIntervalMs: 0, now: () => '2026-10-31T01:00:00.000Z' });
  const preview = await importer.preview(WORK_URL);
  assert.equal(preview.parts.length, 2);
  assert.equal(preview.parts[0].episodeCount, 2);
  assert.equal(preview.parts[0].firstEpisode, '第1話');
  const started = await importer.start(WORK_URL, [2, 1]);
  assert.deepEqual(started.selectedParts, [1, 2]);
  const done = await waitFor(importer, started.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(done.completedEpisodes, 3);
  assert.equal(done.books.length, 2);
  assert.equal(counter.count, 4); // index + three episodes

  const store = new LocalTextBookStore(root);
  const books = await store.list();
  assert.equal(books.length, 2);
  const first = await store.get(books[0].id);
  assert.equal(first.kind, 'text');
  assert.equal(first.chunks.length, 0);
  assert.equal(first.durationSeconds, 0);
  assert.equal(first.source.kind, 'kakuyomu');
  assert.equal(first.source.kind === 'kakuyomu' && first.source.episodes.length, 2);
  assert.ok(first.document.blocks.some(block => block.ruby.length > 0));
  assert.deepEqual((await readdir(root)).sort(), ['kakuyomu-cache', 'locks', 'text-books', 'text-source-maps']);

  const before = counter.count;
  const offline = new KakuyomuImporter({ libraryDir: root, fetch: async () => { throw new Error('cache should be used'); }, minIntervalMs: 0, now: () => '2026-10-31T02:00:00.000Z' });
  const retry = await offline.start(WORK_URL, [1, 2]);
  const retried = await waitFor(offline, retry.id);
  assert.equal(retried.status, 'completed', retried.error ?? '');
  assert.equal(counter.count, before);
  assert.equal((await offline.listBooks()).length, 2);
  assert.throws(() => offline.getJob('not-a-job'), /ジョブID/);
});

test('a failed part is not published and previously completed parts stay complete', async t => {
  const root = await temporary(t), map = pages();
  map.set(episodeUrl(EPISODE_IDS[2]), episodeHtml('<p>本文</p><img src="x.png" alt="挿絵">', EPISODE_IDS[2]));
  const importer = new KakuyomuImporter({ libraryDir: root, fetch: fakeFetch(map), minIntervalMs: 0, now: () => '2026-10-31T01:00:00.000Z' });
  const started = await importer.start(WORK_URL, [1, 2]);
  const done = await waitFor(importer, started.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error ?? '', /本文|未対応/);
  assert.equal(done.books.length, 1);
  assert.equal(done.books[0].partOrder, 1);
  const store = new LocalTextBookStore(root);
  const saved = await store.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].partOrder, 1);
  const cache = openKakuyomuCache(join(root, 'kakuyomu-cache', WORK_ID), WORK_URL);
  const index = await cache.getIndex(undefined, true);
  assert.ok(index.record.bytes > 0); // cache remains available for the retry
});

test('concurrent starts are rejected while the first job owns the acquisition lock', async t => {
  const root = await temporary(t), map = pages();
  const delayed: PageFetch = async (url, source) => { await pause(40); return fakeFetch(map)(url, source); };
  const importer = new KakuyomuImporter({ libraryDir: root, fetch: delayed, minIntervalMs: 0, now: () => '2026-10-31T01:00:00.000Z' });
  const first = await importer.start(WORK_URL, [1]);
  await assert.rejects(importer.start(WORK_URL, [2]), /進行中/);
  const done = await waitFor(importer, first.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal((await importer.listBooks()).length, 1);
});
