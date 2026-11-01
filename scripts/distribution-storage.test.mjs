import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, lstat, rename, symlink, writeFile } from 'node:fs/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDistribution } from './build-distribution.mjs';
import { withDistributionOutput } from './distribution-transaction.mjs';
import { parsePreparation } from './prepare-distribution.mjs';

async function fixture(work) {
  assert.ok(process.env.WORKSPACE_SCRATCH, 'Run tests under guard.py scratch.');
  const root = await mkdtemp(join(process.env.WORKSPACE_SCRATCH, 'distribution-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('two builds leave one adopted output, independent copies and no backup; audit failure preserves it', () => fixture(async root => {
  const client = join(root, 'client'), output = join(root, 'worker');
  await mkdir(join(client, 'assets'), { recursive: true });
  await writeFile(join(client, '_shell.html'), '<html><script src="/assets/reader.js"></script></html>');
  const source = join(client, 'assets/reader.js'), asset = join(output, 'assets/reader.js');
  for (const value of ['first', 'second']) {
    await writeFile(source, `console.log('${value}')`);
    await buildDistribution({ profile: 'worker', client, output, replaceExisting: true });
    assert.equal(await readFile(asset, 'utf8'), `console.log('${value}')`);
    assert.deepEqual((await readdir(root)).sort(), ['client', 'worker', 'worker.wrangler.jsonc']);
  }
  assert.notEqual((await stat(source)).ino, (await stat(asset)).ino);
  await writeFile(asset, 'mutated candidate');
  assert.equal(await readFile(source, 'utf8'), "console.log('second')");
  await writeFile(source, 'const value="GEMINI_API_KEY"');
  await assert.rejects(buildDistribution({ profile: 'worker', client, output, replaceExisting: true }), /Local generation/);
  assert.equal(await readFile(asset, 'utf8'), 'mutated candidate');
}));

test('concurrent writers fail before touching the adopted output and retry succeeds', () => fixture(async root => {
  const output = join(root, 'worker');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = withDistributionOutput(output, async ({ temporary, commit }) => {
    await writeFile(join(temporary, 'asset'), 'first'); entered(); await gate; await commit();
  });
  await ready;
  await assert.rejects(withDistributionOutput(output, () => assert.fail('must not enter')), /locked/);
  await symlink(root, join(root, 'alias'));
  await assert.rejects(withDistributionOutput(join(root, 'alias/worker'), () => assert.fail('must not enter')), /locked/);
  await rm(join(root, 'alias'));
  release(); await first;
  await withDistributionOutput(output, async ({ temporary, commit }) => {
    await writeFile(join(temporary, 'asset'), 'retry'); await commit(await lstat(output, { bigint: true }));
  });
  assert.equal(await readFile(join(output, 'asset'), 'utf8'), 'retry');
  assert.deepEqual(await readdir(root), ['worker']);
}));

test('a non-cooperating output replacement is preserved with the candidate', () => fixture(async root => {
  const output = join(root, 'worker'); await mkdir(output); await writeFile(join(output, 'asset'), 'original');
  const previous = await lstat(output, { bigint: true });
  await assert.rejects(withDistributionOutput(output, async ({ temporary, commit }) => {
    await writeFile(join(temporary, 'asset'), 'candidate'); await rename(output, join(root, 'original-safe'));
    await mkdir(output); await writeFile(join(output, 'source-sentinel'), 'unknown'); await commit(previous);
  }), /identity changed/);
  const lock = join(root, '.rsvp-distribution-worker.lock');
  assert.equal(await readFile(join(lock, 'previous/source-sentinel'), 'utf8'), 'unknown');
  assert.equal(await readFile(join(lock, 'candidate/asset'), 'utf8'), 'candidate');
  assert.equal(await readFile(join(root, 'original-safe/asset'), 'utf8'), 'original');
}));

test('CLI compile failure with a surviving grandchild blocks the next build', () => fixture(async root => {
  const repo = join(root, 'repo'); await mkdir(join(repo, 'scripts'), { recursive: true }); await mkdir(join(root, 'bin'));
  for (const name of ['build-distribution.mjs', 'distribution-transaction.mjs']) await copyFile(new URL(name, import.meta.url), join(repo, 'scripts', name));
  await writeFile(join(repo, 'scripts/distribution-utils.mjs'), 'export const MAX_ASSET_BYTES=1; export function isInside(){}; export function contentHash(){}; export function auditDistribution(){}; export function readLibraryFile(){}; export function validatePublicPresentation(){};');
  await writeFile(join(repo, 'scripts/prepare-pdf-assets.mjs'), '');
  const record = join(root, 'grandchild.json'), pnpm = join(root, 'bin/pnpm');
  await writeFile(pnpm, `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:child.pid}));process.exit(7);`);
  await chmod(pnpm, 0o700); let writer;
  try {
    async function run() {
      const child = spawn(process.execPath, [join(repo, 'scripts/build-distribution.mjs'), '--profile', 'worker'], { cwd: repo, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
      const [code] = await once(child, 'exit'); return { code, log };
    }
    assert.equal((await run()).code, 1); writer = JSON.parse(await readFile(record, 'utf8')).pid;
    process.kill(writer, 0);
    const next = await run(); assert.equal(next.code, 1); assert.match(next.log, /surviving subprocesses/);
    const lock = join(repo, 'dist/.rsvp-distribution-.client-worker.lock');
    assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).recoverable, false);
    assert.equal(JSON.parse(await readFile(record, 'utf8')).pid, writer);
  } finally {
    if (writer) { process.kill(writer, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 30)); }
  }
}));

for (const phase of ['candidate', 'previous', 'adopted']) {
  test(`SIGKILL at ${phase} is recovered on retry without losing adopted data`, () => fixture(async root => {
    const output = join(root, 'worker'); await mkdir(output); await writeFile(join(output, 'asset'), 'original');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {writeFile,rename,lstat} from 'node:fs/promises';
      import {join,dirname} from 'node:path';
      import {withDistributionOutput} from ${JSON.stringify(new URL('./distribution-transaction.mjs', import.meta.url).href)};
      await withDistributionOutput(${JSON.stringify(output)}, async ({temporary}) => {
        await writeFile(join(temporary,'asset'),'new');
        const s=await lstat(temporary);
        const old=await lstat(${JSON.stringify(output)});
        await writeFile(join(dirname(temporary),'transaction.json'),JSON.stringify({schemaVersion:1,output:${JSON.stringify(output)},candidate:{dev:String(s.dev),ino:String(s.ino)},previous:{dev:String(old.dev),ino:String(old.ino)}}));
        if (${JSON.stringify(phase)} !== 'candidate') await rename(${JSON.stringify(output)},join(dirname(temporary),'previous'));
        if (${JSON.stringify(phase)} === 'adopted') await rename(temporary,${JSON.stringify(output)});
        console.log('ready'); setInterval(()=>{},1000);
        await new Promise(()=>{});
      });`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        exited.then(() => { throw new Error('Child exited before interruption point.'); }),
      ]);
      child.kill('SIGKILL'); await exited;
      await assert.rejects(withDistributionOutput(output, async () => {
        assert.equal(await readFile(join(output, 'asset'), 'utf8'), phase === 'adopted' ? 'new' : 'original');
        throw new Error('retry audit failed');
      }), /retry audit failed/);
      assert.equal(await readFile(join(output, 'asset'), 'utf8'), phase === 'adopted' ? 'new' : 'original');
      assert.deepEqual(await readdir(root), ['worker']);
    } finally { clearTimeout(timer); child.kill('SIGKILL'); await exited; }
  }));
}

test('preparation only allows a fixed build destination, explicit allowlist and finite estimate', () => {
  assert.equal(parsePreparation(['--config', 'allowlist.json']).needed, 2);
  assert.throws(() => parsePreparation(['--config', 'a', '--output', 'dated-copy']), /Usage/);
  assert.throws(() => parsePreparation(['--config', 'a', '--needed-gib', 'NaN']), /Invalid/);
  assert.throws(() => parsePreparation([]), /allowlist/);
});

test('interrupted client build lock is retained because subprocesses may still be alive', () => fixture(async root => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(child, 'exit');
  const lock = join(root, '.rsvp-distribution-client.lock'); await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ schemaVersion: 1, output: join(root, 'client'), host: hostname(), pid: child.pid, token: '00000000-0000-4000-8000-000000000000', recoverable: false }));
  await assert.rejects(withDistributionOutput(join(root, 'client'), () => assert.fail('must not enter')), /surviving subprocesses/);
  assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).token, '00000000-0000-4000-8000-000000000000');
}));

test('unmanaged outputs are preserved and incomplete locks are never removed', () => fixture(async root => {
  const client = join(root, 'client'), output = join(root, 'unmanaged');
  await mkdir(client); await writeFile(join(client, '_shell.html'), '<html></html>');
  await mkdir(output); await writeFile(join(output, 'keep'), 'original');
  await assert.rejects(buildDistribution({ profile: 'worker', client, output, replaceExisting: true }));
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'original');
  const empty = join(root, 'empty'); await mkdir(empty);
  await assert.rejects(buildDistribution({ profile: 'worker', client, output: empty, replaceExisting: true }), { code: 'ENOENT' });
  assert.deepEqual(await readdir(empty), []);
  const lock = join(root, '.rsvp-distribution-unmanaged.lock');
  await mkdir(lock); await writeFile(join(lock, 'keep'), 'unknown owner');
  await assert.rejects(withDistributionOutput(output, () => assert.fail('must not enter')), /incomplete/);
  assert.equal(await readFile(join(lock, 'keep'), 'utf8'), 'unknown owner');
}));

test('preparation CLI stages in guard scratch, reuses its default output and cleans failed staging', () => fixture(async root => {
  // Exercise the actual coordinator with a tiny stage-command fixture and real postprocessor.
  for (const directory of ['scripts', 'node_modules/tsx', 'client/assets']) await mkdir(join(root, directory), { recursive: true });
  await copyFile(new URL('./prepare-distribution.mjs', import.meta.url), join(root, 'scripts/prepare-distribution.mjs'));
  await writeFile(join(root, 'node_modules/tsx/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
  await writeFile(join(root, 'node_modules/tsx/index.mjs'), '');
  const stageFixture = `
    import {appendFile,mkdir,readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const args=process.argv.slice(2),out=args[args.indexOf('--output')+1];
    const config=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8'));
    await appendFile(${JSON.stringify(join(root, 'stages.jsonl'))},JSON.stringify(out)+'\\n');
    await mkdir(join(out,'library'),{recursive:true});
    await writeFile(join(out,'library/index.json'),JSON.stringify({schemaVersion:1,target:'worker',audience:'personal',createdAt:new Date().toISOString(),books:[]}));
    if(config.fail)throw new Error('fixture staging failure');
  `;
  for (const file of ['stage-library.ts', 'stage-text-library.ts']) await writeFile(join(root, 'scripts', file), stageFixture);
  const output = join(root, 'dist/personal-worker');
  await writeFile(join(root, 'scripts/build-distribution.mjs'), `
    import {buildDistribution} from ${JSON.stringify(new URL('./build-distribution.mjs', import.meta.url).href)};
    const args=process.argv.slice(2);
    await buildDistribution({profile:'worker',audience:'personal',client:args[args.indexOf('--client')+1],staging:args[args.indexOf('--staging')+1],output:${JSON.stringify(output)},replaceExisting:true});
  `);
  await writeFile(join(root, 'client/_shell.html'), '<html><script src="/assets/a.js"></script></html>');
  await writeFile(join(root, 'client/assets/a.js'), 'fixture');
  const config = join(root, 'allowlist.json');
  async function run(kind, fail) {
    await writeFile(config, JSON.stringify({ target: 'worker', audience: 'personal', fail }));
    const child = spawn(process.execPath, [join(root, 'scripts/prepare-distribution.mjs'), '--config', config, '--kind', kind, '--client', join(root, 'client'), '--needed-gib', '0.01'], { cwd: root, env: process.env, stdio: 'pipe' });
    let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, fail ? 1 : 0, log);
  }
  await run('audio', false); const first = (await readdir(join(root, 'dist'))).sort();
  await run('text', false); assert.deepEqual((await readdir(join(root, 'dist'))).sort(), first);
  await run('audio', true); assert.equal(await readFile(join(output, 'assets/a.js'), 'utf8'), 'fixture');
  const stages = (await readFile(join(root, 'stages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(stages).size, 3);
  for (const path of stages) await assert.rejects(access(path), { code: 'ENOENT' });
}));
