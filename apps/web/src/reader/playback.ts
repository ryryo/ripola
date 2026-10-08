import { DEFAULT_SETTINGS, type ReaderSettings, type ReadingDocument, type ReadingUnit, type SourceAnchor } from './model.ts';

export interface PlaybackSnapshot {
  index: number;
  status: 'paused' | 'playing' | 'completed';
}

/** Injectable clock for deterministic tests; the browser implementation uses monotonic time. */
export interface PlaybackScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserScheduler: PlaybackScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const pauses: Record<ReadingUnit['pause'], number> = {
  none: 0, comma: 100, sentence: 250, paragraph: 400, heading: 600,
};

/** Static code/table units never advance on a timer and contribute no RSVP duration. */
export function durationMs(unit: ReadingUnit, settings: ReaderSettings): number {
  if (unit.kind === 'static') return 0;
  const cpm = Number.isFinite(settings.cpm)
    ? Math.min(3000, Math.max(100, settings.cpm))
    : DEFAULT_SETTINGS.cpm;
  return Math.max(100, 60_000 * unit.characters / cpm)
    + (settings.punctuationPause ? pauses[unit.pause] : 0);
}

function boundedIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(length - 1, Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0));
}

export interface PlaybackProgress {
  fraction: number;
  unitElapsedMs: number;
  unitDurationMs: number;
  remainingMs: number;
}

/** One playback timer. Rendering samples the same monotonic clock without React frame updates. */
export class PlaybackController {
  private settings: ReaderSettings;
  private units: ReadingUnit[] = [];
  private snapshot: PlaybackSnapshot = { index: 0, status: 'paused' };
  private listeners = new Set<() => void>();
  private timer: unknown;
  private generation = 0;
  private disposed = false;
  private prefix: number[] = [0];
  private unitDuration = 0;
  private unitElapsed = 0;
  private startedAt: number | undefined;
  // An epoch anchors the visible percentage when future timings change. This
  // keeps speed changes continuous while redistributing the remaining distance.
  private epochFraction = 0;
  private epochDuration = 0;
  private epochCompleted = 0;

  constructor(settings: ReaderSettings = DEFAULT_SETTINGS, private readonly scheduler: PlaybackScheduler = browserScheduler) {
    this.settings = { ...settings };
  }

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  subscribe = (callback: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  };

  /** O(1) per frame; prefix durations are rebuilt only on load or timing changes. */
  getProgress = (): PlaybackProgress => {
    if (this.snapshot.status === 'completed') return { fraction: 1, unitElapsedMs: this.unitDuration, unitDurationMs: this.unitDuration, remainingMs: 0 };
    const elapsed = this.elapsed();
    const consumed = Math.max(0, this.epochCompleted + elapsed);
    const fraction = this.epochDuration > 0
      ? this.epochFraction + (1 - this.epochFraction) * Math.min(1, consumed / this.epochDuration)
      : this.epochFraction;
    return { fraction: Math.min(1, Math.max(0, fraction)), unitElapsedMs: elapsed, unitDurationMs: this.unitDuration, remainingMs: this.remaining(elapsed) };
  };

  load(units: ReadingUnit[], startIndex = 0): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.units = units;
    this.rebuildTimeline();
    this.enter(boundedIndex(startIndex, units.length));
    this.resetPositionEpoch(boundedIndex(startIndex, units.length));
    this.publish(boundedIndex(startIndex, units.length), 'paused', units.length > 0);
  }

  play(): void {
    if (this.disposed || this.units.length === 0 || this.snapshot.status !== 'paused') return;
    if (this.units[this.snapshot.index].kind === 'static') {
      this.cancelTimer();
      if (this.snapshot.index === this.units.length - 1) this.publish(this.snapshot.index, 'completed');
      else {
        const index = this.snapshot.index + 1;
        this.enter(index);
        this.publish(index, 'paused');
      }
      return;
    }
    this.cancelTimer();
    const generation = this.generation;
    this.startedAt = this.scheduler.now();
    this.publish(this.snapshot.index, 'playing');
    if (this.generation === generation && this.getSnapshot().status === 'playing') this.scheduleUnit(generation);
  }

  pause(): void {
    if (this.disposed) return;
    this.unitElapsed = this.elapsed();
    this.startedAt = undefined;
    this.cancelTimer();
    if (this.snapshot.status === 'playing') this.publish(this.snapshot.index, 'paused');
  }

  seek(index: number): void {
    if (this.disposed) return;
    this.cancelTimer();
    const next = boundedIndex(index, this.units.length);
    this.enter(next);
    this.resetPositionEpoch(next);
    this.publish(next, 'paused', this.units.length > 0);
  }

  step(delta: number): void {
    if (Number.isFinite(delta)) this.seek(this.snapshot.index + Math.trunc(delta));
  }

  updateSettings(settings: ReaderSettings): void {
    const timingChanged = settings.cpm !== this.settings.cpm || settings.punctuationPause !== this.settings.punctuationPause;
    if (!timingChanged) { this.settings = { ...settings }; return; }
    const progress = this.getProgress();
    this.settings = { ...settings };
    this.rebuildTimeline();
    // Already exposed text retains its scheduled duration, including while paused.
    if (this.snapshot.status !== 'playing' && progress.unitElapsedMs === 0) this.unitDuration = this.units[this.snapshot.index] ? durationMs(this.units[this.snapshot.index], settings) : 0;
    this.epochFraction = progress.fraction;
    this.epochCompleted = -progress.unitElapsedMs;
    this.epochDuration = this.remaining(progress.unitElapsedMs);
    this.publish(this.snapshot.index, this.snapshot.status, this.units.length > 0);
  }

  dispose(): void {
    this.unitElapsed = this.elapsed();
    this.startedAt = undefined;
    this.cancelTimer();
    this.disposed = true;
    this.listeners.clear();
  }

  private elapsed(): number {
    return Math.min(this.unitDuration, this.unitElapsed + (this.startedAt === undefined ? 0 : Math.max(0, this.scheduler.now() - this.startedAt)));
  }

  private remaining(elapsed: number): number {
    return Math.max(0, this.unitDuration - elapsed + (this.prefix.at(-1) ?? 0) - (this.prefix[this.snapshot.index + 1] ?? 0));
  }

  private rebuildTimeline(): void {
    this.prefix = new Array<number>(this.units.length + 1).fill(0);
    for (let i = 0; i < this.units.length; i++) this.prefix[i + 1] = this.prefix[i] + durationMs(this.units[i], this.settings);
  }

  private enter(index: number): void {
    this.unitDuration = this.units[index] ? durationMs(this.units[index], this.settings) : 0;
    this.unitElapsed = 0;
    this.startedAt = undefined;
  }

  private resetPositionEpoch(index = this.snapshot.index): void {
    const total = this.prefix.at(-1) ?? 0;
    this.epochFraction = total ? (this.prefix[index] ?? 0) / total : 0;
    this.epochCompleted = 0;
    this.epochDuration = this.unitDuration + total - (this.prefix[index + 1] ?? 0);
  }

  private cancelTimer(): void {
    this.generation++;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(index: number, status: PlaybackSnapshot['status'], force = false): void {
    if (!force && this.snapshot.index === index && this.snapshot.status === status) return;
    this.snapshot = { index, status };
    for (const callback of [...this.listeners]) callback();
  }

  private scheduleUnit(generation: number): void {
    const deadline = this.scheduler.now() + this.unitDuration - this.unitElapsed;
    const advance = () => {
      if (this.disposed || generation !== this.generation || this.snapshot.status !== 'playing') return;
      const remaining = deadline - this.scheduler.now();
      if (remaining > 0) { this.timer = this.scheduler.setTimeout(advance, remaining); return; }
      this.timer = undefined;
      this.epochCompleted += this.unitDuration;
      this.unitElapsed = this.unitDuration;
      this.startedAt = undefined;
      if (this.snapshot.index === this.units.length - 1) {
        this.cancelTimer();
        this.publish(this.snapshot.index, 'completed');
        return;
      }
      const index = this.snapshot.index + 1;
      this.enter(index);
      if (this.units[index].kind === 'static') {
        this.cancelTimer();
        this.publish(index, 'paused');
        return;
      }
      this.startedAt = this.scheduler.now();
      this.publish(index, 'playing');
      // Reentrant listener actions take precedence; late callbacks never skip units.
      if (this.generation === generation && this.snapshot.status === 'playing') this.scheduleUnit(generation);
    };
    this.timer = this.scheduler.setTimeout(advance, Math.max(0, deadline - this.scheduler.now()));
  }
}

/** Restore by block and UTF-16 source offset, never by a persisted array index. */
export function sourceAnchorToIndex(document: ReadingDocument, anchor: SourceAnchor): number {
  if (document.units.length === 0) return 0;
  const blockIndex = document.blocks.findIndex((block) => block.id === anchor.blockId);
  if (blockIndex === -1) return 0;
  const block = document.blocks[blockIndex];
  const offset = Math.min(block.text.length, Math.max(0, Number.isFinite(anchor.offset) ? anchor.offset : 0));
  const indexes: number[] = [];
  for (let index = 0; index < document.units.length; index += 1) {
    if (document.units[index].blockId === block.id) indexes.push(index);
  }
  if (indexes.length > 0) {
    let low = 0;
    let high = indexes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (document.units[indexes[middle]].end <= offset) low = middle + 1;
      else high = middle;
    }
    return indexes[Math.min(low, indexes.length - 1)];
  }
  // Empty/excluded blocks resolve to the next readable block, or the closest previous unit.
  const blockPositions = new Map(document.blocks.map((item, index) => [item.id, index]));
  for (let index = 0; index < document.units.length; index += 1) {
    if ((blockPositions.get(document.units[index].blockId) ?? -1) > blockIndex) return index;
  }
  return document.units.length - 1;
}
