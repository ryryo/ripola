export interface HtmlPage { url: string; bytes: Uint8Array; fetchedAt: string }
interface Options { fetch?: typeof fetch; minIntervalMs?: number; timeoutMs?: number; maxBytes?: number; responseType?: 'html' | 'json' }

/** Local-only transport; each caller must supply its own exact URL allowlist. */
export class SequentialPageFetcher {
  private queue: Promise<void> = Promise.resolve();
  private lastFetch = 0;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly maximum: number;
  constructor(private readonly allowed: (url: string) => boolean, private readonly options: Options = {}) {
    this.interval = options.minIntervalMs ?? 1200;
    this.timeout = options.timeoutMs ?? 30_000;
    this.maximum = options.maxBytes ?? 4_000_000;
    if (!Number.isFinite(this.interval) || this.interval < 0 || !Number.isFinite(this.timeout) || this.timeout <= 0
      || !Number.isSafeInteger(this.maximum) || this.maximum < 1) throw new Error('取得間隔・timeout・容量上限が正しくありません。');
  }
  fetch = (url: string): Promise<HtmlPage> => {
    const run = this.queue.then(() => this.fetchOnce(url));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  };
  private async fetchOnce(url: string): Promise<HtmlPage> {
    if (!this.allowed(url)) throw new Error('このURLは取得対象ではありません。');
    const wait = Math.max(0, this.interval - (Date.now() - this.lastFetch));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastFetch = Date.now();
    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { accept: this.options.responseType === 'json' ? 'application/json' : 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) throw new Error(`ページを取得できませんでした（HTTP ${response.status}）。`);
    if (response.url && response.url !== url) throw new Error('取得先のURLが一致しません。');
    const media = this.options.responseType === 'json' ? /^application\/json(?:\s*;|$)/i : /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;
    if (!media.test(response.headers.get('content-type') ?? '')) throw new Error('取得したページの形式を確認できませんでした。');
    if (Number(response.headers.get('content-length')) > this.maximum) { await response.body?.cancel(); throw new Error('ページの容量が上限を超えています。'); }
    if (!response.body) throw new Error('ページの本文がありません。');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > this.maximum) { await reader.cancel(); throw new Error('ページの容量が上限を超えています。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { url, bytes, fetchedAt: new Date().toISOString() };
  }
}
export { SequentialPageFetcher as SequentialHtmlFetcher };
