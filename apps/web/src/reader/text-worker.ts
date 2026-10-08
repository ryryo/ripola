import type { DraftDocument, ReadingDocument } from './model';
import { prepareDocument } from './segmentation';
import { importText } from './text-import';
import { importAozora } from './aozora-import';

export type TextWorkerRequest =
  | { type: 'text'; raw: string; format: 'txt' | 'md' | 'aozora'; title: string }
  | { type: 'draft'; draft: DraftDocument };
export type TextWorkerResponse =
  | { type: 'progress'; progress: number }
  | { type: 'result'; document: ReadingDocument }
  | { type: 'error'; message: string };

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TextWorkerRequest>) => void) | null;
  postMessage(message: TextWorkerResponse): void;
};
worker.onmessage = async (event) => {
  try {
    const request = event.data;
    const draft = request.type === 'text' ? request.format === 'aozora' ? importAozora(request.raw, request.title) : importText(request.raw, request.format, request.title) : request.draft;
    const document = await prepareDocument(draft, (progress) => worker.postMessage({ type: 'progress', progress }));
    worker.postMessage({ type: 'result', document });
  } catch (error) {
    worker.postMessage({ type: 'error', message: error instanceof Error ? error.message : '本文の処理に失敗しました。' });
  }
};
