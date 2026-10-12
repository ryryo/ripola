import { PREFERENCES_KEY } from '../reader/preferences';

export const COLOR_SCHEME_KEY = 'ripola-color-scheme';

function migrateColorScheme(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, preferencesKey: string) {
  try {
    const current = storage.getItem(key);
    if (current === 'light' || current === 'dark' || current === 'auto') return;
    for (const legacyKey of [preferencesKey, 'rsvp-audio-reading-options-v2']) {
      try {
        const legacy = JSON.parse(storage.getItem(legacyKey) ?? 'null');
        const contrast = legacyKey === preferencesKey
          ? legacy?.schemaVersion === 1 && legacy.settings?.contrast
          : legacy?.settingsVersion === 2 && legacy.contrast;
        if (contrast === 'paper' || contrast === 'night') {
          storage.setItem(key, contrast === 'night' ? 'dark' : 'light');
          return;
        }
      } catch { /* Continue to the next legacy preference record. */ }
    }
  } catch { /* Theme selection also works when browser storage is unavailable. */ }
}

// Runs before Mantine's initialization script, including in the static Pages shell.
export const COLOR_SCHEME_MIGRATION_SCRIPT = `try {
  document.documentElement.setAttribute('data-mantine-color-scheme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  (${migrateColorScheme.toString()})(window.localStorage, ${JSON.stringify(COLOR_SCHEME_KEY)}, ${JSON.stringify(PREFERENCES_KEY)});
} catch {}`;
