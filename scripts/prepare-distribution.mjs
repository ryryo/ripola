import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);

async function run(command, args, cwd = repository, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: false });
    let output = '';
    if (capture) child.stdout.on('data', value => { output += value; });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? accept(output) : reject(new Error(`${command} failed (${signal ?? code}).`)));
  });
}

async function storageDirectory(destination) {
  let directory = resolve(destination);
  for (;;) {
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error('Storage destination must have a directory ancestor.');
      return await realpath(directory);
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(directory) === directory) throw error;
      directory = dirname(directory);
    }
  }
}

export function parsePreparation(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--kind', '--client', '--needed-gib', '--scratch'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Usage: node scripts/prepare-distribution.mjs --config ALLOWLIST [--kind audio|text] [--client EXISTING_CLIENT] [--needed-gib 2]');
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has('--config')) throw new Error('An explicit allowlist is required.');
  const kind = flags.get('--kind') ?? 'audio';
  const needed = Number(flags.get('--needed-gib') ?? 2);
  if (!['audio', 'text'].includes(kind) || !Number.isFinite(needed) || needed < 0) throw new Error('Invalid preparation kind or space estimate.');
  return { config: resolve(flags.get('--config')), kind, needed, client: flags.has('--client') ? resolve(flags.get('--client')) : undefined, scratch: flags.get('--scratch') };
}

async function main() {
  const args = process.argv.slice(2);
  const options = parsePreparation(args);
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  if (options.kind === 'audio' && Object.hasOwn(config, 'existing')) throw new Error('Audio staging does not support existing. Include every retained and added book in books.');
  if (!['pages', 'worker'].includes(config.target)) throw new Error('Allowlist requires target=pages|worker.');
  if (!options.scratch) {
    const guard = process.env.RIPOLA_STORAGE_GUARD ?? join(homedir(), '.codex/storage-maintenance/guard.py');
    let version;
    try { version = await run('python3', [guard, 'version'], repository, true); }
    catch (error) { throw new Error('Storage guard API v2 is required; version probe failed and preparation was not started.', { cause: error }); }
    if (version.trim() !== '2') throw new Error('Storage guard API v2 is required; preparation was not started.');
    // Candidates/previous live beside output; Vite and PDF assets can be on other filesystems.
    const destinations = [repository, join(repository, config.audience === 'personal' ? 'dist' : 'dist/distribution')];
    if (!options.client) destinations.push(join(repository, 'apps/web/dist', config.target), join(repository, 'apps/web/public/pdfjs'));
    const checked = new Set();
    for (const destination of destinations) {
      const directory = await storageDirectory(destination);
      if (checked.has(directory)) continue;
      await run('python3', [guard, 'check', '--path', directory, '--needed-gib', String(options.needed)]);
      checked.add(directory);
    }
    // Only the owner created by guard may remove this stage. No persistent numbered copy.
    await run('python3', [guard, 'scratch', '--needed-gib', String(options.needed), '--', process.execPath, script, ...args, '--scratch', '{scratch}']);
    return;
  }
  if (!process.env.WORKSPACE_SCRATCH || resolve(options.scratch) !== resolve(process.env.WORKSPACE_SCRATCH)) throw new Error('Scratch must be allocated by the storage guard.');
  const stage = join(resolve(options.scratch), 'stage');
  await run(process.execPath, ['--import', 'tsx', `scripts/stage-${options.kind === 'text' ? 'text-' : ''}library.ts`, '--config', options.config, '--output', stage]);
  const buildArgs = ['scripts/build-distribution.mjs', '--profile', config.target, '--audience', config.audience ?? 'demo', '--staging', stage];
  if (options.client) buildArgs.push('--client', options.client);
  await run(process.execPath, buildArgs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
