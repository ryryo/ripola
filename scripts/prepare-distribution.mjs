import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);

async function run(command, args, cwd = repository) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${command} failed (${signal ?? code}).`)));
  });
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
  if (!options.scratch) {
    const guard = process.env.RIPOLA_STORAGE_GUARD ?? join(homedir(), '.codex/storage-maintenance/guard.py');
    await run('python3', [guard, 'check', '--path', repository, '--needed-gib', String(options.needed)]);
    // Only the owner created by guard may remove this stage. No persistent numbered copy.
    await run('python3', [guard, 'scratch', '--', process.execPath, script, ...args, '--scratch', '{scratch}']);
    return;
  }
  if (!process.env.WORKSPACE_SCRATCH || resolve(options.scratch) !== resolve(process.env.WORKSPACE_SCRATCH)) throw new Error('Scratch must be allocated by the storage guard.');
  const stage = join(resolve(options.scratch), 'stage');
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  if (!['pages', 'worker'].includes(config.target)) throw new Error('Allowlist requires target=pages|worker.');
  await run(process.execPath, ['--import', 'tsx', `scripts/stage-${options.kind === 'text' ? 'text-' : ''}library.ts`, '--config', options.config, '--output', stage]);
  const buildArgs = ['scripts/build-distribution.mjs', '--profile', config.target, '--audience', config.audience ?? 'demo', '--staging', stage];
  if (options.client) buildArgs.push('--client', options.client);
  await run(process.execPath, buildArgs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
