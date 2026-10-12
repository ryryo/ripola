import type { AlignmentRuntimeResult } from './alignment-adapter';

export const ALIGNMENT_WORKER_PROTOCOL = 1;
export const MAX_ALIGNMENT_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_ALIGNMENT_RESPONSE_BYTES = 4 * 1024 * 1024;
export const ALIGNMENT_CONFIDENCE_MEANING = 'transcript-conditioned-ctc';

export type WorkerFrame =
  | { protocolVersion: 1; type: 'ready'; method: 'forced-alignment'; confidenceMeaning: typeof ALIGNMENT_CONFIDENCE_MEANING; alignerVersion: string }
  | { protocolVersion: 1; type: 'result'; id: string; method: 'forced-alignment'; confidenceMeaning: typeof ALIGNMENT_CONFIDENCE_MEANING; result: AlignmentRuntimeResult }
  | { protocolVersion: 1; type: 'error'; id: string; code: 'request-failed' | 'resources-changed' };

/** Bytes, not stream chunks, delimit frames. stdout contains only UTF-8 JSON Lines. */
export class AlignmentFrameDecoder {
  private buffer = Buffer.alloc(0);
  get incomplete(): boolean { return this.buffer.length > 0; }
  push(part: Buffer): WorkerFrame[] {
    const data = Buffer.concat([this.buffer, part]);
    const frames: WorkerFrame[] = [];
    let start = 0;
    let end: number;
    while ((end = data.indexOf(10, start)) >= 0) {
      if (end - start > MAX_ALIGNMENT_RESPONSE_BYTES) throw new Error('oversized-frame');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end))) as WorkerFrame;
      if (!value || value.protocolVersion !== ALIGNMENT_WORKER_PROTOCOL) throw new Error('invalid-protocol');
      if (value.type === 'ready' || value.type === 'result') {
        if (value.method !== 'forced-alignment' || value.confidenceMeaning !== ALIGNMENT_CONFIDENCE_MEANING) throw new Error('invalid-method');
        if (value.type === 'ready' && typeof value.alignerVersion !== 'string') throw new Error('invalid-version');
      } else if (value.type !== 'error' || !['request-failed', 'resources-changed'].includes(value.code)) throw new Error('invalid-frame');
      if (value.type !== 'ready' && (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id))) throw new Error('invalid-id');
      frames.push(value);
      start = end + 1;
    }
    this.buffer = data.subarray(start);
    if (this.buffer.length > MAX_ALIGNMENT_RESPONSE_BYTES) throw new Error('oversized-frame');
    return frames;
  }
}
