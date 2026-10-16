import { Button, NativeSelect } from '@mantine/core';
import { useMemo, type ReactNode } from 'react';
import { audioPositionKey, type AudioPosition } from '../audio-position';
import { useAudioPositions } from './useAudioPositions';
import { selectBookshelfBooks, type BookshelfBook, type BookshelfFilter, type BookshelfOptions } from '../bookshelf';
import './bookshelf.css';

export function bookDurationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`;
}

export function Bookshelf<T extends BookshelfBook>({ books, options, onChange, children }: { books: readonly T[]; options: BookshelfOptions; onChange: (options: BookshelfOptions) => void; children: (book: T, position: AudioPosition | undefined) => ReactNode }) {
  const { view, sort, filter } = options;
  const positions = useAudioPositions(books);
  const listed = useMemo(() => selectBookshelfBooks(books, positions, sort, filter), [books, positions, sort, filter]);
  return <section className="bookshelf" aria-label="本棚一覧">
    <div className="bookshelf-toolbar">
      <p className="bookshelf-count" role="status">{listed.length === books.length ? `${books.length}本` : `${listed.length} / ${books.length}本`}</p>
      <div className="bookshelf-sort-control">
        <span className="bookshelf-control-label">並び順</span>
        <div className="bookshelf-sort bookshelf-toggle" role="group" aria-label="並び順">
          <Button variant={sort === 'newest' ? 'light' : 'subtle'} aria-pressed={sort === 'newest'} onClick={() => onChange({ ...options, sort: 'newest' })}>新しい順</Button>
          <Button variant={sort === 'oldest' ? 'light' : 'subtle'} aria-pressed={sort === 'oldest'} onClick={() => onChange({ ...options, sort: 'oldest' })}>古い順</Button>
        </div>
      </div>
      <NativeSelect className="bookshelf-filter" label="絞り込み" value={filter} onChange={event => onChange({ ...options, filter: event.currentTarget.value as BookshelfFilter })} data={[{ value: 'all', label: 'すべて' }, { value: 'unfinished', label: '読了を非表示' }, { value: 'unread', label: '未読' }, { value: 'reading', label: '読書中' }, { value: 'completed', label: '読了' }]} />
      <div className="bookshelf-view-control">
        <span className="bookshelf-control-label">表示</span>
        <div className="bookshelf-view bookshelf-toggle" role="group" aria-label="本棚の表示">
          <Button className="bookshelf-view-button" variant={view === 'list' ? 'light' : 'subtle'} aria-pressed={view === 'list'} onClick={() => onChange({ ...options, view: 'list' })} leftSection={<ViewIcon grid={false} />}>リスト</Button>
          <Button className="bookshelf-view-button" variant={view === 'grid' ? 'light' : 'subtle'} aria-pressed={view === 'grid'} onClick={() => onChange({ ...options, view: 'grid' })} leftSection={<ViewIcon grid />}>グリッド</Button>
        </div>
      </div>
    </div>
    {!listed.length && <div className="bookshelf-empty"><p>条件に合う本はありません。</p><Button variant="subtle" onClick={() => onChange({ ...options, filter: 'all' })}>絞り込みを解除</Button></div>}
    <ul className="library-grid bookshelf-items" data-view={view} aria-label="本の一覧">{listed.map(book => children(book, positions.get(audioPositionKey(book))))}</ul>
  </section>;
}

function ViewIcon({ grid }: { grid: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    {grid ? <><rect x="2" y="2" width="4.5" height="4.5" rx=".7" /><rect x="9.5" y="2" width="4.5" height="4.5" rx=".7" /><rect x="2" y="9.5" width="4.5" height="4.5" rx=".7" /><rect x="9.5" y="9.5" width="4.5" height="4.5" rx=".7" /></> : <><path d="M5 3h9M5 8h9M5 13h9" /><path d="M2 3h.5M2 8h.5M2 13h.5" strokeWidth="2" /></>}
  </svg>;
}
