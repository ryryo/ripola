import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { COLOR_SCHEME_KEY, COLOR_SCHEME_MIGRATION_SCRIPT } from '../src/ui/color-scheme';
import { PREFERENCES_KEY } from '../src/reader/preferences';

function migrate(values: Record<string, string>) {
  const storage = { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } };
  runInNewContext(COLOR_SCHEME_MIGRATION_SCRIPT, {
    window: { localStorage: storage, matchMedia: () => ({ matches: false }) },
    document: { documentElement: { setAttribute: () => {} } },
  });
  return values[COLOR_SCHEME_KEY];
}

test('theme initialization migrates the previous shared and audio choices without overwriting a site preference', () => {
  for (const [contrast, expected] of [['night', 'dark'], ['paper', 'light']]) {
    const legacy = JSON.stringify({ schemaVersion: 1, settings: { contrast } });
    assert.equal(migrate({ [PREFERENCES_KEY]: legacy }), expected);
    assert.equal(migrate({ 'rsvp-audio-reading-options-v2': JSON.stringify({ settingsVersion: 2, contrast }) }), expected);
    for (const color of ['light', 'dark', 'auto']) assert.equal(migrate({ [COLOR_SCHEME_KEY]: color, [PREFERENCES_KEY]: legacy }), color);
  }
});

test('malformed or absent legacy data leaves system preference available', () => {
  for (const value of ['{', 'null', '[]', '{"schemaVersion":9,"settings":{"contrast":"night"}}', '{"schemaVersion":1,"settings":{"contrast":"other"}}']) {
    assert.equal(migrate({ [PREFERENCES_KEY]: value }), undefined);
    assert.equal(migrate({ [PREFERENCES_KEY]: value, 'rsvp-audio-reading-options-v2': '{"settingsVersion":2,"contrast":"night"}' }), 'dark');
  }
  assert.equal(migrate({}), undefined);
});

test('initial theme follows the system when storage access or reads are blocked', () => {
  for (const dark of [true, false]) for (const getter of [true, false]) {
    let initialScheme: string | undefined;
    const window = {
      matchMedia: () => ({ matches: dark }),
      get localStorage() {
        if (getter) throw new Error('blocked');
        return { getItem: () => { throw new Error('blocked'); } };
      },
    };
    runInNewContext(COLOR_SCHEME_MIGRATION_SCRIPT, { window, document: { documentElement: { setAttribute: (_name: string, value: string) => { initialScheme = value; } } } });
    assert.equal(initialScheme, dark ? 'dark' : 'light');
  }
});
