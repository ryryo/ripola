import { createServerFn } from '@tanstack/react-start';
import { getLocalReadingLibrary } from './reading.server';

export const listLibrary = createServerFn({ method: 'GET' }).handler(async () => (await getLocalReadingLibrary()).listLibrary());
export const getBook = createServerFn({ method: 'GET' }).validator((data: { bookId: string; revision?: string }) => data).handler(async ({ data }) => (await getLocalReadingLibrary()).getBook(data.bookId, data.revision));
export const getReadingUpdate = createServerFn({ method: 'GET' }).validator((data: { bookId: string; revision: string; version?: string; jobId?: string }) => data)
  .handler(async ({ data }) => (await getLocalReadingLibrary()).update(data.bookId, data.revision, data.version, data.jobId));
export const listReadingJobs = createServerFn({ method: 'GET' }).handler(async () => (await getLocalReadingLibrary()).listReadingJobs());
