import { MAX_INPUT_BYTES, MAX_TEXT_LENGTH, migrateReaderSettings, type ReaderSettings, type ReadingDocument, type SourceAnchor } from './model.ts';
import { isReadingFont } from './reading-fonts';

export interface SavedReading {
  schemaVersion: 1;
  document: ReadingDocument;
  anchor: SourceAnchor;
  settings: ReaderSettings;
  pdfData?: ArrayBuffer;
  savedAt: string;
}

export type SavedReadingInput = Omit<SavedReading, 'schemaVersion' | 'savedAt'>;

export class ReadingStorageError extends Error {
  constructor(public readonly code: 'unavailable' | 'quota' | 'invalid' | 'failed', message: string) {
    super(message);
    this.name = 'ReadingStorageError';
  }
}

const DATABASE = 'rsvp-reader-local';
const STORE = 'reading';
const KEY = 'current';

function invalid(): never {
  throw new ReadingStorageError('invalid', '保存データの形式または容量が正しくありません。保存済みデータを削除し、本文を取り込み直してください。');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0, maximum = MAX_TEXT_LENGTH): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function text(value: unknown, maximum = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function source(value: unknown, rawLength: number): boolean {
  if (!record(value) || !integer(value.start) || !integer(value.end) || value.start > value.end) return false;
  if (value.kind === 'text') return value.end <= rawLength;
  return value.kind === 'pdf' && integer(value.page, 1, 100_000) && integer(value.item)
    && Array.isArray(value.rect) && value.rect.length === 4 && value.rect.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}

function ruby(value: unknown, length: number): boolean {
  return record(value) && integer(value.start, 0, length) && integer(value.end, 0, length)
    && value.start < value.end && text(value.reading)
    && (value.annotationKind === undefined || ['reading', 'editorial', 'unknown'].includes(String(value.annotationKind)))
    && (value.source === undefined || record(value.source) && integer(value.source.start) && integer(value.source.end) && value.source.end >= value.source.start);
}

function mapping(value: unknown): boolean {
  return value === 'exact' || value === 'transformed' || value === 'approximate';
}

function settings(value: unknown): value is ReaderSettings {
  return record(value) && integer(value.cpm, 100, 3000) && integer(value.fontSize, 24, 96)
    && typeof value.punctuationPause === 'boolean' && typeof value.ruby === 'boolean'
    && typeof value.guide === 'boolean' && (value.contrast === 'paper' || value.contrast === 'night')
    && (value.settingsVersion === undefined || value.settingsVersion === 2)
    && (value.fontFamily === undefined || isReadingFont(value.fontFamily))
    && (value.groupTarget === undefined || integer(value.groupTarget, 0, 24))
    && (value.groupMinimum === undefined || integer(value.groupMinimum, 0, 12))
    && (value.context === undefined || typeof value.context === 'boolean')
    && (value.writingMode === undefined || value.writingMode === 'horizontal-tb' || value.writingMode === 'vertical-rl')
    && (value.mode === undefined || value.mode === 'flash' || value.mode === 'guide');
}

/** Validate local data before use. Invalid records remain deletable without being rendered. */
export function validateSavedReading(value: unknown): asserts value is SavedReading {
  if (!record(value) || value.schemaVersion !== 1 || !settings(value.settings)
    || !text(value.savedAt, 64) || !Number.isFinite(Date.parse(value.savedAt))
    || !record(value.anchor) || !text(value.anchor.blockId, 256) || !integer(value.anchor.offset)
    || !record(value.document)) invalid();
  const document = value.document;
  if (!text(document.id, 256) || !text(document.contentHash, 256) || document.contentHash.length === 0
    || !text(document.title) || !text(document.rawText) || !integer(document.totalCharacters)
    || !['txt', 'md', 'pdf', 'aozora'].includes(document.format as string)
    || !Array.isArray(document.warnings) || !document.warnings.every((warning) => text(warning, 10_000))
    || !record(document.versions) || !text(document.versions.parser, 256)
    || !text(document.versions.model, 256) || !text(document.versions.rules, 256)
    || !Array.isArray(document.blocks) || document.blocks.length > MAX_TEXT_LENGTH
    || !Array.isArray(document.units) || document.units.length > MAX_TEXT_LENGTH) invalid();
  const blocks = new Map<string, { text: string; end: number }>();
  let blockCharacters = 0;
  for (const block of document.blocks) {
    if (!record(block) || !text(block.id, 256) || blocks.has(block.id) || !text(block.text)
      || !['paragraph', 'heading', 'listItem', 'quote', 'code', 'table'].includes(block.kind as string)
      || !Array.isArray(block.runs) || !Array.isArray(block.ruby)) invalid();
    blockCharacters += block.text.length;
    if (blockCharacters > MAX_TEXT_LENGTH) invalid();
    for (const run of block.runs) {
      if (!record(run) || !integer(run.start, 0, block.text.length) || !integer(run.end, 0, block.text.length)
        || run.start > run.end || !mapping(run.mapping) || !Array.isArray(run.sources)
        || !run.sources.every((range) => source(range, (document.rawText as string).length))) invalid();
    }
    if (!block.ruby.every((span) => ruby(span, (block.text as string).length))) invalid();
    blocks.set(block.id, { text: block.text, end: 0 });
  }
  let cumulative = 0;
  const unitIds = new Set<string>();
  for (const unit of document.units) {
    if (!record(unit) || !text(unit.id, 256) || unitIds.has(unit.id) || !text(unit.blockId, 256)
      || !text(unit.text) || unit.text.length === 0 || (unit.kind !== 'text' && unit.kind !== 'static')) invalid();
    const block = blocks.get(unit.blockId);
    if (!block || !integer(unit.start, 0, block.text.length) || !integer(unit.end, 0, block.text.length)
      || unit.start !== block.end || unit.start >= unit.end || unit.text !== block.text.slice(unit.start, unit.end)
      || !integer(unit.characters) || !integer(unit.cumulativeCharacters)
      || unit.cumulativeCharacters !== cumulative || cumulative + unit.characters > document.totalCharacters
      || !mapping(unit.mapping) || !Array.isArray(unit.sources)
      || !unit.sources.every((range) => source(range, (document.rawText as string).length))
      || !Array.isArray(unit.ruby) || !unit.ruby.every((span) => ruby(span, (unit.text as string).length))
      || !['none', 'comma', 'sentence', 'paragraph', 'heading'].includes(unit.pause as string)) invalid();
    unitIds.add(unit.id);
    block.end = unit.end;
    cumulative += unit.characters;
  }
  if ([...blocks.values()].some((block) => block.end !== block.text.length) || cumulative !== document.totalCharacters) invalid();
  if (document.provenance !== undefined) {
    const value = document.provenance;
    if (!record(value) || !text(value.title, 10_000) || !text(value.author, 10_000) || !text(value.bibliography) || !text(value.notationNotes)
      || !record(value.counts) || !['ruby', 'gaiji', 'notes'].every(key => integer((value.counts as Record<string, unknown>)[key]))
      || !Array.isArray(value.chapters) || value.chapters.length > 10_000 || !Array.isArray(value.annotations) || value.annotations.length > 100_000
      || (value.sourceSha256 !== undefined && (!text(value.sourceSha256, 64) || !/^[a-f0-9]{64}$/.test(value.sourceSha256)))) invalid();
    for (const key of ['sourceUrl', 'cardUrl']) {
      const url = value[key]; if (url !== undefined && (!text(url, 2000) || !/^https:\/\/[^\s]+$/.test(url))) invalid();
    }
    for (const chapter of value.chapters) if (!record(chapter) || !text(chapter.title, 10_000) || !text(chapter.blockId, 256) || !blocks.has(chapter.blockId)
      || (chapter.anchor !== undefined && !text(chapter.anchor, 256))) invalid();
    for (const note of value.annotations) {
      if (!record(note) || !['note', 'gaiji'].includes(String(note.kind)) || !text(note.text, 10_000) || !record(note.source)
        || !integer(note.source.start, 0, (document.rawText as string).length) || !integer(note.source.end, 0, (document.rawText as string).length) || note.source.end < note.source.start
        || (note.blockId !== undefined && (!text(note.blockId, 256) || !blocks.has(note.blockId)))
        || (note.offset !== undefined && !integer(note.offset)) || (note.imageSource !== undefined && !text(note.imageSource, 2000))) invalid();
    }
  }
  if (document.pages !== undefined && (!Array.isArray(document.pages) || !document.pages.every((page) => record(page)
    && integer(page.number, 1, 100_000) && typeof page.width === 'number' && Number.isFinite(page.width) && page.width > 0
    && typeof page.height === 'number' && Number.isFinite(page.height) && page.height > 0))) invalid();
  if (value.pdfData !== undefined && (!(value.pdfData instanceof ArrayBuffer) || value.pdfData.byteLength > MAX_INPUT_BYTES
    || document.format !== 'pdf')) invalid();
  if (document.blocks.length > 0 && !blocks.has(value.anchor.blockId)) invalid();
}

function storageError(error: unknown): ReadingStorageError {
  if (error instanceof ReadingStorageError) return error;
  const name = record(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'QuotaExceededError') return new ReadingStorageError('quota', 'この端末の保存容量が不足しています。保存済みデータを削除するか、保存せずに読み続けてください。');
  if (name === 'SecurityError' || name === 'InvalidStateError') return new ReadingStorageError('unavailable', 'このブラウザでは端末保存を利用できません。保存せずに読み続けられます。');
  return new ReadingStorageError('failed', '端末の保存データにアクセスできませんでした。保存せずに読み続けられます。');
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (!globalThis.indexedDB) throw new ReadingStorageError('unavailable', 'このブラウザでは端末保存を利用できません。保存せずに読み続けられます。');
      request = globalThis.indexedDB.open(DATABASE, 1);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onerror = () => { settled = true; reject(storageError(request.error)); };
    request.onblocked = () => {
      settled = true;
      reject(new ReadingStorageError('failed', '別のタブが保存データを使用しています。そのタブを閉じてから、もう一度お試しください。'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      database.onversionchange = () => { database.close(); };
      resolve(database);
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      let result: T;
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => { resolve(result); };
      transaction.onabort = () => { reject(storageError(request.error ?? transaction.error)); };
      transaction.onerror = () => { reject(storageError(request.error ?? transaction.error)); };
    });
  } catch (error) {
    throw storageError(error);
  } finally {
    database.close();
  }
}

export async function saveReading(input: SavedReadingInput): Promise<void> {
  const saved: SavedReading = { ...input, schemaVersion: 1, savedAt: new Date().toISOString() };
  validateSavedReading(saved);
  await transaction('readwrite', (store) => store.put(saved, KEY));
}

export async function loadReading(): Promise<SavedReading | undefined> {
  const saved: unknown = await transaction('readonly', (store) => store.get(KEY));
  if (saved === undefined) return undefined;
  validateSavedReading(saved);
  saved.settings = migrateReaderSettings(saved.settings);
  return saved;
}

export async function deleteReading(): Promise<void> {
  await transaction('readwrite', (store) => store.delete(KEY));
}
