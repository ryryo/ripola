import { Button, Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SentenceLocation } from '../sentences';
import './navigation.css';

export function NavigationLayout({ children, entries, current, onJump, onPause, onResume, chapters = [], playing = false }: {
  children: ReactNode; entries: SentenceLocation[]; current: number; onJump: (target: number) => void; onPause: () => void;
  playing?: boolean;
  onResume?: () => void;
  chapters?: Array<{ title: string; target: number }>;
}) {
  const mobile = useMediaQuery('(max-width: 900px)', false);
  const [expanded, setExpanded] = useState(false); const [drawer, setDrawer] = useState(false); const id = useId();
  const [stoppedCurrent, setStoppedCurrent] = useState(current);
  useEffect(() => { if (!playing) setStoppedCurrent(current); }, [current, playing]);
  useEffect(() => { if (playing) { setExpanded(false); setDrawer(false); } }, [playing]);
  const navigate = (target: number) => { onPause(); onJump(target); setDrawer(false); };
  const panel = <SentencePanel entries={entries} current={playing ? stoppedCurrent : current} onJump={navigate} chapters={chapters} />;
  return <div className="navigation-layout" data-expanded={expanded && !mobile && !playing}>
    <div className="navigation-reading"><div className="navigation-toolbar"><Button variant="subtle" size="sm" aria-controls={id} aria-expanded={!playing && (mobile ? drawer : expanded)}
      onClick={() => { onPause(); if (mobile) setDrawer(true); else setExpanded(value => !value); }}>{mobile ? '文一覧を開く' : expanded ? '文一覧を閉じる' : '文一覧を開く'}</Button></div>{children}</div>
    {!mobile && expanded && !playing && <aside id={id} className="navigation-sidebar" aria-label="文を移動" onPointerDownCapture={onPause} onKeyDownCapture={onPause}>{panel}</aside>}
    <Drawer opened={mobile && drawer && !playing} onClose={() => setDrawer(false)} position="right" title="文を移動" size="md" closeButtonProps={{ 'aria-label': '文一覧を閉じる' }}><div id={mobile ? id : undefined}>{drawer && !playing && panel}</div>{onResume && <Button fullWidth mt="md" onClick={() => { setDrawer(false); onResume(); }}>一覧を閉じて再生</Button>}</Drawer>
  </div>;
}

function SentencePanel({ entries, current, onJump, chapters }: {
  entries: SentenceLocation[]; current: number; onJump: (target: number) => void; chapters: Array<{ title: string; target: number }>;
}) {
  const scroll = useRef<HTMLDivElement>(null); const [scrollTop, setScrollTop] = useState(0); const [jump, setJump] = useState('');
  const rowHeight = 76; const viewport = 456; const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 3); const end = Math.min(entries.length, first + 13);
  useEffect(() => {
    const panel = scroll.current; if (!panel) return;
    const top = current * rowHeight; const bottom = top + rowHeight;
    if (top < panel.scrollTop || bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = Math.max(0, top - panel.clientHeight / 2 + rowHeight / 2);
    setScrollTop(panel.scrollTop);
  }, [current]);
  const submit = () => { const value = Number(jump); if (Number.isInteger(value) && value >= 1 && value <= entries.length) { onJump(entries[value - 1].target); setJump(''); } };
  return <div className="sentence-panel">
    <div className="sentence-panel-heading"><h2>文を移動</h2><span data-testid="sentence-count">{current + 1} / {entries.length} 文</span></div>
    <p className="navigation-hint">文を選ぶと、その位置で停止します。位置表示は一時停止時に更新します。</p>
    <div className="sentence-navigation-buttons"><Button variant="light" disabled={current <= 0} onClick={() => onJump(entries[current - 1].target)}>前の文へ移動</Button><Button variant="light" disabled={current >= entries.length - 1} onClick={() => onJump(entries[current + 1].target)}>次の文へ移動</Button></div>
    {chapters.length > 0 && <label className="chapter-jump">章から移動<select aria-label="章から移動" value="" onChange={event => { if (event.target.value) onJump(Number(event.target.value)); }}><option value="">章を選ぶ</option>{chapters.map(chapter => <option key={chapter.target} value={chapter.target}>第{chapter.title}章</option>)}</select></label>}
    <form className="sentence-jump" onSubmit={event => { event.preventDefault(); submit(); }}><label>文番号<input aria-label="移動する文番号" type="number" min="1" max={entries.length} value={jump} onChange={event => setJump(event.target.value)} placeholder={String(current + 1)} /></label><Button type="submit" variant="light" disabled={!jump || Number(jump) < 1 || Number(jump) > entries.length}>移動</Button></form>
    <div ref={scroll} className="sentence-list" style={{ height: viewport }} role="list" aria-label="文一覧" data-testid="sentence-list" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      <div style={{ height: entries.length * rowHeight, position: 'relative' }}>{entries.slice(first, end).map((entry, index) => <div role="listitem" key={entry.id} style={{ position: 'absolute', top: (first + index) * rowHeight, height: rowHeight, width: '100%' }}>
        <button type="button" className="sentence-row" aria-current={first + index === current ? 'location' : undefined} title={entry.text} onClick={() => onJump(entry.target)}><span className="sentence-number">{first + index + 1}</span><span className="sentence-text">{entry.text}</span></button>
      </div>)}</div>
    </div>
  </div>;
}
