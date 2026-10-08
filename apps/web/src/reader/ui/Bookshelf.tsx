import { Button } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import './bookshelf.css';

export function bookDurationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`;
}

export function Bookshelf({ count, children }: { count: number; children: ReactNode }) {
  const [view, setView] = useState<'list' | 'grid'>('list');
  return <section className="bookshelf" aria-label="本棚一覧">
    <div className="bookshelf-toolbar">
      <p className="bookshelf-count">{count}本</p>
      <div className="bookshelf-view" role="group" aria-label="本棚の表示">
        <Button className="bookshelf-view-button" variant={view === 'list' ? 'light' : 'subtle'} aria-pressed={view === 'list'} onClick={() => setView('list')} leftSection={<ViewIcon grid={false} />}>リスト</Button>
        <Button className="bookshelf-view-button" variant={view === 'grid' ? 'light' : 'subtle'} aria-pressed={view === 'grid'} onClick={() => setView('grid')} leftSection={<ViewIcon grid />}>グリッド</Button>
      </div>
    </div>
    <ul className="library-grid bookshelf-items" data-view={view} aria-label="本の一覧">{children}</ul>
  </section>;
}

function ViewIcon({ grid }: { grid: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    {grid ? <><rect x="2" y="2" width="4.5" height="4.5" rx=".7" /><rect x="9.5" y="2" width="4.5" height="4.5" rx=".7" /><rect x="2" y="9.5" width="4.5" height="4.5" rx=".7" /><rect x="9.5" y="9.5" width="4.5" height="4.5" rx=".7" /></> : <><path d="M5 3h9M5 8h9M5 13h9" /><path d="M2 3h.5M2 8h.5M2 13h.5" strokeWidth="2" /></>}
  </svg>;
}
