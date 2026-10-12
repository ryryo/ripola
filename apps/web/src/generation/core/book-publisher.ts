const PUBLICATION_INTERVAL_MS = 5000;

/** One generation runner owns the timer and drains it before correction/compression. */
export class BookPublisher {
  private timer?: ReturnType<typeof globalThis.setTimeout>;
  private writing?: Promise<void>;
  private lastPublishedAt?: number;
  private dirty = false;
  private closed = false;
  private failure?: { error: unknown };

  constructor(private readonly publish: () => Promise<void>) {}

  check(): void { if (this.failure) throw this.failure.error; }

  async changed(): Promise<void> {
    this.check();
    if (this.closed) throw new Error('Book publication is closed.');
    this.dirty = true;
    if (this.writing) { await this.writing; this.check(); return; }
    if (this.lastPublishedAt === undefined || Date.now() - this.lastPublishedAt >= PUBLICATION_INTERVAL_MS) {
      await this.write(); this.check();
    } else this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closed || this.failure || this.lastPublishedAt === undefined) return;
    const delay = Math.max(0, PUBLICATION_INTERVAL_MS - (Date.now() - this.lastPublishedAt));
    this.timer = globalThis.setTimeout(() => { this.timer = undefined; void this.write(); }, delay);
  }

  private write(): Promise<void> {
    if (this.writing) return this.writing;
    if (this.timer !== undefined) { globalThis.clearTimeout(this.timer); this.timer = undefined; }
    this.dirty = false;
    this.writing = Promise.resolve().then(this.publish).then(() => {
      this.lastPublishedAt = Date.now();
    }).catch(error => {
      // A timer must never reject unobserved. The runner checks before its next send.
      this.failure = { error };
    }).finally(() => {
      this.writing = undefined;
      if (this.dirty) this.schedule();
    });
    return this.writing;
  }

  async finish(): Promise<void> {
    await this.close();
    this.check();
    if (this.dirty || this.lastPublishedAt === undefined) { await this.write(); this.check(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) { globalThis.clearTimeout(this.timer); this.timer = undefined; }
    await this.writing;
  }
}
