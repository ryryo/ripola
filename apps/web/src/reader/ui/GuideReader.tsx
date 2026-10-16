import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { ReadingUnit, TextBlock, WritingMode } from '../model';
import { RubyText } from './ReadingText';

interface GuideRow { id: string; block: TextBlock; units: Array<{ unit: ReadingUnit; index: number }>; length: number }
export function GuideReader({ blocks, units, currentIndices, playing, ruby, family, onJump, onPause, writingMode = 'horizontal-tb', fontSize = 20 }: {
  blocks: TextBlock[]; units: ReadingUnit[]; currentIndices: number[]; playing: boolean; ruby: boolean; family: string; onJump: (index: number) => void; onPause: () => void; writingMode?: WritingMode; fontSize?: number;
}) {
  const vertical = writingMode === 'vertical-rl';
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{ scroll: number; prefix: number[] | null }>({ scroll: 0, prefix: null });
  const committedWindow = useRef<{ first: number; end: number } | null>(null);
  const [inlineSize, setInlineSize] = useState(600);
  const [extent, setExtent] = useState(330);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [copyOpen, setCopyOpen] = useState(false);
  const copyText = useMemo(() => copyOpen ? blocks.map(block => block.text).join('\n\n') : '', [blocks, copyOpen]);
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
    const characters = Math.max(8, Math.floor((inlineSize - 40) / fontSize));
    for (const row of rows) values.push(values.at(-1)! + (measurements.get(row.id) ?? Math.max(72, Math.ceil(row.length / characters) * (ruby ? 2.4 : 2) * fontSize + 28)));
    return values;
  }, [rows, measurements, inlineSize, ruby, fontSize]);
  const setScroll = (scroll: number) => setView(previous => previous.scroll === scroll && previous.prefix === prefix ? previous : { scroll, prefix });
  const scroll = view.scroll;
  const current = currentIndices[0] ?? 0;
  const preserveView = !follow && (playing || lastCurrent.current === current);
  const currentRow = useMemo(() => {
    let low = 0; let high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].units.at(-1)!.index < current) low = middle + 1; else high = middle; }
    return Math.min(low, Math.max(0, rows.length - 1));
  }, [rows, current]);
  let first = 0, high = Math.max(0, rows.length - 1);
  while (first < high) { const middle = (first + high) >>> 1; if (prefix[middle + 1] < scroll - 350) first = middle + 1; else high = middle; }
  let end = first;
  while (end < rows.length && (prefix[end] < scroll + extent + 350 || end < first + 3)) end++;
  // A far seek must render its anchor before measuring or scrolling. Near the
  // document end, the browser clamps the estimated scroll offset; using only
  // that offset can otherwise keep the target just outside the virtual window.
  if (follow && (currentRow < first || currentRow >= end)) {
    first = Math.max(0, currentRow - 2); end = currentRow;
    while (end < rows.length && (prefix[end] < prefix[currentRow] + extent + 350 || end < currentRow + 3)) end++;
  }
  // Keep the mounted anchor through a measurement commit; after restoring its
  // position, the viewport reports the corrected offset with the new prefix.
  if (preserveView && view.prefix !== prefix && committedWindow.current) {
    ({ first, end } = committedWindow.current);
  }
  useLayoutEffect(() => { committedWindow.current = { first, end }; });
  const active = new Set(currentIndices);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const resize = () => { setInlineSize(vertical ? element.clientHeight : element.clientWidth); setExtent(vertical ? element.clientWidth : element.clientHeight); };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, [vertical]);
  useEffect(() => { setMeasurements(new Map()); }, [family, ruby, inlineSize, vertical, fontSize]);
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
      setFollow(true); onJump(target); setMessage('検索位置へ移動しました。'); return;
    }
    setMessage('一致する文字列がありません。');
  };
  return <div className="guide-reader" data-testid="guide-reader" style={{ '--reading-font': family, '--document-font-size': `${fontSize}px` } as CSSProperties}>
    <div className="guide-toolbar"><label>本文を検索<input aria-label="本文を検索" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) search(); }} /></label><button type="button" onClick={search}>検索して移動</button><button type="button" aria-pressed={follow} onClick={() => setFollow(value => !value)}>{follow ? '追従を止める' : '現在位置を追従'}</button></div>
    <div ref={viewport} className="guide-viewport" data-testid="guide-viewport" data-writing-mode={writingMode} tabIndex={0} aria-label="全文表示" aria-live="off" data-reader-shortcuts="off"
      onScroll={event => setScroll(vertical ? -event.currentTarget.scrollLeft : event.currentTarget.scrollTop)} onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}
      onPointerDown={event => { if (event.target === viewport.current) setFollow(false); }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(event.code)) setFollow(false); }}>
      <GuideScrollAnchor viewport={viewport} vertical={vertical} enabled={preserveView} onLayout={() => {
        const element = viewport.current;
        if (element) setScroll(vertical ? -element.scrollLeft : element.scrollTop);
      }}>
      <div style={{ blockSize: prefix[first] }} aria-hidden="true" />
      {rows.slice(first, end).map(row => <MeasuredRow key={row.id} row={row} onMeasure={measure} vertical={vertical}>{row.units.map(({ unit, index }) => <button key={unit.id} type="button" className={`guide-unit ${active.has(index) ? 'active' : ''}`} aria-current={active.has(index) ? 'location' : undefined} data-unit-id={unit.id} onClick={() => { setFollow(true); onJump(index); }} title="ここへ移動して停止"><RubyText unit={unit} show={ruby} vertical={vertical} /></button>)}</MeasuredRow>)}
      <div style={{ blockSize: (prefix.at(-1) ?? 0) - (prefix[end] ?? 0) }} aria-hidden="true" />
      </GuideScrollAnchor>
    </div>
    <p className="guide-status" role="status">{message || (follow ? '読んでいる位置を追います。' : '自由にスクロールできます。')}</p>
    <details className="guide-static-text" onToggle={event => { setCopyOpen(event.currentTarget.open); onPause(); }}><summary>全文を静止表示・コピー</summary>{copyOpen && <textarea aria-label="コピーする全文" value={copyText} readOnly rows={8} />}</details>
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

interface ScrollAnchorProps {
  viewport: RefObject<HTMLDivElement | null>; vertical: boolean; enabled: boolean; onLayout: () => void; children: ReactNode;
}
interface ScrollAnchor { node: Element; fragment: number; position: number; distance: number }

// React's snapshot lifecycle reads the old layout before row/spacer mutations.
// A layout effect alone would already see the new positions of mounted rows.
class GuideScrollAnchor extends Component<ScrollAnchorProps, Record<string, never>, ScrollAnchor[] | null> {
  getSnapshotBeforeUpdate(previous: ScrollAnchorProps): ScrollAnchor[] | null {
    const element = this.props.viewport.current;
    if (!this.props.enabled || previous.vertical !== this.props.vertical || !element) return null;
    const frame = element.getBoundingClientRect();
    return [...element.querySelectorAll('.guide-unit')].map(node => {
      const fragments = [...node.getClientRects()];
      const visible = fragments.findIndex(rect => rect.left < frame.right && rect.right > frame.left && rect.top < frame.bottom && rect.bottom > frame.top);
      const fragment = Math.max(0, visible);
      const rect = fragments[fragment];
      const position = this.props.vertical ? rect.right - frame.right : rect.top - frame.top;
      const distance = visible >= 0 ? 0 : Math.abs(position);
      return { node, fragment, position, distance };
    }).sort((a, b) => a.distance - b.distance);
  }
  componentDidMount() { this.props.onLayout(); }
  componentDidUpdate(_previous: ScrollAnchorProps, _state: Record<string, never>, snapshot?: ScrollAnchor[] | null) {
    const element = this.props.viewport.current;
    const anchor = snapshot?.find(item => item.node.isConnected && element?.contains(item.node));
    const rect = anchor?.node.getClientRects()[anchor.fragment];
    if (element && anchor && rect) {
      const frame = element.getBoundingClientRect();
      const difference = (this.props.vertical ? rect.right - frame.right : rect.top - frame.top) - anchor.position;
      if (Math.abs(difference) >= .5) {
        if (this.props.vertical) element.scrollLeft += difference;
        else element.scrollTop += difference;
      }
    }
    this.props.onLayout();
  }
  render() { return this.props.children; }
}
