import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GenerationService } from '../src/generation/core/service.ts';
import { automaticChunkPlanner } from '../src/generation/core/automatic-chunk-planner.ts';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';
import { inspectAudioPresentation } from '../src/reader/audio-presentation.ts';
import type { GenerationOptions } from '../src/generation/contracts.ts';
import type { SpeechAdapter } from '../src/generation/core/providers.ts';
import { plannerFixtures } from './fixtures/speech-chunk-planner.ts';

const options: GenerationOptions = { provider: 'voicevox', voice: '3', transport: 'direct', readings: [], chunking: { mode: 'auto' } };
function wav(): Uint8Array {
  const sampleRate = 16000; const bytes = Buffer.alloc(44 + sampleRate * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const libraryDir = await mkdtemp(join(tmpdir(), 'ripola-planner-service-'));
  t.after(() => rm(libraryDir, { recursive: true, force: true }));
  const config = { libraryDir, localOrigin: 'http://127.0.0.1:4173', paidEnabled: false };
  let calls = 0; let version = 'voicevox-engine:mock-v1';
  const adapter: SpeechAdapter = { voices: async () => [{ id: '3', name: '自作mock' }], fingerprint: async () => version,
    synthesize: async (_request, beforeSend) => { await beforeSend(); calls++; return wav(); } };
  const service = new GenerationService(config, { voicevox: adapter, planChunks: automaticChunkPlanner, compression: { available: async () => false, encode: async () => { throw new Error('not used'); } } });
  const document = await prepareDocument(importText(plannerFixtures[1].text, 'txt', '自作の短文'));
  return { libraryDir, config, adapter, service, document, calls: () => calls, updateVersion: () => { version = 'voicevox-engine:mock-v2'; } };
}

test('fresh auto plans batch requests, keep complete display/source coverage, select stable IDs and reuse completed audio', async t => {
  const { service, document, calls } = await fixture(t);
  const plan = await service.prepareGeneration({ document, options });
  assert.equal(plan.chunks.length, 1); assert.ok(plan.chunkPlan);
  assert.equal(plan.chunks.map(chunk => chunk.originalText).join(''), document.blocks[0].text);
  const same = await service.prepareGeneration({ document, options });
  assert.equal(plan.hash, same.hash); assert.equal(plan.revision, same.revision); assert.deepEqual(plan.chunks, same.chunks);
  const selected = await service.prepareGeneration({ document, options: { ...options, selectedChunkIds: [plan.chunks[0].id] } });
  assert.equal(selected.chunks[0].speechKey, plan.chunks[0].speechKey);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'auto-complete', paidConfirmed: false });
  assert.equal((await service.waitForJob(job.id)).status, 'completed'); assert.equal(calls(), 1);
  const book = await service.getBook(job.bookId, job.revision);
  assert.equal(inspectAudioPresentation(book).status, 'valid');
  const cached = await service.prepareGeneration({ document, options });
  assert.ok(cached.chunks.every(chunk => chunk.cacheHit)); assert.equal(cached.sendingText, ''); assert.equal(calls(), 1);
});

test('planner version changes plan/revision, while identical transcripts reuse audio; provider versions change speech keys', async t => {
  const { service, config, adapter, document, updateVersion } = await fixture(t);
  const first = await service.prepareGeneration({ document, options });
  const job = await service.startGeneration({ planId: first.id, planHash: first.hash, operationId: 'version-base', paidConfirmed: false });
  await service.waitForJob(job.id);
  const next = new GenerationService(config, { voicevox: adapter, planChunks: input => ({ ...automaticChunkPlanner(input), version: 'fixture-planner-v2' }) });
  const revised = await next.prepareGeneration({ document, options });
  assert.notEqual(revised.revision, first.revision); assert.notEqual(revised.hash, first.hash);
  assert.equal(revised.chunks[0].id, first.chunks[0].id); assert.equal(revised.chunks[0].speechKey, first.chunks[0].speechKey); assert.equal(revised.chunks[0].cacheHit, true);
  updateVersion();
  const changedProvider = await next.prepareGeneration({ document, options });
  assert.notEqual(changedProvider.chunks[0].speechKey, first.chunks[0].speechKey); assert.equal(changedProvider.chunks[0].cacheHit, false);
  const displayOnly = structuredClone(document); displayOnly.versions.rules = 'display-only-fixture';
  const changedDisplay = await next.prepareGeneration({ document: displayOnly, options });
  assert.equal(changedDisplay.chunks[0].speechKey, changedProvider.chunks[0].speechKey);
});

test('restarting legacy saved jobs and reading completed books never invokes or applies the new planner', async t => {
  const { service, config, adapter, document, libraryDir, calls } = await fixture(t);
  const legacyOptions = { ...options, chunking: undefined };
  const legacy = await service.prepareGeneration({ document, options: legacyOptions });
  assert.equal(legacy.chunks.length, 12); assert.equal(legacy.chunkPlan, undefined);
  const job = await service.startGeneration({ planId: legacy.id, planHash: legacy.hash, operationId: 'legacy-complete', paidConfirmed: false });
  await service.waitForJob(job.id); assert.equal(calls(), 12);
  const bookPath = join(libraryDir, 'books', `${job.bookId}_${job.revision}.json`);
  const before = await readFile(bookPath);
  const restarted = new GenerationService(config, { voicevox: adapter, planChunks: () => { throw new Error('old saves must not replan'); } });
  await restarted.ready(); await restarted.getBook(job.bookId, job.revision); await restarted.getJobPlan(job.id);
  await restarted.resumeJob(job.id); await restarted.waitForJob(job.id);
  assert.equal(calls(), 12); assert.deepEqual(await readFile(bookPath), before);
});

test('a cancelled automatic plan resumes saved spans and keys after a planner update, sending only unsent work', async t => {
  const { config, document } = await fixture(t);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const adapter: SpeechAdapter = { voices: async () => [], capabilities: { local: true, supportsStyle: false, cancellation: 'before-send', maxCharacters: 20 },
    synthesize: async (_request, beforeSend) => { await beforeSend(); calls++; if (calls === 1) { entered(); await gate; } return wav(); } };
  const service = new GenerationService(config, { voicevox: adapter, planChunks: automaticChunkPlanner });
  const plan = await service.prepareGeneration({ document, options }); assert.ok(plan.chunks.length > 1);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'auto-cancel', paidConfirmed: false });
  await started; await service.cancelJob(job.id); release(); assert.equal((await service.waitForJob(job.id)).status, 'cancelled');
  const restarted = new GenerationService(config, { voicevox: adapter, planChunks: () => { throw new Error('resume must use saved plan'); } });
  const resume = await restarted.getJobPlan(job.id);
  assert.deepEqual(resume.chunks.map(chunk => [chunk.id, chunk.speechKey]), plan.chunks.slice(1).map(chunk => [chunk.id, chunk.speechKey]));
  await restarted.resumeJob(job.id); assert.equal((await restarted.waitForJob(job.id)).status, 'completed'); assert.equal(calls, plan.chunks.length);
});
