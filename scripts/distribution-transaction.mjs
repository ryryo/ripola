import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }

// A fixed, output-specific workspace also records the interrupted rename window.
// No library, arbitrary sibling directory, or old dated snapshot is a cleanup target.
async function settle(lock, output) {
  const previous = join(lock, 'previous');
  const old = await info(previous);
  if (!old) return;
  if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('Invalid distribution recovery directory; preserved for inspection.');
  const current = await info(output);
  if (!current) await rename(previous, output);
  else {
    const candidate = JSON.parse(await readFile(join(lock, 'candidate.json'), 'utf8'));
    if (!sameFile(current, candidate)) throw new Error('Output changed during distribution recovery; both trees were preserved.');
    await rm(previous, { recursive: true });
  }
}

async function acquire(lock, output, recoverable) {
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const state = await info(lock);
    if (!state?.isDirectory() || state.isSymbolicLink()) throw new Error('Invalid distribution lock; preserved for inspection.', { cause: error });
    let owner;
    try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
    catch (cause) { throw new Error('Distribution lock is initializing or incomplete; retry or inspect it.', { cause }); }
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) throw new Error('Distribution output is locked by another build.', { cause: error });
    if (owner.recoverable !== true) throw new Error('Interrupted client build may have surviving subprocesses; inspect its lock before retrying.', { cause: error });
    // Serialize stale-owner recovery. Never steal a live lock or guess by age.
    const recovery = `${lock}.recovery`;
    try { await mkdir(recovery, { mode: 0o700 }); }
    catch (cause) { throw new Error('Distribution recovery is already in progress; retry or inspect it.', { cause }); }
    try {
      const latest = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (latest.token !== owner.token || alive(latest.pid)) throw new Error('Distribution lock owner changed; retry.', { cause: error });
      await settle(lock, output);
      await rm(lock, { recursive: true });
      // Another new build may win this mkdir; it then owns the output.
      await mkdir(lock, { mode: 0o700 });
    } finally { await rm(recovery, { recursive: true }); }
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), recoverable }), { flag: 'wx', mode: 0o600 });
}

/** Serialize replacement, preserve the adopted tree on failure, recover a dead owner on retry. */
export async function withDistributionOutput(path, work, { recoverable = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const output = join(await realpath(dirname(path)), basename(path));
  const lock = join(dirname(output), `.rsvp-distribution-${basename(output)}.lock`);
  await acquire(lock, output, recoverable);
  const temporary = join(lock, 'candidate');
  try {
    await mkdir(temporary);
    return await work({ temporary, async commit(existing) {
      const candidate = await lstat(temporary);
      await writeFile(join(lock, 'candidate.json'), JSON.stringify({ dev: candidate.dev, ino: candidate.ino }), { flag: 'wx' });
      if (existing) await rename(output, join(lock, 'previous'));
      await rename(temporary, output);
      await settle(lock, output);
    } });
  } finally {
    // If recovery cannot prove ownership, keep the lock and all data for inspection.
    await settle(lock, output);
    await rm(lock, { recursive: true });
  }
}
