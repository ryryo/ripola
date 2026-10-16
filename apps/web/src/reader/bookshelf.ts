import { audioPositionKey, audioPositionPercent, type AudioPosition } from './audio-position';

export type BookshelfBook = { id: string; revision: string; title: string; durationSeconds: number; updatedAt?: string; completedChunks?: number; totalChunks?: number };
export type BookshelfSort = 'newest' | 'oldest';
export type BookshelfFilter = 'all' | 'unfinished' | 'unread' | 'reading' | 'completed';
export type BookshelfOptions = { view: 'list' | 'grid'; sort: BookshelfSort; filter: BookshelfFilter };
export const DEFAULT_BOOKSHELF_OPTIONS: BookshelfOptions = { view: 'list', sort: 'newest', filter: 'all' };

export function selectBookshelfBooks<T extends BookshelfBook>(books: readonly T[], positions: ReadonlyMap<string, AudioPosition>, sort: BookshelfSort, filter: BookshelfFilter): T[] {
  const entries = books.map((book, index) => {
    const position = positions.get(audioPositionKey(book));
    const seconds = position?.status === 'saved' ? position.seconds : 0;
    const percent = position && position.status !== 'unavailable' ? audioPositionPercent(seconds, book.durationSeconds) : undefined;
    const incomplete = book.completedChunks !== undefined && book.totalChunks !== undefined && book.completedChunks < book.totalChunks;
    const status = !position || position.status === 'unavailable' ? 'unknown' : seconds === 0 ? 'unread'
      : !incomplete && percent === 100 ? 'completed' : 'reading';
    return { book, index, updated: Date.parse(book.updatedAt ?? ''), status };
  }).filter(entry => filter === 'all' || (filter === 'unfinished' ? entry.status !== 'completed' : entry.status === filter));
  entries.sort((a, b) => {
    const datedA = Number.isFinite(a.updated), datedB = Number.isFinite(b.updated);
    if (datedA !== datedB) return datedA ? -1 : 1;
    const dateOrder = datedA ? a.updated - b.updated : 0;
    // Legacy catalogs omit dates; their existing order is the newest-first fallback.
    return (sort === 'oldest' ? dateOrder : -dateOrder) || (sort === 'oldest' ? b.index - a.index : a.index - b.index);
  });
  return entries.map(entry => entry.book);
}
