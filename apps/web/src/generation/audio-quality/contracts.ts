/** Independent QA evidence. Neither presentation validity nor alignment scores certify content. */
export const AUDIO_INSPECTION_VERSION = 'audio-qa-pcm-lattice-v1';
export const REAZON_ASR_VERSION = 'reazon-rs35kh-46afc596-greedy-v1';
export interface TimeRange { startSeconds: number; endSeconds: number }
export interface SourceSpan { blockId: string; start: number; end: number }
export interface InspectionIssue {
  severity: 'warning' | 'fatal';
  code: 'silent-audio' | 'long-silence' | 'clipping' | 'extreme-rate' | 'duration-mismatch' | 'possible-omission' | 'possible-repetition' | 'content-mismatch' | 'invalid-source' | 'invalid-audio';
  message: string;
  source?: SourceSpan;
  audio?: TimeRange;
}
export interface PcmMetrics {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  rms: number;
  peak: number;
  clippingRatio: number;
  silentRatio: number;
  silenceThresholdRms: number;
  characters: number;
  charactersPerSecond: number;
  silence: TimeRange[];
  clipped: TimeRange[];
}
export interface AsrCandidate {
  schemaVersion: 1;
  method: 'audio-only-greedy-ctc';
  version: string;
  mediaHash: string;
  text: string;
  /** Mean posterior on nonblank greedy tokens; never calibrated recognition accuracy. */
  tokenScore: number;
}
export interface ContentEvidence {
  status: 'indeterminate' | 'review';
  reason: string;
  method: 'audio-only-greedy-ctc' | 'not-run';
  modelVersion?: string;
  candidate?: string;
  tokenScore?: number;
  spellingVersion: string;
  editDistance?: number;
  referenceCharacters?: number;
  matchedCharacters?: number;
  qualification?: 'unvalidated' | 'test-only' | 'validated';
  /** Candidate differences remain visible even when the recognizer cannot support quality warnings. */
  differences?: Array<{ kind: 'omission' | 'repetition'; message: string; start: number; end: number }>;
}
export interface AudioInspection {
  schemaVersion: 1;
  inspectionVersion: string;
  key: string;
  /** Original synthesis identity; may differ from the decoded MP3 bytes. */
  audioHash: string;
  mediaHash: string;
  mediaFormat: 'wav' | 'mp3';
  textHash: string;
  inspectedAt: string;
  chunkId: string;
  source?: SourceSpan;
  text: string;
  status: 'warning' | 'indeterminate' | 'fatal';
  lightweight: { status: 'no-warning' | 'warning' | 'indeterminate' | 'fatal'; metrics?: PcmMetrics; reason?: string };
  content: ContentEvidence;
  issues: InspectionIssue[];
}
export interface AudioInspectionReport {
  schemaVersion: 1;
  inspectionVersion: string;
  bookId: string;
  revision: string;
  inspectedAt: string;
  chunks: AudioInspection[];
  reusedChunks: number;
}
export interface InspectSavedAudioInput { bookId: string; revision: string; selectedChunkIds?: string[]; content?: boolean; refresh?: boolean }
export interface ReadingAlternative { start: number; end: number; text: string }
