import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ReadingUnit, TextBlock, WritingMode } from '../model';
import { RubyText } from './PhraseDisplay';

interface GuideRow { id: string; block: TextBlock; units: Array<{ unit: ReadingUnit; index: number }>; length: number }
export function GuideReader({ blocks, units, currentIndices, playing, ruby, family, onJump, onPause, writingMode = 'horizontal-tb' }: {
  blocks: TextBlock[]; units: ReadingUnit[]; currentIndices: number[]; playing: boolean; ruby: boolean; family: string; onJump: (index: number) => void; onPause: () => void; writingMode?: WritingMode;
}) {
  const vertical = writingMode === 'vertical-rl';
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [inlineSize, setInlineSize] = useState(600);
  const [extent, setExtent] = useState(330);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [measurements, setMeasurements] = useState<Map<string, number>>(() => new Map());
  const lastCurrent = useRef(-1);
  const rows = useMemo(() => {
    const byBlock = new Map<string, Array<{ unit: ReadingUnit; index: number }>>();
    units.forEach((unit, index) => { const values = byBlock.get(unit.blockId) ?? []; values.push({ unit, index }); byBlock.set(unit.blockId, values); });
    const result: GuideRow[] = [];
    for (const block of blocks) {
      let values: GuideRow['units'] = []; let length = 0;
      for (const item of byBlock.get(block.id) ?? []) {
        if (length >= 220) { result.push({ id: `${block.id}:${values[0].index}`, block, units: values, length }); values = []; length = 0; }
        values.push(item); length += Array.from(item.unit.text).length;
      }
      if (values.length) result.push({ id: `${block.id}:${values[0].index}`, block, units: values, length });
    }
    return result;
  }, [blocks, units]);
  const prefix = useMemo(() => {
    const values = [0];
    const characters = Math.max(8, Math.floor((inlineSize - 40) / 20));
    for (const row of rows) values.push(values.at(-1)! + (measurements.get(row.id) ?? Math.max(72, Math.ceil(row.length / characters) * (ruby ? 48 : 40) + 28)));
    return values;
  }, [rows, measurements, inlineSize, ruby]);
  const current = currentIndices[0] ?? 0;
  const currentRow = useMemo(() => {
    let low = 0; let high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].units.at(-1)!.index < current) low = middle + 1; else high = middle; }
    return Math.min(low, Math.max(0, rows.length - 1));
  }, [rows, current]);
  let first = 0;
  while (first < rows.length - 1 && prefix[first + 1] < scroll - 350) first++;
  let end = first;
  while (end < rows.length && (prefix[end] < scroll + extent + 350 || end < first + 3)) end++;
  // A far seek must render its anchor before measuring or scrolling. Near the
  // document end, the browser clamps the estimated scroll offset; using only
  // that offset can otherwise keep the target just outside the virtual window.
  if (follow && (currentRow < first || currentRow >= end)) {
    first = Math.max(0, currentRow - 2); end = currentRow;
    while (end < rows.length && (prefix[end] < prefix[currentRow] + extent + 350 || end < currentRow + 3)) end++;
  }
  const active = new Set(currentIndices);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const resize = () => { setInlineSize(vertical ? element.clientHeight : element.clientWidth); setExtent(vertical ? element.clientWidth : element.clientHeight); };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, [vertical]);
  useEffect(() => { setMeasurements(new Map()); }, [family, ruby, inlineSize, vertical]);
  useEffect(() => {
    const element = viewport.current; if (!element || !vertical) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault(); setFollow(false);
      const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
      element.scrollLeft -= delta;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [vertical]);
  useLayoutEffect(() => {
    const previous = lastCurrent.current;
    const element = viewport.current;
    if (!element) return;
    if (!follow && (playing || previous === current)) { lastCurrent.current = current; return; }
    const highlighted = element.querySelector<HTMLElement>('.guide-unit[aria-current="location"]');
    if (!highlighted) {
      // First render the virtual row; its phrase may be far inside a tall row.
      const target = Math.max(0, (prefix[currentRow] ?? 0) - 35);
      if (vertical) element.scrollLeft = -target; else element.scrollTop = target;
      setScroll(vertical ? -element.scrollLeft : element.scrollTop);
      return;
    }
    lastCurrent.current = current;
    const frame = element.getBoundingClientRect();
    const phrase = highlighted.getClientRects()[0] ?? highlighted.getBoundingClientRect();
    if (vertical) {
      if (phrase.right > frame.right - 25 || phrase.left < frame.left + 25) {
        element.scrollLeft += phrase.right - frame.right + 35;
        setScroll(-element.scrollLeft);
      }
    } else if (phrase.top < frame.top + 25 || phrase.bottom > frame.bottom - 25) {
      element.scrollTop += phrase.top - frame.top - 35;
      setScroll(element.scrollTop);
    }
  }, [currentRow, current, follow, playing, prefix, first, end, vertical]);

  const measure = (id: string, height: number) => setMeasurements(previous => {
    if (Math.abs((previous.get(id) ?? 0) - height) < 1) return previous;
    const next = new Map(previous); next.set(id, height); return next;
  });
  const search = () => {
    if (!query.trim()) return;
    const starts = [...units.keys()].filter(index => units[index].blockId === units[index - 1]?.blockId ? false : true);
    const blockUnits = new Map(starts.map(index => [units[index].blockId, index]));
    const ordered = [...blocks.slice(blocks.findIndex(block => block.id === units[current]?.blockId)), ...blocks.slice(0, blocks.findIndex(block => block.id === units[current]?.blockId))];
    for (const block of ordered) {
      const offset = block.text.indexOf(query);
      if (offset < 0) continue;
      let target = blockUnits.get(block.id) ?? 0;
      while (target < units.length - 1 && units[target].blockId === block.id && units[target].end <= offset) target++;
      setFollow(true); onJump(target); setMessage('検索位置へ移動して停止しました。'); return;
    }
    setMessage('一致する文字列がありません。');
  };
  return <div className="guide-reader" data-testid="guide-reader" style={{ '--reading-font': family } as CSSProperties}>
    <div className="guide-toolbar"><label>本文を検索<input aria-label="Guide本文を検索" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) search(); }} /></label><button type="button" onClick={search}>検索して移動</button><button type="button" aria-pressed={follow} onClick={() => setFollow(value => !value)}>{follow ? '追従を止める' : '現在位置を追従'}</button></div>
    <div ref={viewport} className="guide-viewport" data-testid="guide-viewport" data-writing-mode={writingMode} tabIndex={0} aria-label="全文Guide" aria-live="off" data-reader-shortcuts="off"
      onScroll={event => setScroll(vertical ? -event.currentTarget.scrollLeft : event.currentTarget.scrollTop)} onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}
      onPointerDown={event => { if (event.target === viewport.current) setFollow(false); }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(event.code)) setFollow(false); }}>
      <div style={{ blockSize: prefix[first] }} aria-hidden="true" />
      {rows.slice(first, end).map(row => <MeasuredRow key={row.id} row={row} onMeasure={measure} vertical={vertical}>{row.units.map(({ unit, index }) => <button key={unit.id} type="button" className={`guide-unit ${active.has(index) ? 'active' : ''}`} aria-current={active.has(index) ? 'location' : undefined} data-unit-id={unit.id} onClick={() => { setFollow(true); onJump(index); }} title="ここへ移動して停止"><RubyText unit={unit} show={ruby} /></button>)}</MeasuredRow>)}
      <div style={{ blockSize: (prefix.at(-1) ?? 0) - (prefix[end] ?? 0) }} aria-hidden="true" />
    </div>
    <p className="guide-status" role="status">{message || (follow ? '現在位置を追従します。スクロール操作で追従を止められます。' : '自由にスクロールできます。読書位置は変わりません。')}</p>
    <details className="guide-static-text" onToggle={onPause}><summary>全文を静止表示・コピー</summary><textarea aria-label="Guide静止全文" value={blocks.map(block => block.text).join('\n\n')} readOnly rows={8} /></details>
  </div>;
}

function MeasuredRow({ row, onMeasure, children, vertical }: { row: GuideRow; onMeasure: (id: string, height: number) => void; children: React.ReactNode; vertical: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const measureRef = useRef(onMeasure); measureRef.current = onMeasure;
  useLayoutEffect(() => {
    const node = element.current; if (!node) return;
    const measure = () => measureRef.current(row.id, vertical ? node.getBoundingClientRect().width : node.getBoundingClientRect().height);
    // Record the mounted extent before following can clamp a far seek. Waiting
    // for ResizeObserver allows estimated windows to alternate synchronously.
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [row.id, vertical]);
  return <div ref={element} className={`guide-row guide-row-${row.block.kind}`} role={row.block.kind === 'heading' ? 'heading' : undefined} aria-level={row.block.kind === 'heading' ? row.block.level ?? 2 : undefined}>{children}</div>;
}
