import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { MULTILINE_SPACING, type ReaderSettings, type SourceAnchor, type WritingMode } from '../model';
import { planPreviousTextPage, planTextPage, type ReadingMarker } from '../display-sets';
import { displayFlow, displaySet, flowOffset, previousDisplayFlow, setContains, sourceSlices, type DisplayFlow, type DisplaySet, type SetSource } from '../display-flow';
import { shortcutBlocked, repeatedArrowAllowed } from '../shortcuts';
import { RubyText } from './ReadingText';
import { appendReadingText } from './reading-typography';
import './display-sets.css';

export interface DisplaySetSession {
  position: () => SourceAnchor | undefined;
  source: (position: SourceAnchor) => SetSource | undefined;
  seek: (position: SourceAnchor) => boolean;
  before: (position: SourceAnchor) => SourceAnchor | undefined;
  marker?: () => ReadingMarker | undefined;
  subscribe?: (listener: () => void) => () => void;
  sourceVersion?: unknown;
}
interface Layout { set: DisplaySet; flow: DisplayFlow; start: number; end: number; revision: string; fontSize: number; sourceVersion?: unknown; before?: SourceAnchor }

/** Clocks own source position; measured pages own only layout and reversible source mappings. */
export function DisplaySetReader({ session, lines, fontSize, family, ruby, writingMode = 'horizontal-tb', playing, disabled = false, highlightColor = 'blue', highlightIntensity = 'normal', multilineSpacing = 'normal' }: {
  session: DisplaySetSession; lines: number; fontSize: number; family: string; ruby: boolean; writingMode?: WritingMode; playing: boolean; disabled?: boolean;
  highlightColor?: ReaderSettings['highlightColor']; highlightIntensity?: ReaderSettings['highlightIntensity'];
  multilineSpacing?: ReaderSettings['multilineSpacing'];
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const clock = useRef(session); clock.current = session;
  const blocked = useRef(disabled); blocked.current = disabled;
  const current = useRef<Layout | undefined>(undefined);
  const [layout, setLayout] = useState<Layout>();
  const [marker, setMarker] = useState<ReadingMarker>();
  const painted = useRef<ReadingMarker | undefined>(undefined);
  const vertical = writingMode === 'vertical-rl';
  const lineHeight = MULTILINE_SPACING[multilineSpacing];
  const gesture = useRef<{ id: string; x: number; y: number; time: number; valid: boolean } | undefined>(undefined);
  const refresh = useRef<() => void>(() => {});
  const navigate = useRef<(direction: -1 | 1) => void>(() => {});
  const arrowAt = useRef(0);
  useLayoutEffect(() => {
    const slot = viewport.current;
    if (!slot) return;
    const probe = document.createElement('div');
    probe.className = 'display-set-text'; probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;font-family:${family};writing-mode:${writingMode};line-height:${lineHeight};max-width:none;`;
    document.body.append(probe);
    const plan = (navigation?: { position: SourceAnchor; end?: SourceAnchor }) => {
      const position = navigation?.position ?? clock.current.position();
      if (!position || slot.clientWidth <= 0 || slot.clientHeight <= 0) return;
      const revision = `${slot.clientWidth}:${slot.clientHeight}:${lines}:${fontSize}:${family}:${ruby}:${writingMode}:${lineHeight}`;
      const previous = current.current;
      if (!navigation && previous?.revision === revision && setContains(previous.set, position)) {
        if (previous.sourceVersion !== clock.current.sourceVersion) {
          // New audio enables navigation without replacing the page currently being read.
          const last = previous.set.ranges.at(-1)!;
          const available = clock.current.source({ blockId: last.blockId, offset: last.start });
          const next = available && available.end >= last.end
            ? available.end > last.end ? { blockId: last.blockId, offset: last.end } : available.next
            : undefined;
          current.current = { ...previous, set: { ...previous.set, next }, before: clock.current.before({ blockId: previous.set.ranges[0].blockId, offset: previous.set.ranges[0].start }), sourceVersion: clock.current.sourceVersion };
          setLayout(current.current);
        }
        return;
      }
      const source = (anchor: SourceAnchor) => {
        const value = clock.current.source(anchor);
        return navigation && value && anchor.blockId === position.blockId ? { ...value, start: Math.max(value.start, position.offset) } : value;
      };
      let flow = navigation?.end ? previousDisplayFlow(source, position, navigation.end) : displayFlow(source, position);
      if (!flow) return;
      const next = previous?.revision === revision ? previous.set.next : undefined;
      let start = 0;
      if (!navigation && next) {
        const continuation = displayFlow(clock.current.source, next);
        const from = continuation && flowOffset(continuation, next);
        const cursor = continuation && flowOffset(continuation, position);
        if (continuation && from !== undefined && cursor !== undefined && cursor >= from) {
          // Whole cue/unit ranges can also contain a backward seek before this continuation.
          flow = continuation; start = from;
        }
      }
      probe.style.width = vertical ? 'max-content' : `${slot.clientWidth}px`;
      probe.style.height = vertical ? `${slot.clientHeight}px` : 'max-content';
      const extent = vertical ? slot.clientWidth : slot.clientHeight;
      let effectiveSize = Math.min(fontSize, Math.floor(extent / (lines * lineHeight + (ruby ? .4 : 0)) * 4) / 4);
      effectiveSize = Math.max(8, effectiveSize);
      const measure = (range: { start: number; end: number }) => {
        probe.style.fontSize = `${effectiveSize}px`;
        appendReadingText(probe, { text: flow.text.slice(range.start, range.end), ruby: flow.ruby.filter(span => span.start >= range.start && span.end <= range.end).map(span => ({ ...span, start: span.start - range.start, end: span.end - range.start })) }, ruby, vertical);
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
      const backwardEnd = navigation?.end ? flowOffset(flow, navigation.end) ?? flow.text.length : undefined;
      const pageAt = (offset: number) => backwardEnd !== undefined
        ? planPreviousTextPage(flow, backwardEnd, flow.boundaries, measure, lines)
        : planTextPage(flow, offset, flow.text.length, flow.boundaries, measure, lines);
      let page = pageAt(start);
      const cursor = flowOffset(flow, position);
      for (let i = 0; backwardEnd === undefined && i < 64 && cursor !== undefined && cursor >= page.end && page.end < flow.text.length; i++) {
        start = page.end; page = pageAt(start);
      }
      // Row selection precedes physical fit, so height cannot silently reduce the requested amount.
      while ((!page.fits || !measure(page).inside) && effectiveSize > 8) {
        effectiveSize = Math.max(8, effectiveSize - 1); page = pageAt(start);
      }
      const set = displaySet(flow, page);
      const first = set.ranges[0];
      if (navigation && (!first || !clock.current.seek({ blockId: first.blockId, offset: first.start }))) return;
      current.current = { set, flow, start: page.start, end: page.end, revision, fontSize: effectiveSize, sourceVersion: clock.current.sourceVersion, before: first && clock.current.before({ blockId: first.blockId, offset: first.start }) };
      setLayout(current.current);
      slot.scrollTop = 0; slot.scrollLeft = 0;
    };
    navigate.current = direction => {
      if (blocked.current) return;
      const set = current.current?.set; const first = set?.ranges[0];
      if (!set || !first) return;
      const end = { blockId: first.blockId, offset: first.start };
      const target = direction === -1 ? clock.current.before(end) : set.next;
      if (target) plan({ position: target, end: direction === -1 ? end : undefined });
    };
    refresh.current = () => {
      plan();
      const next = clock.current.marker?.(); const previous = painted.current;
      if (next?.blockId !== previous?.blockId || next?.start !== previous?.start || next?.end !== previous?.end || next?.precision !== previous?.precision) {
        painted.current = next; setMarker(next);
      }
    };
    refresh.current();
    const observer = new ResizeObserver(() => plan()); observer.observe(slot);
    return () => { observer.disconnect(); probe.remove(); refresh.current = () => {}; navigate.current = () => {}; };
  }, [lines, fontSize, family, ruby, writingMode, vertical, lineHeight]);
  useLayoutEffect(() => refresh.current());
  const subscribe = session.subscribe;
  useEffect(() => {
    if (subscribe) return subscribe(() => refresh.current());
    if (!playing) return;
    let frame: number;
    const tick = () => { refresh.current(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, subscribe]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      const button = target instanceof HTMLButtonElement && target.matches('.display-set-nav') && target.parentElement === viewport.current?.parentElement ? target : undefined;
      if (blocked.current || shortcutBlocked(event, button) || (event.code !== 'ArrowUp' && event.code !== 'ArrowDown')) return;
      event.preventDefault();
      if (repeatedArrowAllowed(event, arrowAt)) navigate.current(event.code === 'ArrowUp' ? -1 : 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const set = layout?.set;
  const before = layout?.before;
  const slices = layout ? sourceSlices(layout.flow, layout) : [];
  return <div className="display-set-reader" data-testid="display-set-reader" data-writing-mode={writingMode} style={{
    '--reading-font': family,
    '--display-line-height': lineHeight,
    '--reading-highlight-color': highlightColor === 'yellow' ? '#f2c94c' : 'var(--mantine-primary-color-filled,#d09b46)',
    '--reading-highlight-intensity': `${{ light: 10, normal: 28, strong: 42 }[highlightIntensity]}%`,
  } as CSSProperties}>
    <div ref={viewport} className="display-set-viewport" aria-label="本文">
      <div className="display-set-text" data-testid="display-set-text" data-block-id={set?.ranges[0]?.blockId} data-source-start={set?.ranges[0]?.start} data-source-end={set?.ranges.at(-1)?.end} data-source-ranges={JSON.stringify(set?.ranges)} data-lines={set?.lines} data-set-id={set?.id} style={{ fontSize: layout?.fontSize ?? fontSize, fontFamily: family, writingMode }}>
        {slices.map((slice, index) => <Fragment key={`${slice.blockId}:${slice.start}`}>{index > 0 && '\n'}<RubyText unit={slice} show={ruby} vertical={vertical} marker={marker} layoutKey={`${layout?.revision}:${layout?.fontSize}`} /></Fragment>)}
      </div>
    </div>
    {([-1, 1] as const).map(direction => <button key={direction} type="button" className={`display-set-nav ${direction === -1 ? 'display-set-previous' : 'display-set-next'}`} aria-label={direction === -1 ? '前へ' : '次へ'} aria-keyshortcuts={direction === -1 ? 'ArrowUp' : 'ArrowDown'} title={direction === -1 ? '前の本文へ（↑）' : '次の本文へ（↓）'} disabled={disabled || (direction === -1 ? !before : !set?.next)}
      onPointerDown={event => { gesture.current = { id: set?.id ?? '', x: event.clientX, y: event.clientY, time: performance.now(), valid: event.isPrimary && event.button === 0 }; }}
      onPointerMove={event => { const value = gesture.current; if (value && Math.hypot(event.clientX - value.x, event.clientY - value.y) > 8) value.valid = false; }}
      onPointerCancel={() => { if (gesture.current) gesture.current.valid = false; }}
      onClick={event => {
        const value = gesture.current; gesture.current = undefined;
        if (event.detail > 0 && (!value?.valid || value.id !== current.current?.set.id || performance.now() - value.time > 500 || window.getSelection()?.toString())) return;
        navigate.current(direction);
      }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={vertical ? direction === -1 ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6' : direction === -1 ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg></button>)}
  </div>;
}
