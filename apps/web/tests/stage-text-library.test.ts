import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import type { ReadingDocument } from '../src/reader/model';
import { stageTextLibrary, writeStagedAsset } from '../../../scripts/stage-text-library.ts';

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ripola-text-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function documentFor(text: string): Promise<ReadingDocument> {
  return prepareDocument(importText(`# 見出し\n\n${text}\n\n次の段落です。`, 'md', 'テスト本'));
}
async function emptyPersonal(t: TestContext): Promise<string> {
  const base = await temporary(t);
  await mkdir(join(base, 'library'), { recursive: true });
  await writeFile(join(base, 'library', 'index.json'), `${JSON.stringify({ schemaVersion: 1, target: 'worker', audience: 'personal', createdAt: '2026-10-31T00:00:00.000Z', books: [] })}\n`);
  return base;
}
function selection(document: ReadingDocument, documentFile: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'text-test-01', revision: document.contentHash, documentFile, attribution: 'テスト著者／テスト本／出典URL', rightsConfirmed: true as const,
    updatedAt: '2026-10-31T01:00:00.000Z', ...extra,
  };
}
async function manifestOf(root: string): Promise<{ path: string; bytes: Buffer; manifest: { revision: string; updatedAt: string; document: ReadingDocument } }> {
  const library = JSON.parse(await readFile(join(root, 'library', 'index.json'), 'utf8')) as { books: Array<{ manifestUrl: string }> };
  assert.equal(library.books.length, 1);
  const path = join(root, library.books[0].manifestUrl);
  const bytes = await readFile(path);
  return { path, bytes, manifest: JSON.parse(bytes.toString('utf8')) };
}

test('identical asset bytes are reused for repeated references and different bytes collide', async t => {
  const root = await temporary(t);
  const path = join(root, 'library', 'books', 'shared', 'media', 'same.mp3');
  const bytes = new Uint8Array([1, 2, 3, 4]);
  // Two references to one verified audio asset must not fail with EEXIST.
  await writeStagedAsset(path, bytes);
  await writeStagedAsset(path, bytes);
  assert.deepEqual([...await readFile(path)], [...bytes]);
  await assert.rejects(writeStagedAsset(path, new Uint8Array([1, 2, 3, 5])), /different bytes/);
  assert.deepEqual([...await readFile(path)], [...bytes]);
});

test('text staging is deterministic for the same explicit metadata and reuses an existing immutable revision', async t => {
  const root = await temporary(t), base = await emptyPersonal(t), document = await documentFor('本文です。');
  const documentFile = join(root, 'document.json');
  await writeFile(documentFile, JSON.stringify(document));
  const config = { target: 'worker' as const, audience: 'personal' as const, existing: base, books: [selection(document, documentFile)] };
  const first = join(root, 'release-a'), second = join(root, 'release-b');
  await stageTextLibrary(config, first);
  await stageTextLibrary(config, second);
  const a = await manifestOf(first), b = await manifestOf(second);
  assert.deepEqual(a.bytes, b.bytes);
  assert.equal(a.manifest.updatedAt, '2026-10-31T01:00:00.000Z');

  // A local text-book JSON carries the same fixed updatedAt, so an allowlist can
  // omit it without reintroducing the stage-time clock.
  const localBook = join(root, 'local-book.json');
  await writeFile(localBook, JSON.stringify({ kind: 'text', updatedAt: '2026-10-31T01:00:00.000Z', document }));
  const third = join(root, 'release-c');
  await stageTextLibrary({ ...config, books: [{ ...selection(document, localBook), updatedAt: undefined }] }, third);
  assert.deepEqual((await manifestOf(third)).bytes, a.bytes);

  const fourth = join(root, 'release-d');
  const reused = await stageTextLibrary({ ...config, existing: first }, fourth);
  assert.equal(reused.added, 0);
  assert.equal(reused.reused, 1);
  assert.deepEqual((await manifestOf(fourth)).bytes, a.bytes);
});

test('a legacy raw document uses its source mtime, never the stage clock, so restaging is stable', async t => {
  const root = await temporary(t), base = await emptyPersonal(t), document = await documentFor('本文です。');
  const documentFile = join(root, 'document.json');
  await writeFile(documentFile, JSON.stringify(document));
  const config = { target: 'worker' as const, audience: 'personal' as const, existing: base, books: [{ ...selection(document, documentFile), updatedAt: undefined }] };
  const first = join(root, 'out-a'), second = join(root, 'out-b');
  await stageTextLibrary(config, first);
  await stageTextLibrary(config, second);
  const a = await manifestOf(first), b = await manifestOf(second);
  assert.deepEqual(a.bytes, b.bytes);
  assert.notEqual(a.manifest.updatedAt, new Date().toISOString());
});

test('a same id/revision with different document bytes is rejected without touching the existing stage', async t => {
  const root = await temporary(t), base = await emptyPersonal(t), document = await documentFor('本文です。');
  const documentFile = join(root, 'document.json');
  await writeFile(documentFile, JSON.stringify(document));
  const config = { target: 'worker' as const, audience: 'personal' as const, existing: base, books: [selection(document, documentFile)] };
  const first = join(root, 'release');
  await stageTextLibrary(config, first);
  const before = await readFile(join(first, 'library', 'index.json'));
  const altered = { ...document, provenance: { title: '別の由来', author: '著者', bibliography: '出典', notationNotes: '注記', counts: { ruby: 0, gaiji: 0, notes: 0 }, annotations: [], chapters: [] } };
  const alteredFile = join(root, 'altered.json');
  await writeFile(alteredFile, JSON.stringify(altered));
  await assert.rejects(stageTextLibrary({ ...config, existing: first, books: [selection(altered, alteredFile)] }, join(root, 'collision')), /different immutable bytes/);
  assert.deepEqual(await readFile(join(first, 'library', 'index.json')), before);
  await assert.rejects(lstat(join(root, 'collision')));
});

test('capacity preflight fails before creating the destination or changing the base catalog', async t => {
  const root = await temporary(t), base = await emptyPersonal(t), document = await documentFor('容量確認用の本文です。');
  const documentFile = join(root, 'document.json');
  await writeFile(documentFile, JSON.stringify(document));
  const before = await readFile(join(base, 'library', 'index.json'));
  const output = join(root, 'too-large');
  await assert.rejects(stageTextLibrary({ target: 'worker', audience: 'personal', existing: base, books: [selection(document, documentFile)] }, output, { maxAssetBytes: 200 }), /asset limit/);
  await assert.rejects(lstat(output));
  assert.deepEqual(await readFile(join(base, 'library', 'index.json')), before);
  // The same destination is usable after the preflight is corrected.
  await stageTextLibrary({ target: 'worker', audience: 'personal', existing: base, books: [selection(document, documentFile)] }, output);
  assert.equal((await manifestOf(output)).manifest.revision, document.contentHash);
});

test('duplicate selections and missing attribution are rejected before any output exists', async t => {
  const root = await temporary(t), base = await emptyPersonal(t), document = await documentFor('本文です。');
  const documentFile = join(root, 'document.json');
  await writeFile(documentFile, JSON.stringify(document));
  await assert.rejects(stageTextLibrary({ target: 'worker', audience: 'personal', existing: base, books: [selection(document, documentFile), selection(document, documentFile)] }, join(root, 'duplicate')), /duplicate|重複/i);
  await assert.rejects(stageTextLibrary({ target: 'worker', audience: 'personal', existing: base, books: [{ ...selection(document, documentFile), attribution: ' ' }] }, join(root, 'no-attribution')), /attribution/);
  await assert.rejects(lstat(join(root, 'duplicate')));
  await assert.rejects(lstat(join(root, 'no-attribution')));
});
