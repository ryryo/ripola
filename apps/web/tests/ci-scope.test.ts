import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrowserFiles, assertCaseInventory, browserCases, classifyChanges, DOMAINS, selectedCases } from '../../../scripts/ci-scope.mjs';

test('only allowlisted documentation bypasses shipping and browser checks', () => {
  assert.equal(classifyChanges(['README.md', 'docs/development/ci.md']).code, false);
  for (const path of ['docs/licenses/NOTICE.md', 'docs/validation/fixtures/book.md', '.env.example', 'LICENSE', 'apps/web/public/samples/audio/NOTICE.md', 'docs/unclassified/new.md']) assert.equal(classifyChanges([path]).code, true, path);
  assert.equal(classifyChanges(['README.md', 'apps/web/src/styles.css']).code, true);
});
test('manual runs full; unknown automatic diffs stay within the focused smoke budget', () => {
  assert.equal(classifyChanges(['README.md'], { manual: true }).mode, 'full');
  for (const scope of [classifyChanges([]), classifyChanges(['new/subsystem.ts']), classifyChanges(['README.md'], { uncertain: true })]) {
    assert.equal(scope.mode, 'normal'); assert.deepEqual(scope.domains, DOMAINS);
  }
  for (const path of ['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'playwright.config.ts']) assert.deepEqual(classifyChanges([path]).domains, DOMAINS, path);
});
test('targeted source changes retain mandatory smoke and the appropriate extra coverage', () => {
  assert.deepEqual(classifyChanges(['apps/web/src/reader/pages-demo.ts']).domains, []);
  assert.ok(classifyChanges(['apps/web/src/reader/pdf-import.ts']).domains.includes('import'));
  assert.ok(classifyChanges(['apps/web/src/generation/core/service.ts']).domains.includes('generation'));
  assert.equal(classifyChanges(['scripts/alignment-platforms.json']).python, true);
  const layout = selectedCases('normal', ['layout']);
  assert.equal(layout.filter(item => item.file === 'wrapping.spec.ts').length, 0);
  assert.equal(layout.filter(item => item.file === 'responsive.spec.ts').length, 1);
  assert.ok(layout.some(item => item.title.startsWith('vertical phrases')));
});
test('full preserves every registered case; selection is a union', () => {
  const original = browserCases.filter(item => item.project !== 'pages-chromium');
  assert.equal(original.filter(item => item.lane === 'normal').length, 12);
  assert.equal(original.filter(item => item.lane === 'local_opt_in').length, 4);
  assert.deepEqual(selectedCases('full'), browserCases);
  assert.equal(selectedCases('normal').length, 14);
  assert.deepEqual(selectedCases('normal', DOMAINS), browserCases.filter(item => item.lane === 'normal' || item.lane === 'related' && item.quick));
  assertCaseInventory(browserCases);
  const files = [...new Set(browserCases.map(item => item.file))];
  assertBrowserFiles(files);
  assert.throws(() => assertBrowserFiles([...files, 'unregistered.spec.ts']), /file registry mismatch/);
  assert.throws(() => assertBrowserFiles(files.slice(1)), /file registry mismatch/);
  assert.throws(() => assertCaseInventory(browserCases.slice(1)), /registry mismatch/);
  assert.throws(() => assertCaseInventory([...browserCases, { ...browserCases[0], title: 'new unregistered case' }]), /unknown=/);
  assert.throws(() => assertCaseInventory([...browserCases, browserCases[0]]), /registry mismatch/);
  assert.throws(() => selectedCases('normal', ['typo']), /Invalid/);
});

test('reader UI and preferences do not opt into generation/setup or Python; unknown sources retain every focused smoke', () => {
  for (const path of ['apps/web/src/reader/preferences.ts', 'apps/web/src/reader/ui/ReaderApp.tsx', 'apps/web/src/reader/ui/FullscreenReader.tsx', 'apps/web/src/reader/ui/useReaderPreferences.ts']) {
    const scope = classifyChanges([path]);
    assert.equal(scope.mode, 'normal', path);
    assert.deepEqual(scope.domains, ['import', 'audio', 'layout'], path);
    assert.equal(scope.python, false, path);
  }
  assert.deepEqual(classifyChanges(['apps/web/src/styles.css']).domains, ['layout']);
  const browser = classifyChanges(['apps/web/tests/browser/reading-options.spec.ts', 'apps/web/tests/preferences.test.ts']);
  assert.deepEqual(browser.domains, ['audio', 'layout']);
  assert.equal(browser.python, false);
  assert.deepEqual(classifyChanges(['apps/web/tests/preferences.test.ts']).domains, []);
  assert.deepEqual(classifyChanges(['apps/web/tests/browser/new-unregistered.spec.ts']).domains, DOMAINS);
  assert.deepEqual(classifyChanges(['apps/web/src/reader/new-subsystem.ts']).domains, DOMAINS);
  assert.equal(classifyChanges(['apps/web/src/generation/core/service.ts']).python, false);
  for (const path of ['scripts/align_audio.py', 'scripts/test_check_alignment_runtime.py', 'scripts/alignment-requirements.txt', '.github/workflows/ci.yml']) assert.equal(classifyChanges([path]).python, true, path);
});

test('automatic browser coverage remains bounded and full retains exhaustive regressions', () => {
  const automatic = selectedCases('normal', DOMAINS);
  assert.ok(automatic.length <= 24, 'replace a representative before expanding the automatic suite');
  assert.ok(automatic.length > selectedCases('normal').length);
  for (const item of selectedCases('normal')) assert.ok(automatic.includes(item));
  assert.ok(automatic.some(item => item.project === 'mobile-chromium' && item.title.startsWith('vertical phrases')));
  assert.ok(automatic.some(item => item.title.startsWith('audio vertical')));
  assert.ok(automatic.some(item => item.title.startsWith('vertical Guide')));
  assert.equal(selectedCases('full').filter(item => item.file === 'wrapping.spec.ts').length, 6);
  assert.equal(selectedCases('full').length, browserCases.length);
});
