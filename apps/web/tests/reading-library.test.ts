import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LibraryDisk } from '../src/generation/core/disk';
import { ReadingLibrary } from '../src/generation/core/reading-library';
import { loadLibraryConfig } from '../src/generation/core/config';
import type { AudioBookManifest, GenerationJob } from '../src/generation/contracts';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'ripola-reading-library-')); t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new LibraryDisk(root), reader = new ReadingLibrary(disk);
  const document = await prepareDocument(importText('窓辺で本を読みます。次の頁を開きます。', 'txt', '保存本'));
  const block = document.blocks[0], revision = 'a'.repeat(64), speechKey = 'b'.repeat(64);
  const book: AudioBookManifest = { schemaVersion: 1, id: 'book', revision, title: document.title, document, updatedAt: '2026-10-16', completedChunks: 1, totalChunks: 1, durationSeconds: 3, precision: 'sentence', warnings: [], options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] },
    generation: { jobId: 'job', planId: 'plan', planHash: 'c'.repeat(64), sequence: 1 },
    chunks: [{ id: 'chunk', speechKey, audioUrl: `/api/local-audio/${speechKey}.wav`, mimeType: 'audio/wav', durationSeconds: 3, timeline: [{ chunkId: 'chunk', startSeconds: 0, endSeconds: 3, precision: 'sentence', blockId: block.id, start: 0, end: block.text.length, unitIds: document.units.map(unit => unit.id) }] }] };
  const job: GenerationJob = { schemaVersion: 1, id: 'job', operationId: 'operation', planId: 'plan', bookId: book.id, revision, title: book.title, provider: 'voicevox', status: 'running', createdAt: '2026-10-16', updatedAt: '2026-10-16', chunks: [], completedChunks: 1, totalChunks: 1 };
  const file = `${book.id}_${revision}.json`;
  await disk.write(['books', file], book); await disk.write(['jobs', 'job.json'], job);
  return { root, disk, reader, book, job, file };
}

test('unchanged reading polls omit the manuscript and preserve job recovery state', async t => {
  const { disk, reader, book, job } = await fixture(t);
  const first = await reader.update(book.id, book.revision, undefined, job.id);
  assert.ok(first.book); assert.equal(first.job?.status, 'running');
  assert.equal('chunks' in first.job!, false); assert.equal('operationId' in first.job!, false);
  const read = disk.readBytes.bind(disk); let bookReads = 0, allReads = 0;
  disk.readBytes = async parts => { allReads++; if (parts[0] === 'books') bookReads++; return read(parts); };
  const same = await reader.update(book.id, book.revision, first.version, job.id);
  assert.equal(same.book, undefined); assert.equal(bookReads, 0);
  assert.equal(allReads, 0);
  await disk.write(['jobs', 'job.json'], { ...job, status: 'cancelled' });
  const stopped = await reader.update(book.id, book.revision, same.version, job.id);
  assert.equal(stopped.job?.status, 'cancelled'); assert.equal(stopped.book, undefined);
  await reader.getBook(book.id, book.revision); await reader.listLibrary();
  assert.equal((await disk.read<GenerationJob>(['jobs', 'job.json']))?.status, 'cancelled');
});

test('same-sequence cue edits, rename and compression metadata changes invalidate reading versions', async t => {
  const { root, disk, reader, book, file } = await fixture(t);
  let current = await reader.update(book.id, book.revision);
  const unit = book.document.units[0];
  const aligned = structuredClone(book);
  aligned.chunks[0].alignment = { schemaVersion: 1, key: 'c'.repeat(64), audioHash: 'd'.repeat(64), normalizeVersion: 'fixture', alignerVersion: 'fixture', precision: 'phrase', method: 'forced-alignment', status: 'partial', score: .9, warnings: [], units: [], cues: [{ unitId: unit.id, unitIds: [unit.id], blockId: unit.blockId, start: unit.start, end: unit.end, startSeconds: .1, endSeconds: .6, score: .9 }] };
  await disk.write(['books', file], aligned);
  const changed = await reader.update(book.id, book.revision, current.version);
  assert.ok(changed.book); assert.notEqual(changed.version, current.version);
  assert.equal(changed.book.generation?.sequence, book.generation?.sequence);
  assert.equal(changed.book.chunks[0].alignment?.cues[0].startSeconds, .1); current = changed;
  await disk.write(['book-names', file], { schemaVersion: 1, title: '表示名' });
  const renamed = await reader.update(book.id, book.revision, current.version);
  assert.equal(renamed.book?.title, '表示名'); current = renamed;
  const key = book.chunks[0].speechKey;
  await disk.write(['audio-media', `${key}.json`], { schemaVersion: 1 });
  await assert.rejects(reader.update(book.id, book.revision, current.version), /MP3/);
  await rm(join(root, 'audio-media', `${key}.json`));
  assert.equal((await reader.update(book.id, book.revision, current.version)).book, undefined);
  await writeFile(join(root, 'books', file), JSON.stringify({ ...aligned, title: '直接編集' }));
  assert.equal((await reader.update(book.id, book.revision, current.version)).book?.document.title, '表示名');
  await rm(join(root, 'books', file));
  await assert.rejects(reader.update(book.id, book.revision, current.version), /見つかりません/);
});

test('a book replacement during validation cannot acknowledge the wrong manifest version', async t => {
  const { disk, reader, book, file } = await fixture(t);
  const first = await reader.update(book.id, book.revision);
  await disk.write(['book-names', file], { schemaVersion: 1, title: '変更名' });
  const read = disk.read.bind(disk); let replaced = false;
  disk.read = async <T>(parts: string[]) => {
    const result = await read<T>(parts);
    if (parts[0] === 'books' && !replaced) { replaced = true; await disk.write(parts, { ...book, durationSeconds: 4, chunks: [{ ...book.chunks[0], durationSeconds: 4 }] }); }
    return result;
  };
  const update = await reader.update(book.id, book.revision, first.version);
  assert.equal(update.book?.chunks[0].durationSeconds, 4);
  assert.equal((await reader.update(book.id, book.revision, update.version)).book, undefined);
  await assert.rejects(reader.update(book.id, book.revision, 'invalid'), /音声ID/);
  await disk.write(['jobs', 'other.json'], { id: 'other', bookId: 'other', revision: book.revision });
  await assert.rejects(reader.update(book.id, book.revision, update.version, 'other'), /一致しません/);
});

test('reading configuration ignores broken provider setup while validating the loopback origin', async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'deployment'));
  await writeFile(join(root, 'deployment/local-ai.wrangler.jsonc'), '{ broken provider config');
  await writeFile(join(root, '.env.local'), 'RSVP_LIBRARY_DIR=/tmp/reading-library\nRSVP_LOCAL_ORIGIN=http://localhost:4259\nRSVP_AI_GATEWAY_TOKEN=bad token\n');
  const keys = ['RSVP_LIBRARY_DIR', 'RSVP_LOCAL_ORIGIN'] as const;
  const saved = keys.map(key => process.env[key]); keys.forEach(key => { delete process.env[key]; });
  try {
    assert.deepEqual(await loadLibraryConfig(root), { libraryDir: '/tmp/reading-library', localOrigin: 'http://localhost:4259' });
    process.env.RSVP_LOCAL_ORIGIN = 'https://example.com';
    await assert.rejects(loadLibraryConfig(root), /localhost/);
  } finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
});
