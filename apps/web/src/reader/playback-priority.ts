export interface PlaybackPriority { jobId: string; chunkIds: string[] }
/** Coalesce rapid seeks; an older priority RPC cannot overtake a newer one. */
export class PlaybackPriorityQueue {
  private readonly abort = new AbortController();
  private pending?: PlaybackPriority;
  private running = false;
  private lastKey = '';
  constructor(private readonly send: (priority: PlaybackPriority, signal: AbortSignal) => Promise<unknown>) {}
  update(priority: PlaybackPriority) {
    if (this.abort.signal.aborted) return;
    const key = JSON.stringify(priority);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.pending = priority.chunkIds.length ? priority : undefined;
    if (!this.running) void this.drain();
  }
  private async drain() {
    this.running = true;
    while (this.pending && !this.abort.signal.aborted) {
      const priority = this.pending;
      this.pending = undefined;
      try { await this.send(priority, this.abort.signal); }
      catch { if (!this.pending) this.lastKey = ''; }
    }
    this.running = false;
  }
  dispose() { this.pending = undefined; this.abort.abort(); }
}
