import { assertAllowedKakuyomuUrl, type SourceAccess } from './parser';

export interface FetchedPage { bytes: Uint8Array; url: string; fetchedAt: string; contentType?: string }
export type PageFetch = (url: string, access: SourceAccess) => Promise<FetchedPage>;

export interface SequentialFetchOptions {
  fetch?: typeof fetch;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
}

/**
 * Local HTTP acquisition. Only exact Kakuyomu work/episode URLs pass, redirects
 * are errors, responses are bounded, and requests are strictly sequential.
 */
export class SequentialKakuyomuFetcher {
  private lastFetch = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly interval: number;
  private readonly timeout: number;
  private readonly maximum: number;
  private readonly now: () => number;
  constructor(private readonly options: SequentialFetchOptions = {}) {
    this.interval = options.minIntervalMs ?? 1200;
    this.timeout = options.timeoutMs ?? 30_000;
    this.maximum = options.maxBytes ?? 3_000_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.interval) || this.interval < 0 || !Number.isFinite(this.timeout) || this.timeout <= 0 || !Number.isSafeInteger(this.maximum) || this.maximum < 1) {
      throw new Error('取得間隔・timeout・容量の設定が正しくありません。');
    }
  }
  /**
   * Calls are serialized even when several tabs/requests reach the same
   * process at once; the interval is measured from the previous request start.
   */
  fetch = (url: string, access: SourceAccess): Promise<FetchedPage> => {
    const run = this.queue.then(() => this.fetchOnce(url, access));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  };
  private async fetchOnce(url: string, access: SourceAccess): Promise<FetchedPage> {
    const expected = assertAllowedKakuyomuUrl(url, access);
    const wait = Math.max(0, this.interval - (this.now() - this.lastFetch));
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastFetch = this.now();
    const request = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await request(expected, {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('公開ページの取得が時間内に完了しませんでした。', { cause: error });
      throw new Error('公開ページを取得できませんでした。通信を確認し、時間をおいて再試行してください。', { cause: error });
    }
    if (!response.ok) throw new Error(`公開ページを取得できません: HTTP ${response.status}。ログイン・CAPTCHA・制限は回避しません。`);
    if (response.url && response.url !== expected) throw new Error('公開ページのURLが取得先と一致しません。');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > this.maximum) throw new Error('公開ページの容量が上限を超えています。');
    const bytes = await this.readBounded(response);
    return { bytes, url: expected, fetchedAt: new Date().toISOString(), ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type')! } : {}) };
  }
  private async readBounded(response: Response): Promise<Uint8Array> {
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maximum) throw new Error('公開ページの容量が上限を超えています。');
      return bytes;
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maximum) { await reader.cancel().catch(() => undefined); throw new Error('公開ページの容量が上限を超えています。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
}
