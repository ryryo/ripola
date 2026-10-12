import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ReadingUnit, WritingMode } from '../model';
import { PhraseFrame } from './PhraseFrame';

export function RubyText({ unit, show }: { unit?: Pick<ReadingUnit, 'text' | 'ruby'>; show: boolean }) {
  if (!unit) return null;
  if (!show || !unit.ruby.length) return <>{unit.text}</>;
  let offset = 0;
  const pieces: ReactNode[] = [];
  for (const span of unit.ruby) {
    if (span.start > offset) pieces.push(unit.text.slice(offset, span.start));
    pieces.push(<ruby key={`${span.start}-${span.end}`}>{unit.text.slice(span.start, span.end)}<rt>{span.reading}</rt></ruby>);
    offset = span.end;
  }
  pieces.push(unit.text.slice(offset));
  return <>{pieces}</>;
}

/** Measure the actual whole phrase and ruby. This does not choose a fixation character. */
export function PhraseDisplay({ unit, fontSize, ruby, family, audio = false, precision = 'phrase', unitIds, timingMethod, timingScore, writingMode = 'horizontal-tb' }: {
  unit?: ReadingUnit; fontSize: number; ruby: boolean; family: string; audio?: boolean; precision?: string; unitIds?: string; timingMethod?: string; timingScore?: number; writingMode?: WritingMode;
}) {
  const vertical = writingMode === 'vertical-rl';
  const container = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState(fontSize);
  useLayoutEffect(() => {
    const frame = container.current; const element = text.current;
    if (!frame || !element || !unit) return;
    let measuredKey = '';
    const fit = () => {
      const style = getComputedStyle(frame);
      const guides = [...frame.querySelectorAll<HTMLElement>(':scope > .guide')];
      const guideSize = guides.reduce((size, guide) => size + (vertical ? guide.offsetWidth : guide.offsetHeight), 0);
      const gap = parseFloat(vertical ? style.columnGap : style.rowGap) || 0;
      const availableWidth = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (vertical ? guideSize + gap * 2 : 0);
      const availableHeight = frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (vertical ? 0 : guideSize + gap * 2);
      const desired = Math.min(fontSize, window.innerWidth <= 600 ? window.innerWidth * .11 : window.innerHeight <= 520 ? 36 : fontSize);
      const key = `${availableWidth}:${availableHeight}:${desired}`;
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
      probe.style.setProperty('white-space', 'pre-wrap', 'important');
      probe.style.setProperty('width', 'max-content');
      probe.style.setProperty('max-width', vertical ? 'none' : `${availableWidth}px`);
      probe.style.setProperty('height', 'max-content');
      probe.style.setProperty('max-height', vertical ? `${availableHeight}px` : 'none');
      probe.style.writingMode = writingMode;
      const actual = getComputedStyle(element);
      // Preserve contextual letter spacing when the clone is outside the reader.
      const spacing = parseFloat(actual.letterSpacing);
      const actualSize = parseFloat(actual.fontSize);
      if (Number.isFinite(spacing) && actualSize > 0) probe.style.letterSpacing = `${spacing / actualSize}em`;
      const lineHeight = parseFloat(actual.lineHeight);
      if (Number.isFinite(lineHeight) && actualSize > 0) probe.style.lineHeight = String(lineHeight / actualSize);
      host.append(probe); document.body.append(host);
      let next = 24;
      try {
        const range = document.createRange(); range.selectNodeContents(probe);
        let low = 24; let high = Math.max(24, Math.floor(desired));
        while (low <= high) {
          const size = Math.floor((low + high) / 2);
          probe.style.setProperty('font-size', `${size}px`, 'important');
          const glyphs = range.getBoundingClientRect(); const bounds = probe.getBoundingClientRect();
          if (Math.max(glyphs.width, bounds.width) <= availableWidth + .5 && Math.max(glyphs.height, bounds.height) <= availableHeight + .5) { next = size; low = size + 1; }
          else high = size - 1;
        }
      } finally { host.remove(); }
      setFitted(previous => previous === next ? previous : next);
    };
    fit();
    // Refit when either axis changes, including fullscreen and wrapped controls.
    const observer = new ResizeObserver(fit); observer.observe(frame);
    return () => observer.disconnect();
  }, [unit, fontSize, ruby, family, vertical, writingMode]);
  return <PhraseFrame containerRef={container} vertical={vertical}><div ref={text} className={audio ? 'phrase audio-sentence' : 'phrase'}
    style={{ fontSize: `${fitted}px`, '--phrase-size': `${fitted}px`, fontFamily: family, fontWeight: 400, writingMode } as CSSProperties}
    data-testid={audio ? 'audio-sentence' : 'current-phrase'} data-precision={audio ? precision : undefined} data-method={timingMethod} data-score={timingScore} aria-live="off">
    {audio ? <span data-testid="audio-phrase" data-unit-id={unitIds ?? unit?.id}><RubyText unit={unit} show={ruby} /></span> : <RubyText unit={unit} show={ruby} />}
  </div></PhraseFrame>;
}
