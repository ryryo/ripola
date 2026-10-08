import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';
import type { GenerationOptions, GenerationJob } from '../src/generation/contracts.ts';
import { loadGenerationConfig } from '../src/generation/core/config.ts';
import { digest, LibraryDisk } from '../src/generation/core/disk.ts';
import { GenerationService } from '../src/generation/core/service.ts';
import { SpeechRequestError, wavDuration, geminiAdapter, gatewayEndpoint, type SpeechAdapter } from '../src/generation/core/providers.ts';

function wav(seconds = 1): Uint8Array {
  const sampleRate = 16000;
  const bytes = Buffer.alloc(44 + sampleRate * 2 * seconds);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function gatewayControlResponse(url: string): Response {
  return new Response(JSON.stringify({success: true, result: url.includes('/provider_configs?') ? [] : {id: 'reader', authentication: true, byok_only: false}}));
}
function gatewayAudioResponse(): Response {
  return new Response(JSON.stringify({success: true, result: {audio: Buffer.from(wav()).toString('base64'), gatewayMetadata: {keySource: 'Unified'}}}));
}
const voiceOptions: GenerationOptions = { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, adapter?: SpeechAdapter, paid = false) {
  const libraryDir = await mkdtemp(join(tmpdir(), 'rsvp-generation-test-'));
  t.after(() => rm(libraryDir, { recursive: true, force: true }));
  let calls = 0;
  const mock: SpeechAdapter = adapter ?? { async voices() { return [{ id: '3', name: 'テスト声' }]; }, async synthesize(_request, beforeSend) { await beforeSend(); calls++; return wav(); } };
  const config = { libraryDir, localOrigin: 'http://127.0.0.1:4173', paidEnabled: paid, ...(paid ? { geminiApiKey: 'test-only-credential' } : {}) };
  const service = new GenerationService(config, { voicevox: mock, gemini: mock });
  await service.ready();
  const document = await prepareDocument(importText('朝の光が差す。窓を開ける。', 'txt', '自作の検証'));
  return { service, config, mock, document, disk: new LibraryDisk(libraryDir), calls: () => calls };
}

test('plans preserve sentence/source boundaries, apply ruby and dictionary, and share an immutable audio cache', async (t) => {
  const { service, calls } = await fixture(t);
  const document = await prepareDocument(importText('# 自作\n\n<ruby>東京<rt>とうきょう</rt></ruby>へ行く。図書館で読む。\n\n```ts\n秘密ではないコード\n```', 'md', '自作'));
  const options = { ...voiceOptions, readings: [{ text: '図書館', reading: 'としょかん' }] };
  const plan = await service.prepareGeneration({ document, options });
  assert.equal(plan.chunks.length, 3);
  assert.match(plan.sendingText, /とうきょうへ行く。\nとしょかんで読む。/);
  assert.ok(!plan.sendingText.includes('コード'));
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'operation-a', paidConfirmed: false });
  assert.equal((await service.waitForJob(job.id)).status, 'completed');
  assert.equal(calls(), 3);
  const book = await service.getBook(job.bookId, job.revision);
  assert.equal(book.precision, 'sentence'); assert.equal(book.durationSeconds, 3);
  assert.ok(book.chunks.every((chunk) => chunk.timeline.length === 1 && chunk.timeline[0].startSeconds === 0 && chunk.timeline[0].endSeconds === 1));
  assert.equal((await service.getAudio(book.chunks[0].speechKey)).bytes.length, wav().length);
  const cachedPlan = await service.prepareGeneration({ document, options });
  assert.ok(cachedPlan.chunks.every((chunk) => chunk.cacheHit)); assert.equal(cachedPlan.sendingText, '');
  const second = await service.startGeneration({ planId: cachedPlan.id, planHash: cachedPlan.hash, operationId: 'operation-b', paidConfirmed: false });
  assert.equal((await service.waitForJob(second.id)).status, 'completed'); assert.equal(calls(), 3);
});

test('double-click and simultaneous process requests have durable operation idempotency', async (t) => {
  const { service, config, mock, document, calls } = await fixture(t);
  const other = new GenerationService(config, { voicevox: mock }); await other.ready();
  const plan = await service.prepareGeneration({ document, options: voiceOptions });
  const input = { planId: plan.id, planHash: plan.hash, operationId: 'double-click', paidConfirmed: false };
  const [a, b] = await Promise.all([service.startGeneration(input), other.startGeneration(input)]);
  assert.equal(a.id, b.id);
  await service.waitForJob(a.id); await other.waitForJob(b.id);
  assert.equal(calls(), 2); assert.equal((await service.listJobs()).length, 1);
  await assert.rejects(service.startGeneration({ ...input, planHash: 'changed' }), /計画/);
});

test('cancel retains in-flight completed audio and resume sends only missing sentences', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const adapter: SpeechAdapter = { async voices() { return [{ id: '3', name: '声' }]; }, async synthesize(_request, beforeSend) { await beforeSend(); calls++; if (calls === 1) { entered(); await gate; } return wav(); } };
  const { service, document } = await fixture(t, adapter);
  const plan = await service.prepareGeneration({ document, options: voiceOptions });
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'cancel-a', paidConfirmed: false });
  await started; await service.cancelJob(job.id); release();
  const cancelled = await service.waitForJob(job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.completedChunks, 1); assert.equal(calls, 1);
  assert.equal((await service.getBook(job.bookId, job.revision)).completedChunks, 1);
  const resumed = await service.resumeJob(job.id); await service.waitForJob(resumed.id);
  assert.equal((await service.getJob(job.id)).status, 'completed'); assert.equal(calls, 2);
});

test('downstream alignment failure leaves raw audio durable and resume never repeats TTS', async (t) => {
  const { config, mock, document, calls } = await fixture(t);
  let failures = 1;
  const service = new GenerationService(config, { voicevox: mock, async finalizeAudio(bytes) { if (failures > 0) { failures--; throw new Error('internal details'); } return wavDuration(bytes); } });
  const plan = await service.prepareGeneration({ document, options: voiceOptions });
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'downstream-a', paidConfirmed: false });
  const failed = await service.waitForJob(job.id); assert.equal(failed.status, 'failed'); assert.equal(failed.chunks[0].status, 'audio-ready'); assert.equal(calls(), 1);
  const resumePlan = await service.getJobPlan(job.id); assert.equal(resumePlan.chunks[0].cacheHit, true); assert.ok(!resumePlan.sendingText.includes('朝の光'));
  await service.resumeJob(job.id); assert.equal((await service.waitForJob(job.id)).status, 'completed'); assert.equal(calls(), 2);
});

test('restart recovers paid sent requests as unknown and never resends them; only unsent work resumes with explicit confirmation', async (t) => {
  const { service, config, mock, document, disk, calls } = await fixture(t, undefined, true);
  const options: GenerationOptions = { provider: 'gemini', voice: 'Kore', model: 'gemini-3.8-flash-lite-tts', transport: 'direct', readings: [] };
  const plan = await service.prepareGeneration({ document, options });
  const job: GenerationJob = { schemaVersion: 1, id: 'job-interrupted', operationId: 'interrupted', planId: plan.id, bookId: plan.bookId, revision: plan.revision, title: plan.title, provider: 'gemini', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), chunks: plan.chunks.map((chunk, index) => ({ id: chunk.id, speechKey: chunk.speechKey, status: index === 0 ? 'sending' : 'pending', attempts: index === 0 ? 1 : 0, reused: false })), completedChunks: 0, totalChunks: 2 };
  await disk.write(['jobs', `${job.id}.json`], job);
  await disk.write(['cache', `${job.chunks[0].speechKey}.json`], { schemaVersion: 1, provider: 'gemini', status: 'sending' });
  const restarted = new GenerationService(config, { gemini: mock }); await restarted.ready();
  assert.equal((await restarted.getJob(job.id)).status, 'outcome-unknown'); assert.equal(calls(), 0);
  const remaining = await restarted.getJobPlan(job.id); assert.equal(remaining.chunks.length, 1); assert.match(remaining.sendingText, /窓/);
  await assert.rejects(restarted.resumeJob(job.id), /有料再開/);
  await restarted.resumeJob(job.id, true); const result = await restarted.waitForJob(job.id);
  assert.equal(result.status, 'outcome-unknown'); assert.equal(calls(), 1); assert.equal(result.completedChunks, 1);
  await assert.rejects(restarted.resumeJob(job.id, true), /安全に再開/); assert.equal(calls(), 1);
});

test('paid network outcome uncertainty is retained across a fresh plan; Gateway never falls back', async (t) => {
  let calls = 0;
  const adapter: SpeechAdapter = { async voices() { return []; }, async synthesize(_request, beforeSend) { await beforeSend(); calls++; throw new SpeechRequestError('応答不明', true); } };
  const { service, document } = await fixture(t, adapter, true);
  const options: GenerationOptions = { provider: 'gemini', voice: 'Kore', transport: 'direct', readings: [] };
  const plan = await service.prepareGeneration({ document, options });
  await assert.rejects(service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'unconfirmed', paidConfirmed: false }), /有料開始/);
  await assert.rejects(service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'bad-confirmation', paidConfirmed: 'yes' as unknown as boolean }), /有料開始/);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'uncertain-a', paidConfirmed: true });
  assert.equal((await service.waitForJob(job.id)).status, 'outcome-unknown'); assert.equal(calls, 1);
  const second = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'uncertain-b', paidConfirmed: true });
  await service.waitForJob(second.id); assert.equal(calls, 2); // First unknown stays blocked; the previously unsent second sentence may execute.
  const gateway = await service.prepareGeneration({ document, options: { ...options, transport: 'gateway' } });
  assert.equal(gateway.available, false); assert.equal(gateway.chunks[0].speechKey, plan.chunks[0].speechKey);
  await assert.rejects(service.startGeneration({ planId: gateway.id, planHash: gateway.hash, operationId: 'gateway', paidConfirmed: true }), /Gateway/); assert.equal(calls, 2);
});

test('cache integrity, invalid IDs and symlink references fail without regeneration', async (t) => {
  const { service, document, config, calls, disk } = await fixture(t);
  const plan = await service.prepareGeneration({ document, options: voiceOptions });
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'integrity', paidConfirmed: false }); await service.waitForJob(job.id);
  const key = plan.chunks[0].speechKey;
  await writeFile(join(config.libraryDir, 'audio', `${key}.wav`), wav(2));
  await assert.rejects(service.getAudio(key), /整合性/); await assert.rejects(service.prepareGeneration({ document, options: voiceOptions }), /整合性/); assert.equal(calls(), 2);
  await assert.rejects(service.getAudio('../secret'), /音声ID/); await assert.rejects(service.getBook('../secret'), /ID/);
  const external = join(config.libraryDir, 'outside.txt'); await writeFile(external, 'outside');
  await symlink(external, join(config.libraryDir, 'audio', `${digest('symlink')}.wav`));
  await assert.rejects(disk.readBytes(['audio', `${digest('symlink')}.wav`]), /symlink/);
});

test('configuration and public DTOs never reveal credentials; .env.local loading is explicit and does not mutate process env', async (t) => {
  const { service, config } = await fixture(t, undefined, true);
  const dto = await service.getGenerationConfig(); assert.equal(dto.gemini.credentialConfigured, true); assert.ok(!JSON.stringify(dto).includes(config.geminiApiKey!));
  const root = await mkdtemp(join(tmpdir(), 'rsvp-env-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env.local'), 'GEMINI_API_KEY=private-test-value\nRSVP_LIBRARY_DIR=/tmp/rsvp-test-library\nRSVP_ENABLE_PAID_GENERATION=true\n');
  const before = process.env.GEMINI_API_KEY;
  const loaded = await loadGenerationConfig(root); assert.equal(loaded.geminiApiKey, before === undefined ? 'private-test-value' : before || undefined); assert.equal(process.env.GEMINI_API_KEY, before);
  assert.equal(loaded.libraryDir, process.env.RSVP_LIBRARY_DIR ?? '/tmp/rsvp-test-library');
});

test('long manuscript planning selects deterministic sentences without fake phrase timing', async (t) => {
  const { service } = await fixture(t);
  const document = await prepareDocument(importText('日差しの中で本を開いた。次の頁をゆっくり読んだ。\n'.repeat(4000), 'txt', '長文の自作検証'));
  const plan = await service.prepareGeneration({ document, options: voiceOptions }); assert.ok(document.rawText.length >= 100000); assert.equal(plan.chunks.length, 8000);
  const selected = await service.prepareGeneration({ document, options: { ...voiceOptions, selectedChunkIds: [plan.chunks[999].id] } });
  assert.equal(selected.chunks.length, 1); assert.equal(selected.chunks[0].speechKey, plan.chunks[999].speechKey);
  await assert.rejects(service.prepareGeneration({ document, options: { ...voiceOptions, selectedChunkIds: ['missing'] } }), /本文に存在/);
});


test('paid raw audio survives a downstream failure and restart with zero repeated TTS requests', async (t) => {
  const { config, mock, document, calls } = await fixture(t, undefined, true);
  const options: GenerationOptions = { provider: 'gemini', voice: 'Kore', transport: 'direct', readings: [] };
  const failing = new GenerationService(config, { gemini: mock, async finalizeAudio() { throw new Error('alignment unavailable'); } });
  const plan = await failing.prepareGeneration({ document, options });
  const job = await failing.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'paid-alignment', paidConfirmed: true });
  assert.equal((await failing.waitForJob(job.id)).chunks[0].status, 'audio-ready'); assert.equal(calls(), 1);
  const restarted = new GenerationService(config, { gemini: mock }); await restarted.ready();
  const remaining = await restarted.getJobPlan(job.id); assert.equal(remaining.chunks[0].cacheHit, true); assert.ok(!remaining.sendingText.includes('朝の光'));
  await restarted.resumeJob(job.id, true); assert.equal((await restarted.waitForJob(job.id)).status, 'completed'); assert.equal(calls(), 2);
  const ready = await restarted.prepareGeneration({ document, options }); assert.equal(ready.sendingText, ''); assert.equal(ready.estimatedOutputUsd, 0);
});

test('a durable job record recovers an operation mapping interrupted before it was written', async (t) => {
  const { service, document, disk, calls } = await fixture(t);
  const plan = await service.prepareGeneration({ document, options: voiceOptions });
  const operationId = 'operation-crashed-before-index';
  const job: GenerationJob = { schemaVersion: 1, id: `job-${digest(operationId)}`, operationId, planId: plan.id, bookId: plan.bookId, revision: plan.revision, title: plan.title, provider: 'voicevox', status: 'cancelled', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), chunks: plan.chunks.map((chunk) => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'pending', attempts: 0, reused: false })), completedChunks: 0, totalChunks: 2 };
  await disk.write(['jobs', `${job.id}.json`], job);
  const recovered = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId, paidConfirmed: false });
  assert.equal(recovered.id, job.id); assert.equal(recovered.status, 'cancelled'); assert.equal(calls(), 0);
  assert.equal((await service.listJobs()).length, 1);
});


test('independent browser/CLI jobs serialize the same paid speech key and reuse its completed result', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const adapter: SpeechAdapter = { async voices() { return []; }, async synthesize(_request, beforeSend) { await beforeSend(); calls++; entered(); await gate; return wav(); } };
  const { service, config, document } = await fixture(t, adapter, true);
  const cli = new GenerationService(config, { gemini: adapter }); await cli.ready();
  const options: GenerationOptions = { provider: 'gemini', voice: 'Kore', transport: 'direct', readings: [] };
  const all = await service.prepareGeneration({ document, options });
  const plan = await service.prepareGeneration({ document, options: { ...options, selectedChunkIds: [all.chunks[0].id] } });
  const browser = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'browser-paid', paidConfirmed: true });
  await started;
  const command = await cli.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'cli-paid', paidConfirmed: true });
  assert.equal((await cli.waitForJob(command.id)).status, 'failed'); assert.equal(calls, 1);
  release(); assert.equal((await service.waitForJob(browser.id)).status, 'completed');
  await cli.resumeJob(command.id, true); assert.equal((await cli.waitForJob(command.id)).status, 'completed'); assert.equal(calls, 1);
});

test('WAV duration reads actual data and rejects malformed formats', () => {
  assert.equal(wavDuration(wav(2)), 2);
  assert.throws(() => wavDuration(new Uint8Array([1, 2, 3])), /WAV/);
  const broken = wav(); Buffer.from(broken.buffer).writeUInt32LE(999999999, 40); assert.throws(() => wavDuration(broken), /途中/);
});


test('accidentally collapsed source phrases are rejected before synthesis', async t => {
  const { service, document, calls } = await fixture(t);
  const collapsed = structuredClone(document); const block = collapsed.blocks[0];
  collapsed.units = [{ ...collapsed.units[0], start: 0, end: block.text.length, text: block.text, ruby: block.ruby,
    characters: collapsed.totalCharacters, cumulativeCharacters: 0, pause: 'paragraph', sources: [{ kind: 'text', start: 0, end: block.text.length }] }];
  await assert.rejects(service.prepareGeneration({ document: collapsed, options: voiceOptions }), /source-segmentation-mismatch/);
  assert.equal(calls(), 0);
});


test('Gateway plans preflight without speech, reject changed routes, and share completed audio with Direct', async t => {
  const { config, document, disk, mock } = await fixture(t, undefined, true);
  const gateway = {accountId: 'a'.repeat(32), gatewayId: 'reader', token: 'mock-gateway-secret'};
  let sends = 0; let verifies = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url !== gatewayEndpoint(gateway)) { verifies++; return gatewayControlResponse(url); }
    assert.equal(url, gatewayEndpoint(gateway)); sends++;
    return gatewayAudioResponse();
  });
  const service = new GenerationService({...config, gateway}, {voicevox: mock, gemini: geminiAdapter(config.geminiApiKey, gateway)});
  const opts: GenerationOptions = {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []};
  const plan = await service.prepareGeneration({document, options: opts});
  assert.equal(plan.available, true); assert.equal(plan.endpoint, gatewayEndpoint(gateway)); assert.equal(verifies, 0); assert.equal(sends, 0);
  await assert.rejects(service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'gateway-no-confirm', paidConfirmed: false}), /有料開始/);
  const changed = new GenerationService({...config, gateway: {...gateway, gatewayId: 'other'}}, {voicevox: mock});
  await assert.rejects(changed.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'gateway-wrong-route', paidConfirmed: true}), /Gateway設定/);
  const job = await service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'gateway-paid-mock', paidConfirmed: true});
  assert.equal((await service.waitForJob(job.id)).status, 'completed'); assert.equal(sends, 2);
  const record = await disk.read<Record<string, unknown>>(['receipts', `${plan.chunks[0].speechKey}.json`]);
  assert.equal(record?.transport, 'gateway'); assert.ok(!JSON.stringify(record).includes('secret'));
  const direct = await service.prepareGeneration({document, options: {...opts, transport: 'direct'}});
  assert.equal(direct.sendingText, ''); assert.ok(direct.chunks.every(chunk => chunk.cacheHit));
  const reused = await service.startGeneration({planId: direct.id, planHash: direct.hash, operationId: 'direct-reuses-gateway', paidConfirmed: true});
  assert.equal((await service.waitForJob(reused.id)).status, 'completed'); assert.equal(sends, 2);
  const gatewayCached = await service.prepareGeneration({document, options: opts});
  assert.equal(gatewayCached.sendingText, ''); assert.equal(verifies, 0);
  const dto = await service.getGenerationConfig(); assert.equal(dto.transports.find(value => value.id === 'gateway')?.available, true); assert.ok(!JSON.stringify(dto).includes('secret'));
});

test('Gateway timeout remains blocked when a fresh Direct plan requests the same unfinished audio', async t => {
  const {config, document, mock} = await fixture(t, undefined, true);
  const gateway = {accountId: 'a'.repeat(32), gatewayId: 'reader', token: 'mock-gateway-secret'};
  let sends = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url !== gatewayEndpoint(gateway)) return gatewayControlResponse(url);
    sends++; return new Response('private-timeout-details', {status: 504});
  });
  const service = new GenerationService({...config, gateway}, {voicevox: mock});
  const options: GenerationOptions = {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []};
  const all = await service.prepareGeneration({document, options});
  const selected = {...options, selectedChunkIds: [all.chunks[0].id]};
  const plan = await service.prepareGeneration({document, options: selected});
  const job = await service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'gateway-unknown', paidConfirmed: true});
  assert.equal((await service.waitForJob(job.id)).status, 'outcome-unknown'); assert.equal(sends, 1);
  const direct = await service.prepareGeneration({document, options: {...selected, transport: 'direct'}});
  const second = await service.startGeneration({planId: direct.id, planHash: direct.hash, operationId: 'direct-still-unknown', paidConfirmed: true});
  assert.equal((await service.waitForJob(second.id)).status, 'outcome-unknown'); assert.equal(sends, 1);
});

test('Gateway env settings are server-only and partial settings do not enable the route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rsvp-gateway-env-')); t.after(() => rm(root, {recursive: true, force: true}));
  const prefix = `RSVP_AI_GATEWAY_ACCOUNT_ID=${'a'.repeat(32)}\nRSVP_AI_GATEWAY_ID=reader\n`;
  await writeFile(join(root, '.env.local'), prefix);
  assert.equal((await loadGenerationConfig(root)).gateway?.mode, 'wrangler');
  await writeFile(join(root, '.env.local'), prefix+'RSVP_AI_GATEWAY_TOKEN=mock-gateway-secret\n');
  assert.equal((await loadGenerationConfig(root)).gateway?.gatewayId, 'reader');
  assert.equal((await loadGenerationConfig(root)).gateway?.mode, 'wrangler');
  await writeFile(join(root, '.env.local'), prefix+'RSVP_AI_GATEWAY_TOKEN=mock-gateway-secret\nRSVP_AI_GATEWAY_TRANSPORT=rest\n');
  assert.equal((await loadGenerationConfig(root)).gateway?.mode, 'rest');
  await writeFile(join(root, '.env.local'), prefix.replace('reader', '../../bad')+'RSVP_AI_GATEWAY_TOKEN=mock-gateway-secret\n');
  await assert.rejects(loadGenerationConfig(root), error => error instanceof Error && error.message.includes('Gateway') && !error.message.includes('secret'));
});


test('cancelling during Wrangler connection stops before paid sending and later resumes safely', async t => {
  const {config, document, mock} = await fixture(t, undefined, true);
  const gateway = {mode: 'wrangler' as const, configPath: '/mock/ai.jsonc', gatewayId: 'reader'};
  let release!: () => void; let entered!: () => void; let sends = 0; let connects = 0;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const connecting = new Promise<void>(resolve => {entered = resolve;});
  const adapter = geminiAdapter(undefined, gateway, {async connect() {
    connects++; if (connects === 1) {entered(); await gate;}
    return {ai: {async run() {sends++; return {audio: Buffer.from(wav()).toString('base64')};}}, async dispose() {}};
  }});
  const service = new GenerationService({...config, gateway}, {voicevox: mock, gemini: adapter});
  const options: GenerationOptions = {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []};
  const all = await service.prepareGeneration({document, options});
  const plan = await service.prepareGeneration({document, options: {...options, selectedChunkIds: [all.chunks[0].id]}});
  const job = await service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'gateway-cancel-before-send', paidConfirmed: true});
  await connecting; await service.cancelJob(job.id); release();
  const stopped = await service.waitForJob(job.id); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.chunks[0].attempts, 0); assert.equal(sends, 0);
  await service.resumeJob(job.id, true); assert.equal((await service.waitForJob(job.id)).status, 'completed'); assert.equal(sends, 1);
});


test('Cloudflare-only configuration enables paid prepare/start/resume without a Google credential', async t => {
  const {config, document, mock} = await fixture(t, undefined, true);
  const gateway = {accountId: 'a'.repeat(32), gatewayId: 'reader', token: 'mock-cloudflare-secret'};
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), null);
    if (init.method !== 'POST') return gatewayControlResponse(url);
    posts++; return posts === 1 ? new Response('private reject', {status: 402}) : gatewayAudioResponse();
  });
  const service = new GenerationService({...config, geminiApiKey: undefined, gateway}, {voicevox: mock});
  const dto = await service.getGenerationConfig();
  assert.equal(dto.gemini.available, true); assert.equal(dto.transports.find(value => value.id === 'direct')?.available, false); assert.equal(dto.transports.find(value => value.id === 'gateway')?.available, true);
  assert.ok(!JSON.stringify(dto).includes('secret'));
  const plan = await service.prepareGeneration({document, options: {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []}});
  assert.equal(plan.available, true);
  const started = await service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'cloudflare-without-google', paidConfirmed: true});
  const failed = await service.waitForJob(started.id); assert.equal(failed.status, 'failed'); assert.match(failed.chunks[0].error ?? '', /残高/); assert.equal(posts, 1);
  await assert.rejects(service.resumeJob(started.id, false), /有料再開/);
  await service.resumeJob(started.id, true); assert.equal((await service.waitForJob(started.id)).status, 'completed'); assert.equal(posts, 3);
  const direct = await service.prepareGeneration({document, options: {...plan.options, transport: 'direct'}});
  assert.equal(direct.available, false); assert.match(direct.unavailableReason ?? '', /Google API key/);
  await assert.rejects(service.prepareGeneration({document, options: {...plan.options, style: '落ち着いて'}}), /未対応/);
});

test('legacy BYOK plans cannot execute with the new Cloudflare credit adapter', async t => {
  const {config, document, disk, mock} = await fixture(t, undefined, true);
  const gateway = {accountId: 'a'.repeat(32), gatewayId: 'reader', token: 'mock-cloudflare-secret'};
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {if (init.method === 'POST') posts++; return gatewayControlResponse(url);});
  const service = new GenerationService({...config, gateway}, {voicevox: mock});
  const plan = await service.prepareGeneration({document, options: {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []}});
  const legacy = {...plan, routeIdentity: undefined, endpoint: `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/reader/custom-old/v1beta/interactions`};
  await disk.write(['plans', `${plan.id}.json`], {plan: legacy, document});
  await assert.rejects(service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'legacy-route', paidConfirmed: true}), /Gateway設定/);
  assert.equal(posts, 0);
});


test('normal Cloudflare config uses project Gateway without extracting OAuth or requiring a token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rsvp-wrangler-config-')); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'deployment'));
  await writeFile(join(root, 'deployment', 'local-ai.wrangler.jsonc'), '// JSONC is read by Wrangler without starting a session.\n{\n"ai": {"binding": "AI", "remote": true,},\n"vars": {"RSVP_AI_GATEWAY_ID": "existing-reader",},\n}');
  const {mock, document} = await fixture(t);
  const loaded = await loadGenerationConfig(root);
  assert.equal(loaded.gateway?.mode, 'wrangler'); assert.equal(loaded.gateway?.gatewayId, 'existing-reader');
  assert.equal('token' in loaded.gateway!, false); assert.equal(loaded.paidEnabled, true);
  const service = new GenerationService({...loaded, libraryDir: join(root, 'library'), paidEnabled: true}, {voicevox: mock});
  const dto = await service.getGenerationConfig();
  assert.equal(dto.transports.find(v => v.id === 'gateway')?.available, true);
  assert.match(dto.transports.find(v => v.id === 'gateway')?.message ?? '', /既存Wranglerログイン/);
  assert.equal(JSON.stringify(dto).includes(root), false);
  const plan = await service.prepareGeneration({document, options: {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []}});
  assert.equal(plan.available, true);
  assert.equal(plan.unavailableReason, undefined);
});


test('Wrangler mock completes and reuses saved audio without a Google credential', async t => {
  const {config, mock, document} = await fixture(t, undefined, true);
  const gateway = {mode: 'wrangler' as const, configPath: '/mock/ai.jsonc', gatewayId: 'reader'};
  let calls = 0; let disposes = 0;
  const adapter = geminiAdapter(undefined, gateway, {async connect() {return {
    ai: {async run() {calls++; return {audio: Buffer.from(wav()).toString('base64'), gatewayMetadata: {keySource: 'Unified'}};}},
    async dispose() {disposes++;},
  };}});
  const service = new GenerationService({...config, geminiApiKey: undefined, gateway}, {voicevox: mock, gemini: adapter});
  const dto = await service.getGenerationConfig();
  assert.equal(dto.transports.find(v => v.id === 'direct')?.available, false);
  assert.equal(dto.transports.find(v => v.id === 'gateway')?.available, true);
  const plan = await service.prepareGeneration({document, options: {provider: 'gemini', voice: 'Kore', transport: 'gateway', readings: []}});
  assert.equal(plan.available, true); assert.match(plan.routeIdentity ?? '', /cloudflare-wrangler-gateway/);
  const changed = new GenerationService({...config, gateway: {...gateway, gatewayId: 'other'}}, {voicevox: mock, gemini: adapter});
  await assert.rejects(changed.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'changed-binding', paidConfirmed: true}), /Gateway設定/);
  const job = await service.startGeneration({planId: plan.id, planHash: plan.hash, operationId: 'verified-mock-binding', paidConfirmed: true});
  assert.equal((await service.waitForJob(job.id)).status, 'completed'); assert.equal(calls, 2); assert.equal(disposes, 2);
  const cached = await service.prepareGeneration({document, options: plan.options});
  assert.equal(cached.sendingText, '');
  const reuse = await service.startGeneration({planId: cached.id, planHash: cached.hash, operationId: 'cached-binding', paidConfirmed: true});
  assert.equal((await service.waitForJob(reuse.id)).status, 'completed'); assert.equal(calls, 2);
});

// Configuration cases own their synthetic env; shell credentials and verification guards stay outside the fixture.
let inheritedEnvironment: Record<string, string> = {};
beforeEach(() => {
  inheritedEnvironment = {};
  for (const key of Object.keys(process.env)) if (key.startsWith('RSVP_') || key === 'GEMINI_API_KEY') {
    inheritedEnvironment[key] = process.env[key]!; delete process.env[key];
  }
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('RSVP_') || key === 'GEMINI_API_KEY') delete process.env[key];
  Object.assign(process.env, inheritedEnvironment);
});
