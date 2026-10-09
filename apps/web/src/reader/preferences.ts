import { DEFAULT_SETTINGS, type ReaderSettings } from './model';
import { isReadingFont } from './reading-fonts';

export const PREFERENCES_KEY = 'ripola-reader-preferences-v1';
export const DEFAULT_AUDIO_RATE = '2.5';
export interface ReaderPreferences { settings: ReaderSettings; audioRate: string }
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Browser data is optional and untrusted. Recover valid fields independently. */
export function normalizeSettings(value: unknown): ReaderSettings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings;
  const stored = value as Record<string, unknown>;
  const integer = (key: string, min: number, max: number) => typeof stored[key] === 'number' && Number.isInteger(stored[key]) && Number(stored[key]) >= min && Number(stored[key]) <= max;
  if (integer('cpm', 100, 3000)) settings.cpm = Number(stored.cpm);
  if (integer('fontSize', 24, 96)) settings.fontSize = Number(stored.fontSize);
  if (integer('groupTarget', 0, 24)) settings.groupTarget = Number(stored.groupTarget);
  if (integer('groupMinimum', 0, 12)) settings.groupMinimum = Number(stored.groupMinimum);
  for (const key of ['punctuationPause', 'ruby', 'guide', 'context'] as const) if (typeof stored[key] === 'boolean') settings[key] = stored[key];
  if (isReadingFont(stored.fontFamily)) settings.fontFamily = stored.fontFamily;
  if (stored.writingMode === 'horizontal-tb' || stored.writingMode === 'vertical-rl') settings.writingMode = stored.writingMode;
  if (stored.mode === 'flash' || stored.mode === 'guide') settings.mode = stored.mode;
  if (stored.contrast === 'paper' || stored.contrast === 'night') settings.contrast = stored.contrast;
  return settings;
}

export function resetDisplaySettings(settings: ReaderSettings): ReaderSettings {
  return { ...DEFAULT_SETTINGS, cpm: settings.cpm, punctuationPause: settings.punctuationPause };
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
