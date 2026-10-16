import { Button, NativeSelect } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';
import { audioPositionKey, loadAudioPosition, type AudioPosition } from '../audio-position';
import { selectBookshelfBooks, type BookshelfBook, type BookshelfFilter, type BookshelfSort, type BookshelfOptions } from '../bookshelf';
import './bookshelf.css';

export function bookDurationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`;
}

export function Bookshelf<T extends BookshelfBook>({ books, options, onChange, children }: { books: readonly T[]; options: BookshelfOptions; onChange: (options: BookshelfOptions) => void; children: (book: T) => ReactNode }) {
  const { view, sort, filter } = options;
  const [positions, setPositions] = useState<ReadonlyMap<string, AudioPosition>>(new Map());
  useEffect(() => {
    const refresh = () => setPositions(new Map(books.map(book => [audioPositionKey(book), loadAudioPosition(book)])));
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith('rsvp-audio-position:') && !event.key.endsWith(':source')) refresh(); };
    const visible = () => { if (!document.hidden) refresh(); };
    refresh();
    window.addEventListener('storage', changed);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('pageshow', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [books]);
  const listed = selectBookshelfBooks(books, positions, sort, filter);
  return <section className="bookshelf" aria-label="本棚一覧">
    <div className="bookshelf-toolbar">
      <p className="bookshelf-count" role="status">{listed.length === books.length ? `${books.length}本` : `${listed.length} / ${books.length}本`}</p>
      <div className="bookshelf-view" role="group" aria-label="本棚の表示">
        <Button className="bookshelf-view-button" variant={view === 'list' ? 'light' : 'subtle'} aria-pressed={view === 'list'} onClick={() => onChange({ ...options, view: 'list' })} leftSection={<ViewIcon grid={false} />}>リスト</Button>
        <Button className="bookshelf-view-button" variant={view === 'grid' ? 'light' : 'subtle'} aria-pressed={view === 'grid'} onClick={() => onChange({ ...options, view: 'grid' })} leftSection={<ViewIcon grid />}>グリッド</Button>
      </div>
    </div>
    <div className="bookshelf-filters">
      <NativeSelect label="並べ替え" value={sort} onChange={event => onChange({ ...options, sort: event.currentTarget.value as BookshelfSort })} data={[{ value: 'standard', label: '本棚順' }, { value: 'title', label: 'タイトル順' }, { value: 'progress-desc', label: '進捗が多い順' }, { value: 'progress-asc', label: '進捗が少ない順' }]} />
      <NativeSelect label="絞り込み" value={filter} onChange={event => onChange({ ...options, filter: event.currentTarget.value as BookshelfFilter })} data={[{ value: 'all', label: 'すべて' }, { value: 'unfinished', label: '読了を非表示' }, { value: 'unread', label: '未読' }, { value: 'reading', label: '読書中' }, { value: 'completed', label: '読了' }]} />
    </div>
    {!listed.length && <div className="bookshelf-empty"><p>条件に合う本はありません。</p><Button variant="subtle" onClick={() => onChange({ ...options, filter: 'all' })}>絞り込みを解除</Button></div>}
    <ul className="library-grid bookshelf-items" data-view={view} aria-label="本の一覧">{listed.map(children)}</ul>
  </section>;
}

function ViewIcon({ grid }: { grid: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    {grid ? <><rect x="2" y="2" width="4.5" height="4.5" rx=".7" /><rect x="9.5" y="2" width="4.5" height="4.5" rx=".7" /><rect x="2" y="9.5" width="4.5" height="4.5" rx=".7" /><rect x="9.5" y="9.5" width="4.5" height="4.5" rx=".7" /></> : <><path d="M5 3h9M5 8h9M5 13h9" /><path d="M2 3h.5M2 8h.5M2 13h.5" strokeWidth="2" /></>}
  </svg>;
}
