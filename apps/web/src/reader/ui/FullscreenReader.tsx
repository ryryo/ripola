import { Button } from '@mantine/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './fullscreen.css';

export function useFullscreenReader(pause: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const native = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pauseRef = useRef(pause); pauseRef.current = pause;
  const exit = useCallback(() => {
    activeRef.current = false; setActive(false); pauseRef.current();
    if (document.fullscreenElement === containerRef.current) void document.exitFullscreen().then(() => {
      requestAnimationFrame(() => { if (!activeRef.current) returnFocus.current?.focus({ preventScroll: true }); });
    }).catch(() => {});
  }, []);
  const enter = useCallback((origin?: HTMLElement) => {
    const element = containerRef.current;
    if (!element || activeRef.current) return;
    returnFocus.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    pauseRef.current(); activeRef.current = true; native.current = false; setActive(true);
    // Keep the viewport layout even when native fullscreen is unavailable/denied.
    if (element.requestFullscreen && document.fullscreenEnabled) void element.requestFullscreen().then(() => {
      if (activeRef.current) native.current = true;
      else if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!active) return;
    const element = containerRef.current;
    if (!element) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const siblings = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
    // The viewport fallback also excludes underlying page controls from tab/AT.
    for (let node: HTMLElement | null = element; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) if (sibling !== node && sibling instanceof HTMLElement) {
        siblings.set(sibling, { inert: sibling.inert, ariaHidden: sibling.getAttribute('aria-hidden') });
        sibling.inert = true; sibling.setAttribute('aria-hidden', 'true');
      }
    }
    element.focus({ preventScroll: true });
    const changed = () => {
      if (document.fullscreenElement === element) native.current = true;
      else if (native.current) exit();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); exit(); }
      if (event.key !== 'Tab') return;
      const items = [...element.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex="0"]')].filter(item => !item.closest('[inert]') && !item.matches(':disabled') && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
      const first = items[0]; const last = items.at(-1);
      if (!first) { event.preventDefault(); element.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('keydown', key, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const [sibling, previous] of siblings) {
        sibling.inert = previous.inert;
        if (previous.ariaHidden === null) sibling.removeAttribute('aria-hidden');
        else sibling.setAttribute('aria-hidden', previous.ariaHidden);
      }
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('keydown', key, true);
      const target = returnFocus.current;
      // Native fullscreen restores its own focus after dispatching the change.
      requestAnimationFrame(() => { if (!activeRef.current && target?.isConnected) target.focus({ preventScroll: true }); });
    };
  }, [active, exit]);
  useEffect(() => () => {
    activeRef.current = false;
  }, []);
  return { active, containerRef, enter, exit };
}

export function FullscreenReader({ fullscreen, playing, children, seek, speed, toggle, pause, disabled = false, playLabel = '再生' }: {
  fullscreen: ReturnType<typeof useFullscreenReader>; playing: boolean; children: ReactNode; seek: ReactNode; speed: ReactNode;
  toggle: () => void; pause: () => void; disabled?: boolean; playLabel?: string;
}) {
  return <div ref={fullscreen.containerRef} className="fullscreen-reader" data-fullscreen={fullscreen.active} data-playing={playing} tabIndex={-1} role={fullscreen.active ? 'region' : undefined} aria-label={fullscreen.active ? '全画面の読書' : undefined}
    onClick={event => {
      if (!fullscreen.active || !playing || !(event.target instanceof HTMLElement) || !event.target.closest('.reader-stage, .audio-stage') || event.target.closest('button, input, select, a')) return;
      pause(); fullscreen.containerRef.current?.focus({ preventScroll: true });
    }}>
    {children}
    {fullscreen.active && <div className="fullscreen-footer">
      <div className="fullscreen-seek">{seek}</div>
      <div className="fullscreen-actions" hidden={playing}>
        <Button disabled={disabled} onClick={() => { toggle(); fullscreen.containerRef.current?.focus({ preventScroll: true }); }} aria-keyshortcuts="Space">{playLabel}</Button>
        {speed}
        <Button variant="subtle" onClick={fullscreen.exit}>全画面を終了</Button>
      </div>
    </div>}
  </div>;
}
