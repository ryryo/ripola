import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('preparation checks resolved write destinations, forwards the scratch peak and refuses old guards or insufficient space', async () => {
  assert.ok(process.env.WORKSPACE_SCRATCH, 'Run under guard.py scratch.');
  const root = await mkdtemp(join(process.env.WORKSPACE_SCRATCH, 'preparation-space-'));
  try {
    const repo = join(root, 'repo'), output = join(root, 'output-volume'), client = join(root, 'client-volume'), pdf = join(root, 'pdf-volume');
    for (const directory of [join(repo, 'scripts'), join(repo, 'apps/web/public'), output, client, pdf]) await mkdir(directory, { recursive: true });
    await symlink(output, join(repo, 'dist')); await symlink(client, join(repo, 'apps/web/dist')); await symlink(pdf, join(repo, 'apps/web/public/pdfjs'));
    await copyFile(new URL('./prepare-distribution.mjs', import.meta.url), join(repo, 'scripts/prepare-distribution.mjs'));
    const config = join(root, 'allowlist.json'), guard = join(root, 'guard.py'), log = join(root, 'calls.jsonl');
    await writeFile(config, JSON.stringify({ target: 'worker', audience: 'personal', books: [] }));
    // Simulate separate mounts/refusals without making a real mount or copying media.
    await writeFile(guard, `import json,os,sys\nfrom pathlib import Path\na=sys.argv[1:]\nwith open(os.environ['FIXTURE_LOG'],'a') as f: f.write(json.dumps(a)+'\\n')\nif a[0]=='version':\n if os.environ.get('FIXTURE_VERSION')=='unsupported': sys.exit(2)\n print(os.environ.get('FIXTURE_VERSION','2'));sys.exit(0)\nif (a[0]=='check' and a[a.index('--path')+1]==os.environ.get('FIXTURE_REFUSE')) or (a[0]=='scratch' and os.environ.get('FIXTURE_REFUSE')=='scratch'): sys.exit(7)\n`);
    async function run(extra = {}, suppliedClient = false) {
      await writeFile(log, '');
      const args = [join(repo, 'scripts/prepare-distribution.mjs'), '--config', config, '--needed-gib', '0.375'];
      if (suppliedClient) args.push('--client', client);
      const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, RIPOLA_STORAGE_GUARD: guard, FIXTURE_LOG: log, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      let message = ''; child.stderr.on('data', value => { message += value; });
      const [code] = await once(child, 'close');
      return { code, message, calls: (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
    }
    const normal = await run(); assert.equal(normal.code, 0, normal.message);
    assert.deepEqual(normal.calls.filter(a => a[0] === 'check').map(a => a[2]), [repo, output, client, pdf]);
    for (const call of normal.calls.filter(a => a[0] !== 'version')) assert.equal(call[call.indexOf('--needed-gib') + 1], '0.375');
    const scratch = normal.calls.at(-1); assert.equal(scratch[0], 'scratch'); assert.ok(scratch.indexOf('--needed-gib') < scratch.indexOf('--'));
    const supplied = await run({}, true); assert.equal(supplied.code, 0);
    assert.deepEqual(supplied.calls.filter(a => a[0] === 'check').map(a => a[2]), [repo, output]); // Supplied client is read-only.
    for (const version of ['1', 'unsupported']) {
      const old = await run({ FIXTURE_VERSION: version }); assert.equal(old.code, 1); assert.match(old.message, /API v2/); assert.deepEqual(old.calls, [['version']]);
    }
    for (const destination of [output, client, pdf, 'scratch']) {
      const failed = await run({ FIXTURE_REFUSE: destination }); assert.equal(failed.code, 1);
      if (destination !== 'scratch') assert.equal(failed.calls.some(a => a[0] === 'scratch'), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
