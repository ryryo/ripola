import { DEFAULT_SETTINGS, migrateReaderSettings, type ReaderSettings } from './model';

export const PREFERENCES_KEY = 'ripola-reader-preferences-v1';
export const DEFAULT_AUDIO_RATE = '2.5';
export interface ReaderPreferences { settings: ReaderSettings; audioRate: string }
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Browser data is optional and untrusted. Recover valid fields independently. */
export const normalizeSettings = migrateReaderSettings;

export function resetDisplaySettings(settings: ReaderSettings): ReaderSettings {
  return { ...DEFAULT_SETTINGS, cpm: settings.cpm, punctuationPause: settings.punctuationPause, readingPace: settings.readingPace ?? 'legacy' };
}

export function hasStoredPreferences(): boolean {
  try {
    return JSON.parse(globalThis.localStorage.getItem(PREFERENCES_KEY) ?? 'null')?.schemaVersion === 1
      || JSON.parse(globalThis.localStorage.getItem('rsvp-audio-reading-options-v2') ?? 'null')?.settingsVersion === 2;
  } catch { return false; }
}

export function readPreferences(storage?: PreferenceStorage): ReaderPreferences {
  const defaults = { settings: { ...DEFAULT_SETTINGS }, audioRate: DEFAULT_AUDIO_RATE };
  try {
    const source = storage ?? globalThis.localStorage;
    const stored = JSON.parse(source.getItem(PREFERENCES_KEY) ?? 'null');
    if (stored?.schemaVersion === 1) {
      const rate = Number(stored.audioRate);
      const validRate = (typeof stored.audioRate === 'string' || typeof stored.audioRate === 'number') && Number.isFinite(rate) && rate >= .5 && rate <= 5 && rate * 4 === Math.round(rate * 4);
      return { settings: normalizeSettings(stored.settings), audioRate: validRate ? String(rate) : DEFAULT_AUDIO_RATE };
    }
    // Retain existing audio display choices when upgrading to shared preferences.
    const legacy = JSON.parse(source.getItem('rsvp-audio-reading-options-v2') ?? 'null');
    if (legacy?.settingsVersion === 2) return { ...defaults, settings: normalizeSettings(legacy) };
  } catch { /* Reading remains available with unavailable or malformed storage. */ }
  return defaults;
}

export function writePreferences(patch: Partial<ReaderPreferences>, storage?: PreferenceStorage): void {
  try {
    const source = storage ?? globalThis.localStorage;
    source.setItem(PREFERENCES_KEY, JSON.stringify({ schemaVersion: 1, ...readPreferences(source), ...patch }));
  } catch { /* Settings still apply for this session when persistence is blocked. */ }
}

export function consumeDisplayMigrationNotice(storage?: PreferenceStorage): string | undefined {
  try {
    const source = storage ?? globalThis.localStorage;
    const current = JSON.parse(source.getItem(PREFERENCES_KEY) ?? 'null');
    const settings = current?.schemaVersion === 1 ? current.settings : JSON.parse(source.getItem('rsvp-audio-reading-options-v2') ?? 'null');
    if (settings?.settingsVersion !== 3 && (settings?.groupTarget > 0 || settings?.groupMinimum > 0) && source.getItem('ripola-display-migration-v3') !== 'seen') {
      source.setItem('ripola-display-migration-v3', 'seen');
      return '表示量の設定が「1文・2〜10行」になりました。以前の文字数指定は「1文」に戻しています。表示量はいつでも変更できます。';
    }
  } catch { /* Optional explanation must not prevent reading. */ }
  return undefined;
}
