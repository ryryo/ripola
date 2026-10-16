import { isReadingFont } from './reading-fonts';

export type SourceRange =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'pdf'; page: number; item: number; start: number; end: number; rect: [number, number, number, number] };
export interface SourceRun {
  start: number;
  end: number;
  sources: SourceRange[];
  mapping: 'exact' | 'transformed' | 'approximate';
}
export interface RubySpan { start: number; end: number; reading: string; annotationKind?: 'reading' | 'editorial' | 'unknown'; source?: { start: number; end: number } }
export interface AozoraAnnotation { kind: 'note' | 'gaiji'; text: string; source: { start: number; end: number }; blockId?: string; offset?: number; imageSource?: string }
export interface AozoraProvenance {
  title: string; author: string; sourceUrl?: string; cardUrl?: string; sourceSha256?: string;
  bibliography: string; notationNotes: string; annotations: AozoraAnnotation[];
  chapters: Array<{ title: string; blockId: string; anchor?: string }>;
  counts: { ruby: number; gaiji: number; notes: number };
}
export interface TextBlock {
  id: string;
  kind: 'paragraph' | 'heading' | 'listItem' | 'quote' | 'code' | 'table';
  text: string;
  runs: SourceRun[];
  ruby: RubySpan[];
  level?: number;
}
export interface PdfPage { number: number; width: number; height: number }
export interface DraftDocument {
  title: string;
  format: 'txt' | 'md' | 'pdf' | 'aozora';
  rawText: string;
  blocks: TextBlock[];
  warnings: string[];
  pages?: PdfPage[];
  provenance?: AozoraProvenance;
}
export interface ReadingUnit {
  id: string;
  blockId: string;
  kind: 'text' | 'static';
  start: number;
  end: number;
  text: string;
  sources: SourceRange[];
  mapping: SourceRun['mapping'];
  ruby: RubySpan[];
  characters: number;
  cumulativeCharacters: number;
  pause: 'none' | 'comma' | 'sentence' | 'paragraph' | 'heading';
}
export interface ReadingDocument extends DraftDocument {
  id: string;
  contentHash: string;
  units: ReadingUnit[];
  totalCharacters: number;
  versions: { parser: string; model: string; rules: string };
}
export interface SourceAnchor { blockId: string; offset: number }
export type WritingMode = 'horizontal-tb' | 'vertical-rl';
export const MULTILINE_SPACING = { narrow: 1.4, normal: 1.6, wide: 2 } as const;
export interface ReaderSettings {
  readingPace?: 'legacy' | 'text-load';
  writingMode?: WritingMode;
  settingsVersion?: 2 | 3;
  focusedDisplay?: { kind: 'phrase' } | { kind: 'multiline'; maxLines: number };
  documentFontSize?: number;
  fontFamily?: 'system' | 'noto-sans-jp' | 'noto-serif-jp' | 'biz-udpgothic';
  groupTarget?: number;
  groupMinimum?: number;
  fullscreenProgress?: boolean;
  highlightColor?: 'blue' | 'yellow';
  highlightIntensity?: 'light' | 'normal' | 'strong';
  multilineSpacing?: keyof typeof MULTILINE_SPACING;
  mode?: 'flash' | 'guide';
  cpm: number;
  fontSize: number;
  punctuationPause: boolean;
  ruby: boolean;
  guide: boolean;
}
export const DEFAULT_SETTINGS: ReaderSettings = {
  readingPace: 'legacy',
  highlightColor: 'blue', highlightIntensity: 'normal',
  multilineSpacing: 'normal',
  settingsVersion: 3, focusedDisplay: { kind: 'phrase' }, documentFontSize: 20, fontFamily: 'system', mode: 'flash', writingMode: 'horizontal-tb',
  cpm: 400, fontSize: 56, punctuationPause: true, ruby: true, guide: true, fullscreenProgress: true,
};
/** Shared migration for browser preferences and saved documents. */
export function migrateReaderSettings(value: unknown): ReaderSettings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings;
  const stored = value as Record<string, unknown>;
  const integer = (key: string, min: number, max: number) => typeof stored[key] === 'number' && Number.isInteger(stored[key]) && Number(stored[key]) >= min && Number(stored[key]) <= max;
  if (integer('cpm', 100, 3000)) settings.cpm = Number(stored.cpm);
  if (integer('fontSize', 24, 96)) settings.fontSize = Number(stored.fontSize);
  if (integer('documentFontSize', 14, 48)) settings.documentFontSize = Number(stored.documentFontSize);
  for (const key of ['punctuationPause', 'ruby', 'guide', 'fullscreenProgress'] as const) if (typeof stored[key] === 'boolean') settings[key] = stored[key];
  if (isReadingFont(stored.fontFamily)) settings.fontFamily = stored.fontFamily;
  if (stored.writingMode === 'horizontal-tb' || stored.writingMode === 'vertical-rl') settings.writingMode = stored.writingMode;
  if (stored.mode === 'flash' || stored.mode === 'guide') settings.mode = stored.mode;
  if (stored.highlightColor === 'blue' || stored.highlightColor === 'yellow') settings.highlightColor = stored.highlightColor;
  if (stored.highlightIntensity === 'light' || stored.highlightIntensity === 'normal' || stored.highlightIntensity === 'strong') settings.highlightIntensity = stored.highlightIntensity;
  if (stored.multilineSpacing === 'narrow' || stored.multilineSpacing === 'normal' || stored.multilineSpacing === 'wide') settings.multilineSpacing = stored.multilineSpacing;
  if (stored.readingPace === 'legacy' || stored.readingPace === 'text-load') settings.readingPace = stored.readingPace;
  const display = stored.focusedDisplay as Record<string, unknown> | undefined;
  if (display?.kind === 'multiline' && typeof display.maxLines === 'number' && Number.isInteger(display.maxLines) && display.maxLines >= 2 && display.maxLines <= 10) settings.focusedDisplay = { kind: 'multiline', maxLines: display.maxLines };
  return settings;
}

/** Strict saved-document gate, using the same canonical schema as preferences. */
export function validReaderSettings(value: unknown): value is ReaderSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stored = value as Record<string, unknown>;
  const canonical = migrateReaderSettings(value) as unknown as Record<string, unknown>;
  for (const key of ['cpm', 'fontSize', 'punctuationPause', 'ruby', 'guide']) if (stored[key] !== canonical[key]) return false;
  for (const key of ['fontFamily', 'writingMode', 'mode', 'readingPace', 'fullscreenProgress', 'documentFontSize', 'highlightColor', 'highlightIntensity', 'multilineSpacing']) if (stored[key] !== undefined && stored[key] !== canonical[key]) return false;
  if (stored.settingsVersion !== undefined && stored.settingsVersion !== 2 && stored.settingsVersion !== 3) return false;
  if (stored.focusedDisplay !== undefined) {
    const display = stored.focusedDisplay as { kind?: unknown; maxLines?: unknown } | null;
    if (!display || typeof display !== 'object' || Array.isArray(display) || !['phrase', 'multiline'].includes(String(display.kind))) return false;
    if (display.kind === 'multiline' && !(Number.isInteger(display.maxLines) && Number(display.maxLines) >= 2 && Number(display.maxLines) <= 10)) return false;
  }
  for (const [key, max] of [['groupTarget', 24], ['groupMinimum', 12]] as const) if (stored[key] !== undefined && !(Number.isInteger(stored[key]) && Number(stored[key]) >= 0 && Number(stored[key]) <= max)) return false;
  return true;
}
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 1_000_000;
