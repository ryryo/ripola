import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ReadingUnit, WritingMode } from '../model';
import { PhraseFrame } from './PhraseFrame';

export function RubyText({ unit, show }: { unit?: ReadingUnit; show: boolean }) {
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
export function PhraseDisplay({ unit, fontSize, ruby, family, audio = false, precision = 'phrase', unitIds, writingMode = 'horizontal-tb' }: {
  unit?: ReadingUnit; fontSize: number; ruby: boolean; family: string; audio?: boolean; precision?: string; unitIds?: string; writingMode?: WritingMode;
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
      const available = vertical
        ? frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        : frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const desired = Math.min(fontSize, window.innerWidth <= 600 ? window.innerWidth * .11 : window.innerHeight <= 520 ? 36 : fontSize);
      const key = `${available}:${desired}`;
      if (available <= 0 || key === measuredKey) return;
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
      probe.style.setProperty('white-space', 'nowrap', 'important');
      probe.style.setProperty('width', 'max-content');
      probe.style.setProperty('max-width', 'none');
      probe.style.setProperty('height', 'max-content');
      probe.style.setProperty('max-height', 'none');
      probe.style.writingMode = writingMode;
      const actual = getComputedStyle(element);
      // Preserve contextual letter spacing when the clone is outside the reader.
      const spacing = parseFloat(actual.letterSpacing);
      const actualSize = parseFloat(actual.fontSize);
      if (Number.isFinite(spacing) && actualSize > 0) probe.style.letterSpacing = `${spacing / actualSize}em`;
      host.append(probe); document.body.append(host);
      let width: number;
      try {
        const range = document.createRange(); range.selectNodeContents(probe);
        const bounds = range.getBoundingClientRect();
        width = vertical ? bounds.height : bounds.width;
      } finally { host.remove(); }
      const next = Math.max(24, Math.min(desired, Math.floor(desired * available / Math.max(1, width))));
      setFitted(previous => previous === next ? previous : next);
    };
    fit();
    // Refit when the available inline axis changes (height for vertical text).
    const observer = new ResizeObserver(fit); observer.observe(frame);
    return () => observer.disconnect();
  }, [unit, fontSize, ruby, family, vertical, writingMode]);
  return <PhraseFrame containerRef={container} vertical={vertical}><div ref={text} className={audio ? 'phrase audio-sentence' : 'phrase'}
    style={{ fontSize: `${fitted}px`, '--phrase-size': `${fitted}px`, fontFamily: family, fontWeight: 400, writingMode } as CSSProperties}
    data-testid={audio ? 'audio-sentence' : 'current-phrase'} data-precision={audio ? precision : undefined} aria-live="off">
    {audio ? <span data-testid="audio-phrase" data-unit-id={unitIds ?? unit?.id}><RubyText unit={unit} show={ruby} /></span> : <RubyText unit={unit} show={ruby} />}
  </div></PhraseFrame>;
}
