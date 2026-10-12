import type { IrodoriSettings as SharedIrodoriSettings } from './contracts';

/** Browser-safe information. Native paths and processes stay on the PC. */
export const IRODORI_MODEL = {
  id: 'irodori-tts',
  repository: 'sakasegawa/Irodori-TTS-v4.1-Small-GGUF',
  revision: '66fe2cde1973fd44e7202fbe36df722103958188',
  filename: 'Irodori-TTS-859M-v4.1-F16.gguf',
  bytes: 1_905_903_936,
  sha256: 'f334932bdf166579bada0a3c8bdabb7199af85682fdcefb6f1cb7e444f5c75b3',
} as const;
export const IRODORI_VOICES = [
  { id: 'reception-female', name: '丁寧な受付（女）', instructions: '明朗快活な受付嬢。明るく丁寧にてきぱきと' },
  { id: 'reception-male', name: '丁寧な受付（男）', instructions: '明朗快活な男性の受付スタッフ。明るく丁寧にてきぱきと' },
] as const;
export function irodoriVoice(voice: string) { return IRODORI_VOICES.find(value => value.id === voice); }
export const IRODORI_HEADROOM = 256 * 1024 * 1024;
export const IRODORI_LIMITS = { maxCharacters: 90, maxTextTokens: 256, maxAudioSeconds: 30, recommendedMaxCharacters: 90 } as const;
/** Fully normalized settings, derived from the shared request contract. */
export type IrodoriSettings = Required<SharedIrodoriSettings>;
export const DEFAULT_IRODORI_SETTINGS: IrodoriSettings = { steps: 40, speed: 1, seed: 42, instructions: IRODORI_VOICES[0].instructions };
export function defaultIrodoriSettings(voice = IRODORI_VOICES[0].id as string): IrodoriSettings {
  if (voice === 'ripola') return { steps: 4, speed: 1, seed: 42, instructions: '' };
  const preset = irodoriVoice(voice);
  if (!preset) throw new Error('対応するIrodoriの声を選んでください。');
  return { ...DEFAULT_IRODORI_SETTINGS, instructions: preset.instructions };
}
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
  referenceMode?: 'caption' | 'fixed';
  runtime: 'stopped' | 'starting' | 'running' | 'failed';
}
