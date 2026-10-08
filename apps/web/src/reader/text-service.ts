import type { DraftDocument, ReadingDocument } from './model';
import type { TextWorkerRequest, TextWorkerResponse } from './text-worker';

export interface ProcessingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

function process(request: TextWorkerRequest, options: ProcessingOptions): Promise<ReadingDocument> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('本文処理を取り消しました。', 'AbortError')); return; }
    if (typeof Worker === 'undefined') { reject(new Error('このブラウザはローカル本文処理用のWorkerに対応していません。')); return; }
    let worker: Worker;
    try { worker = new Worker(new URL('./text-worker.ts', import.meta.url), { type: 'module' }); }
    catch { reject(new Error('本文処理を開始できませんでした。ページを再読み込みして再試行してください。')); return; }
    let settled = false;
    const cleanup = () => {
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => { if (!settled) { cleanup(); reject(new DOMException('本文処理を取り消しました。', 'AbortError')); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<TextWorkerResponse>) => {
      if (settled) return;
      if (event.data.type === 'progress') options.onProgress?.(event.data.progress);
      else if (event.data.type === 'result') { cleanup(); resolve(event.data.document); }
      else { cleanup(); reject(new Error(event.data.message)); }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (!settled) { cleanup(); reject(new Error('本文処理に失敗しました。ページを再読み込みして再試行してください。')); }
    };
    worker.onmessageerror = () => { if (!settled) { cleanup(); reject(new Error('本文処理の結果を受け取れませんでした。')); } };
    try { worker.postMessage(request); }
    catch { cleanup(); reject(new Error('本文を処理用Workerへ渡せませんでした。')); }
  });
}

export function processText(raw: string, format: 'txt' | 'md' | 'aozora', title: string, options: ProcessingOptions = {}): Promise<ReadingDocument> {
  return process({ type: 'text', raw, format, title }, options);
}

export function processDraft(draft: DraftDocument, options: ProcessingOptions = {}): Promise<ReadingDocument> {
  return process({ type: 'draft', draft }, options);
}
