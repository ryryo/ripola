import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadGenerationConfig } from '../src/generation/core/config';
import { GenerationService } from '../src/generation/core/service';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import { pythonAlignmentAdapter } from '../src/generation/core/alignment-adapter';

type Runner = (binary: string, args: string[], options?: { env?: Record<string, string> }) => Promise<string>;
type Setup = (options: { root: string; platform: string; arch: string; environment: Record<string, string>; run: Runner; log: (message: string) => void }) => Promise<{ status: string; dependenciesInstalled: boolean; modelDownloadInvoked: boolean }>;
const { setupAlignment, runCommand } = await import(new URL('../../../scripts/setup-alignment.mjs', import.meta.url).href) as { setupAlignment: Setup; runCommand: (binary: string, args: string[], options: { signal: AbortSignal; onOutput: () => void }) => Promise<string> };
const version = 'reazon-rs35kh-46afc596-ctc-v2';
async function fixture(t: { after: (fn: () => Promise<void>) => void }, platform: 'darwin' | 'linux' = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'rsvp-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/alignment-model.json'), JSON.stringify({ downloadBytes: 386888750, alignerVersion: version }));
  await writeFile(join(root, 'scripts/alignment-requirements.txt'), 'torch==2.8.0\n');
  await writeFile(join(root, 'scripts/alignment-requirements-linux-x64.txt'), 'torch==2.8.0+cpu\n');
  await writeFile(join(root, 'scripts/alignment-platforms.json'), await readFile(new URL('../../../scripts/alignment-platforms.json', import.meta.url)));
  const logs: string[] = [], calls: string[] = [];
  let packages = false, model = false, failInstall = false, missing = '', failModel = false, failDownload = false;
  let pythonVersion = { version: [3, 13], machine: platform === 'darwin' ? 'arm64' : 'x86_64', system: platform === 'darwin' ? 'Darwin' : 'Linux', implementation: 'cpython' };
  const run: Runner = async (binary, args, options) => {
    calls.push([binary, ...args].join(' '));
    assert.equal(options?.env?.GEMINI_API_KEY, undefined);
    assert.equal(options?.env?.RSVP_AI_GATEWAY_TOKEN, undefined);
    if (binary === missing) throw Error('unavailable');
    if (args[0] === '-c') return JSON.stringify(pythonVersion);
    if (args.includes('venv')) { const python = join(root, 'alignment-runtime/.venv/bin/python'); await mkdir(dirname(python), { recursive: true }); await writeFile(python, 'isolated'); }
    if (args.includes('pip')) { if (failInstall) throw Error('interrupted'); packages = true; }
    if (args.includes('--dependencies-only') && !packages) throw Error('not installed');
    if (args.includes('--model-only') && (!model || failModel)) throw Error('not verified');
    if (args[0]?.endsWith('download_alignment_model.py')) { if (failDownload) throw Error('interrupted'); model = true; }
    return '{"status":"ready"}';
  };
  const setup = (environment: Record<string, string> = {}) => setupAlignment({ root, platform, arch: platform === 'darwin' ? 'arm64' : 'x64', environment, run, log: value => logs.push(value) });
  return { root, logs, calls, setup, runtime: join(root, 'alignment-runtime'), setPackages: () => { packages = true; }, setModel: () => { model = true; }, setFailInstall: (value: boolean) => { failInstall = value; }, setMissing: (value: string) => { missing = value; }, setFailModel: () => { failModel = true; }, setFailDownload: (value: boolean) => { failDownload = value; }, setPython: (value: Partial<typeof pythonVersion>) => { pythonVersion = { ...pythonVersion, ...value }; } };
}

test('first setup stores usable config, preserves secrets byte-for-byte and rerun reuses verified resources', async t => {
  const f = await fixture(t); const env = 'GEMINI_API_KEY=private-placeholder\nRSVP_AI_GATEWAY_TOKEN=another-placeholder\n';
  await writeFile(join(f.root, '.env.local'), env);
  assert.deepEqual(await f.setup(), { status: 'ready', dependenciesInstalled: true, modelDownloadInvoked: true, configuration: join(f.runtime, 'setup.json') });
  const config = await loadGenerationConfig(f.root); assert.equal(config.alignmentPython, join(f.runtime, '.venv/bin/python')); assert.equal(config.alignmentModelDir, join(f.runtime, 'models/reazon-rs35kh-46afc596')); assert.equal(config.alignmentSetupState, 'ready');
  assert.equal(await readFile(join(f.root, '.env.local'), 'utf8'), env); assert.equal(f.logs.join('').includes('private-placeholder'), false);
  const installs = f.calls.filter(value => value.includes(' pip ')).length, downloads = f.calls.filter(value => value.includes('download_alignment_model.py')).length;
  const repeated = await f.setup(); assert.equal(repeated.dependenciesInstalled, false); assert.equal(repeated.modelDownloadInvoked, false);
  assert.equal(f.calls.filter(value => value.includes(' pip ')).length, installs); assert.equal(f.calls.filter(value => value.includes('download_alignment_model.py')).length, downloads);
});
for (const binary of ['ffmpeg', 'ffprobe', 'python3.13']) test(`missing ${binary} provides guidance and can recover without false readiness`, async t => {
  const f = await fixture(t); f.setMissing(binary); await assert.rejects(f.setup(), /brew install python@3.13 ffmpeg/);
  await assert.rejects(access(join(f.runtime, 'setup.json'))); assert.equal(JSON.parse(await readFile(join(f.runtime, 'setup-state.json'), 'utf8')).status, 'failed');
  assert.equal(f.calls.some(value => value.startsWith('brew ')), false); f.setMissing(''); await f.setup(); assert.equal((await loadGenerationConfig(f.root)).alignmentSetupState, 'ready');
});
test('interrupted package install keeps its venv and supports a successful rerun', async t => {
  const f = await fixture(t); f.setFailInstall(true); await assert.rejects(f.setup(), /dependencies/); await access(join(f.runtime, '.venv/bin/python'));
  const created = f.calls.filter(value => value.includes(' -m venv ')).length; f.setFailInstall(false); await f.setup(); assert.equal(f.calls.filter(value => value.includes(' -m venv ')).length, created);
  await assert.rejects(access(join(f.runtime, 'setup.lock')));
});
test('existing external runtime and model are verified without installation or replacement', async t => {
  const f = await fixture(t); const python = join(f.root, 'external/bin/python'), model = join(f.root, 'external/model');
  await mkdir(dirname(python), { recursive: true }); await mkdir(model); await writeFile(python, 'existing'); await writeFile(join(model, 'keep'), 'existing-model');
  const env = `RSVP_ALIGNMENT_PYTHON=${python}\nRSVP_ALIGNMENT_MODEL_DIR=${model}\n`; await writeFile(join(f.root, '.env.local'), env);
  await assert.rejects(f.setup(), /既存環境を変更せず/); assert.equal(f.calls.some(value => value.includes(' pip ')), false);
  f.setPackages(); f.setModel(); await f.setup(); assert.equal(f.calls.some(value => value.includes('download_alignment_model.py')), false);
  assert.equal(await readFile(join(f.root, '.env.local'), 'utf8'), env); assert.equal(await readFile(join(model, 'keep'), 'utf8'), 'existing-model');
  f.setFailModel(); await assert.rejects(f.setup(), /既存モデルを変更せず/); assert.equal(await readFile(join(model, 'keep'), 'utf8'), 'existing-model');
});
test('setup refuses a live owner and recovers a stale ownerless lock', async t => {
  const f = await fixture(t); const lock = join(f.runtime, 'setup.lock'); await mkdir(lock, { recursive: true }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.setup(), /別のpnpm setup:audio/); assert.equal(f.calls.length, 0);
  await rm(join(lock, 'owner.json')); await utimes(lock, new Date(0), new Date(0)); await f.setup(); await assert.rejects(access(lock));
});
test('legacy env overrides generated paths, malformed auto config reports failure, and env is never rewritten', async t => {
  const f = await fixture(t); await f.setup(); const contents = 'RSVP_ALIGNMENT_PYTHON=/custom/python\nRSVP_ALIGNMENT_MODEL_DIR=/custom/model\nRSVP_ENABLE_PAID_GENERATION=false\n'; await writeFile(join(f.root, '.env.local'), contents);
  const config = await loadGenerationConfig(f.root); assert.equal(config.alignmentPython, '/custom/python'); assert.equal(config.alignmentModelDir, '/custom/model'); assert.equal(config.paidEnabled, false);
  await writeFile(join(f.runtime, 'setup.json'), '{invalid'); assert.equal((await loadGenerationConfig(f.root)).alignmentSetupState, 'failed'); assert.equal(await readFile(join(f.root, '.env.local'), 'utf8'), contents);
});
test('one Direct key enables planning but unconfirmed start cannot send audio requests; old false remains respected', async t => {
  const previous = { paid: process.env.RSVP_ENABLE_PAID_GENERATION, key: process.env.GEMINI_API_KEY };
  delete process.env.RSVP_ENABLE_PAID_GENERATION; delete process.env.GEMINI_API_KEY;
  t.after(() => {
    for (const [name, value] of [['RSVP_ENABLE_PAID_GENERATION', previous.paid], ['GEMINI_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  });
  const f = await fixture(t); await writeFile(join(f.root, '.env.local'), 'GEMINI_API_KEY=test-placeholder\n');
  const config = await loadGenerationConfig(f.root); assert.equal(config.paidEnabled, true); let calls = 0;
  const mock = { async voices() { return []; }, async synthesize() { calls++; throw Error('no real synthesis'); } };
  const service = new GenerationService({ ...config, libraryDir: join(f.root, 'library') }, { voicevox: mock, gemini: mock });
  const document = await prepareDocument(importText('朝の図書館で本を開きました。', 'txt', '自作'));
  const plan = await service.prepareGeneration({ document, options: { provider: 'gemini', voice: 'Puck', transport: 'direct', readings: [] } });
  await assert.rejects(service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'unconfirmed', paidConfirmed: false }), /有料開始/);
  assert.equal(calls, 0); await writeFile(join(f.root, '.env.local'), 'GEMINI_API_KEY=test-placeholder\nRSVP_ENABLE_PAID_GENERATION=false\n');
  const disabled = new GenerationService({ ...await loadGenerationConfig(f.root), libraryDir: join(f.root, 'library') }, { voicevox: mock, gemini: mock });
  await assert.rejects(disabled.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'disabled', paidConfirmed: true }), /有料開始/); assert.equal(calls, 0);
});
test('runtime readiness distinguishes setup-required and failed without a model download', async () => {
  const base = { libraryDir: '/unused', localOrigin: 'http://127.0.0.1:4173', paidEnabled: false };
  assert.equal((await pythonAlignmentAdapter(base).readiness!()).status, 'setup-required');
  assert.equal((await pythonAlignmentAdapter({ ...base, alignmentSetupState: 'failed' }).readiness!()).status, 'failed');
  assert.equal((await pythonAlignmentAdapter({ ...base, alignmentPython: '/missing/python', alignmentScript: '/missing/script', alignmentModelDir: '/missing/model' }).readiness!()).status, 'failed');
});

test('interruption stops the active child command and reports a recoverable failure', async () => {
  const controller = new AbortController();
  await assert.rejects(runCommand(process.execPath, ['-e', "process.stdout.write('started');setInterval(()=>{},1000)"], { signal: controller.signal, onOutput: () => controller.abort() }), /中断/);
});

for (const platform of ['darwin', 'linux'] as const) test(`${platform} selects its fixed lock and stores its actual hash, then reuses without network`, async t => {
  const f = await fixture(t, platform);
  const env = Buffer.from('# preserve CRLF and secrets\r\nGEMINI_API_KEY=private-placeholder\r\nRSVP_AI_GATEWAY_TOKEN=another-placeholder\r\n');
  await writeFile(join(f.root, '.env.local'), env);
  await f.setup({ GEMINI_API_KEY: 'process-placeholder' });
  const requirements = platform === 'darwin' ? 'alignment-requirements.txt' : 'alignment-requirements-linux-x64.txt';
  const config = JSON.parse(await readFile(join(f.runtime, 'setup.json'), 'utf8'));
  assert.equal(config.requirementsHash, createHash('sha256').update(await readFile(join(f.root, 'scripts', requirements))).digest('hex'));
  const install = f.calls.find(value => value.includes(' pip '))!;
  assert.ok(install.endsWith(requirements));
  for (const flag of ['--isolated', '--only-binary=:all:', '--require-hashes', '--index-url https://pypi.org/simple']) assert.ok(install.includes(flag));
  assert.ok(!install.includes('--extra-index-url'));
  const before = f.calls.length;
  const again = await f.setup();
  assert.equal(again.dependenciesInstalled, false); assert.equal(again.modelDownloadInvoked, false);
  assert.ok(!f.calls.slice(before).some(value => value.includes(' pip ') || value.includes('download_alignment_model.py')));
  assert.deepEqual(await readFile(join(f.root, '.env.local')), env);
  assert.ok(!f.logs.join('').includes('placeholder'));
});

for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']]) test(`unsupported ${platform}/${arch} refuses before creating runtime or starting dependencies`, async t => {
  const f = await fixture(t);
  await assert.rejects(setupAlignment({ root: f.root, platform, arch, environment: {}, run: async () => { throw Error('must not run'); }, log: () => {} }), /対象はmacOS Apple SiliconとLinux x64/);
  await assert.rejects(access(f.runtime));
});

for (const mismatch of [{ version: [3, 12] }, { machine: 'aarch64' }, { system: 'Windows' }, { implementation: 'pypy' }]) test(`Linux refuses Python mismatch ${JSON.stringify(mismatch)} before installing`, async t => {
  const f = await fixture(t, 'linux'); f.setPython(mismatch);
  await assert.rejects(f.setup(), /version\/OS\/architecture/);
  assert.ok(!f.calls.some(value => value.includes(' pip ') || value.includes(' venv ')));
  await assert.rejects(access(join(f.runtime, 'setup.json')));
});

test('Linux never repairs an external Python with wrong architecture or dependency versions', async t => {
  const f = await fixture(t, 'linux'); const python = join(f.root, 'external/python');
  await mkdir(dirname(python), { recursive: true }); await writeFile(python, 'external-runtime');
  f.setPython({ machine: 'arm64' });
  await assert.rejects(f.setup({ RSVP_ALIGNMENT_PYTHON: python }), /既存環境を変更せず/);
  f.setPython({ machine: 'x86_64' });
  await assert.rejects(f.setup({ RSVP_ALIGNMENT_PYTHON: python }), /依存\/versionが一致/);
  assert.equal(await readFile(python, 'utf8'), 'external-runtime');
  assert.ok(!f.calls.some(value => value.includes(' pip ') || value.includes('ensurepip') || value.includes(' venv ')));
});

test('Linux package and model interruptions release the lock and resume verified steps', async t => {
  const f = await fixture(t, 'linux'); f.setFailInstall(true);
  await assert.rejects(f.setup(), /dependencies/); await assert.rejects(access(join(f.runtime, 'setup.lock')));
  f.setFailInstall(false); f.setFailDownload(true);
  await assert.rejects(f.setup(), /model/); await assert.rejects(access(join(f.runtime, 'setup.json')));
  const installs = f.calls.filter(value => value.includes(' pip ')).length;
  f.setFailDownload(false); await f.setup();
  assert.equal(f.calls.filter(value => value.includes(' pip ')).length, installs);
  assert.equal(f.calls.filter(value => value.includes(' -m venv ')).length, 1);
  assert.equal(JSON.parse(await readFile(join(f.runtime, 'setup-state.json'), 'utf8')).status, 'ready');
});
