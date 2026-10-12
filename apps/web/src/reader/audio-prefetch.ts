import type { PlayableAudioChunk } from './audio-clock';

export interface PrefetchEnvironment { saveData?: boolean; downlink?: number; rtt?: number; deviceMemory?: number }
export function browserPrefetchEnvironment(): PrefetchEnvironment {
  if (typeof navigator === 'undefined') return {};
  const device = navigator as Navigator & { connection?: PrefetchEnvironment; deviceMemory?: number };
  return { ...device.connection, saveData: device.connection?.saveData, downlink: device.connection?.downlink, rtt: device.connection?.rtt, deviceMemory: device.deviceMemory };
}
export function audioAssetKey(chunk: PlayableAudioChunk): string {
  return JSON.stringify([chunk.id, chunk.audioUrl, chunk.durationSeconds, chunk.mimeType]);
}
export function audioBufferReadyForAhead(media: { duration: number; buffered: Pick<TimeRanges, 'length' | 'start' | 'end'> }, durationSeconds: number): boolean {
  const duration = media.duration, buffered = media.buffered;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || buffered.length !== 1) return false;
  const start = buffered.start(0), end = buffered.end(0);
  return Number.isFinite(start) && start <= .05 && Number.isFinite(end) && end >= Math.max(duration, durationSeconds) - .05;
}
type Entry = { chunk: PlayableAudioChunk; abort: AbortController; bytes: number; url?: string; started: boolean };
type Dependencies = { fetch: typeof fetch; createURL: (blob: Blob) => string; revokeURL: (url: string) => void; now: () => number };

/** Owns only speculative bytes/URLs. Playback and its currentTime stay native. */
export class AudioPrefetch {
  private entries = new Map<string, Entry>();
  private activeKey = '';
  private busy = 0;
  private disposed = false;
  private latency = 1;
  private budget: number;
  private concurrency: number;
  private environment: PrefetchEnvironment;
  private dependencies: Dependencies;

  constructor(environment: PrefetchEnvironment = {}, dependencies: Partial<Dependencies> = {}) {
    this.environment = environment;
    this.budget = environment.saveData ? 1024 * 1024 : (environment.deviceMemory ?? 8) <= 2 ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
    this.concurrency = environment.saveData || (environment.downlink ?? 10) < 1 ? 1 : 2;
    this.dependencies = { fetch: globalThis.fetch.bind(globalThis), createURL: blob => URL.createObjectURL(blob), revokeURL: url => URL.revokeObjectURL(url), now: () => performance.now(), ...dependencies };
  }

  source(chunk: PlayableAudioChunk): string { return this.entries.get(audioAssetKey(chunk))?.url ?? chunk.audioUrl; }

  /** Reconcile on playback, seek, pause and revision. Never reorder source chunks. */
  update(chunks: PlayableAudioChunk[], current: number, localSeconds: number, rate: number, enabled: boolean, readyForAhead = true): void {
    if (this.disposed) return;
    this.activeKey = chunks[current] ? audioAssetKey(chunks[current]) : '';
    const active = this.entries.get(this.activeKey);
    if (active && !active.url) this.release(this.activeKey, active);
    const wanted = new Map<string, PlayableAudioChunk>();
    if (enabled && chunks[current]) {
      const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
      const horizon = this.environment.saveData ? 0 : Math.min(40, Math.max(8, 2 * this.latency + (this.environment.rtt ?? 0) / 1000 + 4));
      let seconds = Math.max(0, chunks[current].durationSeconds - localSeconds) / speed;
      let bytes = this.entries.get(this.activeKey)?.bytes ?? 0;
      const maxAhead = this.environment.saveData ? 1 : 6;
      for (let i = current + 1; i < chunks.length && wanted.size < maxAhead; i++) {
        // Always try the immediate successor, even when this file is long.
        if (wanted.size && seconds >= horizon) break;
        const chunk = chunks[i];
        const key = audioAssetKey(chunk);
        const estimate = this.entries.get(key)?.bytes || chunk.durationSeconds * (chunk.mimeType === 'audio/wav' ? 48000 : 16000);
        if (bytes + estimate > this.budget) break;
        bytes += estimate; wanted.set(key, chunk); seconds += chunk.durationSeconds / speed;
      }
    }
    for (const [key, entry] of this.entries) if (key !== this.activeKey && (!wanted.has(key) || !readyForAhead && !entry.url)) this.release(key, entry);
    if (readyForAhead) for (const [key, chunk] of wanted) if (!this.entries.has(key)) this.entries.set(key, { chunk, abort: new AbortController(), bytes: 0, started: false });
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    for (const [key, entry] of this.entries) this.release(key, entry);
  }

  private release(key: string, entry: Entry): void {
    this.entries.delete(key); entry.abort.abort();
    if (entry.url) this.dependencies.revokeURL(entry.url);
  }
  private residentBytes(): number { return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0); }
  private pump(): void {
    if (this.disposed) return;
    for (const [key, entry] of this.entries) {
      if (this.busy >= this.concurrency) break;
      if (entry.started || key === this.activeKey) continue;
      entry.started = true; this.busy++;
      void this.load(key, entry).finally(() => { this.busy--; this.pump(); });
    }
  }
  private async load(key: string, entry: Entry): Promise<void> {
    const started = this.dependencies.now();
    const timeout = setTimeout(() => entry.abort.abort(), 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.dependencies.fetch(entry.chunk.audioUrl, { signal: entry.abort.signal, credentials: 'same-origin' });
      if (!response.ok || !response.body) throw new Error('Prefetch unavailable');
      reader = response.body.getReader();
      const length = Number(response.headers.get('content-length'));
      if (length > this.budget - this.residentBytes()) throw new Error('Prefetch budget');
      const parts: Uint8Array<ArrayBuffer>[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (entry.abort.signal.aborted || this.entries.get(key) !== entry) throw new Error('Stale prefetch');
        if (done) break;
        if (this.residentBytes() + value.byteLength > this.budget) throw new Error('Prefetch budget');
        entry.bytes += value.byteLength; parts.push(new Uint8Array(value));
      }
      if (!entry.bytes) throw new Error('Empty prefetch');
      const blob = new Blob(parts, { type: entry.chunk.mimeType ?? response.headers.get('content-type') ?? '' });
      entry.url = this.dependencies.createURL(blob);
      // Include transfer and Blob processing; this is a rolling scheduling hint.
      this.latency = Math.max(.1, .5 * this.latency + .5 * (this.dependencies.now() - started) / 1000);
    } catch {
      // The current audio can still use its normal URL/Range path. Do not retry
      // speculative failures in a loop or turn them into playback errors.
      entry.bytes = 0;
      entry.abort.abort();
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => undefined);
    }
  }
}
