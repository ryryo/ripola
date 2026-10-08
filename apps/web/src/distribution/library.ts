import { requireAudioPresentation, type AudioPresentationReport } from '../reader/audio-presentation';
import type { AudioAlignmentCue, AudioTimelineEntry, AcousticTimingEstimate, VoicevoxTimingEvidence } from '../generation/contracts';
import type { ReadingDocument, SourceRange, RubySpan } from '../reader/model';

export interface MediaTimingAnchor {
  sourceSeconds: number;
  mediaSeconds: number;
  lagSeconds: number;
  correlation: number;
  peakMargin: number;
}
export interface MediaTimingMeasurement {
  verification: 'pcm-correlated' | 'unverified';
  algorithm: 'pcm-normalized-xcorr-v1';
  windowSeconds?: number;
  sampleRate: number;
  sourcePcmDurationSeconds: number;
  decodedPcmDurationSeconds: number;
  offsetSeconds: number;
  scale: number;
  driftPpm: number;
  maxResidualSeconds: number;
  score: number;
  anchors: MediaTimingAnchor[];
  reason?: string;
}
export interface PublicAlignment {
  precision: 'phrase' | 'sentence';
  method: 'forced-alignment' | 'voicevox-mora' | 'sentence-fallback';
  status: 'aligned' | 'partial' | 'fallback';
  score?: number;
  engineTiming?: VoicevoxTimingEvidence;
  acoustic?: AcousticTimingEstimate;
  reason?: string;
  normalizeVersion?: string;
  alignerVersion?: string;
  cues: AudioAlignmentCue[];
  units: Array<{ unitId: string; blockId: string; start: number; end: number; score?: number; status: 'aligned' | 'low-confidence' | 'unmatched'; reason?: string }>;
  warnings: string[];
}
export interface PublicAudioChunk {
  id: string;
  audioUrl: string;
  mimeType: 'audio/mp4' | 'audio/mpeg';
  durationSeconds: number;
  sourceDurationSeconds: number;
  sha256: string;
  bytes: number;
  timeline: AudioTimelineEntry[];
  alignment?: PublicAlignment;
  timing: MediaTimingMeasurement & { durationDeltaSeconds: number; sourceAudioHash: string; sourcePcmHash: string; decodedPcmHash: string };
}
export interface PublicAudioBookManifest {
  presentation?: AudioPresentationReport;
  schemaVersion: 1;
  id: string;
  revision: string;
  title: string;
  updatedAt: string;
  document: ReadingDocument;
  chunks: PublicAudioChunk[];
  warnings: string[];
  completedChunks: number;
  totalChunks: number;
  durationSeconds: number;
  precision: 'sentence';
  attribution: string;
}
export interface PublicBookEntry {
  id: string;
  revision: string;
  title: string;
  manifestUrl: string;
  manifestSha256: string;
  manifestBytes: number;
  durationSeconds: number;
  precision: 'sentence';
  attribution: string;
  publicDemo: boolean;
}
export interface PublicLibraryManifest {
  schemaVersion: 1;
  /** Distribution purpose, not HTTP authentication. Omitted in legacy demo catalogs. */
  audience?: 'demo' | 'personal';
  target: 'pages' | 'worker';
  createdAt: string;
  books: PublicBookEntry[];
}

export function validDistributionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}
export function validContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function source(range: SourceRange): SourceRange {
  return range.kind === 'pdf'
    ? { kind: 'pdf', page: range.page, item: range.item, start: range.start, end: range.end, rect: [...range.rect] }
    : { kind: 'text', start: range.start, end: range.end };
}
function ruby(span: RubySpan): RubySpan {
  return { start: span.start, end: span.end, reading: span.reading, ...(span.annotationKind ? { annotationKind: span.annotationKind } : {}),
    ...(span.source ? { source: { start: span.source.start, end: span.source.end } } : {}) };
}

/** Explicit content projection. Unknown metadata, errors and generation settings are never published. */
export function publicReadingDocument(document: ReadingDocument): ReadingDocument {
  return {
    id: document.id, contentHash: document.contentHash, title: document.title, format: document.format,
    // Selected text is part of the distribution; the original PDF/MD file is not copied.
    rawText: document.rawText,
    blocks: document.blocks.map(block => ({
      id: block.id, kind: block.kind, text: block.text,
      runs: block.runs.map(run => ({ start: run.start, end: run.end, mapping: run.mapping, sources: run.sources.map(source) })),
      ruby: block.ruby.map(ruby),
      ...(block.level === undefined ? {} : { level: block.level }),
    })),
    units: document.units.map(unit => ({
      id: unit.id, blockId: unit.blockId, kind: unit.kind, start: unit.start, end: unit.end, text: unit.text,
      sources: unit.sources.map(source), mapping: unit.mapping,
      ruby: unit.ruby.map(ruby),
      characters: unit.characters, cumulativeCharacters: unit.cumulativeCharacters, pause: unit.pause,
    })),
    totalCharacters: document.totalCharacters,
    versions: { parser: document.versions.parser, model: document.versions.model, rules: document.versions.rules },
    warnings: [],
    ...(document.pages ? { pages: document.pages.map(page => ({ number: page.number, width: page.width, height: page.height })) } : {}),
    ...(document.provenance ? { provenance: {
      title: document.provenance.title, author: document.provenance.author, sourceUrl: document.provenance.sourceUrl,
      cardUrl: document.provenance.cardUrl, sourceSha256: document.provenance.sourceSha256,
      bibliography: document.provenance.bibliography, notationNotes: document.provenance.notationNotes,
      counts: { ...document.provenance.counts }, chapters: document.provenance.chapters.map(chapter => ({ title: chapter.title, blockId: chapter.blockId, anchor: chapter.anchor })),
      annotations: document.provenance.annotations.map(note => ({ kind: note.kind, text: note.text, source: { start: note.source.start, end: note.source.end },
        blockId: note.blockId, offset: note.offset, imageSource: note.imageSource })),
    } } : {}),
  };
}

/** A library can reference only its same-origin static subtree, including Pages subpaths. */
export function distributionAssetUrl(path: string, baseUrl = '/', origin = globalThis.location?.origin ?? 'http://localhost'): string {
  if (!/^library\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..' || !part)) {
    throw new Error('配布assetの参照が正しくありません。');
  }
  const base = new URL(baseUrl, origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new Error('配布URLが正しくありません。');
  }
  return new URL(path, base).href;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配布manifestが正しくありません。');
  return value as Record<string, unknown>;
}
export function parsePublicLibrary(value: unknown): PublicLibraryManifest {
  const data = object(value);
  if (data.schemaVersion !== 1 || !['pages', 'worker'].includes(String(data.target)) || typeof data.createdAt !== 'string' || !Array.isArray(data.books)) {
    throw new Error('配布libraryの形式が正しくありません。');
  }
  if (data.audience !== undefined && !['demo', 'personal'].includes(String(data.audience)) || data.audience === 'personal' && data.target !== 'worker') throw new Error('配布用途が正しくありません。');
  const books = data.books.map(value => {
    const book = object(value);
    if (!validDistributionId(book.id) || !validDistributionId(book.revision) || typeof book.title !== 'string'
      || book.manifestUrl !== `library/books/${book.id}/${book.revision}/manifest.json`
      || !validContentHash(book.manifestSha256) || !Number.isSafeInteger(book.manifestBytes) || Number(book.manifestBytes) <= 0
      || !Number.isFinite(book.durationSeconds) || Number(book.durationSeconds) <= 0 || book.precision !== 'sentence'
      || typeof book.attribution !== 'string' || typeof book.publicDemo !== 'boolean' || ((data.target === 'pages' || data.audience === 'demo') && !book.publicDemo)) {
      throw new Error('配布bookの参照が正しくありません。');
    }
    return {
      id: book.id, revision: book.revision, title: book.title, manifestUrl: String(book.manifestUrl),
      manifestSha256: book.manifestSha256, manifestBytes: Number(book.manifestBytes), durationSeconds: Number(book.durationSeconds),
      precision: 'sentence' as const, attribution: book.attribution, publicDemo: book.publicDemo,
    };
  });
  if (new Set(books.map(book => `${book.id}/${book.revision}`)).size !== books.length) throw new Error('配布bookが重複しています。');
  return { schemaVersion: 1, target: data.target as PublicLibraryManifest['target'], createdAt: data.createdAt, ...(data.audience ? { audience: data.audience as 'demo' | 'personal' } : {}), books };
}
export async function loadDistributionLibrary(baseUrl = '/', fetcher: typeof fetch = fetch): Promise<PublicLibraryManifest> {
  const response = await fetcher(distributionAssetUrl('library/index.json', baseUrl));
  if (!response.ok) throw new Error('音声ライブラリーを取得できませんでした。');
  return parsePublicLibrary(await response.json());
}
export async function loadDistributedBook(entry: PublicBookEntry, baseUrl = '/', fetcher: typeof fetch = fetch): Promise<PublicAudioBookManifest> {
  const response = await fetcher(distributionAssetUrl(entry.manifestUrl, baseUrl));
  if (!response.ok) throw new Error('保存済み音声を取得できませんでした。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== entry.manifestSha256 || bytes.byteLength !== entry.manifestBytes) throw new Error('配布manifestの内容が一致しません。');
  const book = JSON.parse(new TextDecoder().decode(bytes)) as PublicAudioBookManifest;
  if (book.schemaVersion !== 1 || book.id !== entry.id || book.revision !== entry.revision || !Array.isArray(book.chunks) || !book.document || book.precision !== 'sentence') {
    throw new Error('配布manifestの形式が正しくありません。');
  }
  const presentation = requireAudioPresentation(book);
  return { ...book, presentation, chunks: book.chunks.map(chunk => {
    const extension = chunk.mimeType === 'audio/mp4' ? 'm4a' : chunk.mimeType === 'audio/mpeg' ? 'mp3' : undefined;
    if (!extension || chunk.audioUrl !== `library/books/${entry.id}/${entry.revision}/media/${chunk.sha256}.${extension}`) throw new Error('配布音声の形式と参照先が一致しません。');
    if (chunk.alignment?.precision === 'phrase' && (chunk.timing?.verification !== 'pcm-correlated' || !chunk.alignment.cues.length)) {
      throw new Error('フレーズ表示のPCM時刻検証がありません。');
    }
    return { ...chunk, audioUrl: distributionAssetUrl(chunk.audioUrl, baseUrl) };
  }) };
}

/** Keep inspection failures visible without reflecting fetched content or internal paths. */
export function distributionLoadError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('区切り表示の検査')) return '区切り表示の検査に失敗しました。原稿の区切り情報と配布の検査記録を確認してください。音声の再生成は不要です。';
  return '配布された音声データを読み込めませんでした。manifest・音声と参照先を確認してください。';
}
