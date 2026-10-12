import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonAlignmentAdapter, type AlignmentRuntimeRequest } from '../src/generation/core/alignment-adapter.ts';
import type { GenerationServerConfig } from '../src/generation/core/config.ts';
const version = 'reazon-rs35kh-46afc596-ctc-v2';
const request: AlignmentRuntimeRequest = { schemaVersion: 1, audioPath: '/private/unused.wav', audioHash: 'a'.repeat(64), spokenText: 'test', normalizedText: '窓', normalizeVersion: 'ctc-ja-nfkc-v1', alignerVersion: version, offsetUnit: 'utf16' };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ripola-adapter-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'worker.jsonl'), probes = join(dir, 'probes.jsonl');
  const modelDir = join(dir, 'model'); await mkdir(modelDir); await writeFile(join(modelDir, 'model.safetensors'), 'x');
  await writeFile(join(dir, 'alignment-model.json'), JSON.stringify({ schemaVersion: 1, alignerVersion: version, files: [{ filename: 'model.safetensors', bytes: 1 }] }));
  for (const filename of ['alignment_runtime.py', 'alignment_worker.py', 'alignment-platforms.json', 'alignment-requirements.txt', 'alignment-requirements-linux-x64.txt']) await writeFile(join(dir, filename), 'fixture');
  const python = join(dir, 'python');
  await writeFile(python, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); await chmod(python, 0o700);
  const script = join(dir, 'align.mjs');
  const fixtureSource = await readFile(new URL('./fixtures/alignment-worker/mock-worker.mjs', import.meta.url), 'utf8');
  await writeFile(script, fixtureSource.replace('process.argv[2]', JSON.stringify(log)).replace("'pinned'", JSON.stringify(version)).replace('Number(process.argv[3] ?? 0)', '0'));
  const check = join(dir, 'check.mjs');
  await writeFile(check, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(probes)},'probe\\n'); console.log('{"status":"ready"}');`);
  const config = { alignmentPython: python, alignmentScript: script, alignmentCheckScript: check, alignmentModelDir: modelDir, alignmentVersion: version } as GenerationServerConfig;
  const adapter = pythonAlignmentAdapter(config); t.after(() => adapter.close?.());
  return { adapter, config, dir, log, probes };
}

test('adapter keeps existing API/version, shares startup and caches readiness for unchanged resources', async t => {
  const { adapter, log, probes } = await fixture(t);
  assert.deepEqual(await Promise.all([adapter.available(), adapter.available()]), [true, true]);
  assert.equal((await readFile(probes, 'utf8')).trim().split('\n').length, 1);
  await Promise.all([adapter.align(request, new AbortController().signal), adapter.align(request, new AbortController().signal)]);
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'spawn').length, 1);
  assert.equal(events.filter(event => event.type === 'load').length, 1);
  assert.equal(adapter.version, version);
});

test('missing model is rejected before spawn; readiness and resident worker invalidate after resource changes', async t => {
  const { adapter, dir, log, probes } = await fixture(t);
  assert.equal(await adapter.available(), true);
  await adapter.align(request, new AbortController().signal);
  assert.equal(await adapter.available(), true);
  assert.equal((await readFile(probes, 'utf8')).trim().split('\n').length, 1);
  await writeFile(join(dir, 'alignment_runtime.py'), 'new implementation');
  assert.equal(await adapter.available(), true);
  assert.equal((await readFile(probes, 'utf8')).trim().split('\n').length, 2);
  await adapter.align(request, new AbortController().signal);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'spawn').length, 2);
  await rm(join(dir, 'model/model.safetensors'));
  assert.equal(await adapter.available(), false);
  await assert.rejects(adapter.align(request, new AbortController().signal));
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'spawn').length, 2);
});

test('crash invalidates readiness; close is terminal; an absent setup does not download or spawn', async t => {
  const { adapter, probes } = await fixture(t);
  assert.equal(await adapter.available(), true);
  await assert.rejects(adapter.align({ ...request, spokenText: 'crash' }, new AbortController().signal));
  assert.equal(await adapter.available(), true);
  assert.equal((await readFile(probes, 'utf8')).trim().split('\n').length, 2);
  await adapter.close!(); assert.equal(await adapter.available(), false);
  await assert.rejects(adapter.align(request, new AbortController().signal));
  const unconfigured = pythonAlignmentAdapter({} as GenerationServerConfig);
  assert.equal((await unconfigured.readiness!()).status, 'setup-required');
  await assert.rejects(unconfigured.align(request, new AbortController().signal));
  await unconfigured.close!();
});


test('close also kills and awaits an in-flight readiness probe', async t => {
  const { adapter, config, dir } = await fixture(t);
  const pidFile = join(dir, 'probe-pid');
  await writeFile(config.alignmentCheckScript!, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  const readiness = adapter.available();
  let pid = 0;
  for (let i = 0; i < 2000; i++) {
    pid = Number(await readFile(pidFile, 'utf8').catch(() => '0')); if (pid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  await adapter.close!(); assert.equal(await readiness, false);
  assert.throws(() => process.kill(pid, 0));
});
