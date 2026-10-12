import type { IrodoriSettings as SharedIrodoriSettings } from './contracts';

/** Browser-safe information. Native paths and processes stay on the PC. */
export const IRODORI_MODEL = {
  id: 'irodori-tts-mf',
  repository: 'sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF',
  revision: '69d307a472a1708c5637edcfe376d31c2685829d',
  filename: 'Irodori-TTS-866M-MF-v4.1-F16.gguf',
  bytes: 1_920_321_792,
  sha256: 'e237dc3eefe469b8bba87872beacf12fb7fe00dbdf85767edca8ec04ab910d13',
} as const;
export const IRODORI_HEADROOM = 256 * 1024 * 1024;
export const IRODORI_LIMITS = { maxCharacters: 90, maxTextTokens: 256, maxAudioSeconds: 30, recommendedMaxCharacters: 90 } as const;
/** Fully normalized settings, derived from the shared request contract. */
export type IrodoriSettings = Required<SharedIrodoriSettings>;
export const DEFAULT_IRODORI_SETTINGS: IrodoriSettings = { steps: 4, speed: 1, seed: 42, instructions: '' };
export type IrodoriSetupPhase = 'not-installed' | 'downloading' | 'verifying' | 'ready' | 'cancelled' | 'failed';
export interface IrodoriStatus {
  phase: IrodoriSetupPhase;
  downloadedBytes: number;
  totalBytes: number;
  requiredFreeBytes: number;
  freeBytes?: number;
  message: string;
  executableAvailable: boolean;
  voiceAvailable: boolean;
  voiceLabel?: string;
  voiceAttribution?: string;
  runtime: 'stopped' | 'starting' | 'running' | 'failed';
}
