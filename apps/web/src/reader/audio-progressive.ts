import { audioDisplayAt, type AudioSegment, type PlayableAudioBook } from './audio-clock';
import { audioAssetKey } from './audio-prefetch';
import type { AudioBookManifest, GenerationJob } from '../generation/contracts';

export type ProgressiveBook = PlayableAudioBook & Pick<AudioBookManifest, 'plannedChunkIds'>;
export type Continuation = { kind: 'next'; index: number } | { kind: 'waiting'; chunkId?: string } | { kind: 'end' };
export function continuation(book: ProgressiveBook, currentId: string): Continuation {
  if (book.plannedChunkIds) {
    const at = book.plannedChunkIds.indexOf(currentId);
    if (at < 0) return { kind: 'waiting' };
    const next = book.plannedChunkIds[at + 1];
    if (!next) return { kind: 'end' };
    const index = book.chunks.findIndex(chunk => chunk.id === next);
    return index < 0 ? { kind: 'waiting', chunkId: next } : { kind: 'next', index };
  }
  const at = book.chunks.findIndex(chunk => chunk.id === currentId);
  if (at < 0) return { kind: 'waiting' };
  const index = at + 1;
  if (index < book.chunks.length) return { kind: 'next', index };
  return book.completedChunks < book.totalChunks ? { kind: 'waiting' } : { kind: 'end' };
}
export interface PlaybackAnchor { chunkId: string; asset: string; localSeconds: number; unitId?: string; fraction: number; ended: boolean }
export function playbackAnchor(segment: AudioSegment, localSeconds: number, ended = false): PlaybackAnchor {
  const display = audioDisplayAt(segment, localSeconds);
  const cue = display.cue;
  return { chunkId: segment.chunk.id, asset: audioAssetKey(segment.chunk), localSeconds, unitId: display.units[0]?.id, ended,
    fraction: cue ? Math.max(0, Math.min(1, (localSeconds - cue.startSeconds) / (cue.endSeconds - cue.startSeconds))) : 0 };
}
export function restoreAnchor(segments: AudioSegment[], anchor: PlaybackAnchor): { index: number; localSeconds: number; assetChanged: boolean } | undefined {
  const index = segments.findIndex(segment => segment.chunk.id === anchor.chunkId);
  if (index < 0) return;
  const segment = segments[index];
  const assetChanged = anchor.asset !== audioAssetKey(segment.chunk);
  const cue = assetChanged ? segment.displayCues.find(cue => cue.unitIds.includes(anchor.unitId ?? '')) : undefined;
  const localSeconds = anchor.ended ? segment.chunk.durationSeconds : cue ? cue.startSeconds + anchor.fraction * (cue.endSeconds - cue.startSeconds) : anchor.localSeconds;
  return { index, localSeconds: Math.max(0, Math.min(segment.chunk.durationSeconds, localSeconds)), assetChanged };
}

/** Stop at the first generation hole even if later chunks completed first. */
export function contiguousChunks(book: ProgressiveBook, currentId: string) {
  if (!book.plannedChunkIds) return book.chunks.slice(Math.max(0, book.chunks.findIndex(chunk => chunk.id === currentId)));
  const byId = new Map(book.chunks.map(chunk => [chunk.id, chunk]));
  const start = book.plannedChunkIds.indexOf(currentId);
  const result: PlayableAudioBook['chunks'] = [];
  if (start < 0) return result;
  for (const id of book.plannedChunkIds.slice(start)) { const chunk = byId.get(id); if (!chunk) break; result.push(chunk); }
  return result;
}

/** Pending priority affects execution only; the manifest stays in source order. */
export function nearPlaybackPriority(ids: readonly string[], currentId: string, maximum = 6): string[] {
  const at = ids.indexOf(currentId);
  return at < 0 ? [] : ids.slice(at + 1, at + 1 + Math.max(1, Math.min(6, maximum)));
}

export function acceptsManifest(current: AudioBookManifest, incoming: AudioBookManifest, job?: GenerationJob): boolean {
  if (current.id !== incoming.id || current.revision !== incoming.revision || current.totalChunks !== incoming.totalChunks) return false;
  if (current.document.contentHash !== incoming.document.contentHash || JSON.stringify(current.document.versions) !== JSON.stringify(incoming.document.versions)) return false;
  const owner = current.generation;
  const next = incoming.generation;
  if (next && (!Number.isSafeInteger(next.sequence) || next.sequence < 0)) return false;
  if (owner && (!next || owner.jobId !== next.jobId || owner.planId !== next.planId || owner.planHash !== next.planHash || next.sequence < owner.sequence)) return false;
  if (job && (job.bookId !== incoming.id || job.revision !== incoming.revision || next && (next.jobId !== job.id || next.planId !== job.planId))) return false;
  if (!Number.isSafeInteger(incoming.completedChunks) || incoming.completedChunks !== incoming.chunks.length || incoming.completedChunks > incoming.totalChunks) return false;
  if (current.chunks.some(chunk => !incoming.chunks.some(saved => saved.id === chunk.id))) return false;
  if (current.plannedChunkIds && JSON.stringify(current.plannedChunkIds) !== JSON.stringify(incoming.plannedChunkIds)) return false;
  if (incoming.plannedChunkIds) {
    const ids = incoming.plannedChunkIds;
    if (ids.length !== incoming.totalChunks || new Set(ids).size !== ids.length) return false;
    const order = incoming.chunks.map(chunk => ids.indexOf(chunk.id));
    if (order.some((value, i) => value < 0 || i > 0 && value <= order[i - 1])) return false;
  }
  return true;
}

/** Same revision means immutable manuscript; keep font preparation and source refs. */
export function mergeManifest(current: AudioBookManifest, incoming: AudioBookManifest): AudioBookManifest {
  return { ...incoming, document: { ...incoming.document, blocks: current.document.blocks, units: current.document.units } };
}
