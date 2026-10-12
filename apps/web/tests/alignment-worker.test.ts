import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { clearTimeout } from 'node:timers';
import { AlignmentWorker, AlignmentWorkerError, type AlignmentWorkerOptions } from '../src/generation/core/alignment-worker.ts';
import type { AlignmentRuntimeRequest } from '../src/generation/core/alignment-adapter.ts';
const mock = fileURLToPath(new URL('./fixtures/alignment-worker/mock-worker.mjs', import.meta.url));
const request = (mode = 'normal'): AlignmentRuntimeRequest => ({ schemaVersion: 1, audioPath: '/private/unused.wav', audioHash: 'a'.repeat(64), spokenText: mode, normalizedText: '窓😀', normalizeVersion: 'ctc-ja-nfkc-v1', alignerVersion: 'pinned', offsetUnit: 'utf16' });
async function fixture(t: TestContext, options: Partial<AlignmentWorkerOptions> = {}, startupDelay = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'ripola-worker-')); const log = join(dir, 'events.jsonl');
  const settings: AlignmentWorkerOptions = { command: process.execPath, args: [mock, log, String(startupDelay)], cwd: dirname(mock), env: {}, alignerVersion: 'pinned', prepare: async () => 'resources-v1', timeoutMs: 60_000, killGraceMs: 30, ...options };
  const worker = new AlignmentWorker(settings);
  t.after(async () => { await worker.close(); await rm(dir, { recursive: true, force: true }); });
  const events = async (): Promise<Array<{ type: string; pid?: number; id?: string; text?: string; mode?: string }>> => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitFor = async (type: string) => { for (let i = 0; i < 2000; i++) { const found = (await events()).find(event => event.type === type); if (found) return found; await pause(10); } throw new Error(`missing ${type}`); };
  return { worker, settings, events, waitFor, log };
}
const signal = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) => error instanceof AlignmentWorkerError && error.code === expected;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test('sequential and concurrent requests reuse one spawn/load and unique IDs; fragmented UTF-8 is framed', async t => {
  const { worker, events } = await fixture(t);
  await worker.align(request(), signal());
  const results = await Promise.all(['slow', 'split', 'normal'].map(mode => worker.align(request(mode), signal())));
  assert.ok(results.every(result => result.normalizedText === '窓😀'));
  const log = await events();
  assert.equal(log.filter(event => event.type === 'spawn').length, 1);
  assert.equal(log.filter(event => event.type === 'load').length, 1);
  assert.equal(new Set(log.filter(event => event.type === 'request').map(event => event.id)).size, 4);
  assert.deepEqual(log.filter(event => event.type === 'request').map(event => event.mode), ['normal', 'slow', 'split', 'normal']);
});

test('queue is bounded; queued cancellation does not interrupt the active model', async t => {
  const { worker, events, waitFor } = await fixture(t, { maxPending: 2 });
  const active = worker.align(request('slow'), signal()); await waitFor('request');
  const controller = new AbortController();
  const queued = worker.align(request('not-sent'), controller.signal);
  await assert.rejects(worker.align(request(), signal()), code('queue-full'));
  controller.abort(); await assert.rejects(queued, code('cancelled')); await active;
  await worker.align(request(), signal());
  assert.equal((await events()).filter(event => event.type === 'spawn').length, 1);
  assert.ok(!(await events()).some(event => event.mode === 'not-sent'));
});

test('active abort waits for SIGKILL cleanup, rejects queued work and restarts only for a new request', async t => {
  const { worker, events, waitFor } = await fixture(t);
  const controller = new AbortController();
  const active = worker.align(request('descendant'), controller.signal);
  const failed = assert.rejects(active, code('cancelled'));
  const descendant = await waitFor('descendant'); const pid = (await waitFor('spawn')).pid!;
  const queued = worker.align(request('not-sent'), signal()); const queuedFailed = assert.rejects(queued, code('cancelled'));
  await pause(60); controller.abort(); await Promise.all([failed, queuedFailed]);
  assert.equal(alive(pid), false);
  for (let i = 0; i < 100 && alive(descendant.pid!); i++) await pause(10);
  assert.equal(alive(descendant.pid!), false);
  await worker.align(request(), signal());
  assert.equal((await events()).filter(event => event.type === 'spawn').length, 2);
  assert.equal((await events()).filter(event => event.type === 'request').length, 2);
});

for (const [mode, expected] of [['crash', 'crashed'], ['partial-exit', 'crashed'], ['hang', 'timeout'], ['malformed', 'protocol'], ['wrong-id', 'protocol'], ['wrong-method', 'protocol'], ['invalid-result', 'protocol'], ['duplicate', 'protocol'], ['oversized', 'protocol'], ['stderr-flood', 'protocol'], ['resources-changed', 'resources-changed']]) {
  test(`${mode} rejects without replay, cleans up and allows a new request`, async t => {
    const { worker, settings, events } = await fixture(t);
    if (mode === 'hang') { await worker.align(request(), signal()); settings.timeoutMs = 100; }
    await assert.rejects(worker.align(request(mode), signal()), code(expected));
    const pid = (await events()).find(event => event.type === 'spawn')!.pid!;
    assert.equal(alive(pid), false);
    settings.timeoutMs = 60_000;
    await worker.align(request(), signal());
    assert.equal((await events()).filter(event => event.type === 'request').length, mode === 'hang' ? 3 : 2);
  });
}

test('known per-request error keeps model resident; changed resource identity replaces it', async t => {
  let identity = 'v1'; const { worker, events } = await fixture(t, { prepare: async () => identity });
  await assert.rejects(worker.align(request('error'), signal()), code('runtime'));
  await worker.align(request(), signal()); assert.equal((await events()).filter(event => event.type === 'spawn').length, 1);
  identity = 'v2'; await worker.align(request(), signal()); assert.equal((await events()).filter(event => event.type === 'spawn').length, 2);
});

test('close during startup settles input after cleanup; close is idempotent and terminal', async t => {
  const { worker, waitFor } = await fixture(t, {}, 1000);
  const active = worker.align(request(), signal()); const failed = assert.rejects(active, code('closed'));
  await waitFor('spawn'); await worker.close(); await failed; await worker.close();
  await assert.rejects(worker.align(request(), signal()), code('closed'));
});

test('explicit close kills an idle process; an already aborted or oversized input never spawns', async t => {
  const { worker, events, waitFor } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(worker.align(request(), controller.signal), code('cancelled'));
  await assert.rejects(worker.align({ ...request(), spokenText: 'x'.repeat(2 * 1024 * 1024) }, signal()), code('input'));
  assert.deepEqual(await events(), []);
  await worker.align(request(), signal()); const pid = (await waitFor('spawn')).pid!;
  await worker.close(); assert.equal(alive(pid), false);
});

for (const termination of ['natural', 'SIGTERM'] as const) test(`Node parent ${termination} exit cleans the worker process tree`, async t => {
  const { log, waitFor } = await fixture(t);
  const module = fileURLToPath(new URL('../src/generation/core/alignment-worker.ts', import.meta.url));
  const script = `import { AlignmentWorker } from ${JSON.stringify(module)}; const w = new AlignmentWorker({command: process.execPath, args: ${JSON.stringify([mock, log])}, cwd: ${JSON.stringify(dirname(mock))}, env: {}, alignerVersion:'pinned', prepare: async () => 'v1'}); await w.align(${JSON.stringify(request())}, new AbortController().signal); ${termination === 'SIGTERM' ? 'setInterval(() => {}, 1000);' : ''}`;
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'pipe' });
  t.after(() => parent.kill('SIGKILL'));
  const deadline = setTimeout(() => parent.kill('SIGKILL'), 60_000);
  const closed = new Promise<{code: number | null; signal: string | null}>(resolve => parent.on('close', (code, signal) => resolve({code, signal})));
  if (termination === 'SIGTERM') { await waitFor('request'); parent.kill('SIGTERM'); }
  const exit = await closed; clearTimeout(deadline);
  if (termination === 'natural') assert.equal(exit.code, 0); else assert.equal(exit.signal, 'SIGTERM');
  const pid = (await waitFor('spawn')).pid!;
  for (let i = 0; i < 100 && alive(pid); i++) await pause(10);
  assert.equal(alive(pid), false);
});


test('spawn error never becomes success; cancelling before async preparation finishes never spawns later', async t => {
  const missing = await fixture(t, { command: '/missing/alignment-python' });
  await assert.rejects(missing.worker.align(request(), signal()), code('crashed'));
  assert.deepEqual(await missing.events(), []);
  let prepared!: () => void;
  const preparing = new Promise<void>(resolve => { prepared = resolve; });
  const { worker, events } = await fixture(t, { prepare: async () => { await preparing; return 'v1'; } });
  const controller = new AbortController();
  const active = worker.align(request(), controller.signal);
  controller.abort(); await assert.rejects(active, code('cancelled'));
  prepared(); await pause(20); assert.deepEqual(await events(), []);
});
