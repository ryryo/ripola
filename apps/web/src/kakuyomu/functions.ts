import { createServerFn } from '@tanstack/react-start';
import {
  getKakuyomuJob as getJob, getKakuyomuTextBook as getBook, listKakuyomuTextBooks as listBooks,
  previewKakuyomuWork, startKakuyomuImport,
} from './service.server';
import type { KakuyomuJobView, KakuyomuPreview, LocalTextBook, LocalTextBookSummary } from './contracts';

function previewInput(data: { url: string }): { url: string } {
  if (!data || typeof data.url !== 'string' || data.url.length > 2048) throw new Error('カクヨムの作品URLを指定してください。');
  return { url: data.url };
}
function startInput(data: { url: string; parts: number[] }): { url: string; parts: number[] } {
  if (!data || typeof data.url !== 'string' || data.url.length > 2048 || !Array.isArray(data.parts) || data.parts.length > 10_000
    || !data.parts.every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('取り込む作品と章・節を指定してください。');
  return { url: data.url, parts: data.parts };
}
function jobInput(data: { jobId: string }): { jobId: string } {
  if (!data || typeof data.jobId !== 'string' || data.jobId.length > 64) throw new Error('取り込みジョブIDが正しくありません。');
  return data;
}
function bookInput(data: { bookId: string; revision?: string }): { bookId: string; revision?: string } {
  if (!data || typeof data.bookId !== 'string' || data.bookId.length > 128
    || (data.revision !== undefined && (typeof data.revision !== 'string' || data.revision.length > 128))) throw new Error('テキスト本の指定が正しくありません。');
  return data;
}

export const previewKakuyomu = createServerFn({ method: 'POST' }).validator(previewInput)
  .handler(async ({ data }): Promise<KakuyomuPreview> => previewKakuyomuWork(data.url));
export const startKakuyomu = createServerFn({ method: 'POST' }).validator(startInput)
  .handler(async ({ data }): Promise<KakuyomuJobView> => startKakuyomuImport(data.url, data.parts));
export const getKakuyomuJob = createServerFn({ method: 'GET' }).validator(jobInput)
  .handler(async ({ data }): Promise<KakuyomuJobView> => getJob(data.jobId));
export const listKakuyomuBooks = createServerFn({ method: 'GET' })
  .handler(async (): Promise<LocalTextBookSummary[]> => listBooks());
export const getKakuyomuBook = createServerFn({ method: 'GET' }).validator(bookInput)
  .handler(async ({ data }): Promise<LocalTextBook> => getBook(data.bookId, data.revision));
