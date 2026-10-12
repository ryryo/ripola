import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldIo } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { AudioBookManifest, GenerationJob, GenerationOptions } from '../src/generation/contracts';
import { LibraryDisk } from '../src/generation/core/disk';
import { BookPublisher } from '../src/generation/core/book-publisher';
import { SpeechRequestError, type SpeechAdapter } from '../src/generation/core/providers';
import { GenerationService } from '../src/generation/core/service';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function wav() {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
  return bytes;
}
async function eventually(condition: () => Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!await condition()) {
    assert.ok(performance.now() < deadline, 'expected disk state was not published');
    await yieldIo();
  }
}
async function fixture(t: TestContext, provider: 'voicevox' | 'gemini' = 'voicevox', chunks = 3) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const libraryDir = await mkdtemp(join(tmpdir(), 'ripola-publication-'));
  const gates = Array.from({ length: chunks }, () => ({ sent: deferred(), audio: deferred(), fail: false }));
  let calls = 0;
  const adapter: SpeechAdapter = {
    async voices() { return [{ id: '3', name: 'fixture' }]; },
    async synthesize(_request, beforeSend) {
      await beforeSend();
      const gate = gates[calls++]; gate.sent.resolve(); await gate.audio.promise;
      if (gate.fail) throw new SpeechRequestError('fixture request failed', provider === 'gemini');
      return wav();
    },
  };
  const service = new GenerationService({ libraryDir, localOrigin: 'http://127.0.0.1:4173', paidEnabled: true, geminiApiKey: 'test-only', automaticCompression: false }, { voicevox: adapter, gemini: adapter });
  const disk = new LibraryDisk(libraryDir);
  let job: GenerationJob | undefined;
  t.after(async () => {
    gates.forEach(gate => gate.audio.resolve());
    if (job) await service.waitForJob(job.id);
    await rm(libraryDir, { recursive: true, force: true });
  });
  const document = await prepareDocument(importText(['朝の光が差す。', '窓を開ける。', '庭の木を見る。', '本を開く。'].slice(0, chunks).join(''), 'txt', '公開間隔の検証'));
  const options: GenerationOptions = { provider, voice: provider === 'voicevox' ? '3' : 'Kore', transport: 'direct', readings: [] };
  const plan = await service.prepareGeneration({ document, options });
  return {
    service, disk, plan, gates, adapter, calls: () => calls,
    async start() { job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'publication', paidConfirmed: true }); return job; },
    readBook: () => disk.read<AudioBookManifest>(['books', `${plan.bookId}_${plan.revision}.json`]),
  };
}

test('completed speech is published within five seconds while the next synthesis remains pending', async t => {
  const f = await fixture(t);
  const job = await f.start();
  await f.gates[0].sent.promise; f.gates[0].audio.resolve(); await f.gates[1].sent.promise;
  assert.equal((await f.readBook())!.completedChunks, 1);
  t.mock.timers.tick(1000);
  f.gates[1].audio.resolve(); await f.gates[2].sent.promise;
  assert.equal((await f.service.getJob(job.id)).completedChunks, 2);
  assert.equal((await f.readBook())!.completedChunks, 1);
  t.mock.timers.tick(3999);
  assert.equal((await f.readBook())!.completedChunks, 1);
  t.mock.timers.tick(1);
  await eventually(async () => (await f.readBook())?.completedChunks === 2);
  assert.equal(f.calls(), 3, 'the third request has not returned audio');
  const sequence = (await f.readBook())!.generation!.sequence;
  t.mock.timers.tick(10000); await yieldIo();
  assert.equal((await f.readBook())!.generation!.sequence, sequence, 'clean periods do not rewrite the manifest');
  f.gates[2].audio.resolve();
  assert.equal((await f.service.waitForJob(job.id)).status, 'completed');
  assert.equal((await f.readBook())!.completedChunks, 3);
  const finalSequence = (await f.readBook())!.generation!.sequence;
  t.mock.timers.tick(20000); await yieldIo();
  assert.equal((await f.readBook())!.generation!.sequence, finalSequence, 'the completed runner owns no publication timer');
});

test('a pending publication coalesces several completed chunks without postponing its deadline', async t => {
  const f = await fixture(t, 'voicevox', 4);
  const job = await f.start();
  await f.gates[0].sent.promise; f.gates[0].audio.resolve(); await f.gates[1].sent.promise;
  t.mock.timers.tick(1000);
  f.gates[1].audio.resolve(); await f.gates[2].sent.promise;
  t.mock.timers.tick(1000);
  f.gates[2].audio.resolve(); await f.gates[3].sent.promise;
  assert.equal((await f.readBook())!.completedChunks, 1);
  t.mock.timers.tick(3000);
  await eventually(async () => (await f.readBook())?.completedChunks === 3);
  assert.equal((await f.readBook())!.generation!.sequence, 2);
  assert.equal((await f.service.getJob(job.id)).completedChunks, 3);
});

test('cancel flushes completed in-flight speech before the deadline and leaves no timer', async t => {
  const f = await fixture(t, 'voicevox', 4);
  const job = await f.start();
  await f.gates[0].sent.promise; f.gates[0].audio.resolve(); await f.gates[1].sent.promise;
  t.mock.timers.tick(1000);
  f.gates[1].audio.resolve(); await f.gates[2].sent.promise;
  await f.service.cancelJob(job.id); f.gates[2].audio.resolve();
  const cancelled = await f.service.waitForJob(job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.completedChunks, 3);
  assert.equal((await f.readBook())!.completedChunks, 3); assert.equal(f.calls(), 3);
  const sequence = (await f.readBook())!.generation!.sequence;
  t.mock.timers.tick(10000); await yieldIo();
  assert.equal((await f.readBook())!.generation!.sequence, sequence);
});

test('an unknown paid request flushes prior speech promptly and is never resent', async t => {
  const f = await fixture(t, 'gemini');
  const job = await f.start();
  await f.gates[0].sent.promise; f.gates[0].audio.resolve(); await f.gates[1].sent.promise;
  t.mock.timers.tick(1000);
  f.gates[1].audio.resolve(); await f.gates[2].sent.promise;
  f.gates[2].fail = true; f.gates[2].audio.resolve();
  const failed = await f.service.waitForJob(job.id);
  assert.equal(failed.status, 'outcome-unknown'); assert.equal(failed.chunks[2].status, 'outcome-unknown');
  assert.equal((await f.readBook())!.completedChunks, 2);
  await assert.rejects(f.service.resumeJob(job.id, true), /安全に再開/);
  assert.equal(f.calls(), 3);
  const sequence = (await f.readBook())!.generation!.sequence;
  t.mock.timers.tick(10000); await yieldIo();
  assert.equal((await f.readBook())!.generation!.sequence, sequence);
});

for (const unknown of [false, true]) test(`a timer write failure republishes saved speech without credentials or resending an unknown request (${unknown})`, async t => {
  const f = await fixture(t, 'gemini');
  const failedWrite = deferred();
  const originalWrite = LibraryDisk.prototype.write;
  let publications = 0;
  t.mock.method(LibraryDisk.prototype, 'write', async function(this: LibraryDisk, parts: string[], value: unknown) {
    if (parts[0] === 'books' && ++publications === 2) { failedWrite.resolve(); throw new Error('fixture disk failure'); }
    await originalWrite.call(this, parts, value);
  });
  const job = await f.start();
  await f.gates[0].sent.promise; f.gates[0].audio.resolve(); await f.gates[1].sent.promise;
  t.mock.timers.tick(1000);
  f.gates[1].audio.resolve(); await f.gates[2].sent.promise;
  t.mock.timers.tick(4000); await failedWrite.promise; await yieldIo();
  f.gates[2].fail = unknown; f.gates[2].audio.resolve();
  const failed = await f.service.waitForJob(job.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedChunks, unknown ? 2 : 3);
  assert.ok(failed.chunks.every(chunk => chunk.attempts === 1));
  assert.equal(failed.chunks[2].status, unknown ? 'outcome-unknown' : 'completed');
  assert.equal((await f.readBook())!.completedChunks, 1);
  for (const chunk of failed.chunks.filter(chunk => chunk.status === 'completed')) assert.ok((await f.service.getAudio(chunk.speechKey)).bytes.length);
  const offline = new GenerationService({ libraryDir: f.disk.root, localOrigin: 'http://127.0.0.1:4173', paidEnabled: false, automaticCompression: false }, { gemini: { async voices() { return []; }, async synthesize() { assert.fail('republication must not send speech'); } } });
  await offline.resumeJob(job.id);
  const recovered = await offline.waitForJob(job.id);
  assert.equal(recovered.status, unknown ? 'outcome-unknown' : 'completed');
  assert.equal(recovered.chunks[2].status, unknown ? 'outcome-unknown' : 'completed');
  assert.equal((await f.readBook())!.completedChunks, unknown ? 2 : 3); assert.equal(f.calls(), 3);
});

test('a timer failure before the next paid send stops it without recording an unknown outcome', { timeout: 10_000 }, async t => {
  const preflight = deferred(), send = deferred(), failedWrite = deferred();
  t.after(() => send.resolve());
  const f = await fixture(t, 'gemini');
  let preflights = 0;
  f.adapter.preflight = async () => { if (++preflights === 3) { preflight.resolve(); await send.promise; } };
  const captured: { publisher?: BookPublisher } = {};
  const originalChanged = BookPublisher.prototype.changed;
  t.mock.method(BookPublisher.prototype, 'changed', function(this: BookPublisher) {
    captured.publisher ??= this;
    return originalChanged.call(this);
  });
  const diskFailure = new Error('fixture disk failure');
  const originalWrite = LibraryDisk.prototype.write;
  let publications = 0;
  t.mock.method(LibraryDisk.prototype, 'write', async function(this: LibraryDisk, parts: string[], value: unknown) {
    if (parts[0] === 'books' && ++publications === 2) { failedWrite.resolve(); throw diskFailure; }
    await originalWrite.call(this, parts, value);
  });
  const job = await f.start();
  await f.gates[0].sent.promise; f.gates[0].audio.resolve(); await f.gates[1].sent.promise;
  t.mock.timers.tick(1000);
  f.gates[1].audio.resolve(); await preflight.promise;
  t.mock.timers.tick(4000); await failedWrite.promise;
  await eventually(async () => {
    assert.ok(captured.publisher);
    try { captured.publisher.check(); return false; }
    catch (error) { assert.equal(error, diskFailure); return true; }
  });
  send.resolve();
  const failed = await f.service.waitForJob(job.id);
  assert.equal(failed.status, 'failed'); assert.equal(f.calls(), 2);
  assert.equal(failed.chunks[2].status, 'failed'); assert.equal(failed.chunks[2].attempts, 0);
  await f.service.resumeJob(job.id, true); f.gates[2].audio.resolve();
  assert.equal((await f.service.waitForJob(job.id)).status, 'completed'); assert.equal(f.calls(), 3);
});

test('finish waits for an in-flight publication and publishes changes made during that write in order', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const started = deferred(), release = deferred();
  const snapshots: number[] = [];
  let current = 1, active = 0, maximumActive = 0;
  const publisher = new BookPublisher(async () => {
    active++; maximumActive = Math.max(maximumActive, active);
    snapshots.push(current);
    if (snapshots.length === 2) { started.resolve(); await release.promise; }
    active--;
  });
  t.after(async () => { release.resolve(); await publisher.close(); });
  await publisher.changed();
  current = 2; await publisher.changed();
  t.mock.timers.tick(5000); await started.promise;
  current = 3;
  const changing = publisher.changed();
  let finished = false;
  const finishing = publisher.finish().then(() => { finished = true; });
  await yieldIo(); assert.equal(finished, false);
  release.resolve(); await changing; await finishing;
  assert.deepEqual(snapshots, [1, 2, 3]); assert.equal(maximumActive, 1);
  t.mock.timers.tick(10000); await yieldIo();
  assert.deepEqual(snapshots, [1, 2, 3]);
});
