import type { Page } from '@playwright/test';

type Mode = 'grant' | 'defer' | 'deny' | 'unsupported' | 'insecure';
declare global {
  interface Window {
    testWakeLock: {
      requests: string[]; held: number; releases: number; mode: Mode;
      resolvePending: () => void; releaseAll: () => void;
    };
  }
}

/** Verify application lifecycle without treating a browser mock as physical sleep QA. */
export async function installWakeLock(page: Page, mode: Mode = 'grant') {
  await page.addInitScript(initialMode => {
    const active = new Set<() => void>();
    const pending: (() => void)[] = [];
    const state = window.testWakeLock = {
      requests: [] as string[], held: 0, releases: 0, mode: initialMode,
      resolvePending: () => { for (const resolve of pending.splice(0)) resolve(); },
      releaseAll: () => { for (const release of [...active]) release(); },
    };
    const grant = () => {
      const lock = new EventTarget();
      let released = false;
      const release = () => {
        if (released) return;
        released = true; active.delete(release); state.held--; state.releases++;
        lock.dispatchEvent(new Event('release'));
      };
      active.add(release); state.held++;
      Object.defineProperties(lock, {
        type: { value: 'screen' }, released: { get: () => released },
        release: { value: async () => release() },
      });
      return lock;
    };
    if (initialMode === 'insecure') Object.defineProperty(window, 'isSecureContext', { value: false });
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: initialMode === 'unsupported' ? undefined : {
      request: (type: string) => {
        state.requests.push(type);
        if (state.mode === 'deny') return Promise.reject(new DOMException('Power saving', 'NotAllowedError'));
        if (state.mode === 'defer') return new Promise(resolve => pending.push(() => resolve(grant())));
        return Promise.resolve(grant());
      },
    } });
  }, mode);
}
