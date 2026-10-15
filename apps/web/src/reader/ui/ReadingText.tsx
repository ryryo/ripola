import type { ReactNode } from 'react';
import type { ReadingUnit } from '../model';
import type { ReadingMarker } from '../display-sets';

/** Ruby and markers share the same UTF-16 coordinates. Ruby bases stay atomic. */
export function RubyText({ unit, show, marker }: { unit?: Pick<ReadingUnit, 'text' | 'ruby'> & Partial<Pick<ReadingUnit, 'blockId' | 'start'>>; show: boolean; marker?: ReadingMarker }) {
  if (!unit) return null;
  const start = unit.start ?? 0;
  const active = marker && marker.blockId === unit.blockId ? marker : undefined;
  const text = (from: number, to: number): ReactNode => {
    const begin = Math.max(from, (active?.start ?? Infinity) - start); const end = Math.min(to, (active?.end ?? -Infinity) - start);
    if (begin >= end) return unit.text.slice(from, to);
    return <>{unit.text.slice(from, begin)}<mark className={`reading-marker marker-${active!.precision}`} data-testid="reading-marker" data-precision={active!.precision}>{unit.text.slice(begin, end)}</mark>{unit.text.slice(end, to)}</>;
  };
  let offset = 0; const pieces: ReactNode[] = [];
  for (const span of show ? unit.ruby : []) {
    if (span.start > offset) pieces.push(<span key={`text:${offset}`}>{text(offset, span.start)}</span>);
    const annotated = <ruby>{unit.text.slice(span.start, span.end)}<rt>{span.reading}</rt></ruby>;
    pieces.push(active && active.start < start + span.end && active.end > start + span.start
      ? <mark key={`ruby:${span.start}`} className={`reading-marker marker-${active.precision}`} data-testid="reading-marker" data-precision={active.precision}>{annotated}</mark>
      : <span key={`ruby:${span.start}`}>{annotated}</span>);
    offset = span.end;
  }
  pieces.push(<span key={`text:${offset}`}>{text(offset, unit.text.length)}</span>);
  return <>{pieces}</>;
}
