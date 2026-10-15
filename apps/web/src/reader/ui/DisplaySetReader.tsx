import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { SourceAnchor, WritingMode } from '../model';
import { planTextPage, type ReadingMarker } from '../display-sets';
import { displayFlow, displaySet, flowOffset, setContains, sourceSlices, type DisplayFlow, type DisplaySet, type SetSource } from '../display-flow';
import { RubyText } from './ReadingText';
import './display-sets.css';

export interface DisplaySetSession {
  position: () => SourceAnchor | undefined;
  source: (position: SourceAnchor) => SetSource | undefined;
  seek: (position: SourceAnchor) => void;
  marker?: ReadingMarker;
  sourceVersion?: unknown;
}
interface Layout { set: DisplaySet; flow: DisplayFlow; start: number; end: number; revision: string; fontSize: number; sourceVersion?: unknown }

/** Clocks own source position; measured pages own only layout and reversible source mappings. */
export function DisplaySetReader({ session, lines, fontSize, family, ruby, writingMode = 'horizontal-tb', playing }: {
  session: DisplaySetSession; lines: number; fontSize: number; family: string; ruby: boolean; writingMode?: WritingMode; playing: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const clock = useRef(session); clock.current = session;
  const current = useRef<Layout | undefined>(undefined);
  const [layout, setLayout] = useState<Layout>();
  const vertical = writingMode === 'vertical-rl';
  const gesture = useRef<{ id: string; x: number; y: number; time: number; valid: boolean } | undefined>(undefined);
  const refresh = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const slot = viewport.current;
    if (!slot) return;
    const probe = document.createElement('div');
    probe.className = 'display-set-text'; probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;font-family:${family};writing-mode:${writingMode};max-width:none;`;
    document.body.append(probe);
    const plan = () => {
      const position = clock.current.position();
      if (!position || slot.clientWidth <= 0 || slot.clientHeight <= 0) return;
      const revision = `${slot.clientWidth}:${slot.clientHeight}:${lines}:${fontSize}:${family}:${ruby}:${writingMode}`;
      const previous = current.current;
      if (previous?.revision === revision && setContains(previous.set, position)) {
        if (previous.sourceVersion !== clock.current.sourceVersion) {
          // New audio enables navigation without replacing the page currently being read.
          const last = previous.set.ranges.at(-1)!;
          const available = clock.current.source({ blockId: last.blockId, offset: last.start });
          const next = available && available.end >= last.end
            ? available.end > last.end ? { blockId: last.blockId, offset: last.end } : available.next
            : undefined;
          current.current = { ...previous, set: { ...previous.set, next }, sourceVersion: clock.current.sourceVersion };
          setLayout(current.current);
        }
        return;
      }
      let flow = displayFlow(clock.current.source, position);
      if (!flow) return;
      const next = previous?.revision === revision ? previous.set.next : undefined;
      if (next) {
        const continuation = displayFlow(clock.current.source, next);
        if (continuation && flowOffset(continuation, position) !== undefined) {
          // Drivers return whole cue/unit ranges: trim only layout, never timed units.
          flow = continuation;
        }
      }
      let start = next && flowOffset(flow, next) !== undefined && flowOffset(flow, position) !== undefined ? flowOffset(flow, next)! : 0;
      probe.style.width = vertical ? 'max-content' : `${slot.clientWidth}px`;
      probe.style.height = vertical ? `${slot.clientHeight}px` : 'max-content';
      const extent = vertical ? slot.clientWidth : slot.clientHeight;
      let effectiveSize = Math.min(fontSize, Math.floor(extent / (lines * 1.6 + (ruby ? .4 : 0)) * 4) / 4);
      effectiveSize = Math.max(8, effectiveSize);
      const measure = (range: { start: number; end: number }) => {
        probe.style.fontSize = `${effectiveSize}px`;
        probe.replaceChildren();
        let offset = range.start;
        for (const span of ruby ? flow.ruby : []) {
          if (span.start < range.start || span.end > range.end) continue;
          probe.append(document.createTextNode(flow.text.slice(offset, span.start)));
          const base = document.createElement('ruby');
          base.append(document.createTextNode(flow.text.slice(span.start, span.end)));
          const rt = document.createElement('rt'); rt.textContent = span.reading; base.append(rt); probe.append(base); offset = span.end;
        }
        probe.append(document.createTextNode(flow.text.slice(offset, range.end)));
        const bands: number[] = [];
        const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest('rt')) continue;
          const textRange = document.createRange(); textRange.selectNodeContents(node);
          for (const rect of textRange.getClientRects()) {
            if (rect.width < .1 || rect.height < .1) continue;
            const value = vertical ? rect.right : rect.top;
            if (!bands.some(existing => Math.abs(existing - value) < effectiveSize * .6)) bands.push(value);
          }
        }
        const glyphRange = document.createRange(); glyphRange.selectNodeContents(probe);
        const bounds = probe.getBoundingClientRect(); const glyphs = glyphRange.getBoundingClientRect();
        return { lines: bands.length, fits: bands.length <= lines,
          inside: Math.max(bounds.width, glyphs.width) <= slot.clientWidth + .5 && Math.max(bounds.height, glyphs.height) <= slot.clientHeight + .5 };
      };
      const pageAt = (offset: number) => planTextPage(flow, offset, flow.text.length, flow.boundaries, measure, lines);
      let page = pageAt(start);
      const cursor = flowOffset(flow, position);
      for (let i = 0; i < 64 && cursor !== undefined && cursor >= page.end && page.end < flow.text.length; i++) {
        start = page.end; page = pageAt(start);
      }
      // Row selection precedes physical fit, so height cannot silently reduce the requested amount.
      while ((!page.fits || !measure(page).inside) && effectiveSize > 8) {
        effectiveSize = Math.max(8, effectiveSize - 1); page = pageAt(start);
      }
      const set = displaySet(flow, page);
      current.current = { set, flow, start: page.start, end: page.end, revision, fontSize: effectiveSize, sourceVersion: clock.current.sourceVersion };
      setLayout(current.current);
      slot.scrollTop = 0; slot.scrollLeft = 0;
    };
    refresh.current = plan;
    plan();
    const observer = new ResizeObserver(plan); observer.observe(slot);
    return () => { observer.disconnect(); probe.remove(); refresh.current = () => {}; };
  }, [lines, fontSize, family, ruby, writingMode, vertical]);
  useLayoutEffect(() => refresh.current());
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const tick = () => { refresh.current(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const set = layout?.set;
  const slices = layout ? sourceSlices(layout.flow, layout) : [];
  return <div className="display-set-reader" data-testid="display-set-reader" data-writing-mode={writingMode} style={{ '--reading-font': family } as CSSProperties}>
    <div ref={viewport} className="display-set-viewport" aria-label="本文">
      <div className="display-set-text" data-testid="display-set-text" data-block-id={set?.ranges[0]?.blockId} data-source-start={set?.ranges[0]?.start} data-source-end={set?.ranges.at(-1)?.end} data-source-ranges={JSON.stringify(set?.ranges)} data-lines={set?.lines} data-set-id={set?.id} style={{ fontSize: layout?.fontSize ?? fontSize, fontFamily: family, writingMode }}>
        {slices.map((slice, index) => <Fragment key={`${slice.blockId}:${slice.start}`}>{index > 0 && '\n'}<RubyText unit={slice} show={ruby} marker={session.marker} /></Fragment>)}
      </div>
    </div>
    <button type="button" className="display-set-next" aria-label="次へ" title="次の本文へ" disabled={!set?.next}
      onPointerDown={event => { gesture.current = { id: set?.id ?? '', x: event.clientX, y: event.clientY, time: performance.now(), valid: event.isPrimary && event.button === 0 }; }}
      onPointerMove={event => { const value = gesture.current; if (value && Math.hypot(event.clientX - value.x, event.clientY - value.y) > 8) value.valid = false; }}
      onPointerCancel={() => { if (gesture.current) gesture.current.valid = false; }}
      onClick={event => {
        const value = gesture.current; gesture.current = undefined;
        if (event.detail > 0 && (!value?.valid || value.id !== current.current?.set.id || performance.now() - value.time > 500 || window.getSelection()?.toString())) return;
        const target = current.current?.set.next;
        if (target) clock.current.seek(target);
      }}><span>次へ</span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={vertical ? 'M15 6l-6 6 6 6' : 'M6 9l6 6 6-6'} /></svg></button>
  </div>;
}
