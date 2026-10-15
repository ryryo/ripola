import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GenerationService, type ServiceDependencies } from '../src/generation/core/service.ts';
import { digest, LibraryDisk } from '../src/generation/core/disk.ts';
import { IRODORI_CAPABILITIES, type SpeechAdapter } from '../src/generation/core/providers.ts';
import type { GenerationOptions } from '../src/generation/contracts.ts';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';

const options: GenerationOptions = { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] };
function wav() {
  const b = Buffer.alloc(32044);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(32000, 40); return b;
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(t: { after(fn: () => Promise<void>): void }, dependencies: ServiceDependencies = {}) {
  const libraryDir = await mkdtemp(join(tmpdir(), 'ripola-foundation-'));
  t.after(() => rm(libraryDir, { force: true, recursive: true }));
  const adapter: SpeechAdapter = { async voices() { return [{ id: '3', name: '自作声' }]; }, async synthesize(_r, beforeSend) { await beforeSend(); return wav(); } };
  const config = { libraryDir, localOrigin: 'http://127.0.0.1:4173', paidEnabled: false, automaticCompression: false };
  const service = new GenerationService(config, { voicevox: adapter, ...dependencies });
  const document = await prepareDocument(importText('朝の光が差す。窓を開ける。椅子に座る。', 'txt', '自作の基盤検証'));
  return { service, document, config, disk: new LibraryDisk(libraryDir) };
}

test('legacy defaults keep speech keys and sentence spans; absent optional providers add no setup or network calls', async t => {
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('Network must not be used'); });
  const { service, document } = await fixture(t, { planChunks() { throw new Error('Must be opt-in'); } });
  const plan = await service.prepareGeneration({ document, options });
  assert.equal(plan.chunks.length, 3); assert.equal(plan.chunkPlan, undefined);
  const c = plan.chunks[0];
  assert.equal(c.speechKey, digest(JSON.stringify({ schema: 'speech-v1', text: c.spokenText, provider: 'voicevox', model: 'voicevox-engine', voice: '3', style: '', providerVersion: 'voicevox-engine:unspecified' })));
  const config = await service.getGenerationConfig();
  assert.equal(config.providers?.find(p => p.id === 'irodori'), undefined);
  // Existing alignment capability probing may check loopback VOICEVOX; optional plans add no calls.
  const baselineCalls = networkCalls;
  await assert.rejects(service.prepareGeneration({ document, options: { ...options, provider: 'irodori', voice: 'none' } }), /開発用.*有効化/);
  assert.equal(networkCalls, baselineCalls);
});

test('priority changes execution only; partial publications identify gaps and final book retains source order', async t => {
  const firstEntered = gate(); const firstRelease = gate(); const secondEntered = gate(); const secondRelease = gate(); const calls: string[] = [];
  const { service, document } = await fixture(t, { voicevox: {
    async voices() { return []; }, async synthesize(r, beforeSend) {
      await beforeSend(); calls.push(r.text);
      if (calls.length === 1) { firstEntered.release(); await firstRelease.promise; }
      if (calls.length === 2) { secondEntered.release(); await secondRelease.promise; }
      return wav();
    },
  } });
  const plan = await service.prepareGeneration({ document, options });
  const ids = plan.chunks.map(c => c.id);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'priority', paidConfirmed: false, prioritizedChunkIds: [ids[2]] });
  await firstEntered.promise;
  await assert.rejects(service.prioritizeJobChunks(job.id, ['missing']), /対象外/);
  await assert.rejects(service.prioritizeJobChunks(job.id, [ids[1], ids[1]]), /重複/);
  await service.prioritizeJobChunks(job.id, [ids[1]]);
  firstRelease.release(); await secondEntered.promise;
  const partial = await service.getBook(job.bookId, job.revision);
  assert.deepEqual(partial.plannedChunkIds, ids); assert.deepEqual(partial.chunks.map(c => c.id), [ids[2]]); assert.equal(partial.chunks[0].sourceOrder, 2);
  assert.equal(partial.generation?.planHash, plan.hash); assert.equal(partial.generation?.jobId, job.id);
  secondRelease.release(); assert.equal((await service.waitForJob(job.id)).status, 'completed');
  assert.deepEqual(calls, [plan.chunks[2].spokenText, plan.chunks[1].spokenText, plan.chunks[0].spokenText]);
  const book = await service.getBook(job.bookId, job.revision);
  assert.deepEqual(book.chunks.map(c => c.id), ids); assert.ok(book.generation!.sequence > partial.generation!.sequence);
  assert.deepEqual((await service.getJob(job.id)).chunks.map(c => c.id), ids);
});

test('planner coverage is validated before synthesis and resume uses frozen spans without replanning', async t => {
  let plans = 0; let calls = 0;
  const { service, document, config } = await fixture(t, {
    planChunks({ defaultSpans }) { plans++; return { spans: [{ ...defaultSpans[0], end: defaultSpans.at(-1)!.end }], version: 'test-v1', settingsFingerprint: 'test-policy' }; },
    voicevox: { async voices() { return []; }, async synthesize(_r, beforeSend) { await beforeSend(); calls++; return wav(); } },
    async finalizeAudio() { throw new Error('Fixture local finalization failure'); },
  });
  const plan = await service.prepareGeneration({ document, options: { ...options, chunking: { mode: 'auto' } } });
  assert.equal(plan.chunks.length, 1); assert.equal(plan.chunkPlan?.version, 'test-v1');
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'frozen', paidConfirmed: false });
  assert.equal((await service.waitForJob(job.id)).status, 'failed');
  const restarted = new GenerationService(config, { planChunks() { throw new Error('New planner must not run'); } });
  const preview = await restarted.getJobPlan(job.id);
  assert.equal(plans, 1); assert.equal(preview.chunks[0].speechKey, plan.chunks[0].speechKey); assert.equal(preview.chunks[0].cacheHit, true);
  await restarted.resumeJob(job.id); assert.equal((await restarted.waitForJob(job.id)).status, 'completed'); assert.equal(calls, 1);
  const invalid = new GenerationService(config, { voicevox: { async voices() { return []; }, async synthesize() { throw new Error('Must not synthesize'); } }, planChunks({ defaultSpans }) { return { spans: defaultSpans.slice(1), version: 'invalid', settingsFingerprint: 'test' }; } });
  await assert.rejects(invalid.prepareGeneration({ document, options: { ...options, chunking: { mode: 'auto' } } }), /元範囲|未収録/);
});

test('abort-capable local provider cancels the active request and resumes only unfinished work', async t => {
  const entered = gate(); let calls = 0; let receivedVersion: string | undefined;
  const adapter: SpeechAdapter = { endpoint: 'http://127.0.0.1:59999', capabilities: IRODORI_CAPABILITIES,
    attribution() { return '検証用の自作音声'; },
    async fingerprint() { return 'irodori-test:model-and-voice'; }, async voices() { return [{ id: 'none', name: '自作fixture' }]; },
    async synthesize(r, beforeSend) {
      receivedVersion = r.providerVersion; await beforeSend(); calls++;
      if (calls === 1) { entered.release(); await new Promise((_resolve, reject) => r.signal!.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true })); }
      return wav();
    },
  };
  const { service, document } = await fixture(t, { providers: { irodori: adapter } });
  const plan = await service.prepareGeneration({ document, options: { ...options, provider: 'irodori', voice: 'none', irodori: { steps: 4, seed: 1 } } });
  assert.equal(plan.attribution, '検証用の自作音声');
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'abort', paidConfirmed: false });
  await entered.promise; await service.cancelJob(job.id);
  const stopped = await service.waitForJob(job.id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.chunks[0].status, 'pending'); assert.equal(calls, 1);
  assert.equal(receivedVersion, plan.providerVersion);
  await service.resumeJob(job.id); assert.equal((await service.waitForJob(job.id)).status, 'completed'); assert.equal(calls, 4);
  assert.equal((await service.getBook(job.bookId, job.revision)).attribution, plan.attribution);
});

test('disabling Irodori rejects new, cached and resumed generation while saved audio remains readable', async t => {
  let calls = 0;
  const adapter: SpeechAdapter = { async voices() { return [{ id: 'fixture', name: '自作検証声' }]; }, async synthesize(_r, beforeSend) { await beforeSend(); calls++; return wav(); } };
  const { service, document, config, disk } = await fixture(t, { providers: { irodori: adapter } });
  assert.equal((await service.getGenerationConfig()).providers?.find(p => p.id === 'irodori')?.available, true);
  const plan = await service.prepareGeneration({ document, options: { ...options, provider: 'irodori', voice: 'fixture' } });
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'before-disable', paidConfirmed: false });
  assert.equal((await service.waitForJob(job.id)).status, 'completed');
  const disabled = new GenerationService(config, { voicevox: adapter });
  assert.equal((await disabled.getGenerationConfig()).providers?.some(p => p.id === 'irodori'), false);
  const book = await disabled.getBook(job.bookId, job.revision);
  assert.equal(book.options.provider, 'irodori'); assert.equal(book.chunks.length, 3);
  assert.equal((await disabled.getAudio(book.chunks[0].speechKey)).bytes.length, wav().length);
  await assert.rejects(disabled.prepareGeneration({ document, options: plan.options }), /開発用.*有効化/);
  await assert.rejects(disabled.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'after-disable', paidConfirmed: false }), /開発用.*有効化/);
  const interrupted = await service.getJob(job.id); interrupted.status = 'cancelled'; interrupted.chunks[2].status = 'pending';
  await disk.write(['jobs', `${job.id}.json`], interrupted);
  await assert.rejects(disabled.resumeJob(job.id), /開発用.*有効化/);
  assert.deepEqual(await disabled.getJob(job.id), interrupted); assert.equal(calls, 3);
  assert.equal((await disabled.getBook(job.bookId, job.revision)).chunks.length, 3);
});

test('old saved books lacking new optional fields remain readable without changing their files', async t => {
  const { service, document, disk } = await fixture(t);
  const plan = await service.prepareGeneration({ document, options });
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'legacy-book', paidConfirmed: false });
  await service.waitForJob(job.id);
  const book = await service.getBook(job.bookId, job.revision); delete book.generation; delete book.plannedChunkIds;
  book.chunks.forEach(c => { delete c.sourceOrder; });
  await disk.write(['books', `${book.id}_${book.revision}.json`], book);
  const before = await disk.readBytes(['books', `${book.id}_${book.revision}.json`]);
  const restored = await service.getBook(book.id, book.revision);
  assert.deepEqual(restored.chunks.map(c => c.id), plan.chunks.map(c => c.id)); assert.equal(restored.generation, undefined);
  assert.deepEqual(await disk.readBytes(['books', `${book.id}_${book.revision}.json`]), before);
});
