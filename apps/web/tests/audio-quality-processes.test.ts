import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const parentFixture = fileURLToPath(new URL('./fixtures/audio-quality-parent.mjs', import.meta.url));
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`explicit ASR terminates its native child when only its parent receives ${signal}`, { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ripola-asr-signal-'));
    const pidFile = join(directory, 'child.pid');
    // The interpreter and CJS entry are controlled; exercise the real adapter's OS process lifetime without a model.
    await writeFile(join(directory, 'inspect_audio_asr.py'), "require('node:fs').writeFileSync(require('node:path').join(process.env.RSVP_ALIGNMENT_MODEL_DIR, 'child.pid'), String(process.pid)); setInterval(() => {}, 1000);\n");
    const parent = spawn(process.execPath, ['--import', 'tsx', parentFixture, directory], { stdio: 'ignore' });
    const closed = once(parent, 'close');
    let nativePid: number | undefined;
    try {
      const readyDeadline = Date.now() + 8000;
      while (Date.now() < readyDeadline) {
        try { nativePid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(20); }
      }
      assert.ok(nativePid && Number.isInteger(nativePid) && alive(nativePid), 'native process must actually be running before the signal');
      parent.kill(signal);
      const [code, killedBy] = await Promise.race([closed, delay(2000).then(() => { throw new Error('parent did not terminate'); })]);
      assert.equal(code, null); assert.equal(killedBy, signal);
      const deadline = Date.now() + 2000;
      while (alive(nativePid) && Date.now() < deadline) await delay(20);
      assert.equal(alive(nativePid), false, 'native ASR must not outlive its interrupted owner');
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL');
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
