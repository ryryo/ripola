import { audioPositionKey, loadAudioPosition, type AudioPosition } from './audio-position';
import { selectBookshelfBooks, type BookshelfBook, type BookshelfFilter, type BookshelfSort } from './bookshelf';

/** A shelf entry together with the canonical detail URL used by the reader. */
export type BookNavigationBook = BookshelfBook & { href: string };
export type BookNavigationTarget = Pick<BookNavigationBook, 'id' | 'revision' | 'title' | 'href'>;
export type BookNavigation = { previous?: BookNavigationTarget; next?: BookNavigationTarget; shelfHref: string };

export function sameBook(a: { id: string; revision: string }, b: { id: string; revision: string }): boolean {
  return a.id === b.id && a.revision === b.revision;
}

/** Reads every shelf position once, so the shelf UI and this navigation agree. */
export function loadBookshelfPositions(books: readonly { id: string; revision: string }[]): ReadonlyMap<string, AudioPosition> {
  return new Map(books.map(book => [audioPositionKey(book), loadAudioPosition(book)]));
}

/** Reuses the shelf selector, then removes entries the reader cannot open. */
export function selectBookNavigationSnapshot<T extends BookNavigationBook>(
  books: readonly T[], positions: ReadonlyMap<string, AudioPosition>, sort: BookshelfSort, filter: BookshelfFilter, canRead: (book: T) => boolean,
): T[] {
  return selectBookshelfBooks(books, positions, sort, filter).filter(canRead);
}

/**
 * Resolves the previous/next books with the same selector as the shelf.
 * `preferred` is the frozen order captured when a shelf entry was opened;
 * it is only used while it still contains the current id/revision.
 */
export function buildBookNavigation<T extends BookNavigationBook>({
  books, positions, sort, filter, current, canRead, preferred,
}: {
  books: readonly T[]; positions: ReadonlyMap<string, AudioPosition>; sort: BookshelfSort; filter: BookshelfFilter;
  current: { id: string; revision: string }; canRead: (book: T) => boolean; preferred?: readonly T[] | null;
}): { list: T[]; index: number; total: number; previous?: T; next?: T } {
  const select = (value: BookshelfFilter) => selectBookNavigationSnapshot(books, positions, sort, value, canRead);
  // Re-apply canRead to the frozen snapshot so a book that became unreadable
  // while reading is still skipped, without letting progress reorder the rest.
  const frozen = preferred?.filter(canRead);
  let list = frozen?.some(book => sameBook(book, current)) ? [...frozen] : select(filter);
  // A direct URL can point at a book hidden by the current filter. Fall back
  // to the complete sorted shelf for a stable, useful pair of neighbors.
  if (!list.some(book => sameBook(book, current)) && filter !== 'all') list = select('all');
  const index = list.findIndex(book => sameBook(book, current));
  return {
    list, index, total: list.length,
    previous: index > 0 ? list[index - 1] : undefined,
    next: index >= 0 ? list[index + 1] : undefined,
  };
}
