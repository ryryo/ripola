import { Button, Menu, Modal, Popover } from '@mantine/core';
import { Component, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { ReadingUnit, TextBlock, WritingMode } from '../model';
import { mergeMarkerRects } from '../marker-rects';
import { firstMatchAtOrAfter, searchText, type TextSearchMatch } from '../text-search';
import { RubyText } from './ReadingText';
import { FullscreenReaderContext } from './FullscreenReaderContext';
import './guide-search.css';

interface GuideRow { id: string; block: TextBlock; units: Array<{ unit: ReadingUnit; index: number }>; length: number }
const EMPTY_MATCHES: TextSearchMatch[] = [];
interface GuideSearchMemory { key: string; query: string; committedQuery: string; selectedId: string | null; viewingSelection: boolean; canReturnToReading: boolean }
// Keeps the search term and selected occurrence while the same book switches
// between phrase and full-text modes. Not persisted across reloads or books.
let searchMemory: GuideSearchMemory | null = null;
export function GuideReader({ blocks, units, currentIndices, playing, ruby, family, onJump, onPause, onPlayIndex, canPlayIndex = () => true, writingMode = 'horizontal-tb', fontSize = 20, searchKey }: {
  blocks: TextBlock[]; units: ReadingUnit[]; currentIndices: number[]; playing: boolean; ruby: boolean; family: string; onJump: (index: number) => void; onPause: () => void;
  onPlayIndex?: (index: number) => void; canPlayIndex?: (index: number) => boolean; writingMode?: WritingMode; fontSize?: number; searchKey: string;
}) {
  const vertical = writingMode === 'vertical-rl';
  const { desktop, setOverlayOpen } = useContext(FullscreenReaderContext);
  const remembered = searchMemory?.key === searchKey ? searchMemory : null;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setOverlayOpen(searchFocused || copyOpen || menuOpen);
    return () => setOverlayOpen(false);
  }, [searchFocused, copyOpen, menuOpen, setOverlayOpen]);
  useEffect(() => { setSearchOpen(false); setSearchFocused(false); if (!desktop) { setCopyOpen(false); setMenuOpen(false); } }, [desktop]);
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{ scroll: number; prefix: number[] | null }>({ scroll: 0, prefix: null });
  const committedWindow = useRef<{ first: number; end: number } | null>(null);
  const [inlineSize, setInlineSize] = useState(600);
  const [extent, setExtent] = useState(330);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState(remembered?.query ?? '');
  const [committedQuery, setCommittedQuery] = useState(remembered?.committedQuery ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(remembered?.selectedId ?? null);
  const [viewingSelection, setViewingSelection] = useState(remembered?.viewingSelection ?? false);
  const [canReturnToReading, setCanReturnToReading] = useState(remembered?.canReturnToReading ?? false);
  const [status, setStatus] = useState('');
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => { searchMemory = { key: searchKey, query, committedQuery, selectedId, viewingSelection, canReturnToReading }; }, [searchKey, query, committedQuery, selectedId, viewingSelection, canReturnToReading]);
  const [measurements, setMeasurements] = useState<Map<string, number>>(() => new Map());
  const lastCurrent = useRef(-1);
  const searchOrigin = useRef(currentIndices[0] ?? 0);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const focusOnOpen = useRef(false);
  const composing = useRef(false);
  const statusTimer = useRef<number | undefined>(undefined);
  const searchScroll = useRef<string | null>(null);
  const searchPrefix = useRef<number[] | null>(null);
  const searchStatusId = useId();
  useEffect(() => () => { if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current); }, []);
  const announce = (text: string, delay = 0) => {
    if (statusTimer.current !== undefined) { window.clearTimeout(statusTimer.current); statusTimer.current = undefined; }
    const update = () => {
      setAnnouncement(text);
      // The counter already shows "全N件中M件目". Keep that count in the live
      // region only, so the visible panel does not repeat it twice.
      setStatus(text.startsWith('全') ? '' : text.replace(/全\d+件中\d+件目$/, ''));
    };
    if (delay > 0) {
      setAnnouncement('');
      setStatus('');
      statusTimer.current = window.setTimeout(() => { statusTimer.current = undefined; update(); }, delay);
    } else update();
  };
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
  const matches = useMemo(() => committedQuery ? searchText(blocks, units, committedQuery) : [], [blocks, units, committedQuery]);
  const rowsByBlock = useMemo(() => {
    const result = new Map<string, GuideRow[]>();
    for (const row of rows) { const values = result.get(row.block.id) ?? []; values.push(row); result.set(row.block.id, values); }
    return result;
  }, [rows]);
  const rowMatches = useMemo(() => {
    const result = new Map<string, TextSearchMatch[]>();
    for (const match of matches) {
      const values = rowsByBlock.get(match.blockId);
      if (!values?.length) continue;
      let low = 0; let high = values.length;
      while (low < high) { const middle = (low + high) >>> 1; if (values[middle].units.at(-1)!.unit.end <= match.start) low = middle + 1; else high = middle; }
      for (let index = low; index < values.length; index++) {
        const row = values[index];
        const from = row.units[0].unit.start; const to = row.units.at(-1)!.unit.end;
        if (from >= match.end) break;
        if (match.end > from && match.start < to) { const list = result.get(row.id) ?? []; list.push(match); result.set(row.id, list); }
      }
    }
    return result;
  }, [rowsByBlock, matches]);
  const selectedIndex = selectedId ? matches.findIndex(match => match.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? matches[selectedIndex] : undefined;
  const selectedUnit = viewingSelection && selected ? selected.unitIndex : -1;
  const commitSearch = (value: string) => {
    const normalized = value.trim() ? value : '';
    if (normalized === committedQuery) return;
    setCommittedQuery(normalized);
    if (!normalized) { setSelectedId(null); setViewingSelection(false); setCanReturnToReading(false); searchScroll.current = null; searchPrefix.current = null; announce(''); return; }
    const found = searchText(blocks, units, normalized);
    if (!found.length) { setSelectedId(null); setViewingSelection(false); setCanReturnToReading(false); searchScroll.current = null; searchPrefix.current = null; announce('一致する文字列がありません。', 400); return; }
    const pick = firstMatchAtOrAfter(found, searchOrigin.current) ?? found[0];
    setSelectedId(pick.id); setViewingSelection(true); setCanReturnToReading(true); setFollow(true);
    searchScroll.current = null; searchPrefix.current = null;
    announce(`全${found.length}件中${found.findIndex(match => match.id === pick.id) + 1}件目`, 350);
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    if (!composing.current) commitSearch(value);
  };
  const move = (direction: -1 | 1) => {
    if (!matches.length) { announce('一致する文字列がありません。'); return; }
    const hadSelection = selectedIndex >= 0;
    const from = selectedIndex >= 0 ? selectedIndex : direction > 0 ? -1 : 0;
    const to = (from + direction + matches.length) % matches.length;
    const wrapped = hadSelection && (direction > 0 ? to === 0 : to === matches.length - 1);
    setSelectedId(matches[to].id); setViewingSelection(true); setCanReturnToReading(true); setFollow(true);
    searchScroll.current = null; searchPrefix.current = null;
    const count = `全${matches.length}件中${to + 1}件目`;
    announce(wrapped ? `${direction > 0 ? '末尾から先頭に戻りました。' : '先頭から末尾へ移動しました。'}${count}` : count);
  };
  const openSearch = () => {
    searchOrigin.current = currentIndices[0] ?? 0;
    onPause();
    focusOnOpen.current = true;
    setSearchOpen(true);
    setSearchFocused(true);
  };
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchFocused(false);
    requestAnimationFrame(() => searchTrigger.current?.focus({ preventScroll: true }));
  }, []);
  const toggleSearch = () => { if (searchOpen) closeSearch(); else openSearch(); };
  useEffect(() => {
    if (!searchOpen) return;
    // Escape closes only the search, even when focus moved to the text or
    // another fullscreen control. The fullscreen handler sees data-settings-open
    // and leaves the fullscreen state alone.
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); closeSearch();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [searchOpen, closeSearch]);
  const returnToReading = () => {
    searchScroll.current = null; searchPrefix.current = null;
    setViewingSelection(false);
    setCanReturnToReading(false);
    setFollow(true);
    announce('読書位置に戻りました。');
  };
  const playFromSelection = () => {
    if (!selected || !canPlayIndex(selected.unitIndex)) return;
    searchScroll.current = null; searchPrefix.current = null;
    setViewingSelection(false);
    setCanReturnToReading(false);
    setFollow(true);
    setSearchOpen(false);
    setSearchFocused(false);
    setStatus('');
    if (onPlayIndex) onPlayIndex(selected.unitIndex);
    else onJump(selected.unitIndex);
  };
  useLayoutEffect(() => {
    if (!searchOpen || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    searchInput.current?.focus({ preventScroll: true });
  }, [searchOpen]);
  const prefix = useMemo(() => {
    const values = [0];
    const characters = Math.max(8, Math.floor((inlineSize - 40) / fontSize));
    for (const row of rows) values.push(values.at(-1)! + (measurements.get(row.id) ?? Math.max(72, Math.ceil(row.length / characters) * (ruby ? 2.4 : 2) * fontSize + 28)));
    return values;
  }, [rows, measurements, inlineSize, ruby, fontSize]);
  const setScroll = (scroll: number) => setView(previous => previous.scroll === scroll && previous.prefix === prefix ? previous : { scroll, prefix });
  const scroll = view.scroll;
  const reading = currentIndices[0] ?? 0;
  const preserveView = !follow && (selectedUnit >= 0 || playing || lastCurrent.current === reading);
  const focusRow = useMemo(() => {
    const focus = selectedUnit >= 0 ? selectedUnit : reading;
    let low = 0; let high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].units.at(-1)!.index < focus) low = middle + 1; else high = middle; }
    return Math.min(low, Math.max(0, rows.length - 1));
  }, [rows, reading, selectedUnit]);
  let first = 0;
  while (first < rows.length - 1 && prefix[first + 1] < scroll - 350) first++;
  let end = first;
  while (end < rows.length && (prefix[end] < scroll + extent + 350 || end < first + 3)) end++;
  // A far seek must render its anchor before measuring or scrolling. Near the
  // document end, the browser clamps the estimated scroll offset; using only
  // that offset can otherwise keep the target just outside the virtual window.
  if (follow && (focusRow < first || focusRow >= end)) {
    first = Math.max(0, focusRow - 2); end = selectedUnit >= 0 ? focusRow + 1 : focusRow;
    while (end < rows.length && (prefix[end] < prefix[focusRow] + extent + 350 || end < focusRow + 3)) end++;
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
      event.preventDefault(); setFollow(false); setViewingSelection(false);
      const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.clientWidth : 1);
      element.scrollLeft -= delta;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [vertical]);
  useLayoutEffect(() => {
    const previous = lastCurrent.current;
    const element = viewport.current;
    if (!element || selectedUnit >= 0) return;
    if (!follow && (playing || previous === reading)) { lastCurrent.current = reading; return; }
    const highlighted = element.querySelector<HTMLElement>('.guide-unit[aria-current="location"]');
    if (!highlighted) {
      // First render the virtual row; its phrase may be far inside a tall row.
      const target = Math.max(0, (prefix[focusRow] ?? 0) - 35);
      if (vertical) element.scrollLeft = -target; else element.scrollTop = target;
      setScroll(vertical ? -element.scrollLeft : element.scrollTop);
      return;
    }
    lastCurrent.current = reading;
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
  }, [focusRow, reading, follow, playing, prefix, first, end, vertical, selectedUnit]);
  useLayoutEffect(() => {
    if (selectedUnit < 0 || !selected || !follow) return;
    // Position a new selection, then correct once after virtual rows report
    // their measured sizes. After the layout settles, manual scrolling owns the
    // viewport; measurements must not pull the reader back mid-swipe.
    const fresh = searchScroll.current !== selected.id;
    if (!fresh && searchPrefix.current === prefix) return;
    const element = viewport.current; if (!element) return;
    const marks = [...element.querySelectorAll<HTMLElement>('.guide-search-mark[data-search-selected="true"]')];
    const target = marks.find(mark => mark.dataset.searchMatchId === selected.id)
      ?? element.querySelector<HTMLElement>('.guide-unit[data-search-current="true"]');
    if (!target) {
      const offset = Math.max(0, (prefix[focusRow] ?? 0) - 35);
      if (vertical) element.scrollLeft = -offset; else element.scrollTop = offset;
      setScroll(vertical ? -element.scrollLeft : element.scrollTop);
      return;
    }
    const frame = element.getBoundingClientRect();
    if (vertical) {
      const margin = Math.min(140, Math.max(40, frame.width / 3));
      // A virtual row is measured after it mounts. Correct the estimated
      // offset repeatedly so the selected glyph, not just its row, is visible.
      for (let pass = 0; pass < 4; pass++) {
        const rect = target.getClientRects()[0] ?? target.getBoundingClientRect();
        if (rect.right <= frame.right - 24 && rect.left >= frame.left + 24) break;
        const delta = rect.right - frame.right + margin;
        if (Math.abs(delta) < 1) break;
        element.scrollLeft += delta;
      }
      setScroll(-element.scrollLeft);
    } else {
      const margin = Math.min(140, Math.max(40, frame.height / 3));
      for (let pass = 0; pass < 4; pass++) {
        const rect = target.getClientRects()[0] ?? target.getBoundingClientRect();
        if (rect.top >= frame.top + 24 && rect.bottom <= frame.bottom - 24) break;
        const delta = rect.top - frame.top - margin;
        if (Math.abs(delta) < 1) break;
        element.scrollTop += delta;
      }
      setScroll(element.scrollTop);
    }
    searchScroll.current = selected.id;
    searchPrefix.current = prefix;
  }, [selectedUnit, selected?.id, focusRow, prefix, first, end, vertical, selected]);
  const measure = (id: string, height: number) => setMeasurements(previous => {
    if (Math.abs((previous.get(id) ?? 0) - height) < 1) return previous;
    const next = new Map(previous); next.set(id, height); return next;
  });
  const searchPlayable = selected ? canPlayIndex(selected.unitIndex) : false;
  const searchField = <label className="guide-search-field"><span>本文を検索</span><input ref={searchInput} data-autofocus aria-label="本文を検索" aria-describedby={searchStatusId} type="text" autoComplete="off" spellCheck={false} value={query}
      onFocus={() => setSearchFocused(true)}
      onChange={event => changeQuery(event.target.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; setQuery(event.currentTarget.value); commitSearch(event.currentTarget.value); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); return; }
        if (event.key !== 'Enter') return;
        const native = event.nativeEvent;
        if (native.isComposing || composing.current || native.keyCode === 229) { event.preventDefault(); return; }
        event.preventDefault();
        if (query !== committedQuery) { commitSearch(query); return; }
        move(event.shiftKey ? -1 : 1);
      }} /></label>;
  const searchPanel = <div className="guide-search-panel" data-testid="guide-search-panel" onFocusCapture={() => setSearchFocused(true)}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closeSearch(); } }}>
    <div className="guide-search-heading">
      <strong>本文を検索</strong>
      <button type="button" className="guide-search-close" aria-label="検索を閉じる" onClick={closeSearch}>×</button>
    </div>
    {searchField}
    <div className="guide-search-meta">
      {committedQuery && <span className="guide-search-count" data-testid="guide-search-count">{selectedIndex >= 0 ? `全${matches.length}件中${selectedIndex + 1}件目` : `全${matches.length}件`}</span>}
      <span id={searchStatusId} className="guide-search-status" aria-hidden={status ? undefined : 'true'}>{status}</span>
      <span className="visually-hidden" role="status" aria-live="polite">{announcement}</span>
    </div>
    <div className="guide-search-actions">
      <Button size="sm" variant="default" onMouseDown={event => event.preventDefault()} onClick={() => move(-1)} disabled={matches.length < 2}>前へ</Button>
      <Button size="sm" variant="default" onMouseDown={event => event.preventDefault()} onClick={() => move(1)} disabled={matches.length < 2}>次へ</Button>
      <Button size="sm" variant="light" onMouseDown={event => event.preventDefault()} onClick={playFromSelection} disabled={!selected || !searchPlayable} title={!selected ? '一致を選んでください' : !searchPlayable ? 'この箇所は再生できません' : undefined}>ここから再生</Button>
      <Button size="sm" variant="subtle" onMouseDown={event => event.preventDefault()} onClick={returnToReading} disabled={!selected || !canReturnToReading}>読書位置に戻る</Button>
    </div>
    <p className="guide-search-hint">Enterで次へ・Shift+Enterで前へ・Escで閉じる</p>
  </div>;
  const trigger = <Button ref={searchTrigger} variant="default" aria-haspopup="dialog" aria-expanded={searchOpen} onClick={toggleSearch}>検索</Button>;
  return <div className="guide-reader" data-testid="guide-reader" style={{ '--reading-font': family, '--document-font-size': `${fontSize}px` } as CSSProperties}>
    {desktop ? <div className="guide-toolbar fullscreen-guide-tools">
      <Popover opened={searchOpen} onChange={value => { setSearchOpen(value); if (!value) setSearchFocused(false); }} position="bottom-end" withinPortal={false} trapFocus returnFocus>
        <Popover.Target>{trigger}</Popover.Target>
        <Popover.Dropdown role="dialog" aria-label="本文を検索" className="guide-search guide-search-popover" onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>{searchPanel}</Popover.Dropdown>
      </Popover>
      <Button variant={follow ? 'light' : 'default'} aria-label={follow ? '追従を止める' : '現在位置を追従'} aria-pressed={follow} onClick={() => { if (!follow) { setViewingSelection(false); setCanReturnToReading(false); searchScroll.current = null; searchPrefix.current = null; } setFollow(value => !value); }}>{follow ? '追従中' : '追従する'}</Button>
      <Menu opened={menuOpen} onChange={setMenuOpen} withinPortal={false} position="bottom-end">
        <Menu.Target><Button variant="default" aria-label="全文の操作">…</Button></Menu.Target>
        <Menu.Dropdown><Menu.Item onClick={() => { onPause(); setCopyOpen(true); }}>全文を静止表示・コピー</Menu.Item></Menu.Dropdown>
      </Menu>
    </div> : <div className="guide-toolbar">
      {trigger}
      <button type="button" aria-pressed={follow} onClick={() => { if (!follow) { setViewingSelection(false); setCanReturnToReading(false); searchScroll.current = null; searchPrefix.current = null; } setFollow(value => !value); }}>{follow ? '追従を止める' : '現在位置を追従'}</button>
    </div>}
    {!desktop && searchOpen && searchPanel}
    <div ref={viewport} className="guide-viewport" data-testid="guide-viewport" data-writing-mode={writingMode} tabIndex={0} aria-label="全文表示" aria-live="off" data-reader-shortcuts="off"
      onScroll={event => setScroll(vertical ? -event.currentTarget.scrollLeft : event.currentTarget.scrollTop)}
      onWheel={() => { setFollow(false); setViewingSelection(false); }}
      onTouchMove={() => { setFollow(false); setViewingSelection(false); }}
      onPointerDown={event => { if (event.target === viewport.current) { setFollow(false); setViewingSelection(false); } }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(event.code)) { setFollow(false); setViewingSelection(false); } }}>
      <GuideScrollAnchor viewport={viewport} vertical={vertical} enabled={preserveView} onLayout={() => {
        const element = viewport.current;
        if (element) setScroll(vertical ? -element.scrollLeft : element.scrollTop);
      }}>
      <div style={{ blockSize: prefix[first] }} aria-hidden="true" />
      {rows.slice(first, end).map(row => <MeasuredRow key={row.id} row={row} onMeasure={measure} vertical={vertical}
        matches={rowMatches.get(row.id) ?? EMPTY_MATCHES} selectedId={selected?.id ?? null} layoutKey={`${ruby}:${family}:${fontSize}:${vertical}`}>
        {row.units.map(({ unit, index }) => <button key={unit.id} type="button" className={`guide-unit ${active.has(index) ? 'active' : ''}`} aria-current={active.has(index) ? 'location' : undefined} data-unit-id={unit.id} data-unit-index={index} data-search-current={selectedUnit === index ? 'true' : undefined}
          onClick={() => { setViewingSelection(false); setCanReturnToReading(false); searchScroll.current = null; searchPrefix.current = null; setFollow(true); setSearchOpen(false); setSearchFocused(false); onJump(index); }} title="ここへ移動して停止"><RubyText unit={unit} show={ruby} vertical={vertical} /></button>)}
      </MeasuredRow>)}
      <div style={{ blockSize: (prefix.at(-1) ?? 0) - (prefix[end] ?? 0) }} aria-hidden="true" />
      </GuideScrollAnchor>
    </div>
    <p className="guide-status" role="status">{follow ? '読んでいる位置を追います。' : '自由にスクロールできます。'}</p>
    {desktop ? <Modal opened={copyOpen} onClose={() => setCopyOpen(false)} title="全文を静止表示・コピー" withinPortal={false} size="xl" centered closeButtonProps={{ 'aria-label': '全文を閉じる' }}><textarea className="fullscreen-guide-copy" aria-label="コピーする全文" value={blocks.map(block => block.text).join('\n\n')} readOnly rows={12} /></Modal> : <details className="guide-static-text" onToggle={onPause}><summary>全文を静止表示・コピー</summary><textarea aria-label="コピーする全文" value={blocks.map(block => block.text).join('\n\n')} readOnly rows={8} /></details>}
  </div>;
}

function MeasuredRow({ row, onMeasure, children, vertical, matches, selectedId, layoutKey }: {
  row: GuideRow; onMeasure: (id: string, height: number) => void; children: React.ReactNode; vertical: boolean;
  matches: TextSearchMatch[]; selectedId: string | null; layoutKey: string;
}) {
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
  return <div ref={element} className={`guide-row guide-row-${row.block.kind}`} role={row.block.kind === 'heading' ? 'heading' : undefined} aria-level={row.block.kind === 'heading' ? row.block.level ?? 2 : undefined}>{children}<GuideSearchMarks units={row.units} matches={matches} selectedId={selectedId} vertical={vertical} layoutKey={layoutKey} /></div>;
}

function GuideSearchMarks({ units, matches, selectedId, vertical, layoutKey }: {
  units: GuideRow['units']; matches: TextSearchMatch[]; selectedId: string | null; vertical: boolean; layoutKey: string;
}) {
  const layer = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = layer.current; const row = host?.parentElement;
    if (!host || !row) return;
    const paint = () => {
      if (!matches.length) { host.replaceChildren(); return; }
      const origin = row.getBoundingClientRect();
      const nodes = [...row.querySelectorAll<HTMLElement>('button.guide-unit')];
      const normal: HTMLElement[] = []; const selected: HTMLElement[] = [];
      for (const node of nodes) {
        const index = Number(node.dataset.unitIndex);
        const item = units.find(value => value.index === index);
        if (!item) continue;
        const textNodes: Text[] = [];
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let child: Node | null;
        while ((child = walker.nextNode())) {
          if (child.parentElement?.closest('rt')) continue;
          textNodes.push(child as Text);
        }
        for (const match of matches) {
          if (match.end <= item.unit.start || match.start >= item.unit.end) continue;
          const from = Math.max(match.start, item.unit.start) - item.unit.start;
          const to = Math.min(match.end, item.unit.end) - item.unit.start;
          let cursor = 0; let startNode: Text | undefined; let startOffset = 0; let endNode: Text | undefined; let endOffset = 0;
          for (const textNode of textNodes) {
            const length = textNode.data.length;
            if (!startNode && from < cursor + length) { startNode = textNode; startOffset = from - cursor; }
            if (to <= cursor + length) { endNode = textNode; endOffset = to - cursor; break; }
            cursor += length;
          }
          if (!startNode || !endNode || startOffset >= startNode.data.length || endOffset <= 0) continue;
          const range = document.createRange();
          try { range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset); } catch { continue; }
          const rects = [...range.getClientRects()].filter(rect => rect.width > .1 && rect.height > .1).map(rect => ({ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }));
          if (!rects.length) continue;
          const gap = Math.max(0, parseFloat(getComputedStyle(row).letterSpacing) || 0) + .5;
          for (const rect of mergeMarkerRects(rects, vertical, gap)) {
            const box = document.createElement('span');
            box.className = `guide-search-mark${match.id === selectedId ? ' is-selected' : ''}`;
            box.dataset.searchMatchId = match.id;
            if (match.id === selectedId) box.dataset.searchSelected = 'true';
            box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
            (match.id === selectedId ? selected : normal).push(box);
          }
        }
      }
      host.replaceChildren(...normal, ...selected);
    };
    paint();
    const observer = new ResizeObserver(paint); observer.observe(row);
    document.fonts.addEventListener('loadingdone', paint);
    return () => { observer.disconnect(); document.fonts.removeEventListener('loadingdone', paint); host.replaceChildren(); };
  }, [units, matches, selectedId, vertical, layoutKey]);
  return <span ref={layer} className="guide-search-layer" aria-hidden="true" />;
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
