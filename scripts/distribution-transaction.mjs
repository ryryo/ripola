import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function info(path) {
  try { return await lstat(path, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function identity(value) { return { dev: String(value.dev), ino: String(value.ino) }; }
function validIdentity(value) {
  return value && typeof value === 'object' && /^(0|[1-9][0-9]*)$/.test(value.dev)
    && typeof value.dev === 'string' && typeof value.ino === 'string' && /^[1-9][0-9]*$/.test(value.ino);
}
function sameFile(a, b) { return a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino); }
async function record(path) {
  const file = await info(path);
  if (!file?.isFile() || file.isSymbolicLink()) throw new Error('Distribution record is missing or not a regular file; preserved for inspection.');
  return JSON.parse(await readFile(path, 'utf8'));
}
function validOwner(owner, output) {
  return owner?.schemaVersion === 1 && owner.output === output && owner.host === hostname()
    && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.recoverable === 'boolean'
    && typeof owner.token === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner.token);
}
async function ownerRecord(lock, output) {
  let owner;
  try { owner = await record(join(lock, 'owner.json')); }
  catch (cause) { throw new Error('Distribution lock is initializing or incomplete; retry or inspect it.', { cause }); }
  if (!validOwner(owner, output)) throw new Error('Distribution lock owner is incomplete or invalid; preserved for inspection.');
  return owner;
}
async function assertOwner(lock, output, expected) {
  if (!sameFile(await info(lock), expected.directory) || (await ownerRecord(lock, output)).token !== expected.owner.token) {
    throw new Error('Distribution lock identity changed; preserved for inspection.');
  }
}
async function releaseRecovery(path, expected) {
  if (!sameFile(await info(path), expected)) throw new Error('Recovery lock changed; preserved for inspection.');
  // A foreign file in this empty recovery directory must never be recursively removed.
  await rmdir(path);
}

// Validate the tree being removed, as well as the newly adopted candidate.
async function settle(lock, output) {
  const previous = join(lock, 'previous');
  const old = await info(previous);
  if (!old) return;
  const transaction = await record(join(lock, 'transaction.json'));
  if (transaction.schemaVersion !== 1 || transaction.output !== output || !validIdentity(transaction.previous)
    || !validIdentity(transaction.candidate) || !old.isDirectory() || old.isSymbolicLink() || !sameFile(old, transaction.previous)) {
    throw new Error('Previous distribution identity changed; all trees were preserved.');
  }
  const current = await info(output);
  if (!current) await rename(previous, output);
  else {
    if (!sameFile(current, transaction.candidate)) throw new Error('Output changed during distribution recovery; both trees were preserved.');
    await rm(previous, { recursive: true });
  }
}

async function acquire(lock, output, recoverable) {
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const directory = await info(lock);
    if (!directory?.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid distribution lock; preserved for inspection.', { cause: error });
    const owner = await ownerRecord(lock, output);
    if (alive(owner.pid)) throw new Error('Distribution output is locked by another build.', { cause: error });
    if (!owner.recoverable) throw new Error('Interrupted client build may have surviving subprocesses; inspect its lock before retrying.', { cause: error });
    const recovery = `${lock}.recovery`;
    try { await mkdir(recovery, { mode: 0o700 }); }
    catch (cause) { throw new Error('Distribution recovery is already in progress; retry or inspect it.', { cause }); }
    const recoveryIdentity = await info(recovery);
    try {
      await assertOwner(lock, output, { owner, directory });
      if (alive(owner.pid)) throw new Error('Distribution lock owner changed; retry.', { cause: error });
      await settle(lock, output);
      await assertOwner(lock, output, { owner, directory });
      await rm(lock, { recursive: true });
      await mkdir(lock, { mode: 0o700 });
    } finally {
      await releaseRecovery(recovery, recoveryIdentity);
    }
  }
  const directory = await info(lock);
  const owner = { schemaVersion: 1, output, pid: process.pid, host: hostname(), token: randomUUID(), recoverable };
  await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  return { owner, directory };
}

/** A failed nonrecoverable workspace remains locked until its descendants are inspected. */
export async function withDistributionOutput(path, work, { recoverable = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const output = join(await realpath(dirname(path)), basename(path));
  const lock = join(dirname(output), `.rsvp-distribution-${basename(output)}.lock`);
  const ownership = await acquire(lock, output, recoverable);
  const temporary = join(lock, 'candidate');
  let succeeded = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    const result = await work({ output, temporary, async commit(previous = null) {
      if (previous !== null && !validIdentity(identity(previous))) throw new Error('Commit requires the inspected previous directory identity.');
      const candidate = await info(temporary);
      await writeFile(join(lock, 'transaction.json'), JSON.stringify({ schemaVersion: 1, output,
        candidate: identity(candidate), previous: previous === null ? null : identity(previous) }), { flag: 'wx', mode: 0o600 });
      if (previous !== null) {
        await rename(output, join(lock, 'previous'));
        // Check after the rename: a pre-rename check alone leaves a substitution window.
        if (!sameFile(await info(join(lock, 'previous')), previous)) throw new Error('Previous distribution identity changed; all trees were preserved.');
      } else if (await info(output)) throw new Error('Unexpected distribution output appeared; preserved for inspection.');
      await rename(temporary, output);
      await settle(lock, output);
    } });
    succeeded = true;
    return result;
  } finally {
    if (recoverable || succeeded) {
      await assertOwner(lock, output, ownership);
      await settle(lock, output);
      await assertOwner(lock, output, ownership);
      await rm(lock, { recursive: true });
    }
  }
}
