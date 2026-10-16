import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { ReadingUnit } from '../model';
import type { ReadingMarker } from '../display-sets';

/** Colour ranges without inserting inline boxes that can change shaping, ruby or line breaks. */
export function RubyText({ unit, show, marker, layoutKey }: { unit?: Pick<ReadingUnit, 'text' | 'ruby'> & Partial<Pick<ReadingUnit, 'blockId' | 'start'>>; show: boolean; marker?: ReadingMarker; layoutKey?: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const background = useRef<HTMLSpanElement>(null);
  const text = unit?.text ?? '';
  const start = unit?.start ?? 0;
  const ruby = show ? unit?.ruby ?? [] : [];
  let from = marker && unit && marker.blockId === unit.blockId ? Math.max(0, marker.start - start) : text.length;
  let to = marker && unit && marker.blockId === unit.blockId ? Math.min(text.length, marker.end - start) : 0;
  for (const span of ruby) if (span.start < to && span.end > from) { from = Math.min(from, span.start); to = Math.max(to, span.end); }
  const active = from < to;
  const rubyKey = JSON.stringify(ruby);
  useLayoutEffect(() => {
    const node = element.current; const layer = background.current;
    const surface = node?.closest<HTMLElement>('.display-set-text');
    if (!node || !layer || !surface || !active) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let child: Node | null; let offset = 0;
    while ((child = walker.nextNode())) {
      if (child.parentElement?.closest('rt')) continue;
      const length = child.textContent?.length ?? 0;
      const begin = Math.max(0, from - offset); const end = Math.min(length, to - offset);
      if (begin < end) {
        const range = document.createRange(); range.setStart(child, begin); range.setEnd(child, end); ranges.push(range);
      }
      offset += length;
    }
    const paint = () => {
      const origin = surface.getBoundingClientRect();
      const rectangles = ranges.flatMap(range => [...range.getClientRects()]).filter(rect => rect.width > .1 && rect.height > .1);
      layer.replaceChildren(...rectangles.map(rect => {
        const box = document.createElement('span');
        box.style.cssText = `left:${rect.left - origin.left - surface.clientLeft + surface.scrollLeft}px;top:${rect.top - origin.top - surface.clientTop + surface.scrollTop}px;width:${rect.width}px;height:${rect.height}px`;
        return box;
      }));
    };
    paint();
    const observer = new ResizeObserver(paint); observer.observe(surface);
    document.fonts.addEventListener('loadingdone', paint);
    return () => { observer.disconnect(); document.fonts.removeEventListener('loadingdone', paint); layer.replaceChildren(); };

  }, [text, rubyKey, active, from, to, layoutKey]);
  if (!unit) return null;
  let offset = 0; const pieces: ReactNode[] = [];
  for (const span of ruby) {
    if (span.start > offset) pieces.push(<span key={`text:${offset}`}>{text.slice(offset, span.start)}</span>);
    pieces.push(<ruby key={`ruby:${span.start}`}>{text.slice(span.start, span.end)}<rt>{span.reading}</rt></ruby>);
    offset = span.end;
  }
  pieces.push(<span key={`text:${offset}`}>{text.slice(offset)}</span>);
  return <span ref={element} className="reading-text" data-testid={active ? 'reading-marker' : undefined} data-precision={active ? marker?.precision : undefined} data-marker-start={active ? start + from : undefined} data-marker-end={active ? start + to : undefined}>{pieces}{active && <span ref={background} className="reading-marker-layer" aria-hidden="true" />}</span>;
}
