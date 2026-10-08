import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { getShareTarget } from '../src/sharing/qr.ts';
import { AUDIO_DEMOS, audioDemo, audioDemoBaseUrl, audioDemoHref, loadAudioDemos } from '../src/reader/audio-demo.ts';
import { loadDistributedBook, type PublicLibraryManifest } from '../src/distribution/library.ts';
import { auditDistribution, contentHash } from '../../../scripts/distribution-utils.mjs';

test('sample links retain local, Worker and Pages routes and explicit revisions', () => {
  assert.equal(audioDemo(null), undefined);
  assert.equal(audioDemo('other'), undefined);
  for (const [profile, base, route] of [['local', '/', 'library'], ['worker', '/', 'books/'], ['pages', '/ripola/', 'demo/']]) {
    for (const sample of AUDIO_DEMOS) {
      const url = new URL(audioDemoHref(sample.key, profile, base), 'https://example.test');
      assert.equal(url.pathname, base + route);
      assert.equal(url.searchParams.get('sample'), sample.key);
      assert.equal(url.searchParams.get('book'), sample.id);
      assert.equal(url.searchParams.get('revision'), sample.revision);
    }
  }
});

test('sample discovery excludes unselected revisions, private entries and unrelated books', async () => {
  const sample = AUDIO_DEMOS[0];
  const entry = { id: sample.id, revision: sample.revision, title: 'sample', manifestUrl: `library/books/${sample.id}/${sample.revision}/manifest.json`, manifestSha256: 'a'.repeat(64), manifestBytes: 100, durationSeconds: 1, precision: 'sentence', attribution: 'author', publicDemo: true };
  const stale = { ...entry, revision: 'b'.repeat(64), manifestUrl: `library/books/${sample.id}/${'b'.repeat(64)}/manifest.json` };
  const unknown = { ...entry, id: 'book-other', manifestUrl: `library/books/book-other/${sample.revision}/manifest.json` };
  const urls: string[] = [];
  const loaded = await loadAudioDemos('https://example.test/ripola/', async input => {
    urls.push(String(input));
    return new Response(JSON.stringify({schemaVersion:1,target:'worker',createdAt:'2026-10-07',books:[entry,stale,unknown]}));
  });
  assert.deepEqual(loaded, [entry]);
  assert.deepEqual(urls, ['https://example.test/ripola/samples/audio/library/index.json']);
  assert.deepEqual(await loadAudioDemos('/', async () => new Response(JSON.stringify({schemaVersion:1,target:'worker',createdAt:'now',books:[{...entry,publicDemo:false}]}))), []);
});

test('bundled samples contain verified unchanged AAC and current correction with all 96 phrases', async () => {
  const root = new URL('../public/samples/audio/', import.meta.url);
  const index = JSON.parse(await readFile(new URL('library/index.json', root), 'utf8')) as PublicLibraryManifest;
  assert.equal(index.books.length, 3);
  const audit = await auditDistribution(new URL('../public/', import.meta.url).pathname);
  assert.equal(audit.audioBooks, 3);
  for (const [position, sample] of AUDIO_DEMOS.entries()) {
    const entry = index.books.find(entry => entry.id === sample.id && entry.revision === sample.revision)!;
    assert.equal(entry.publicDemo, true);
    const bytes = await readFile(new URL(entry.manifestUrl, root));
    const loaded = await loadDistributedBook(entry, audioDemoBaseUrl('https://example.test/ripola/'), async () => new Response(new Uint8Array(bytes)));
    assert.equal(loaded.presentation!.status, 'valid');
    assert.equal(loaded.presentation!.expectedUnits, 96);
    assert.equal(loaded.presentation!.displayedUnits, 96);
    assert.equal(loaded.presentation!.acousticEstimatedUnits, [25,66,63][position]);
    assert.deepEqual(loaded.presentation!.missingUnitIds, []);
    assert.deepEqual(loaded.presentation!.duplicateUnitIds, []);
    assert.equal(loaded.chunks.length, 13);
    for (const chunk of loaded.chunks) {
      const relative = chunk.audioUrl.split('/samples/audio/')[1];
      const audio = await readFile(new URL(relative, root));
      assert.equal(audio.length, chunk.bytes);
      assert.equal(contentHash(audio), chunk.sha256);
      assert.equal(chunk.timing.verification, 'pcm-correlated');
    }
    assert.equal('options' in loaded, false);
    assert.equal('speechKey' in loaded.chunks[0], false);
  }
});

test('shared sample URLs retain the selected voice without allowing arbitrary sample payloads', () => {
  for (const sample of AUDIO_DEMOS) {
    const url = 'https://example.com' + audioDemoHref(sample.key, 'pages', '/ripola/');
    assert.equal(getShareTarget(url).url, url);
    assert.equal(getShareTarget(url).qrAllowed, true);
  }
  const removed = getShareTarget('https://example.com/books/?sample=private-source&text=secret');
  assert.equal(removed.url, 'https://example.com/books/');
});
