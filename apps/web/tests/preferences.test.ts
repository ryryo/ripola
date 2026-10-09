import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/reader/model.ts';
import { PREFERENCES_KEY, normalizeSettings, readPreferences, resetDisplaySettings, writePreferences } from '../src/reader/preferences.ts';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test('preferences retain separate speeds and shared display settings without manuscript data', () => {
  const local = storage();
  writePreferences({ audioRate: '5' }, local);
  writePreferences({ settings: { ...DEFAULT_SETTINGS, cpm: 850, contrast: 'night', ruby: false, fontSize: 72 } }, local);
  assert.equal(readPreferences(local).audioRate, '5');
  assert.equal(readPreferences(local).settings.cpm, 850);
  assert.equal(readPreferences(local).settings.contrast, 'night');
  assert.deepEqual(Object.keys(JSON.parse(local.getItem(PREFERENCES_KEY)!)).sort(), ['audioRate', 'schemaVersion', 'settings']);
});
test('malformed, unsupported and inaccessible storage leave valid bounded defaults', () => {
  const local = storage();
  for (const source of ['{', 'null', '[]', '{"schemaVersion":9,"audioRate":"5"}']) {
    local.setItem(PREFERENCES_KEY, source);
    assert.deepEqual(readPreferences(local), { settings: DEFAULT_SETTINGS, audioRate: '2.5' });
  }
  local.setItem(PREFERENCES_KEY, JSON.stringify({ schemaVersion: 1, audioRate: 6, settings: { cpm: -1, fontSize: 999, fontFamily: '__proto__', mode: 'other', contrast: 'bad', ruby: 'false', guide: false, groupTarget: null } }));
  assert.deepEqual(readPreferences(local), { settings: { ...DEFAULT_SETTINGS, guide: false }, audioRate: '2.5' });
  for (const audioRate of ['NaN', '0.49', '2.6', null, false, true, {}, [], [2]]) {
    local.setItem(PREFERENCES_KEY, JSON.stringify({ schemaVersion: 1, audioRate }));
    assert.equal(readPreferences(local).audioRate, '2.5');
  }
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readPreferences(blocked).settings, DEFAULT_SETTINGS);
  assert.doesNotThrow(() => writePreferences({ audioRate: '4' }, blocked));
  assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS);
});
test('old audio display preferences migrate; reset preserves both speeds and rhythm', () => {
  const local = storage();
  const settings = { ...DEFAULT_SETTINGS, fontFamily: 'noto-serif-jp' as const, cpm: 900, punctuationPause: false, fontSize: 72, contrast: 'night' as const };
  local.setItem('rsvp-audio-reading-options-v2', JSON.stringify(settings));
  assert.deepEqual(readPreferences(local).settings, settings);
  writePreferences({ audioRate: '4.75', settings: resetDisplaySettings(settings) }, local);
  assert.deepEqual(readPreferences(local), { audioRate: '4.75', settings: { ...DEFAULT_SETTINGS, cpm: 900, punctuationPause: false } });
  assert.equal(JSON.parse(local.getItem('rsvp-audio-reading-options-v2')!).contrast, 'night');
});
