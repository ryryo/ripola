import type { ReadingDocument, SourceAnchor } from './model';

export interface TextBookIdentity { id: string; revision: string }
export function textPositionKey(book: TextBookIdentity): string { return `ripola-text-position:${book.id}:${book.revision}`; }
function validAnchor(value: unknown, document: ReadingDocument): value is SourceAnchor {
  if (!value || typeof value !== 'object') return false;
  const anchor = value as SourceAnchor;
  const block = document.blocks.find(block => block.id === anchor.blockId);
  return Boolean(block && Number.isFinite(anchor.offset) && anchor.offset >= 0 && anchor.offset <= block.text.length);
}
export function loadTextPosition(book: TextBookIdentity, document: ReadingDocument, storage?: Pick<Storage, 'getItem'>): SourceAnchor | undefined {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(textPositionKey(book));
    if (!raw || raw.length > 4096) return;
    const value = JSON.parse(raw);
    if (value.schemaVersion === 1 && value.contentHash === document.contentHash && validAnchor(value.anchor, document)) return value.anchor;
  } catch { /* Unavailable/corrupt storage must not prevent reading. */ }
}
export function saveTextPosition(book: TextBookIdentity, document: ReadingDocument, anchor: SourceAnchor, storage?: Pick<Storage, 'setItem'>): boolean {
  if (!validAnchor(anchor, document)) return false;
  try {
    (storage ?? globalThis.localStorage).setItem(textPositionKey(book), JSON.stringify({ schemaVersion: 1, contentHash: document.contentHash, anchor }));
    return true;
  } catch { return false; }
}
