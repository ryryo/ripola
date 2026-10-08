import type { VoiceOption } from './contracts';
/** Resolve from Engine metadata; style IDs differ across engines and installed libraries. */
export function defaultVoicevoxVoice(voices: VoiceOption[]): string {
  return voices.find(voice => voice.speakerName === 'ずんだもん' && voice.styleName === 'ノーマル')?.id
    ?? voices.find(voice => voice.name === 'ずんだもん / ノーマル')?.id ?? voices[0]?.id ?? '';
}
