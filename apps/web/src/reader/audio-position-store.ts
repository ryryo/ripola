import { audioPositionKey, loadAudioPosition, type AudioPosition } from './audio-position';

type Book = { id: string; revision: string };
const empty: ReadonlyMap<string, AudioPosition> = new Map();
const equal = (left: AudioPosition | undefined, right: AudioPosition) => left?.status === right.status
  && (left.status !== 'saved' || right.status === 'saved' && left.seconds === right.seconds);

/** Small position snapshots, owned only while a shelf or home view is subscribed. */
export class AudioPositionStore {
  private snapshot: ReadonlyMap<string, AudioPosition> = empty;
  private books = new Map<string, { book: Book; references: number }>();
  private listeners = new Set<() => void>();
  private disconnect?: () => void;
  constructor(private readonly read = loadAudioPosition) {}
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => empty;

  subscribe(books: readonly Book[], listener: () => void): () => void {
    const keys = new Map(books.map(book => [audioPositionKey(book), book]));
    for (const [key, book] of keys) {
      const value = this.books.get(key);
      this.books.set(key, { book, references: (value?.references ?? 0) + 1 });
    }
    this.listeners.add(listener);
    if (!this.disconnect && typeof window !== 'undefined') {
      const changed = (event: StorageEvent) => this.refresh(event.key ?? undefined);
      const saved = (event: Event) => this.refresh((event as CustomEvent<string>).detail);
      const refresh = () => this.refresh();
      const visible = () => { if (!document.hidden) refresh(); };
      window.addEventListener('storage', changed);
      window.addEventListener('rsvp-audio-position-changed', saved);
      window.addEventListener('pageshow', refresh);
      document.addEventListener('visibilitychange', visible);
      this.disconnect = () => {
        window.removeEventListener('storage', changed);
        window.removeEventListener('rsvp-audio-position-changed', saved);
        window.removeEventListener('pageshow', refresh);
        document.removeEventListener('visibilitychange', visible);
      };
    }
    this.update([...keys.keys()].filter(key => !this.snapshot.has(key)));
    return () => {
      this.listeners.delete(listener);
      const next = new Map(this.snapshot);
      for (const key of keys.keys()) {
        const value = this.books.get(key)!;
        if (--value.references === 0) { this.books.delete(key); next.delete(key); }
      }
      if (next.size !== this.snapshot.size) { this.snapshot = next; this.publish(); }
      if (!this.listeners.size) { this.disconnect?.(); this.disconnect = undefined; this.snapshot = empty; }
    };
  }
  refresh(key?: string): void {
    this.update(key === undefined ? this.books.keys() : [key]);
  }
  private update(keys: Iterable<string>) {
    let next: Map<string, AudioPosition> | undefined;
    for (const id of keys) {
      const value = this.books.get(id);
      if (!value) continue;
      const position = this.read(value.book);
      if (!equal(this.snapshot.get(id), position)) { next ??= new Map(this.snapshot); next.set(id, position); }
    }
    if (next) { this.snapshot = next; this.publish(); }
  }
  private publish() { for (const listener of this.listeners) listener(); }
}

export const audioPositions = new AudioPositionStore();

export function notifyAudioPositionChanged(key: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rsvp-audio-position-changed', { detail: key }));
}
