import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryDisk } from '../src/generation/core/disk.ts';
import { LibraryCatalog } from '../src/generation/core/library-catalog.ts';
const revision = 'a'.repeat(64);
const file = `sample_${revision}.json`;
const book = { schemaVersion: 1, id: 'sample', revision, title: '原題', updatedAt: '2026-10-01T00:00:00Z', completedChunks: 1, totalChunks: 3, durationSeconds: 60, precision: 'sentence', document: { text: 'あ'.repeat(100_000) } };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'ripola-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new LibraryDisk(root); await disk.write(['books', file], book);
  let payloadReads = 0;
  const read = disk.readBytes.bind(disk);
  disk.readBytes = async parts => { if (parts[0] === 'books') payloadReads++; return read(parts); };
  return { root, disk, reads: () => payloadReads };
}

test('catalog migrates legacy books once, serves small summaries after restart, and keeps manifests canonical', async t => {
  const { disk, reads } = await fixture(t); const catalog = new LibraryCatalog(disk);
  const [first, simultaneous] = await Promise.all([catalog.list(), catalog.list()]);
  assert.deepEqual(first, simultaneous); assert.equal(first[0].title, '原題'); assert.equal('document' in first[0], false); assert.equal(reads(), 1);
  assert.deepEqual(await catalog.list(), first); assert.equal(reads(), 1);
  assert.deepEqual(await new LibraryCatalog(disk).list(), first); assert.equal(reads(), 1);
  assert.deepEqual(await disk.read(['books', file]), book);
});

test('catalog observes external replacement, in-place edits, rename metadata and deletion without invalidating every payload', async t => {
  const { disk, root, reads } = await fixture(t); const catalog = new LibraryCatalog(disk); await catalog.list();
  const other = new LibraryDisk(root);
  await other.write(['books', file], { ...book, durationSeconds: 90, completedChunks: 2 });
  assert.equal((await catalog.list())[0].durationSeconds, 90); assert.equal(reads(), 2);
  await disk.write(['book-names', file], { schemaVersion: 1, title: '表示名', updatedAt: '2026-10-10T00:00:00Z' });
  const renamed = (await catalog.list())[0]; assert.equal(renamed.title, '表示名'); assert.equal(renamed.updatedAt, book.updatedAt); assert.equal(reads(), 2);
  await writeFile(join(root, 'books', file), JSON.stringify({ ...book, durationSeconds: 80 }));
  assert.equal((await catalog.list())[0].durationSeconds, 80); assert.equal(reads(), 3);
  await rm(join(root, 'books', file)); assert.deepEqual(await catalog.list(), []);
});

test('missing or corrupt derived catalog rebuilds from the current manifest', async t => {
  const { root, disk, reads } = await fixture(t); await new LibraryCatalog(disk).list();
  await writeFile(join(root, 'catalog', 'index.json'), '{broken');
  assert.equal((await new LibraryCatalog(disk).list())[0].title, '原題'); assert.equal(reads(), 2);
  await rm(join(root, 'catalog', 'index.json'));
  assert.equal((await new LibraryCatalog(disk).list())[0].title, '原題'); assert.equal(reads(), 3);
});

test('a concurrent canonical replacement cannot be marked fresh using the later file stamp', async t => {
  const { disk, root } = await fixture(t); const read = disk.read.bind(disk); let replaced = false;
  disk.read = async <T>(parts: string[]) => {
    const value = await read<T>(parts);
    if (parts[0] === 'books' && !replaced) { replaced = true; await new LibraryDisk(root).write(parts, { ...book, durationSeconds: 120 }); }
    return value;
  };
  assert.equal((await new LibraryCatalog(disk).list())[0].durationSeconds, 120);
  assert.equal((await new LibraryCatalog(new LibraryDisk(root)).list())[0].durationSeconds, 120);
});

test('an unwritable derived cache does not block reading the catalog or mutate its cached summaries', async t => {
  const { disk, reads } = await fixture(t); const write = disk.write.bind(disk);
  disk.write = async (parts, value) => {
    if (parts[0] === 'catalog') throw Object.assign(new Error('read only'), { code: 'EROFS' });
    await write(parts, value);
  };
  const catalog = new LibraryCatalog(disk);
  const books = await catalog.list(); books[0].title = 'caller mutation';
  assert.equal((await catalog.list())[0].title, book.title);
  assert.equal(reads(), 1);
});

test('derived cache failures never hide unsafe paths or corrupt canonical book data', async t => {
  const { root, disk } = await fixture(t);
  await symlink(join(root, 'books', file), join(root, 'catalog'));
  await assert.rejects(new LibraryCatalog(disk).list(), /symlink/);
  await rm(join(root, 'catalog'));
  await writeFile(join(root, 'books', file), '{broken');
  await assert.rejects(new LibraryCatalog(disk).list(), SyntaxError);
});
