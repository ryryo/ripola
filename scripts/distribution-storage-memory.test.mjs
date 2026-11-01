// Memory-only regression cases: no child execution or filesystem fixtures.
import vm from 'node:vm';
import path from 'node:path';
import * as url from 'node:url';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = await readFile(new URL('./distribution-transaction.mjs', import.meta.url), 'utf8');
function memoryFS() {
  let seq = 10; const nodes = new Map(), removed = [];
  const error = code => Object.assign(new Error(code), { code });
  function put(p, kind, body = '') { nodes.set(p, { kind, body, dev: 1, ino: ++seq }); }
  async function mkdir(p, opts = {}) {
    if (nodes.has(p)) { if (opts.recursive) return; throw error('EEXIST'); }
    if (opts.recursive && p !== '/') await mkdir(path.dirname(p), opts); put(p, 'dir');
  }
  async function lstat(p) { const n = nodes.get(p); if (!n) throw error('ENOENT'); return { ...n, isDirectory: () => n.kind === 'dir', isSymbolicLink: () => n.kind === 'link', isFile: () => n.kind === 'file' }; }
  async function writeFile(p, b, opts = {}) { if (opts.flag === 'wx' && nodes.has(p)) throw error('EEXIST'); put(p, 'file', String(b)); }
  async function readFile(p) { if (!nodes.has(p)) throw error('ENOENT'); return nodes.get(p).body; }
  async function rename(a, b) {
    if (!nodes.has(a)) throw error('ENOENT'); const moved = [...nodes].filter(([p]) => p === a || p.startsWith(a + '/'));
    for (const [p] of moved) nodes.delete(p); for (const [p, n] of moved) nodes.set(b + p.slice(a.length), n);
  }
  async function rmdir(p) { if ([...nodes.keys()].some(k => k.startsWith(p + '/'))) throw error('ENOTEMPTY'); nodes.delete(p); }
  async function rm(p) { removed.push(p); for (const key of [...nodes.keys()]) if (key === p || key.startsWith(p + '/')) nodes.delete(key); }
  return { nodes, removed, fs: { mkdir, lstat, writeFile, readFile, rename, rm, rmdir, realpath: async p => p, mkdtemp: async prefix => { const p = prefix + 'fixture'; await mkdir(p, { recursive: true }); return p; } } };
}
async function load(code, memory, extras = {}) {
  const processMock = extras.process ?? { pid: 4444, kill(pid) { if (pid === 4444) return; throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } };
  const context = vm.createContext({ process: processMock, console, URL });
  const imports = { 'node:fs/promises': memory.fs, 'node:path': { ...path }, 'node:os': { hostname: () => 'fixture-host', homedir: () => '/mem/home' }, 'node:crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000000' }, 'node:url': { ...url }, ...extras.imports };
  const mod = new vm.SourceTextModule(code, { context, initializeImportMeta(meta) { meta.url = 'file:///mem/repo/scripts/verify.mjs'; } });
  await mod.link(async spec => {
    const values = imports[spec]; if (!values) throw new Error('Unexpected import ' + spec);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
  });
  return mod;
}

test('compile callback failure retains its lock and rejects the next writer', async () => {
  const m = memoryFS(), mod = await load(source, m); await mod.evaluate();
  await assert.rejects(mod.namespace.withDistributionOutput('/mem/client', async () => { throw new Error('compiler child failed; descendants unknown'); }, { recoverable: false }));
  assert.equal(m.nodes.has('/mem/.rsvp-distribution-client.lock'), true);
  await assert.rejects(mod.namespace.withDistributionOutput('/mem/client', async () => assert.fail('must not enter')), /locked/);
  const next = await load(source, m, { process: { pid: 5555, kill() { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } } });
  await next.evaluate();
  await assert.rejects(next.namespace.withDistributionOutput('/mem/client', async () => assert.fail('must not enter')), /surviving subprocesses/);
});

test('replaced previous tree is retained with the candidate instead of being deleted', async () => {
  const m = memoryFS(); await m.fs.mkdir('/mem/output', { recursive: true }); await m.fs.writeFile('/mem/output/asset', 'original');
  const inspected = await m.fs.lstat('/mem/output'), mod = await load(source, m); await mod.evaluate();
  await assert.rejects(mod.namespace.withDistributionOutput('/mem/output', async ({ temporary, commit }) => {
    await m.fs.writeFile(temporary + '/asset', 'new'); await m.fs.rename('/mem/output', '/mem/original-safe');
    await m.fs.mkdir('/mem/output'); await m.fs.writeFile('/mem/output/source-sentinel', 'foreign'); await commit(inspected);
  }), /identity changed/);
  const lock = '/mem/.rsvp-distribution-output.lock';
  assert.equal(m.nodes.get(lock + '/previous/source-sentinel').body, 'foreign');
  assert.equal(m.nodes.get(lock + '/candidate/asset').body, 'new');
  assert.equal(m.nodes.get('/mem/original-safe/asset').body, 'original');
});

for (const token of [undefined, null, 1, true, '', 'not-a-uuid']) test(`invalid owner token ${String(token)} preserves unknown files`, async () => {
  const m = memoryFS(), lock = '/mem/.rsvp-distribution-output.lock'; await m.fs.mkdir(lock, { recursive: true });
  await m.fs.writeFile(lock + '/owner.json', JSON.stringify({ schemaVersion: 1, output: '/mem/output', host: 'fixture-host', pid: 7777, recoverable: true, token }));
  await m.fs.writeFile(lock + '/unknown-sentinel', 'keep');
  const mod = await load(source, m); await mod.evaluate();
  await assert.rejects(mod.namespace.withDistributionOutput('/mem/output', async () => assert.fail('must not enter')), /incomplete|invalid/);
  assert.equal(m.nodes.get(lock + '/unknown-sentinel').body, 'keep');
});

for (const phase of ['candidate', 'previous', 'adopted']) test(`trusted journal recovers ${phase} on retry`, async () => {
  const m = memoryFS(), lock = '/mem/.rsvp-distribution-output.lock';
  await m.fs.mkdir(lock + '/candidate', { recursive: true }); await m.fs.writeFile(lock + '/candidate/asset', 'new');
  await m.fs.mkdir('/mem/output'); await m.fs.writeFile('/mem/output/asset', 'old');
  const candidate = await m.fs.lstat(lock + '/candidate'), previous = await m.fs.lstat('/mem/output');
  const id = s => ({ dev: String(s.dev), ino: String(s.ino) });
  await m.fs.writeFile(lock + '/owner.json', JSON.stringify({ schemaVersion: 1, output: '/mem/output', host: 'fixture-host', pid: 7777, recoverable: true, token: '00000000-0000-4000-8000-000000000000' }));
  await m.fs.writeFile(lock + '/transaction.json', JSON.stringify({ schemaVersion: 1, output: '/mem/output', candidate: id(candidate), previous: id(previous) }));
  if (phase !== 'candidate') await m.fs.rename('/mem/output', lock + '/previous');
  if (phase === 'adopted') await m.fs.rename(lock + '/candidate', '/mem/output');
  const mod = await load(source, m); await mod.evaluate(); await mod.namespace.withDistributionOutput('/mem/output', async () => {});
  assert.equal(m.nodes.get('/mem/output/asset').body, phase === 'adopted' ? 'new' : 'old');
  assert.equal([...m.nodes.keys()].some(p => p.includes('.rsvp-')), false);
});

test('an unexpected output is kept when no previous output was inspected', async () => {
  const m = memoryFS(), mod = await load(source, m); await mod.evaluate();
  await assert.rejects(mod.namespace.withDistributionOutput('/mem/output', async ({ commit }) => {
    await m.fs.mkdir('/mem/output'); await m.fs.writeFile('/mem/output/unknown', 'keep'); await commit();
  }), /Unexpected distribution output/);
  assert.equal(m.nodes.get('/mem/output/unknown').body, 'keep');
});

test('normal fixed-output replacement, callback failure and retry remain usable', async () => {
  const m = memoryFS(), mod = await load(source, m); await mod.evaluate();
  for (const value of ['first', 'second']) {
    const old = m.nodes.has('/mem/output') ? await m.fs.lstat('/mem/output') : null;
    await mod.namespace.withDistributionOutput('/mem/output', async ({ output, temporary, commit }) => {
      assert.equal(output, '/mem/output'); await m.fs.writeFile(temporary + '/asset', value); await commit(old);
    });
    assert.equal(m.nodes.get('/mem/output/asset').body, value);
    assert.equal([...m.nodes.keys()].some(p => p.includes('.rsvp-')), false);
  }
  await assert.rejects(mod.namespace.withDistributionOutput('/mem/output', async () => { throw new Error('audit failed'); }), /audit failed/);
  assert.equal(m.nodes.get('/mem/output/asset').body, 'second');
  await mod.namespace.withDistributionOutput('/mem/output', async () => {});
});

test('audio validation keeps explicit A plus B and rejects existing plus B', async () => {
  const stage = await readFile(new URL('./stage-library.ts', import.meta.url), 'utf8');
  const library = await readFile(new URL('../apps/web/src/distribution/library.ts', import.meta.url), 'utf8');
  const idStart = library.indexOf('export function validDistributionId(');
  const idFunction = library.slice(idStart, library.indexOf('\n}', idStart) + 2);
  const start = stage.indexOf('export function validateStageConfig('), end = stage.indexOf('\nasync function audioInfo(', start);
  const js = stripTypeScriptTypes(idFunction + '\n' + stage.slice(start, end));
  const mod = new vm.SourceTextModule(js); await mod.link(() => assert.fail('no external dependency')); await mod.evaluate();
  const book = id => ({ id, revision: 'revision', rightsConfirmed: true, publicDemo: false, attribution: 'fixture' });
  const selected = { target: 'worker', audience: 'personal', libraryDir: '/mem/library', books: [book('A'), book('B')] };
  assert.deepEqual(mod.namespace.validateStageConfig(selected).books.map(b => b.id), ['A', 'B']);
  assert.throws(() => mod.namespace.validateStageConfig({ ...selected, existing: '/mem/previous', books: [book('B')] }), /does not support existing/);
});
