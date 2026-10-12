import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { trackAlignmentProcess } from '../src/generation/core/alignment-worker';
import { trackNativeProcess } from '../src/generation/core/native-processes';

test('alignment and other native children share one lifecycle owner and detach after the last child', () => {
  const events = ['beforeExit', 'exit', 'SIGINT', 'SIGTERM'] as const;
  const listeners = () => events.map(event => process.listenerCount(event));
  for (const alignmentFirst of [true, false]) {
    const before = listeners();
    const alignment = new ChildProcess(), other = new ChildProcess();
    const trackAlignment = () => trackAlignmentProcess(alignment, false);
    const trackOther = () => trackNativeProcess(other);
    const unregister = alignmentFirst ? [trackAlignment(), trackOther()] : [trackOther(), trackAlignment()];
    try {
      assert.deepEqual(listeners(), before.map(count => count + 1));
      alignment.emit('exit', 0, null);
      assert.deepEqual(listeners(), before.map(count => count + 1));
      other.emit('exit', 0, null);
      assert.deepEqual(listeners(), before);
    } finally { unregister.forEach(release => { release(); release(); }); }
    assert.deepEqual(listeners(), before);
  }
});
