import assert from 'node:assert/strict';
import test from 'node:test';
import { audioPositionKey, type AudioPosition } from '../src/reader/audio-position';
import { selectBookshelfBooks } from '../src/reader/bookshelf';

const books = [
  { id: 'partial', revision: 'v1', title: '本10', durationSeconds: 10, completedChunks: 1, totalChunks: 2 },
  { id: 'completed', revision: 'v1', title: '本2', durationSeconds: 10, completedChunks: 2, totalChunks: 2 },
  { id: 'reading', revision: 'v1', title: '本3', durationSeconds: 10, completedChunks: 2, totalChunks: 2 },
  { id: 'unread', revision: 'v1', title: '本4', durationSeconds: 10, completedChunks: 2, totalChunks: 2 },
  { id: 'unknown', revision: 'v1', title: '本5', durationSeconds: 10, completedChunks: 2, totalChunks: 2 },
];
const positions = new Map<string, AudioPosition>(books.map((book, index) => [audioPositionKey(book), index === 4 ? { status: 'unavailable' } : index === 3 ? { status: 'empty' } : { status: 'saved', seconds: index === 2 ? 5 : 10 }]));
const ids = (values: typeof books) => values.map(book => book.id);

test('bookshelf completion excludes partial audio and does not misclassify unavailable positions as unread', () => {
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'newest', 'completed')), ['completed']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'newest', 'reading')), ['partial', 'reading']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'newest', 'unread')), ['unread']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'newest', 'unfinished')), ['partial', 'reading', 'unread', 'unknown']);
});

test('bookshelf switches between newest and oldest dates without changing source order', () => {
  const dated = books.slice(0, 3).map((book, index) => ({ ...book, updatedAt: ['2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-01T00:00:00Z'][index] }));
  const original = ids(dated);
  assert.deepEqual(ids(selectBookshelfBooks(dated, positions, 'newest', 'all')), ['completed', 'partial', 'reading']);
  assert.deepEqual(ids(selectBookshelfBooks(dated, positions, 'oldest', 'all')), ['reading', 'partial', 'completed']);
  assert.deepEqual(ids(selectBookshelfBooks(dated, positions, 'oldest', 'reading')), ['reading', 'partial']);
  assert.deepEqual(ids(dated), original);
});

test('undated and invalid-date books retain catalog order and reverse with the toggle', () => {
  const undated = books.map((book, index) => ({ ...book, updatedAt: index === 1 ? 'not-a-date' : undefined }));
  assert.deepEqual(ids(selectBookshelfBooks(undated, positions, 'newest', 'all')), ids(books));
  assert.deepEqual(ids(selectBookshelfBooks(undated, positions, 'oldest', 'all')), ids(books).reverse());
  const mixed = [{ ...books[0], updatedAt: '2026-10-01T00:00:00Z' }, ...undated.slice(1)];
  assert.deepEqual(ids(selectBookshelfBooks(mixed, positions, 'oldest', 'all')), ['partial', 'unknown', 'unread', 'reading', 'completed']);
});
