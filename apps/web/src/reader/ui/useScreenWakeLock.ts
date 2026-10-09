import { useEffect } from 'react';

/** Best-effort screen retention for one playback session, including audio buffering. */
export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !window.isSecureContext || !navigator.wakeLock || document.hidden) return;
    let cancelled = false;
    let lock: WakeLockSentinel | undefined;
    const release = (value?: WakeLockSentinel) => {
      if (value && !value.released) void value.release().catch(() => {});
    };
    const stop = () => { cancelled = true; release(lock); lock = undefined; };
    // Readers pause when hidden. A visible return must wait for explicit playback,
    // even if it arrives before React has committed the paused state.
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', stop);
    void navigator.wakeLock.request('screen').then(value => {
      // The request can complete after pause, navigation or StrictMode cleanup.
      if (cancelled || document.hidden) release(value);
      else lock = value;
    }).catch(() => {
      // Unsupported policies and power-saving refusal must not block reading.
      // Do not retry an OS release/refusal in a loop; the next playback tries again.
    });
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [active]);
}
