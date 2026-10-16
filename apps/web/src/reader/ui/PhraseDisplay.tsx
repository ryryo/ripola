import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReadingUnit, WritingMode } from '../model';
import { phrasePageAt, planPhrasePages, type PhrasePage } from '../phrase-layout';
import { PhraseFrame } from './PhraseFrame';

import { RubyText } from './ReadingText';
export { RubyText } from './ReadingText';

/** Measure the actual whole phrase and ruby. This does not choose a fixation character. */
export function PhraseDisplay({ unit, sourceUnits, activeUnit, getProgress, playing = false, fontSize, ruby, family, audio = false, precision = 'phrase', unitIds, timingMethod, timingScore, writingMode = 'horizontal-tb' }: {
  unit?: ReadingUnit; fontSize: number; ruby: boolean; family: string; audio?: boolean; precision?: string; unitIds?: string; timingMethod?: string; timingScore?: number; writingMode?: WritingMode;
  sourceUnits?: readonly ReadingUnit[]; activeUnit?: ReadingUnit; getProgress?: () => number; playing?: boolean;
}) {
  const vertical = writingMode === 'vertical-rl';
  const container = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ unit: ReadingUnit; pages: PhrasePage[] }>();
  const [pageIndex, setPageIndex] = useState(0);
  const pages = layout?.unit === unit ? layout?.pages : undefined;
  const clock = useRef({ activeUnit, getProgress });
  clock.current = { activeUnit, getProgress };
  const selectPage = () => setPageIndex(phrasePageAt(pages ?? [], clock.current.activeUnit, clock.current.getProgress?.() ?? 0));
  useLayoutEffect(selectPage);
  useEffect(() => {
    if (!playing || !pages || pages.length < 2) return;
    let frame: number;
    const tick = () => { setPageIndex(phrasePageAt(pages, clock.current.activeUnit, clock.current.getProgress?.() ?? 0)); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, pages]);
  useLayoutEffect(() => {
    const frame = container.current; const element = text.current;
    const slot = frame?.querySelector<HTMLElement>(':scope > .phrase-slot');
    if (!frame || !element || !slot || !unit) return;
    let measuredKey = '';
    const fit = () => {
      const availableWidth = slot.clientWidth;
      const availableHeight = slot.clientHeight;
      const style = getComputedStyle(frame);
      const guides = [...frame.querySelectorAll<HTMLElement>(':scope > .guide')];
      const guideSize = guides.reduce((size, guide) => size + (vertical ? guide.offsetWidth : guide.offsetHeight), 0);
      const gap = parseFloat(vertical ? style.columnGap : style.rowGap) || 0;
      const expandedWidth = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (vertical ? guideSize + gap * 2 : 0);
      const expandedHeight = frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (vertical ? 0 : guideSize + gap * 2);
      const desired = Math.min(fontSize, window.innerWidth <= 600 ? window.innerWidth * .11 : window.innerHeight <= 520 ? 36 : fontSize);
      const key = `${availableWidth}:${availableHeight}:${expandedWidth}:${expandedHeight}:${desired}`;
      if (availableWidth <= 0 || availableHeight <= 0 || key === measuredKey) return;
      measuredKey = key;
      // Measure a zero-layout, clipped clone. Mobile CSS uses !important and a
      // fitted-size variable: mutating the live phrase measured its previous size
      // and let ResizeObserver alternate sizes while also moving scroll anchors.
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;overflow:hidden;visibility:hidden;contain:strict;pointer-events:none';
      const probe = element.cloneNode(true) as HTMLDivElement;
      probe.removeAttribute('data-testid');
      for (const child of probe.querySelectorAll('[data-testid]')) child.removeAttribute('data-testid');
      probe.style.setProperty('font-size', `${desired}px`, 'important');
      probe.style.setProperty('width', 'max-content');
      probe.style.setProperty('height', 'max-content');
      probe.style.writingMode = writingMode;
      const actual = getComputedStyle(element);
      // Preserve contextual letter spacing when the clone is outside the reader.
      const spacing = parseFloat(actual.letterSpacing);
      const actualSize = parseFloat(actual.fontSize);
      if (Number.isFinite(spacing) && actualSize > 0) probe.style.letterSpacing = `${spacing / actualSize}em`;
      const lineHeight = parseFloat(actual.lineHeight);
      if (Number.isFinite(lineHeight) && actualSize > 0) probe.style.lineHeight = String(lineHeight / actualSize);
      host.append(probe); document.body.append(host);
      try {
        const planned = planPhrasePages(unit, sourceUnits ?? [unit], desired, (value, size, wrap) => {
          const width = wrap ? expandedWidth : availableWidth;
          const height = wrap ? expandedHeight : availableHeight;
          probe.replaceChildren();
          let offset = 0;
          for (const span of ruby ? value.ruby : []) {
            probe.append(document.createTextNode(value.text.slice(offset, span.start)));
            const annotation = document.createElement('ruby');
            annotation.append(document.createTextNode(value.text.slice(span.start, span.end)));
            const reading = document.createElement('rt'); reading.textContent = span.reading;
            annotation.append(reading); probe.append(annotation); offset = span.end;
          }
          probe.append(document.createTextNode(value.text.slice(offset)));
          probe.style.setProperty('font-size', `${size}px`, 'important');
          probe.style.setProperty('white-space', wrap ? 'pre-wrap' : 'nowrap', 'important');
          probe.style.setProperty('max-width', wrap && !vertical ? `${width}px` : 'none');
          probe.style.setProperty('max-height', wrap && vertical ? `${height}px` : 'none');
          const range = document.createRange(); range.selectNodeContents(probe);
          const glyphs = range.getBoundingClientRect(); const bounds = probe.getBoundingClientRect();
          return Math.max(glyphs.width, bounds.width) <= width + .5 && Math.max(glyphs.height, bounds.height) <= height + .5;
        });
        setLayout({ unit, pages: planned });
      } finally { host.remove(); }
    };
    fit();
    // Refit when either axis changes, including fullscreen and wrapped controls.
    const observer = new ResizeObserver(fit); observer.observe(slot); observer.observe(frame);
    return () => observer.disconnect();
  }, [unit, sourceUnits, fontSize, ruby, family, vertical, writingMode]);
  const page = pages?.[Math.min(pageIndex, pages.length - 1)];
  const visible = page?.unit ?? unit;
  const estimated = audio && activeUnit && visible && (visible.start > activeUnit.start || visible.end < activeUnit.end);
  const visibleIds = page && sourceUnits ? sourceUnits.filter(value => value.start < page.unit.end && value.end > page.unit.start).map(value => value.id).join(' ') : unitIds ?? unit?.id;
  return <PhraseFrame containerRef={container} vertical={vertical} expanded={pages?.some(page => page.wrapped)}><div ref={text} className={audio ? 'phrase audio-sentence' : 'phrase'}
    style={{ fontSize: `${page?.fontSize ?? fontSize}px`, '--phrase-size': `${page?.fontSize ?? fontSize}px`, fontFamily: family, fontWeight: 400, writingMode } as CSSProperties}
    data-testid={audio ? 'audio-sentence' : 'current-phrase'} data-precision={audio ? precision : undefined} data-method={estimated ? 'estimated' : timingMethod} data-score={estimated ? undefined : timingScore}
    data-source-start={visible?.start} data-source-end={visible?.end} data-pages={pages?.length ?? 1} aria-live="off">
    {audio ? <span data-testid="audio-phrase" data-unit-id={visibleIds}><RubyText unit={visible} show={ruby} /></span> : <RubyText unit={visible} show={ruby} />}
  </div></PhraseFrame>;
}
