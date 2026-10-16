import { audioPositionKey, audioPositionPercent, type AudioPosition } from './audio-position';

export type BookshelfBook = { id: string; revision: string; title: string; durationSeconds: number; completedChunks?: number; totalChunks?: number };
export type BookshelfSort = 'standard' | 'title' | 'progress-desc' | 'progress-asc';
export type BookshelfFilter = 'all' | 'unfinished' | 'unread' | 'reading' | 'completed';
export type BookshelfOptions = { view: 'list' | 'grid'; sort: BookshelfSort; filter: BookshelfFilter };
export const DEFAULT_BOOKSHELF_OPTIONS: BookshelfOptions = { view: 'list', sort: 'standard', filter: 'all' };

export function selectBookshelfBooks<T extends BookshelfBook>(books: readonly T[], positions: ReadonlyMap<string, AudioPosition>, sort: BookshelfSort, filter: BookshelfFilter): T[] {
  const entries = books.map(book => {
    const position = positions.get(audioPositionKey(book));
    const seconds = position?.status === 'saved' ? position.seconds : 0;
    const percent = position && position.status !== 'unavailable' ? audioPositionPercent(seconds, book.durationSeconds) : undefined;
    const incomplete = book.completedChunks !== undefined && book.totalChunks !== undefined && book.completedChunks < book.totalChunks;
    const status = !position || position.status === 'unavailable' ? 'unknown' : seconds === 0 ? 'unread'
      : !incomplete && percent === 100 ? 'completed' : 'reading';
    return { book, percent, status };
  }).filter(entry => filter === 'all' || (filter === 'unfinished' ? entry.status !== 'completed' : entry.status === filter));
  if (sort === 'title') entries.sort((a, b) => a.book.title.localeCompare(b.book.title, 'ja', { numeric: true }));
  else if (sort === 'progress-desc' || sort === 'progress-asc') entries.sort((a, b) => {
    if (a.percent === undefined || b.percent === undefined) return Number(a.percent === undefined) - Number(b.percent === undefined);
    return sort === 'progress-desc' ? b.percent - a.percent : a.percent - b.percent;
  });
  return entries.map(entry => entry.book);
}
