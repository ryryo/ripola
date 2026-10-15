import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { BOOK_REFERENCES_LOCK, LibraryDisk } from '../src/generation/core/disk';

test('book persistence waits for a source cleanup that exceeds the short job-lock retry window', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ripola-book-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = new LibraryDisk(root);
  const release = (await disk.lock(BOOK_REFERENCES_LOCK))!;
  t.after(release);
  const saving = disk.write(['books', 'fixture.json'], { id: 'fixture' }).then(() => undefined, error => error);
  await pause(2200);
  await release();
  assert.equal(await saving, undefined);
  assert.deepEqual(await disk.read(['books', 'fixture.json']), { id: 'fixture' });
});
