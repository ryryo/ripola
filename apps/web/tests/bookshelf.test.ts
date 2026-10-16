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
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'standard', 'completed')), ['completed']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'standard', 'reading')), ['partial', 'reading']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'standard', 'unread')), ['unread']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'standard', 'unfinished')), ['partial', 'reading', 'unread', 'unknown']);
});

test('bookshelf sorting keeps unknown progress last, compares numeric titles, and preserves catalog order', () => {
  const original = ids(books);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'progress-desc', 'all')), ['partial', 'completed', 'reading', 'unread', 'unknown']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'progress-asc', 'all')), ['unread', 'reading', 'partial', 'completed', 'unknown']);
  assert.deepEqual(ids(selectBookshelfBooks(books, positions, 'title', 'all')), ['completed', 'reading', 'unread', 'unknown', 'partial']);
  assert.deepEqual(ids(books), original);
});
