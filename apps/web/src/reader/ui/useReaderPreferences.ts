import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { DEFAULT_SETTINGS, type ReaderSettings } from '../model';
import { DEFAULT_AUDIO_RATE, readPreferences, writePreferences } from '../preferences';

export function useReaderPreferences() {
  // Restore after hydration so the server and first browser render agree.
  const [settings, applySettings] = useState<ReaderSettings>({ ...DEFAULT_SETTINGS });
  const [rate, applyRate] = useState(DEFAULT_AUDIO_RATE);
  const currentSettings = useRef(settings);
  const currentRate = useRef(rate);
  useEffect(() => {
    const stored = readPreferences();
    currentSettings.current = stored.settings; currentRate.current = stored.audioRate;
    applySettings(stored.settings); applyRate(stored.audioRate);
  }, []);
  const setSettings = useCallback((action: SetStateAction<ReaderSettings>) => {
    const next = typeof action === 'function' ? action(currentSettings.current) : action;
    currentSettings.current = next; applySettings(next); writePreferences({ settings: next });
  }, []);
  const setRate = useCallback((action: SetStateAction<string>) => {
    const next = typeof action === 'function' ? action(currentRate.current) : action;
    currentRate.current = next; applyRate(next); writePreferences({ audioRate: next });
  }, []);
  return { settings, setSettings, rate, setRate };
}
