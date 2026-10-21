import assert from 'node:assert/strict';
import test from 'node:test';
import { audioPositionKey, type AudioPosition } from '../src/reader/audio-position';
import { buildBookNavigation, selectBookNavigationSnapshot, type BookNavigationBook } from '../src/reader/book-navigation';

type ShelfBook = BookNavigationBook & { completedChunks: number; totalChunks: number; demo?: boolean };

const href = (book: { id: string; revision: string }) => `/library?book=${book.id}&revision=${book.revision}`;
const book = (id: string, revision: string, updatedAt: string, completedChunks = 2): ShelfBook => ({
  id, revision, title: `本 ${id}`, updatedAt, completedChunks, totalChunks: 2, durationSeconds: 60, href: href({ id, revision }),
});
const books: ShelfBook[] = [
  book('a', 'r1', '2026-10-01T00:00:00Z'),
  book('b', 'r1', '2026-10-03T00:00:00Z'),
  book('c', 'r1', '2026-10-02T00:00:00Z'),
  { ...book('demo', 'r1', '2026-10-04T00:00:00Z'), demo: true },
  book('empty', 'r1', '2026-10-05T00:00:00Z', 0),
];
const canRead = (value: ShelfBook) => value.completedChunks > 0 && !value.demo;
function positionsFor(values: Partial<Record<string, AudioPosition>>): ReadonlyMap<string, AudioPosition> {
  return new Map(books.map(value => [audioPositionKey(value), values[value.id] ?? { status: 'empty' }]));
}
const ids = (values: readonly ShelfBook[]) => values.map(value => `${value.id}:${value.revision}`);

test('navigation snapshot reuses shelf order and omits demo-only or unreadable entries', () => {
  assert.deepEqual(ids(selectBookNavigationSnapshot(books, positionsFor({}), 'newest', 'all', canRead)), ['b:r1', 'c:r1', 'a:r1']);
  assert.deepEqual(ids(selectBookNavigationSnapshot(books, positionsFor({}), 'oldest', 'all', canRead)), ['a:r1', 'c:r1', 'b:r1']);
  assert.deepEqual(ids(selectBookNavigationSnapshot(books, positionsFor({ a: { status: 'saved', seconds: 10 }, b: { status: 'saved', seconds: 60 } }), 'newest', 'reading', canRead)), ['a:r1']);
});

test('neighbors follow the selected order, never wrap, and handle one or no books', () => {
  const newest = buildBookNavigation({ books, positions: positionsFor({}), sort: 'newest', filter: 'all', current: books[1], canRead });
  assert.equal(newest.index, 0);
  assert.equal(newest.total, 3);
  assert.equal(newest.previous, undefined);
  assert.equal(newest.next?.id, 'c');

  const middle = buildBookNavigation({ books, positions: positionsFor({}), sort: 'newest', filter: 'all', current: books[2], canRead });
  assert.equal(middle.previous?.id, 'b');
  assert.equal(middle.next?.id, 'a');

  const oldest = buildBookNavigation({ books, positions: positionsFor({}), sort: 'oldest', filter: 'all', current: books[2], canRead });
  assert.equal(oldest.previous?.id, 'a');
  assert.equal(oldest.next?.id, 'b');

  const last = buildBookNavigation({ books, positions: positionsFor({}), sort: 'newest', filter: 'all', current: books[0], canRead });
  assert.equal(last.next, undefined);
  assert.equal(last.previous?.id, 'c');

  const single = buildBookNavigation({ books: [books[0]], positions: positionsFor({}), sort: 'newest', filter: 'all', current: books[0], canRead });
  assert.deepEqual({ previous: single.previous, next: single.next, index: single.index, total: single.total }, { previous: undefined, next: undefined, index: 0, total: 1 });
  const none = buildBookNavigation({ books: [], positions: new Map(), sort: 'newest', filter: 'all', current: books[0], canRead });
  assert.deepEqual({ previous: none.previous, next: none.next, index: none.index, total: none.total }, { previous: undefined, next: undefined, index: -1, total: 0 });
});

test('id and revision are both required to identify a book', () => {
  const current = { ...books[1], revision: 'other' };
  const result = buildBookNavigation({ books, positions: positionsFor({}), sort: 'newest', filter: 'all', current, canRead });
  assert.equal(result.index, -1);
  assert.equal(result.previous, undefined);
  assert.equal(result.next, undefined);
  assert.deepEqual(ids(result.list), ['b:r1', 'c:r1', 'a:r1']);
});

test('a frozen shelf order survives progress changes in another tab', () => {
  const reading = positionsFor({ a: { status: 'saved', seconds: 1 }, b: { status: 'saved', seconds: 1 }, c: { status: 'saved', seconds: 1 } });
  const before = selectBookNavigationSnapshot(books, reading, 'newest', 'reading', canRead);
  assert.deepEqual(ids(before), ['b:r1', 'c:r1', 'a:r1']);
  // a reaches the end while the reader is open; a would disappear from a live
  // 'reading' selection, but the frozen entry order still points b -> c -> a.
  const progressed = positionsFor({ a: { status: 'saved', seconds: 60 }, b: { status: 'saved', seconds: 1 }, c: { status: 'saved', seconds: 1 } });
  const frozen = buildBookNavigation({ books, positions: progressed, sort: 'newest', filter: 'reading', current: books[2], canRead, preferred: before });
  assert.deepEqual(ids(frozen.list), ['b:r1', 'c:r1', 'a:r1']);
  assert.equal(frozen.previous?.id, 'b');
  assert.equal(frozen.next?.id, 'a');
  const live = buildBookNavigation({ books, positions: progressed, sort: 'newest', filter: 'reading', current: books[2], canRead });
  assert.equal(live.next, undefined);
});

test('a direct URL hidden by the current filter falls back to the full sorted shelf', () => {
  const reading = selectBookNavigationSnapshot(books, positionsFor({}), 'newest', 'reading', canRead);
  assert.deepEqual(ids(reading), []);
  const result = buildBookNavigation({ books, positions: positionsFor({}), sort: 'newest', filter: 'reading', current: books[1], canRead });
  assert.deepEqual(ids(result.list), ['b:r1', 'c:r1', 'a:r1']);
  assert.equal(result.previous, undefined);
  assert.equal(result.next?.id, 'c');
});

test('a stale frozen snapshot falls back to a freshly selected order', () => {
  const stale = [books[0], books[1]].filter(canRead);
  const result = buildBookNavigation({ books, positions: positionsFor({}), sort: 'newest', filter: 'all', current: books[2], canRead, preferred: stale });
  assert.deepEqual(ids(result.list), ['b:r1', 'c:r1', 'a:r1']);
  assert.equal(result.next?.id, 'a');
});

test('positions stay keyed by the id and revision pair', () => {
  assert.deepEqual([...positionsFor({}).keys()], books.map(audioPositionKey));
});
