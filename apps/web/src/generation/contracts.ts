import type { ReadingDocument } from '../reader/model';
import type { AudioPresentationReport } from '../reader/audio-presentation';

export const GEMINI_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'] as const;
export type GeminiModel = typeof GEMINI_MODELS[number];
export type SpeechProvider = 'voicevox' | 'gemini';
export interface ReadingOverride { text: string; reading: string }
export interface GenerationOptions {
  provider: SpeechProvider;
  voice: string;
  model?: GeminiModel;
  transport: 'direct' | 'gateway';
  readings: ReadingOverride[];
  style?: string;
  selectedChunkIds?: string[];
}
export interface PrepareGenerationInput { document: ReadingDocument; options: GenerationOptions }
export interface GenerationChunk {
  id: string;
  blockId: string;
  start: number;
  end: number;
  unitIds: string[];
  originalText: string;
  spokenText: string;
  speechKey: string;
  cacheHit: boolean;
}
export interface GenerationPlan {
  schemaVersion: 1;
  id: string;
  hash: string;
  bookId: string;
  revision: string;
  title: string;
  createdAt: string;
  options: GenerationOptions;
  chunks: GenerationChunk[];
  sendingText: string;
  endpoint: string;
  providerVersion?: string;
  /** Pins the Cloudflare Gateway and adapter version; never a credential. */
  routeIdentity?: string;
  attribution?: string;
  available: boolean;
  unavailableReason?: string;
  estimatedSeconds: number;
  estimatedOutputUsd: number;
  estimateNote: string;
  warnings: string[];
}
export interface SpeechReceipt {
  schemaVersion: 1;
  transport: GenerationOptions['transport'];
  endpoint: string;
  model: GeminiModel;
  interactionId?: string;
  /** Optional Cloudflare-reported source; Gateway settings determine billing. */
  keySource?: 'Unified' | 'BYOK';
  /** Provider-reported counts; not a charge receipt or proof of comprehension. */
  usage?: Record<string, number>;
}
export interface VoiceOption { id: string; name: string; speakerName?: string; styleName?: string }
export interface GenerationConfig {
  voicevox: { available: boolean; endpoint: string; voices: VoiceOption[]; message?: string };
  gemini: { available: boolean; credentialConfigured: boolean; models: readonly GeminiModel[]; voices: VoiceOption[]; endpoint: string; message?: string };
  transports: Array<{ id: 'direct' | 'gateway'; available: boolean; message?: string }>;
  precision: 'sentence';
  alignment?: AlignmentCapabilities;
}
export type JobStatus = 'queued' | 'running' | 'cancel-requested' | 'cancelled' | 'failed' | 'outcome-unknown' | 'completed';
export type ChunkStatus = 'pending' | 'sending' | 'audio-ready' | 'completed' | 'failed' | 'outcome-unknown';
export interface JobChunk { id: string; speechKey: string; status: ChunkStatus; attempts: number; reused: boolean; error?: string }
export interface GenerationJob {
  schemaVersion: 1;
  id: string;
  operationId: string;
  planId: string;
  bookId: string;
  revision: string;
  title: string;
  provider: SpeechProvider;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  chunks: JobChunk[];
  completedChunks: number;
  totalChunks: number;
  automaticAlignment?: { status: 'running' | 'completed' | 'unavailable' | 'failed' | 'cancelled'; jobId?: string };
  automaticCompression?: { status: 'running' | 'completed' | 'partial' | 'unavailable' | 'cancelled' | 'failed'; completedFiles: number; totalFiles: number; sourceBytes: number; compressedBytes: number; removedWavBytes: number; retainedWavFiles: number };
  error?: string;
}
export interface StartGenerationInput { planId: string; planHash: string; operationId: string; paidConfirmed: boolean }
export interface ResumeGenerationInput { jobId: string; paidConfirmed?: boolean }
export interface AudioTimelineEntry {
  chunkId: string;
  blockId: string;
  start: number;
  end: number;
  unitIds: string[];
  startSeconds: number;
  endSeconds: number;
  precision: 'sentence';
}
export interface SavedAudioChunk {
  id: string;
  speechKey: string;
  audioUrl: string;
  mimeType: 'audio/wav' | 'audio/mpeg';
  durationSeconds: number;
  timeline: AudioTimelineEntry[];
  alignment?: SavedAlignment;
}
export interface AudioBookSummary {
  id: string;
  revision: string;
  title: string;
  updatedAt: string;
  completedChunks: number;
  totalChunks: number;
  durationSeconds: number;
  precision: 'sentence';
}
export interface AudioBookManifest extends AudioBookSummary {
  presentation?: AudioPresentationReport;
  schemaVersion: 1;
  document: ReadingDocument;
  options: GenerationOptions;
  providerVersion?: string;
  attribution?: string;
  chunks: SavedAudioChunk[];
  warnings: string[];
}
export const GENERATION_API_PATH = '/api/local-generation';

/** CTC posterior scores are filtering signals, not calibrated timing-accuracy probabilities. */
export const MIN_ALIGNMENT_SCORE = 0.75;
export const ALIGNMENT_NORMALIZE_VERSION = 'ctc-ja-nfkc-v1';
export const ACOUSTIC_TIMING_VERSION = 'ctc-energy-v1';
export interface AcousticTimingEstimate {
  version: 'ctc-energy-v1';
  anchorCount: number;
  minimumTokenScore: 0.75;
  units: Array<{ unitId: string; blockId: string; start: number; end: number; startSeconds: number; endSeconds: number }>;
}
export type AlignmentStatus = 'aligned' | 'low-confidence' | 'unmatched';
export interface AlignmentRange { start: number; end: number }
export interface AlignmentUnitResult {
  unitId: string;
  blockId: string;
  start: number;
  end: number;
  spokenRanges: AlignmentRange[];
  normalizedRanges: AlignmentRange[];
  startSeconds?: number;
  endSeconds?: number;
  score?: number;
  status: AlignmentStatus;
  reason?: string;
}
export interface AudioAlignmentCue {
  unitId: string;
  /** Several original units can share a many-to-many reading span. */
  unitIds: string[];
  blockId: string;
  start: number;
  end: number;
  startSeconds: number;
  endSeconds: number;
  score?: number;
}
export interface VoicevoxTimingEvidence {
  verification: 'voicevox-mora-frames';
  version: 'voicevox-mora-v1';
  querySource: 'captured' | 'reconstructed';
  engineVersion: string;
  styleId: string;
  frameRate: 93.75;
  frames: number;
  queryHash: string;
  phonemeMapping: 'exact';
  ctcAnchors: number;
}
export interface SavedAlignment {
  schemaVersion: 1;
  key: string;
  audioHash: string;
  normalizeVersion: string;
  alignerVersion: string;
  precision: 'phrase' | 'sentence';
  method: 'forced-alignment' | 'voicevox-mora' | 'sentence-fallback';
  status: 'aligned' | 'partial' | 'fallback';
  score?: number;
  engineTiming?: VoicevoxTimingEvidence;
  /** Diagnostic only; not a confidence score for engine-derived timings. */
  ctcScore?: number;
  /** Approximate display timing from PCM activity and reliable CTC token landmarks. */
  acoustic?: AcousticTimingEstimate;
  reason?: string;
  cues: AudioAlignmentCue[];
  units: AlignmentUnitResult[];
  warnings: string[];
}
export type AlignmentJobStatus = 'queued' | 'running' | 'cancel-requested' | 'cancelled' | 'failed' | 'completed';
export interface AlignmentJobChunk {
  id: string;
  speechKey: string;
  alignmentKey?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: SavedAlignment['status'];
  reused: boolean;
  error?: string;
}
export interface AlignmentJob {
  schemaVersion: 1;
  id: string;
  operationId: string;
  bookId: string;
  revision: string;
  title: string;
  status: AlignmentJobStatus;
  alignerVersion: string;
  normalizeVersion: string;
  selectedChunkIds: string[];
  createdAt: string;
  updatedAt: string;
  chunks: AlignmentJobChunk[];
  completedChunks: number;
  totalChunks: number;
  reusedChunks: number;
  error?: string;
}
export interface StartAlignmentInput { bookId: string; revision: string; operationId: string; selectedChunkIds?: string[] }
export interface AlignmentCapabilities {
  automatic?: { status: 'ready' | 'setup-required' | 'failed'; message: string };
  configured: boolean;
  available: boolean;
  alignerVersion: string;
  normalizeVersion: string;
  method: 'forced-alignment';
  message?: string;
}
