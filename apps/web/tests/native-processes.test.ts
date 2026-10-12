import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { trackNativeProcess } from '../src/generation/core/native-processes';

const fixture = fileURLToPath(new URL('./fixtures/native-process-signals.mjs', import.meta.url));
async function signalTrial(order: string, signal: NodeJS.Signals, owner = 'none') {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, order, signal, owner], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
  child.stderr.on('data', bytes => { errors += bytes; });
  let sent = false;
  child.stdout.on('data', bytes => {
    output += bytes;
    if (!sent && output.includes('"type":"ready"')) { sent = true; child.kill(signal); }
    if (owner === 'owner-keeps-running' && output.includes('"type":"host-handled"')) child.kill('SIGKILL');
  });
  const [code, killedBy] = await once(child, 'close'); clearTimeout(timer);
  assert.equal(timedOut, false, `${order}/${signal}: ${output} ${errors}`);
  assert.equal(sent, true, errors);
  const frames = output.trim().split('\n').map(line => JSON.parse(line) as { type: string; received?: string });
  assert.ok(frames.some(frame => frame.type === 'mock-child-kill'));
  return { code, killedBy, frames };
}

test('native child registry terminates its parent for both registration orders and signals', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const order of ['irodori-only', 'alignment-first', 'irodori-first']) {
      const result = await signalTrial(order, signal);
      assert.equal(result.killedBy, signal); assert.equal(result.code, null);
    }
  }
});
test('a host once-handler retains signal ownership', async () => {
  for (const owner of ['owner-exits', 'owner-keeps-running']) {
    const result = await signalTrial('alignment-first', 'SIGTERM', owner);
    if (owner === 'owner-exits') assert.equal(result.code, 0);
    else assert.ok(result.frames.some(frame => frame.type === 'host-handled'));
  }
});
test('the last child unregisters native hooks and repeated cleanup is harmless', () => {
  const events = ['beforeExit', 'exit', 'SIGINT', 'SIGTERM'] as const;
  const before = events.map(event => process.listenerCount(event));
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const unregister = trackNativeProcess(child);
  assert.deepEqual(events.map(event => process.listenerCount(event)), before.map(count => count + 1));
  unregister(); unregister();
  assert.deepEqual(events.map(event => process.listenerCount(event)), before);
});
