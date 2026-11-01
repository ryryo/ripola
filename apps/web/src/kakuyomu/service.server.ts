import '@tanstack/react-start/server-only';
import { getRequest } from '@tanstack/react-start/server';
import { assertLocalRequest } from '../server/local-request';
import { loadGenerationConfig } from '../generation/core/config';
import { KakuyomuImporter } from './importer';
import type { KakuyomuJobView, KakuyomuPreview, LocalTextBook, LocalTextBookSummary } from './contracts';

const key = Symbol.for('ripola.local-kakuyomu-importer.v1');
const holders = globalThis as typeof globalThis & { [key]?: Promise<{ importer: KakuyomuImporter; localOrigin: string }> };

async function holder() {
  return holders[key] ??= loadGenerationConfig().then(config => {
    const importer = new KakuyomuImporter({ libraryDir: config.libraryDir });
    return { importer, localOrigin: config.localOrigin };
  });
}
/** Every local server function re-checks the loopback origin and Host. */
export async function localKakuyomu(): Promise<KakuyomuImporter> {
  const { importer, localOrigin } = await holder();
  assertLocalRequest(getRequest(), localOrigin);
  return importer;
}
export async function previewKakuyomuWork(url: string): Promise<KakuyomuPreview> {
  return (await localKakuyomu()).preview(url);
}
export async function startKakuyomuImport(url: string, parts: number[]): Promise<KakuyomuJobView> {
  return (await localKakuyomu()).start(url, parts);
}
export async function getKakuyomuJob(jobId: string): Promise<KakuyomuJobView> {
  return (await localKakuyomu()).getJob(jobId);
}
export async function listKakuyomuTextBooks(): Promise<LocalTextBookSummary[]> {
  return (await localKakuyomu()).listBooks();
}
export async function getKakuyomuTextBook(id: string, revision?: string): Promise<LocalTextBook> {
  return (await localKakuyomu()).getBook(id, revision);
}
