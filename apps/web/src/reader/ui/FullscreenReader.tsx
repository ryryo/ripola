import { Button, Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { FullscreenReaderContext } from './FullscreenReaderContext';
import { useNormalReaderHeight } from './useNormalReaderHeight';
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
      // The settings sheet handles Escape and traps its own keyboard focus.
      if (element.dataset.settingsOpen === 'true') {
        if (event.key === 'Escape' && !event.isComposing) event.preventDefault();
        return;
      }
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

export function FullscreenEnterButton({ fullscreen }: { fullscreen: ReturnType<typeof useFullscreenReader> }) {
  return <button type="button" className="fullscreen-enter" hidden={fullscreen.active} aria-label="全画面で読む" title="全画面で読む" onClick={event => fullscreen.enter(event.currentTarget)}>
    <FullscreenIcon />
  </button>;
}

function FullscreenIcon({ exiting = false }: { exiting?: boolean }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={exiting ? 'M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3' : 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5'} /></svg>;
}

export function ReaderPlayButton({ playing, disabled = false, label = '再生', onPlay }: {
  playing: boolean; disabled?: boolean; label?: string; onPlay: () => void;
}) {
  const { desktop } = useContext(FullscreenReaderContext);
  if (desktop) return null;
  return <button type="button" className="reader-play-overlay" hidden={playing} disabled={disabled} aria-label={`${label}（画面中央）`} title={label} aria-keyshortcuts="Space" onClick={onPlay}>
    <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l14-8z" /></svg>
  </button>;
}

export function FullscreenReader({ fullscreen, playing, children, seek, speed, modes, displayControls, readingControls, displaySettings, position, fullText = false, toggle, pause, disabled = false, playLabel = '再生', showProgress = true, multiline = false }: {
  fullscreen: ReturnType<typeof useFullscreenReader>; playing: boolean; children: ReactNode; seek: ReactNode; speed: ReactNode; modes: ReactNode; displayControls?: ReactNode;
  toggle: () => void; pause: () => void; disabled?: boolean; playLabel?: string; showProgress?: boolean; multiline?: boolean;
  fullText?: boolean; readingControls?: ReactNode; displaySettings?: ReactNode; position?: ReactNode;
}) {
  const footerRef = useRef<HTMLDivElement>(null);
  const compact = useMediaQuery('(max-width: 600px), (max-width: 950px) and (max-height: 520px)');
  const wide = useMediaQuery('(min-width: 951px)');
  const desktopReader = fullscreen.active && wide;
  useNormalReaderHeight(fullscreen.containerRef, fullscreen.active);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOverlayOpen, setGuideOverlayOpen] = useState(false);
  const sheetOpen = fullscreen.active && (compact || desktopReader) && settingsOpen;
  useEffect(() => { setSettingsOpen(false); }, [fullscreen.active, compact, desktopReader]);
  const settings = <div className="fullscreen-settings-grid"><div className="fullscreen-speed-control">{speed}</div>{displayControls}</div>;
  useEffect(() => {
    const element = fullscreen.containerRef.current; const footer = footerRef.current;
    if (!fullscreen.active || !element || !footer) return;
    const selector = '.guide-viewport, .phrase-container, .display-set-viewport';
    let surface = element.querySelector<HTMLElement>(selector);
    const measure = () => {
      element.style.setProperty('--fullscreen-footer-height', `${footer.getBoundingClientRect().height}px`);
      if (surface) {
        const bounds = surface.getBoundingClientRect();
        element.style.setProperty('--fullscreen-play-top', `${bounds.top - element.getBoundingClientRect().top + bounds.height / 2}px`);
      } else element.style.removeProperty('--fullscreen-play-top');
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(footer); if (surface) observer.observe(surface);
    const mutations = new MutationObserver(() => {
      if (surface && element.contains(surface) && surface.matches(selector)) return;
      const next = element.querySelector<HTMLElement>(selector);
      if (next === surface) return;
      if (surface) observer.unobserve(surface);
      surface = next;
      if (surface) observer.observe(surface);
      measure();
    });
    mutations.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => { mutations.disconnect(); observer.disconnect(); element.style.removeProperty('--fullscreen-footer-height'); element.style.removeProperty('--fullscreen-play-top'); };
  }, [fullscreen.active, fullscreen.containerRef]);
  return <FullscreenReaderContext.Provider value={{ desktop: desktopReader, setOverlayOpen: setGuideOverlayOpen }}><div ref={fullscreen.containerRef} className="fullscreen-reader" data-fullscreen={fullscreen.active} data-playing={playing} data-desktop-reader={desktopReader} data-desktop-guide={desktopReader && fullText} data-settings-open={sheetOpen || guideOverlayOpen} tabIndex={-1} role={fullscreen.active ? 'region' : undefined} aria-label={fullscreen.active ? '全画面の読書' : undefined}
    onClick={event => {
      if (multiline || !fullscreen.active || !playing || !(event.target instanceof HTMLElement) || !event.target.closest('.reader-stage, .audio-stage') || event.target.closest('button, input, select, textarea, a, [role="dialog"], [role="menu"]')) return;
      pause(); fullscreen.containerRef.current?.focus({ preventScroll: true });
    }}>
    {fullscreen.active && <div className="fullscreen-mode-controls" hidden={playing}>{modes}</div>}
    {children}
    {fullscreen.active && <div ref={footerRef} className="fullscreen-footer">
      {!compact && !desktopReader && <div className="fullscreen-display-controls" hidden={playing} inert={playing}>{settings}</div>}
      <div className="fullscreen-seek" hidden={!showProgress} inert={!showProgress}>{desktopReader && <span className="fullscreen-position-value">{position}</span>}{seek}</div>
      <div className="fullscreen-actions">
        {desktopReader && <><Button className="fullscreen-reading-settings" variant="default" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => { pause(); setSettingsOpen(true); }}>表示設定</Button><div className="fullscreen-reading-speed">{speed}</div></>}
        {compact && <button type="button" className="fullscreen-settings-toggle" aria-label="読書設定を開く" title="読書設定" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => { pause(); setSettingsOpen(true); }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="8" cy="7" r="3" fill="var(--panel)" /><circle cx="16" cy="17" r="3" fill="var(--panel)" /></svg>
        </button>}
        <Button disabled={disabled} onClick={() => { toggle(); fullscreen.containerRef.current?.focus({ preventScroll: true }); }} aria-keyshortcuts="Space">{playing ? '一時停止' : playLabel}</Button>
        {desktopReader && readingControls}
        <button type="button" className="fullscreen-enter" aria-label="全画面を終了" title="全画面を終了" onClick={fullscreen.exit}><FullscreenIcon exiting /></button>
      </div>
    </div>}
    {fullscreen.active && (compact || desktopReader) && <Drawer className={`fullscreen-settings reader-drawer ${desktopReader ? 'fullscreen-reading-settings-drawer' : ''}`} opened={sheetOpen} onClose={() => setSettingsOpen(false)} title={desktopReader ? '表示設定' : '読書設定'} position={desktopReader ? 'right' : 'bottom'} size={desktopReader ? 'md' : 'auto'} withinPortal={false} overlayProps={{ backgroundOpacity: 0 }} zIndex={400} closeButtonProps={{ 'aria-label': '設定を閉じる' }}>{desktopReader ? displaySettings : settings}</Drawer>}
  </div></FullscreenReaderContext.Provider>;
}
