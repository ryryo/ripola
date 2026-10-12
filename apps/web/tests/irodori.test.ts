import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, readdir, utimes } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { defaultIrodoriSettings, IRODORI_MODEL, IRODORI_VOICES } from '../src/generation/irodori-contracts';
import type { GenerationOptions } from '../src/generation/contracts';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import { IrodoriController } from '../src/generation/core/irodori-controller';
import { irodoriAdapter } from '../src/generation/core/irodori-adapter';
import { automaticChunkPlanner } from '../src/generation/core/automatic-chunk-planner';
import { GenerationService, type ServiceDependencies } from '../src/generation/core/service';
import type { AlignmentAdapter } from '../src/generation/core/alignment-adapter';
import { wavDuration } from '../src/generation/core/providers';
import { stageLibrary } from '../../../scripts/stage-library';
import { IrodoriModelStore, type ModelSpec } from '../src/generation/core/irodori-model';
import { detectSpeechExecutable, irodoriFingerprint, IrodoriRuntime, irodoriSettings, synthesizeIrodori, validateIrodoriText, type NativeSession } from '../src/generation/core/irodori-runtime';

const DEFAULT_IRODORI_SETTINGS = defaultIrodoriSettings('ripola');
const modelBytes = Buffer.from('GGUFfixture-model');
const spec: ModelSpec = { id: 'fixture-mf', repository: 'fixture/repo', revision: 'a'.repeat(40), filename: 'fixture.gguf', bytes: modelBytes.length, sha256: createHash('sha256').update(modelBytes).digest('hex') };
function wav(seconds = .1): Buffer {
  const frames = Math.round(seconds * 48000);
  const audio = Buffer.alloc(44 + frames * 2); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(48000, 24); audio.writeUInt32LE(96000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  let state = 12345, filtered = 0;
  for (let i = 0; i < frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0; filtered = filtered * .985 + (state / 2 ** 32 - .5) * .015;
    const time = i / 48000; const envelope = .6 + .35 * Math.sin(time * 6.71) ** 2;
    audio.writeInt16LE(Math.round((filtered + .01 * Math.sin(time * time * 37)) * envelope * 150000), 44 + i * 2);
  }
  return audio;
}
async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ripola-irodori-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function endpoint(t: TestContext, listener: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(listener); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function session(endpoint: string): NativeSession {
  return { endpoint, modelHash: spec.sha256, voiceHash: 'b'.repeat(64), binaryHash: 'c'.repeat(64), voice: 'ripola', model: { id: 'Irodori-TTS-866M-MF-v4.1', version: '0.8.3', speech: { name: 'Irodori-TTS-866M-MF-v4.1', architecture: 'irodori-tts', task: 'synthesis', sample_rate: 48000, file_bytes: spec.bytes, weight_type: 'F16', max_text_tokens: 256, voices: [{ name: 'none' }, { name: 'ripola' }], device: 'cpu' } } };
}
function sendWav(res: ServerResponse, bytes = wav(), stop = 'complete') {
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Sample-Rate': '48000', 'X-Speech-Seed': '42', 'X-Speech-Stop': stop }); res.end(bytes);
}

test('uninstalled status/runtime construction performs no download or native startup', async t => {
  const directory = await temporary(t); let calls = 0;
  const store = new IrodoriModelStore(directory, spec, async () => { calls++; throw new Error('must not fetch'); });
  const runtime = new IrodoriRuntime(store);
  assert.equal((await store.status()).phase, 'not-installed'); assert.equal(runtime.status, 'stopped'); assert.equal(calls, 0);
  assert.throws(() => runtime.current(), /停止中/);
  assert.equal(await detectSpeechExecutable(join(directory, 'missing')), undefined);
});

test('explicit install pins source/revision, verifies SHA and separates complete resources', async t => {
  const directory = await temporary(t); let calls = 0;
  const store = new IrodoriModelStore(directory, spec, async (url) => { calls++; assert.equal(String(url), `https://huggingface.co/fixture/repo/resolve/${spec.revision}/fixture.gguf`); return new Response(modelBytes); });
  const phases: string[] = []; await store.install(undefined, value => phases.push(value.phase));
  assert.deepEqual(phases.filter(phase => phase !== 'downloading'), ['verifying', 'ready']); assert.equal((await store.status()).phase, 'ready');
  await store.verify(); assert.deepEqual(await readFile(store.modelPath), modelBytes); await assert.rejects(stat(`${store.modelPath}.part`), /ENOENT/);
  await store.install(); assert.equal(calls, 1);
  await writeFile(store.modelPath, Buffer.from('GGUFchanged-model'));
  assert.equal(await store.installed(), false); assert.equal((await store.status()).phase, 'failed'); await assert.rejects(store.verify(), /検証/);
});

test('download cancellation leaves only partial data and resumes using verified Range', async t => {
  const directory = await temporary(t); const controller = new AbortController(); let calls = 0;
  const store = new IrodoriModelStore(directory, spec, async (_url, init) => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(stream) { stream.enqueue(modelBytes.subarray(0, 6)); }, cancel() {} }));
    assert.equal((init?.headers as Record<string, string>).Range, 'bytes=6-');
    return new Response(modelBytes.subarray(6), { status: 206, headers: { 'Content-Range': `bytes 6-${spec.bytes - 1}/${spec.bytes}` } });
  });
  await assert.rejects(store.install(controller.signal, state => { if (state.phase === 'downloading' && state.downloadedBytes === 6) controller.abort(); }));
  assert.equal((await store.status()).phase, 'cancelled'); assert.equal((await store.status()).downloadedBytes, 6); assert.equal(await store.installed(), false);
  await store.install(); assert.equal(await store.installed(), true); assert.equal(calls, 2);
});

test('short failed transfer resumes; ignored Range replaces partial bytes', async t => {
  const directory = await temporary(t); let calls = 0;
  const store = new IrodoriModelStore(directory, spec, async (_url, init) => { calls++; if (calls === 1) return new Response(modelBytes.subarray(0, 5)); assert.equal((init?.headers as Record<string, string>).Range, 'bytes=5-'); return new Response(modelBytes); });
  await assert.rejects(store.install(), /途中/); assert.equal((await store.status()).phase, 'failed');
  await store.install(); assert.deepEqual(await readFile(store.modelPath), modelBytes);
});

test('verification cancellation keeps complete partial bytes and verifies on resume without refetch', async t => {
  const directory = await temporary(t); const controller = new AbortController(); let calls = 0;
  const store = new IrodoriModelStore(directory, spec, async () => { calls++; return new Response(modelBytes); });
  await assert.rejects(store.install(controller.signal, state => { if (state.phase === 'verifying') controller.abort(); }));
  assert.equal((await store.status()).phase, 'cancelled'); assert.equal((await store.status()).downloadedBytes, spec.bytes); assert.equal(await store.installed(), false);
  await store.install(); assert.equal(await store.installed(), true); assert.equal(calls, 1);
});

test('checksum mismatch and incorrect resume range never publish a model', async t => {
  const directory = await temporary(t);
  const store = new IrodoriModelStore(directory, spec, async () => new Response(Buffer.alloc(spec.bytes)));
  await assert.rejects(store.install(), /チェックサム/); assert.equal(await store.installed(), false); assert.equal((await store.status()).downloadedBytes, 0);
  const wrongRange = new IrodoriModelStore(directory, spec, async () => new Response(modelBytes, { status: 206, headers: { 'Content-Range': 'bytes 0-1/2' } }));
  await assert.rejects(wrongRange.install(), /範囲/); assert.equal(await wrongRange.installed(), false);
});

test('insufficient free space fails before fetching and exposes a retryable state', async t => {
  const directory = await temporary(t); let calls = 0;
  const store = new IrodoriModelStore(directory, spec, async () => { calls++; return new Response(modelBytes); }, async () => 0);
  await assert.rejects(store.install(), /空き容量/); assert.equal(calls, 0); assert.equal((await store.status()).phase, 'failed'); assert.equal((await store.status()).freeBytes, 0);
});

test('installation lock excludes competing setup and recovers a dead owner', async t => {
  const directory = await temporary(t); const store = new IrodoriModelStore(directory, spec, async () => new Response(modelBytes));
  await writeFile(join(directory, 'setup.lock'), JSON.stringify({ pid: process.pid })); await assert.rejects(store.install(), /進行中/);
  await writeFile(join(directory, 'setup.lock'), JSON.stringify({ pid: 99999999 })); await store.install(); assert.equal(await store.installed(), true);
});

test('a crash while creating a setup lock is recoverable without stealing a fresh lock', async t => {
  const directory = await temporary(t); const store = new IrodoriModelStore(directory, spec, async () => new Response(modelBytes));
  const lock = join(directory, 'setup.lock'); await writeFile(lock, '{');
  await assert.rejects(store.install(), /30秒/);
  const old = new Date(Date.now() - 60_000); await utimes(lock, old, old);
  await store.install(); assert.equal(await store.installed(), true);
});

test('rights-confirmed preexisting voice registration verifies identity and never creates a voice', async t => {
  const directory = await temporary(t); const path = join(directory, 'authorized.voice.gguf'); await writeFile(path, 'GGUFvoice-fixture');
  const store = new IrodoriModelStore(directory, spec); assert.equal(await store.voice(), undefined);
  await store.registerVoice({ path, label: '自作fixture', source: 'test fixture', license: 'test-only', attribution: 'Ripola test', rightsConfirmed: true });
  assert.equal((await store.voice())?.path, path);
  await writeFile(path, 'GGUFchanged-fixture'); await assert.rejects(store.voice(), /変わって/);
});

test('native HTTP sends MF settings and receives validated WAV bytes', async t => {
  let body: unknown; const url = await endpoint(t, (req, res) => { assert.equal(req.url, '/v1/audio/speech'); assert.equal(req.method, 'POST'); let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => { body = JSON.parse(raw); sendWav(res); }); });
  const result = await synthesizeIrodori(session(url), '図書館で本を開きます。', DEFAULT_IRODORI_SETTINGS);
  assert.deepEqual(result, wav()); assert.deepEqual(body, { model: 'Irodori-TTS-866M-MF-v4.1', input: '図書館で本を開きます。', voice: 'ripola', response_format: 'wav', language: 'ja', steps: 4, speed: 1, seed: 42, instructions: '' });
});

test('Irodori planning applies the application text ceiling before synthesis', async t => {
  let sent = '';
  const { adapter } = await serviceFixture(t, (req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { sent = (JSON.parse(raw) as { input: string }).input; sendWav(res); });
  });
  assert.equal(adapter.capabilities?.maxCharacters, 90);
  const text = '朝の図書館で本を開きます。'.repeat(8);
  assert.ok([...text].length > 90);
  await assert.rejects(adapter.synthesize({ text, options, providerVersion: await adapter.fingerprint!(options) }, async () => undefined), /上限/);
  assert.equal(sent, '');
  const short = '朝の図書館で本を開きます。';
  const result = await adapter.synthesize({ text: short, options, providerVersion: await adapter.fingerprint!(options) }, async () => undefined);
  assert.equal(sent, short); assert.deepEqual(result, wav());
});

test('abort during native synthesis disconnects the request and returns no partial WAV', async t => {
  let began!: () => void; let disconnected!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; }); const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const url = await endpoint(t, (req, res) => { req.resume(); req.on('end', () => { res.on('close', disconnected); began(); }); });
  const controller = new AbortController(); const pending = synthesizeIrodori(session(url), '取消しの試験です。', DEFAULT_IRODORI_SETTINGS, controller.signal);
  await ready; controller.abort(); await assert.rejects(pending); await closed;
});

test('truncated/model-limit/silent WAV and unknown voice cannot become complete', async t => {
  let bytes = wav(); let stop = 'model_limit'; const url = await endpoint(t, (_req, res) => sendWav(res, bytes, stop));
  await assert.rejects(synthesizeIrodori(session(url), '自作文です。', DEFAULT_IRODORI_SETTINGS), /完了/);
  stop = 'complete'; bytes = wav().subarray(0, 100); await assert.rejects(synthesizeIrodori(session(url), '自作文です。', DEFAULT_IRODORI_SETTINGS), /WAV/);
  bytes = wav(); bytes.fill(0, 44); await assert.rejects(synthesizeIrodori(session(url), '自作文です。', DEFAULT_IRODORI_SETTINGS), /無音/);
  await assert.rejects(synthesizeIrodori({ ...session(url), voice: 'unknown' }, '自作文です。', DEFAULT_IRODORI_SETTINGS), /声の条件/);
  bytes = wav(30.02); await assert.rejects(synthesizeIrodori(session(url), '自作文です。', DEFAULT_IRODORI_SETTINGS), /長さ/);
});

test('fingerprint changes with model/voice/runtime/settings, and excludes ephemeral port', () => {
  const native = session('http://127.0.0.1:12345'); const key = irodoriFingerprint(native, DEFAULT_IRODORI_SETTINGS);
  assert.equal(irodoriFingerprint({ ...native, endpoint: 'http://127.0.0.1:54321' }, DEFAULT_IRODORI_SETTINGS), key);
  assert.equal(irodoriFingerprint({ ...native, model: { ...native.model, ...{ created: 123456 } } }, DEFAULT_IRODORI_SETTINGS), key);
  for (const changed of [{ ...native, modelHash: 'd'.repeat(64) }, { ...native, voiceHash: 'd'.repeat(64) }, { ...native, binaryHash: 'd'.repeat(64) }]) assert.notEqual(irodoriFingerprint(changed, DEFAULT_IRODORI_SETTINGS), key);
  for (const change of [{ steps: 8 }, { speed: 1.2 }, { seed: 43 }, { instructions: '静かに' }]) assert.notEqual(irodoriFingerprint(native, { ...DEFAULT_IRODORI_SETTINGS, ...change }), key);
  assert.throws(() => irodoriSettings({ seed: NaN }));
});

test('owned mock speech process starts from absolute local files and stops cleanly', async t => {
  const directory = await temporary(t); const store = new IrodoriModelStore(directory, spec, async () => new Response(modelBytes)); await store.install();
  const voicePath = join(directory, 'test.voice.gguf'); await writeFile(voicePath, 'GGUFtest-voice'); await store.registerVoice({ path: voicePath, label: 'test', source: 'self fixture', license: 'test-only', attribution: 'test', rightsConfirmed: true });
  const executable = join(directory, 'speech'); const metadata = session('http://127.0.0.1:1').model;
  // The HTTP ID is GGUF's display name, not a catalog alias or an ASCII filename.
  metadata.id = 'Irodori MF v4.1'; metadata.speech.name = 'Irodori Small';
  await writeFile(executable, `#!${process.execPath}\nimport{createServer}from'node:http';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(directory, 'args.json'))},JSON.stringify(process.argv.slice(2)));const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[${JSON.stringify(metadata)}]}));});server.listen(0,'127.0.0.1',()=>console.error('speech serve: speech.cpp 0.8.3, listening on http://127.0.0.1:'+server.address().port));\n`, { mode: 0o700 });
  const runtime = new IrodoriRuntime(store, executable); t.after(() => runtime.stop()); await runtime.start(); const running = runtime.current(); assert.equal(runtime.status, 'running');
  assert.equal(running.model.id, metadata.id);
  const args = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8')); assert.deepEqual(args, ['serve', store.modelPath, '--add-voice', `ripola=${voicePath}`, '--host', '127.0.0.1', '--port', '0']);
  await runtime.stop(); assert.equal(runtime.status, 'stopped'); assert.throws(() => runtime.current(), /停止中/); await assert.rejects(fetch(`${running.endpoint}/health`));
});

const options: GenerationOptions = { provider: 'irodori', voice: 'ripola', transport: 'direct', readings: [], irodori: { ...DEFAULT_IRODORI_SETTINGS } };
async function serviceFixture(t: TestContext, listener: (req: IncomingMessage, res: ServerResponse) => void, dependencies: Pick<ServiceDependencies, 'alignment' | 'planChunks'> = {}, automaticCompression = false) {
  const directory = await temporary(t); const store = new IrodoriModelStore(directory, spec, async () => new Response(modelBytes)); await store.install();
  const path = join(directory, 'authorized.voice.gguf'); await writeFile(path, 'GGUFvoice-fixture');
  await store.registerVoice({ path, label: 'self fixture', source: 'self fixture', license: 'test-only', attribution: 'Ripola fixture', rightsConfirmed: true });
  const native = { ...session(await endpoint(t, listener)), voiceHash: (await store.voice())!.sha256 };
  const adapter = irodoriAdapter(new IrodoriController(store), () => native);
  adapter.availability = () => ({ available: true });
  const service = new GenerationService({ libraryDir: join(directory, 'library'), localOrigin: 'http://127.0.0.1:4173', paidEnabled: false, automaticCompression,
    ...(dependencies.alignment ? { alignmentPython: '/fixture/python', alignmentModelDir: '/fixture/model' } : {}) }, {
    providers: { irodori: adapter },
    voicevox: { async voices() { return []; }, async synthesize() { throw new Error('Must not call VOICEVOX'); } },
    ...dependencies,
  });
  const document = await prepareDocument(importText('<ruby>東京<rt>とうきょう</rt></ruby>で本を開きます。朝の光が差します。', 'md', '自作文'));
  await service.ready(); return { service, directory, document, native, adapter };
}

test('actual Irodori adapter integrates WAV persistence, ruby, reusable cache and settings identity', async t => {
  const requests: Record<string, unknown>[] = [];
  const { service, directory, document, native } = await serviceFixture(t, (req, res) => { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => { requests.push(JSON.parse(raw)); sendWav(res); }); });
  const plan = await service.prepareGeneration({ document, options }); assert.equal(plan.available, true); assert.match(plan.sendingText, /とうきょう/);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'irodori-native', paidConfirmed: false });
  const completed = await service.waitForJob(job.id); assert.equal(completed.status, 'completed'); assert.equal(requests.length, 2);
  const book = await service.getBook(job.bookId, job.revision); assert.equal(book.options.provider, 'irodori'); assert.equal(book.chunks.length, 2);
  assert.equal(book.attribution, 'Ripola fixture');
  assert.deepEqual(await readFile(join(directory, 'library', 'audio', `${plan.chunks[0].speechKey}.wav`)), wav());
  const cached = await service.prepareGeneration({ document, options }); assert.ok(cached.chunks.every(chunk => chunk.cacheHit));
  const again = await service.startGeneration({ planId: cached.id, planHash: cached.hash, operationId: 'irodori-cached', paidConfirmed: false }); await service.waitForJob(again.id); assert.equal(requests.length, 2);
  const changed = await service.prepareGeneration({ document, options: { ...options, irodori: { ...DEFAULT_IRODORI_SETTINGS, steps: 8 } } });
  assert.ok(changed.chunks.every(chunk => !chunk.cacheHit)); assert.notEqual(changed.chunks[0].speechKey, plan.chunks[0].speechKey); assert.deepEqual(changed.chunks.map(chunk => chunk.id), plan.chunks.map(chunk => chunk.id));
  // Model/runtime replacement after planning must fail before the actual endpoint sees text.
  native.binaryHash = 'd'.repeat(64);
  const stale = await service.startGeneration({ planId: changed.id, planHash: changed.hash, operationId: 'irodori-stale', paidConfirmed: false }).catch(error => { assert.match(error.message, /変更|計画/); return undefined; });
  if (stale) assert.equal((await service.waitForJob(stale.id)).status, 'failed');
  assert.equal(requests.length, 2);
});

test('automatic Irodori chunks validate at a fractional speed boundary', async t => {
  const { service } = await serviceFixture(t, (_req, res) => sendWav(res), { planChunks: automaticChunkPlanner });
  const settings = { ...DEFAULT_IRODORI_SETTINGS, speed: .3 };
  const document = await prepareDocument(importText('A'.repeat(90), 'txt', 'fractional boundary'));
  const plan = await service.prepareGeneration({ document, options: { ...options, chunking: { mode: 'auto' }, irodori: settings } });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].spokenText.length, 90);
  for (const chunk of plan.chunks) assert.doesNotThrow(() => validateIrodoriText(chunk.spokenText, settings));
});

test('Irodori rejects oversized or too-slow text before HTTP and before recording a send', async t => {
  let sends = 0, reservations = 0;
  const { adapter } = await serviceFixture(t, (_req, res) => { sends++; sendWav(res); });
  for (const [text, speed] of [['あ'.repeat(91), 1], ['𠮷'.repeat(64), 1], ['あ'.repeat(40), .25]] as const) {
    const boundedOptions = { ...options, irodori: { ...DEFAULT_IRODORI_SETTINGS, speed } };
    const providerVersion = await adapter.fingerprint!(boundedOptions);
    await assert.rejects(adapter.synthesize({ text, options: boundedOptions, providerVersion }, async () => { reservations++; }), /上限|短く/);
  }
  assert.equal(sends, 0); assert.equal(reservations, 0);
});

const codecsAvailable = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0);
test('Irodori saved audio follows common alignment/MP3/static staging without distributing native assets', { skip: !codecsAvailable }, async t => {
  let sends = 0, alignments = 0;
  const alignment: AlignmentAdapter = { version: 'fixture-irodori-alignment', async available() { return true; }, async align(request) {
    alignments++; const durationSeconds = wavDuration(await readFile(request.audioPath)); let offset = 0; const chars = [...request.normalizedText];
    return { schemaVersion: 1, alignerVersion: request.alignerVersion, normalizeVersion: request.normalizeVersion, offsetUnit: 'utf16', normalizedText: request.normalizedText, durationSeconds,
      segments: chars.map((char, i) => { const start = offset; offset += char.length; return { start, end: offset, startSeconds: .1 + i * (durationSeconds - .2) / chars.length, endSeconds: .1 + (i + 1) * (durationSeconds - .2) / chars.length, confidence: .95, status: 'aligned' as const }; }) };
  } };
  const { service, document, directory } = await serviceFixture(t, (req, res) => { req.resume(); req.on('end', () => { sends++; sendWav(res, wav(3)); }); }, { alignment }, true);
  const plan = await service.prepareGeneration({ document, options }); const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'irodori-finalization', paidConfirmed: false });
  const done = await service.waitForJob(job.id); assert.equal(done.status, 'completed'); assert.equal(done.automaticAlignment?.status, 'completed'); assert.equal(done.automaticCompression?.status, 'completed'); assert.equal(alignments, 2);
  const book = await service.getBook(job.bookId, job.revision); assert.ok(book.chunks.every(chunk => chunk.mimeType === 'audio/mpeg' && chunk.alignment?.precision === 'phrase'));
  const staged = await stageLibrary({ audience: 'personal', target: 'worker', mediaFormat: 'mp3', libraryDir: join(directory, 'library'), books: [{ id: book.id, revision: book.revision, rightsConfirmed: true, attribution: '自作文・Ripola fixture' }] }, { output: join(directory, 'stage') });
  const files = await readdir(staged.output, { recursive: true }); assert.ok(files.some(file => file.endsWith('.mp3'))); assert.ok(files.every(file => !/\.gguf|\.part|setup|voice\.json/.test(file))); assert.equal(sends, 2);
});

test('generation cancellation aborts actual adapter HTTP; resume retains the first saved WAV', async t => {
  let calls = 0; let entered!: () => void; let disconnected!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }); const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const { service, document } = await serviceFixture(t, (req, res) => { req.resume(); req.on('end', () => { calls++; if (calls === 2) { res.on('close', disconnected); entered(); } else sendWav(res); }); });
  const plan = await service.prepareGeneration({ document, options }); const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'irodori-cancel', paidConfirmed: false });
  await began; await service.cancelJob(job.id); const stopped = await service.waitForJob(job.id); await closed;
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.completedChunks, 1); assert.equal(stopped.chunks[1].status, 'pending');
  const first = (await service.getBook(job.bookId, job.revision)).chunks[0]; const resumed = await service.resumeJob(job.id); assert.equal((await service.waitForJob(resumed.id)).status, 'completed'); assert.equal(calls, 3);
  assert.equal((await service.getBook(job.bookId, job.revision)).chunks[0].speechKey, first.speechKey);
});

test('normal reception voices retain independent editable defaults and reject invalid voice paths', async t => {
  const directory = await temporary(t);
  const store = new IrodoriModelStore(directory, { ...spec, id: IRODORI_MODEL.id }, async () => new Response(modelBytes));
  const controller = new IrodoriController(store);
  for (const voice of IRODORI_VOICES) assert.deepEqual(await controller.settings(voice.id), { steps: 40, speed: 1, seed: 42, instructions: voice.instructions });
  await assert.rejects(controller.saveSettings(defaultIrodoriSettings()), /導入/);
  await store.install();
  const edited = { ...defaultIrodoriSettings(), instructions: '穏やかに、ゆっくり話してください。', steps: 48 };
  await controller.saveSettings(edited, 'reception-female');
  const reopened = new IrodoriController(new IrodoriModelStore(directory, { ...spec, id: IRODORI_MODEL.id }));
  assert.deepEqual(await reopened.settings('reception-female'), edited);
  assert.deepEqual(await reopened.settings('reception-male'), defaultIrodoriSettings('reception-male'));
  assert.deepEqual(await reopened.settings('ripola'), DEFAULT_IRODORI_SETTINGS);
  await assert.rejects(controller.saveSettings(edited, '../escape'), /声/);
  await assert.rejects(controller.settings('../escape'), /声/);
  assert.throws(() => irodoriSettings({ steps: 101 }), /steps/);
  assert.throws(() => irodoriSettings({ steps: 40 }, 'ripola'), /steps/);
  assert.deepEqual((await irodoriAdapter(controller).voices()).map(value => value.id), ['reception-female', 'reception-male']);
  await writeFile(join(directory, 'voice.json'), '{broken legacy voice');
  assert.deepEqual((await irodoriAdapter(controller).voices()).map(value => value.id), ['reception-female', 'reception-male']);
  assert.equal((await controller.status()).voiceAvailable, true);
});

test('normal reception sends the audition CFG, uses no reference, and separates prompt caches', async t => {
  const directory = await temporary(t); const requests: Record<string, unknown>[] = [];
  const store = new IrodoriModelStore(directory, { ...spec, id: IRODORI_MODEL.id }, async () => new Response(modelBytes)); await store.install();
  const url = await endpoint(t, (req, res) => { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => { requests.push(JSON.parse(raw)); sendWav(res); }); });
  const native = { ...session(url), voice: 'none' };
  const adapter = irodoriAdapter(new IrodoriController(store), () => native); adapter.availability = () => ({ available: true });
  const service = new GenerationService({ libraryDir: join(directory, 'library'), localOrigin: 'http://127.0.0.1:4173', paidEnabled: false, automaticCompression: false }, { providers: { irodori: adapter }, planChunks: automaticChunkPlanner }); await service.ready();
  const document = await prepareDocument(importText('窓を開けて朝の空気を吸います。', 'md', '自作文'));
  const female: GenerationOptions = { provider: 'irodori', voice: 'reception-female', transport: 'direct', readings: [], chunking: { mode: 'auto' } };
  const plan = await service.prepareGeneration({ document, options: female }); assert.equal(plan.options.model, 'irodori-tts'); assert.equal(plan.available, true);
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'reception', paidConfirmed: false }); assert.equal((await service.waitForJob(job.id)).status, 'completed');
  assert.deepEqual(requests, [{ model: native.model.id, input: plan.chunks[0].spokenText, voice: 'none', response_format: 'wav', language: 'ja', ...defaultIrodoriSettings(), sway_coeff: -1, cfg_guidance_mode: 'independent', cfg_scale_text: 3, cfg_scale_instructions: 3, cfg_min_t: .5, cfg_max_t: 1 }]);
  const cached = await service.prepareGeneration({ document, options: female }); assert.ok(cached.chunks.every(chunk => chunk.cacheHit));
  for (const changed of [{ ...female, voice: 'reception-male' }, { ...female, irodori: { instructions: '落ち着いて読む' } }]) {
    const next = await service.prepareGeneration({ document, options: changed }); assert.ok(next.chunks.every(chunk => !chunk.cacheHit)); assert.notEqual(next.providerVersion, plan.providerVersion);
  }
  await assert.rejects(adapter.preflight!({ ...female, model: 'irodori-tts-mf' }), /モデルが異なります/);
  const book = await service.getBook(job.bookId, job.revision); assert.match(book.attribution!, /v4.1 Small/);
});

test('normal runtime starts from the pinned model without a fixed voice file', async t => {
  const directory = await temporary(t); const store = new IrodoriModelStore(directory, { ...spec, id: IRODORI_MODEL.id }, async () => new Response(modelBytes)); await store.install();
  const oldVoice = join(directory, 'mf.voice.gguf'); await writeFile(oldVoice, 'GGUFlegacy-MF-only-voice');
  await store.registerVoice({ path: oldVoice, label: 'legacy', source: 'self fixture', license: 'test-only', attribution: 'fixture', rightsConfirmed: true });
  await writeFile(oldVoice, 'GGUFchanged-old-voice');
  const executable = join(directory, 'speech'); const metadata = session('http://127.0.0.1:1').model;
  metadata.id = 'Irodori normal v4.1'; metadata.speech.voices = [{ name: 'none' }];
  await writeFile(executable, `#!${process.execPath}\nimport{createServer}from'node:http';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(directory, 'args.json'))},JSON.stringify(process.argv.slice(2)));const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[${JSON.stringify(metadata)}]}));});server.listen(0,'127.0.0.1',()=>console.error('speech serve: speech.cpp 0.8.3, listening on http://127.0.0.1:'+server.address().port));\n`, { mode: 0o700 });
  const runtime = new IrodoriRuntime(store, executable); t.after(() => runtime.stop()); await runtime.start(); assert.equal(runtime.current().voice, 'none');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'args.json'), 'utf8')), ['serve', store.modelPath, '--host', '127.0.0.1', '--port', '0']);
});
