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
export interface ReaderSettings {
  writingMode?: WritingMode;
  settingsVersion?: 2;
  fontFamily?: 'system' | 'noto-sans-jp' | 'noto-serif-jp' | 'biz-udpgothic';
  groupTarget?: number;
  groupMinimum?: number;
  context?: boolean;
  mode?: 'flash' | 'guide';
  cpm: number;
  fontSize: number;
  punctuationPause: boolean;
  ruby: boolean;
  guide: boolean;
  contrast: 'paper' | 'night';
}
export const DEFAULT_SETTINGS: ReaderSettings = {
  settingsVersion: 2, fontFamily: 'system', groupTarget: 0, groupMinimum: 0, context: true, mode: 'flash', writingMode: 'horizontal-tb',
  cpm: 400, fontSize: 56, punctuationPause: true, ruby: true, guide: true, contrast: 'paper',
};
export function migrateReaderSettings(settings: ReaderSettings): ReaderSettings {
  return { ...DEFAULT_SETTINGS, ...settings, writingMode: settings.writingMode === 'vertical-rl' ? 'vertical-rl' : 'horizontal-tb', settingsVersion: 2 };
}
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 1_000_000;
