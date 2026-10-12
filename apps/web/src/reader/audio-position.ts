export type AudioPosition = { status: 'saved'; seconds: number } | { status: 'empty' | 'unavailable' };
type BookIdentity = { id: string; revision: string };

export function audioPositionKey(book: BookIdentity): string {
  return `rsvp-audio-position:${book.id}:${book.revision}`;
}

export function loadAudioPosition(book: BookIdentity, storage?: Pick<Storage, 'getItem'>): AudioPosition {
  try {
    const value = (storage ?? globalThis.localStorage).getItem(audioPositionKey(book));
    if (value === null) return { status: 'empty' };
    const seconds = value.trim() ? Number(value) : NaN;
    return Number.isFinite(seconds) && seconds >= 0 ? { status: 'saved', seconds } : { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
}

export function audioPositionPercent(seconds: number, duration: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.floor(Math.min(seconds / duration, 1) * 100);
}
