import type { ChildProcess } from 'node:child_process';

interface Registry {
  children: Map<ChildProcess, boolean>;
  cleanup: () => void;
  interrupt: () => void;
  terminate: () => void;
}
const key = Symbol.for('ripola.native-processes.v1');
const globals = globalThis as typeof globalThis & { [key]?: Registry };

function kill(child: ChildProcess, grouped: boolean) {
  try {
    if (grouped && process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
  }
}
function detach(registry: Registry) {
  process.off('beforeExit', registry.cleanup); process.off('exit', registry.cleanup);
  process.off('SIGINT', registry.interrupt); process.off('SIGTERM', registry.terminate);
}

/** One signal owner for this process's native children, including across HMR. */
export function trackNativeProcess(child: ChildProcess, grouped = false): () => void {
  let registry = globals[key];
  if (!registry) {
    const children = new Map<ChildProcess, boolean>();
    const cleanup = () => { for (const [item, group] of children) kill(item, group); };
    const interrupted = (signal: NodeJS.Signals) => {
      cleanup(); detach(registry!);
      // We run first so a host's once-handler still owns termination when present.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    registry = { children, cleanup, interrupt: () => interrupted('SIGINT'), terminate: () => interrupted('SIGTERM') };
    globals[key] = registry;
  }
  if (!process.listeners('SIGINT').includes(registry.interrupt)) {
    process.on('beforeExit', registry.cleanup); process.on('exit', registry.cleanup);
    process.prependListener('SIGINT', registry.interrupt); process.prependListener('SIGTERM', registry.terminate);
  }
  registry.children.set(child, grouped);
  let tracked = true;
  const unregister = () => {
    if (!tracked) return;
    tracked = false; child.off('exit', unregister); child.off('error', unregister);
    registry.children.delete(child);
    if (registry.children.size === 0) detach(registry);
  };
  child.once('exit', unregister); child.once('error', unregister);
  return unregister;
}
