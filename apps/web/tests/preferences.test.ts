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
  writePreferences({ settings: { ...DEFAULT_SETTINGS, cpm: 850, ruby: false, fontSize: 72, writingMode: 'vertical-rl' } }, local);
  assert.equal(readPreferences(local).audioRate, '5');
  assert.equal(readPreferences(local).settings.cpm, 850);
  assert.equal('contrast' in readPreferences(local).settings, false);
  assert.equal(readPreferences(local).settings.writingMode, 'vertical-rl');
  assert.deepEqual(Object.keys(JSON.parse(local.getItem(PREFERENCES_KEY)!)).sort(), ['audioRate', 'schemaVersion', 'settings']);
});
test('malformed, unsupported and inaccessible storage leave valid bounded defaults', () => {
  const local = storage();
  for (const source of ['{', 'null', '[]', '{"schemaVersion":9,"audioRate":"5"}']) {
    local.setItem(PREFERENCES_KEY, source);
    assert.deepEqual(readPreferences(local), { settings: DEFAULT_SETTINGS, audioRate: '2.5' });
  }
  local.setItem(PREFERENCES_KEY, JSON.stringify({ schemaVersion: 1, audioRate: 6, settings: { cpm: -1, fontSize: 999, fontFamily: '__proto__', mode: 'other', writingMode: 'sideways', contrast: 'bad', ruby: 'false', guide: false, groupTarget: null } }));
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
  const settings = { ...DEFAULT_SETTINGS, fontFamily: 'noto-serif-jp' as const, cpm: 900, punctuationPause: false, fontSize: 72, contrast: 'night' as const, writingMode: 'vertical-rl' as const };
  local.setItem('rsvp-audio-reading-options-v2', JSON.stringify({ ...settings, settingsVersion: 2 }));
  assert.deepEqual(readPreferences(local).settings, { ...DEFAULT_SETTINGS, fontFamily: settings.fontFamily, cpm: 900, punctuationPause: false, fontSize: 72, writingMode: settings.writingMode });
  writePreferences({ audioRate: '4.75', settings: resetDisplaySettings(settings) }, local);
  assert.deepEqual(readPreferences(local), { audioRate: '4.75', settings: { ...DEFAULT_SETTINGS, cpm: 900, punctuationPause: false } });
  assert.equal(JSON.parse(local.getItem('rsvp-audio-reading-options-v2')!).contrast, 'night');
});

test('pace choice persists independently of speeds; old or unknown choices keep legacy behavior', () => {
  const local = storage();
  writePreferences({ settings: { ...DEFAULT_SETTINGS, readingPace: 'text-load', cpm: 850 } }, local);
  writePreferences({ audioRate: '1.75' }, local);
  assert.equal(readPreferences(local).settings.readingPace, 'text-load');
  assert.equal(readPreferences(local).settings.cpm, 850);
  assert.equal(readPreferences(local).audioRate, '1.75');
  assert.equal(resetDisplaySettings(readPreferences(local).settings).readingPace, 'text-load');
  for (const readingPace of [undefined, null, 'unknown', {}, 1]) {
    local.setItem(PREFERENCES_KEY, JSON.stringify({ schemaVersion: 1, settings: { cpm: 900, readingPace }, audioRate: '4' }));
    assert.equal(readPreferences(local).settings.readingPace, 'legacy');
    assert.equal(readPreferences(local).settings.cpm, 900);
    assert.equal(readPreferences(local).audioRate, '4');
  }
});

test('fullscreen progress defaults to visible, persists hiding and returns on display reset', () => {
  const local = storage();
  assert.equal(readPreferences(local).settings.fullscreenProgress, true);
  writePreferences({ settings: { ...DEFAULT_SETTINGS, fullscreenProgress: false, ruby: false } }, local);
  assert.equal(readPreferences(local).settings.fullscreenProgress, false);
  assert.equal(readPreferences(local).settings.ruby, false);
  assert.equal(resetDisplaySettings(readPreferences(local).settings).fullscreenProgress, true);
  for (const fullscreenProgress of [undefined, null, 'false', 0]) {
    assert.equal(normalizeSettings({ fullscreenProgress }).fullscreenProgress, true);
  }
});

test('highlight choices persist independently and reset to blue with normal intensity', () => {
  const local = storage();
  assert.equal(readPreferences(local).settings.highlightColor, 'blue');
  assert.equal(readPreferences(local).settings.highlightIntensity, 'normal');
  for (const highlightColor of ['blue', 'yellow'] as const) {
    for (const highlightIntensity of ['light', 'normal', 'strong'] as const) {
      writePreferences({ settings: { ...DEFAULT_SETTINGS, highlightColor, highlightIntensity, cpm: 900, readingPace: 'text-load' }, audioRate: '4' }, local);
      const restored = readPreferences(local);
      assert.equal(restored.settings.highlightColor, highlightColor);
      assert.equal(restored.settings.highlightIntensity, highlightIntensity);
      writePreferences({ settings: resetDisplaySettings(restored.settings) }, local);
      assert.deepEqual(readPreferences(local), { audioRate: '4', settings: { ...DEFAULT_SETTINGS, cpm: 900, readingPace: 'text-load' } });
    }
  }
});

test('old or malformed highlight choices recover independently without losing other settings', () => {
  for (const value of [undefined, null, '', 'unknown', 0, false, {}, [], ['yellow']]) {
    const color = normalizeSettings({ highlightColor: value, highlightIntensity: 'strong', cpm: 900 });
    assert.equal(color.highlightColor, 'blue');
    assert.equal(color.highlightIntensity, 'strong');
    assert.equal(color.cpm, 900);
    const intensity = normalizeSettings({ highlightColor: 'yellow', highlightIntensity: value, ruby: false });
    assert.equal(intensity.highlightColor, 'yellow');
    assert.equal(intensity.highlightIntensity, 'normal');
    assert.equal(intensity.ruby, false);
  }
});

test('multiline spacing defaults to normal, persists each choice and resets without changing speeds', () => {
  const local = storage();
  assert.equal(readPreferences(local).settings.multilineSpacing, 'normal');
  for (const multilineSpacing of ['narrow', 'normal', 'wide'] as const) {
    writePreferences({ settings: { ...DEFAULT_SETTINGS, multilineSpacing, cpm: 900, highlightColor: 'yellow' }, audioRate: '4' }, local);
    assert.equal(readPreferences(local).settings.multilineSpacing, multilineSpacing);
    assert.equal(readPreferences(local).settings.highlightColor, 'yellow');
    writePreferences({ settings: resetDisplaySettings(readPreferences(local).settings) }, local);
    assert.deepEqual(readPreferences(local), { audioRate: '4', settings: { ...DEFAULT_SETTINGS, cpm: 900 } });
  }
  for (const multilineSpacing of [undefined, null, '', 'unknown', 1.6, false, {}, [], ['wide']]) {
    const settings = normalizeSettings({ multilineSpacing, highlightColor: 'yellow', cpm: 900 });
    assert.equal(settings.multilineSpacing, 'normal');
    assert.equal(settings.highlightColor, 'yellow');
    assert.equal(settings.cpm, 900);
  }
});
