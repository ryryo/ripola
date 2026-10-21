import { useLayoutEffect, type RefObject } from 'react';

/** Fit the reading/transport group while preserving the established text height. */
export function useNormalReaderHeight(containerRef: RefObject<HTMLDivElement | null>, fullscreen: boolean) {
  useLayoutEffect(() => {
    const root = containerRef.current;
    const parent = root?.parentElement;
    const player = parent?.querySelector<HTMLElement>('.reader-player');
    const transport = player?.querySelector<HTMLElement>('.reader-player-main');
    if (fullscreen || !root || !parent || !player || !transport) return;
    const desktop = window.matchMedia('(min-width: 761px) and (min-height: 521px), (min-width: 951px)');
    let frame = 0;
    const clear = () => {
      root.style.removeProperty('--reader-normal-stage-height');
      delete root.dataset.normalFit;
      delete player.dataset.normalFit;
    };
    const measure = () => {
      if (!desktop.matches) { clear(); return; }
      root.dataset.normalFit = 'true';
      player.dataset.normalFit = 'true';
      const primaryHeight = transport.getBoundingClientRect().bottom - player.getBoundingClientRect().top;
      const gap = parseFloat(getComputedStyle(player).marginTop) || 0;
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      // The viewport budget belongs to the reading/transport group, not the
      // page heading. If space runs out, keep the text height and allow scroll.
      const available = Math.max(0, Math.floor(viewport - gap - primaryHeight - 8));
      const value = `max(calc(var(--reader-document-height) + var(--reader-normal-chrome-height)), ${available}px)`;
      if (root.style.getPropertyValue('--reader-normal-stage-height') !== value) root.style.setProperty('--reader-normal-stage-height', value);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(parent); observer.observe(player); observer.observe(transport);
    desktop.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    document.fonts.addEventListener('loadingdone', schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); clear();
      desktop.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      document.fonts.removeEventListener('loadingdone', schedule);
    };
  }, [containerRef, fullscreen]);
}
