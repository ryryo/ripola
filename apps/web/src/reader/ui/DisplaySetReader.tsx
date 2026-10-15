import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { SourceAnchor, TextBlock, WritingMode } from '../model';
import { containsPosition, planDisplaySet, type DisplaySet, type ReadingMarker, type SourceRange } from '../display-sets';
import { RubyText } from './ReadingText';
import './display-sets.css';

export interface SetSource { block: TextBlock; start: number; end: number; boundaries: readonly number[]; next?: SourceAnchor }
export interface DisplaySetSession {
  position: () => SourceAnchor | undefined;
  source: (position: SourceAnchor) => SetSource | undefined;
  seek: (position: SourceAnchor) => void;
  marker?: ReadingMarker;
  sourceVersion?: unknown;
}

/** The original clocks own position; this component owns only the current measured source range. */
export function DisplaySetReader({ session, lines, fontSize, family, ruby, writingMode = 'horizontal-tb', playing }: {
  session: DisplaySetSession; lines: number; fontSize: number; family: string; ruby: boolean; writingMode?: WritingMode; playing: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const clock = useRef(session); clock.current = session;
  const current = useRef<{ set: DisplaySet; block: TextBlock; revision: string; fontSize: number; sourceVersion?: unknown } | undefined>(undefined);
  const [layout, setLayout] = useState<typeof current.current>();
  const vertical = writingMode === 'vertical-rl';
  const gesture = useRef<{ id: string; x: number; y: number; time: number; valid: boolean } | undefined>(undefined);
  const refresh = useRef<(force?: boolean) => void>(() => {});
  useLayoutEffect(() => {
    const slot = viewport.current;
    if (!slot) return;
    const probe = document.createElement('div');
    probe.className = 'display-set-text'; probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;font-family:${family};font-size:${fontSize}px;writing-mode:${writingMode};`;
    document.body.append(probe);
    const plan = (force = false) => {
      const position = clock.current.position();
      if (!position || slot.clientWidth <= 0 || slot.clientHeight <= 0) return;
      let effectiveSize = fontSize;
      const revision = `${slot.clientWidth}:${slot.clientHeight}:${lines}:${fontSize}:${family}:${ruby}:${writingMode}`;
      const previous = current.current;
      if (!force && previous?.revision === revision && containsPosition(previous.set, position)) {
        if (previous.sourceVersion !== clock.current.sourceVersion) {
          // Newly arrived audio may enable the successor; never reflow the current text.
          const available = clock.current.source(position);
          const next = available && available.end >= previous.set.end
            ? available.end > previous.set.end ? { blockId: previous.set.blockId, offset: previous.set.end } : available.next
            : undefined;
          current.current = { ...previous, set: { ...previous.set, next }, sourceVersion: clock.current.sourceVersion };
          setLayout(current.current);
        }
        return;
      }
      let source = clock.current.source(position);
      if (!source) return;
      // Continue at the exact previous boundary, including the remainder of a long unit.
      const next = previous?.revision === revision ? previous.set.next : undefined;
      if (next?.blockId === position.blockId && next.offset <= position.offset) {
        const continuation = clock.current.source(next);
        if (continuation) source = { ...continuation, start: next.offset };
      }
      probe.style.width = vertical ? 'max-content' : `${slot.clientWidth}px`;
      probe.style.height = vertical ? `${slot.clientHeight}px` : 'max-content';
      const measure = (range: SourceRange) => {
        probe.style.fontSize = `${effectiveSize}px`;
        probe.replaceChildren();
        let offset = range.start;
        for (const span of ruby ? source.block.ruby : []) {
          if (span.start < range.start || span.end > range.end) continue;
          probe.append(document.createTextNode(source.block.text.slice(offset, span.start)));
          const base = document.createElement('ruby');
          base.append(document.createTextNode(source.block.text.slice(span.start, span.end)));
          const rt = document.createElement('rt'); rt.textContent = span.reading; base.append(rt); probe.append(base); offset = span.end;
        }
        probe.append(document.createTextNode(source.block.text.slice(offset, range.end)));
        // Count base glyph line bands. Ruby rectangles must not count as extra lines.
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
        return { lines: bands.length, fits: bands.length <= lines && Math.max(bounds.width, glyphs.width) <= slot.clientWidth + .5 && Math.max(bounds.height, glyphs.height) <= slot.clientHeight + .5 };
      };
      let set = planDisplaySet(source.block, source.start, source.end, source.boundaries, source.next, measure);
      while (!set.fits && effectiveSize > 12) {
        effectiveSize = Math.max(12, effectiveSize - 2);
        set = planDisplaySet(source.block, source.start, source.end, source.boundaries, source.next, measure);
      }
      // A late sample may pass more than one short set. Keep the range containing the clock.
      for (let i = 0; i < 32 && !containsPosition(set, position) && set.next?.blockId === position.blockId && set.next.offset <= position.offset; i++) {
        set = planDisplaySet(source.block, set.next.offset, source.end, source.boundaries, source.next, measure);
      }
      current.current = { set, block: source.block, revision, fontSize: effectiveSize, sourceVersion: clock.current.sourceVersion };
      setLayout(current.current);
      slot.scrollTop = 0; slot.scrollLeft = 0;
    };
    refresh.current = plan;
    plan();
    const observer = new ResizeObserver(() => plan()); observer.observe(slot);
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
  const block = layout?.block;
  const visible = set && block ? { blockId: block.id, start: set.start, text: block.text.slice(set.start, set.end), ruby: block.ruby.filter(span => span.start >= set.start && span.end <= set.end).map(span => ({ ...span, start: span.start - set.start, end: span.end - set.start })) } : undefined;
  return <div className="display-set-reader" data-testid="display-set-reader" data-writing-mode={writingMode} style={{ '--set-font-size': `${fontSize}px`, '--reading-font': family } as CSSProperties}>
    <div ref={viewport} className="display-set-viewport" aria-label="本文">
      <div className="display-set-text" data-testid="display-set-text" data-block-id={set?.blockId} data-source-start={set?.start} data-source-end={set?.end} data-lines={set?.lines} data-set-id={set?.id} style={{ fontSize: layout?.fontSize ?? fontSize, fontFamily: family, writingMode }}>
        <RubyText unit={visible} show={ruby} marker={session.marker} />
      </div>
    </div>
    <button type="button" className="display-set-next" aria-label="次の表示セットへ" disabled={!set?.next}
      onPointerDown={event => { gesture.current = { id: set?.id ?? '', x: event.clientX, y: event.clientY, time: performance.now(), valid: event.isPrimary && event.button === 0 }; }}
      onPointerMove={event => { const value = gesture.current; if (value && Math.hypot(event.clientX - value.x, event.clientY - value.y) > 8) value.valid = false; }}
      onPointerCancel={() => { if (gesture.current) gesture.current.valid = false; }}
      onClick={event => {
        const value = gesture.current; gesture.current = undefined;
        if (event.detail > 0 && (!value?.valid || value.id !== current.current?.set.id || performance.now() - value.time > 500 || window.getSelection()?.toString())) return;
        const target = current.current?.set.next;
        if (target) clock.current.seek(target);
      }}>次へ <span aria-hidden="true">→</span></button>
  </div>;
}
