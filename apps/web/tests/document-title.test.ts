import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticDocumentTitle, resolveDocumentTitle } from '../src/reader/document-title';
import { GenerationService } from '../src/generation/core/service';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';

test('optional title uses local civil date/time; explicit titles and guards remain predictable', () => {
  const date = new Date(2026, 9, 6, 19, 20, 30);
  assert.equal(automaticDocumentTitle(date), '2026/10/06 19:20:30');
  for (const input of ['', '   ', '\t\n　']) assert.equal(resolveDocumentTitle(input, date), '2026/10/06 19:20:30');
  assert.equal(resolveDocumentTitle('  自作の本  ', date), '自作の本');
  assert.throws(() => resolveDocumentTitle('x'.repeat(121)));
  assert.throws(() => resolveDocumentTitle('本\u0000名'));
  assert.throws(() => resolveDocumentTitle(null as unknown as string));
});

test('renaming saved audio changes only display-name metadata and survives server restart without TTS', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rsvp-title-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { libraryDir: root, localOrigin: 'http://127.0.0.1:4173', paidEnabled: false };
  let calls = 0;
  const adapter = { async voices() { return [{ id: '3', name: 'Synthetic fixture' }]; }, async synthesize(_value: unknown, beforeSend: () => Promise<void>) {
    await beforeSend(); calls++;
    const bytes = Buffer.alloc(44 + 16000 * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
  } };
  const service = new GenerationService(config, { voicevox: adapter });
  const title = automaticDocumentTitle(new Date(2026, 9, 6, 19, 20, 30));
  const document = await prepareDocument(importText('自作の本を読む。', 'txt', title));
  const options = { provider: 'voicevox' as const, voice: '3', transport: 'direct' as const, readings: [] };
  const plan = await service.prepareGeneration({ document, options });
  const other = await service.prepareGeneration({ document: await prepareDocument(importText('同じ時刻の別の文章。', 'txt', title)), options });
  assert.notEqual(plan.bookId, other.bookId);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'title-fixture', paidConfirmed: false });
  await service.waitForJob(job.id);
  const before = await service.getBook(job.bookId, job.revision);
  const path = join(root, 'books', `${job.bookId}_${job.revision}.json`);
  const bytes = await readFile(path);
  const audio = await readFile(join(root, 'audio', `${before.chunks[0].speechKey}.wav`));
  const renamed = await service.renameBook(before.id, before.revision, '  後から付けた名前  ');
  assert.equal(renamed.title, '後から付けた名前');
  assert.equal(renamed.document.title, renamed.title);
  assert.equal(renamed.id, before.id); assert.equal(renamed.revision, before.revision);
  assert.deepEqual(renamed.document.units, before.document.units); assert.deepEqual(renamed.chunks, before.chunks);
  assert.deepEqual(await readFile(path), bytes); assert.deepEqual(await readFile(join(root, 'audio', `${before.chunks[0].speechKey}.wav`)), audio);
  assert.equal(calls, 1);
  const restarted = new GenerationService(config, { voicevox: adapter });
  assert.equal((await restarted.getBook(before.id, before.revision)).title, renamed.title);
  assert.equal((await restarted.listLibrary())[0].title, renamed.title);
  await assert.rejects(restarted.renameBook('../bad', before.revision, '名前'));
  await assert.rejects(restarted.renameBook(before.id, before.revision, 'a'.repeat(121)));
});
