export interface StoredUrlImportJob { jobId: string; url: string }

/** The key predates the common input integration; keeping it preserves reconnect. */
export const URL_IMPORT_STORAGE_KEY = 'ripola-kakuyomu-import-job';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}
export function readStoredUrlImportJob(target: { getItem(key: string): string | null } | undefined = storage()): StoredUrlImportJob | undefined {
  if (!target) return undefined;
  try {
    const raw = target.getItem(URL_IMPORT_STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as { jobId?: unknown; url?: unknown };
    if (typeof value.jobId !== 'string' || typeof value.url !== 'string') return undefined;
    return { jobId: value.jobId, url: value.url };
  } catch { return undefined; }
}
export function rememberUrlImportJob(job: { id: string; workUrl: string }): void {
  const target = storage();
  if (!target) return;
  try { target.setItem(URL_IMPORT_STORAGE_KEY, JSON.stringify({ jobId: job.id, url: job.workUrl })); } catch { /* Storage is optional. */ }
}
export function forgetUrlImportJob(): void {
  const target = storage();
  if (!target) return;
  try { target.removeItem(URL_IMPORT_STORAGE_KEY); } catch { /* Storage is optional. */ }
}
