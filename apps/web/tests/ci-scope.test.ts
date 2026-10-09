import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrowserFiles, assertCaseInventory, browserCases, classifyChanges, DOMAINS, selectedCases } from '../../../scripts/ci-scope.mjs';

test('only allowlisted documentation bypasses shipping and browser checks', () => {
  assert.equal(classifyChanges(['README.md', 'docs/development/ci.md']).code, false);
  for (const path of ['docs/licenses/NOTICE.md', 'docs/validation/fixtures/book.md', '.env.example', 'LICENSE', 'apps/web/public/samples/audio/NOTICE.md', 'docs/unclassified/new.md']) assert.equal(classifyChanges([path]).code, true, path);
  assert.equal(classifyChanges(['README.md', 'apps/web/src/styles.css']).code, true);
});
test('unknown, missing and manual diffs run full; foundation changes select every related domain', () => {
  for (const scope of [classifyChanges([]), classifyChanges(['new/subsystem.ts']), classifyChanges(['README.md'], { uncertain: true }), classifyChanges(['README.md'], { manual: true })]) assert.equal(scope.mode, 'full');
  for (const path of ['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'playwright.config.ts', 'apps/web/src/reader/ui/ReaderApp.tsx']) assert.deepEqual(classifyChanges([path]).domains, DOMAINS, path);
});
test('targeted source changes retain mandatory smoke and the appropriate extra coverage', () => {
  assert.deepEqual(classifyChanges(['apps/web/src/reader/pages-demo.ts']).domains, []);
  assert.ok(classifyChanges(['apps/web/src/reader/pdf-import.ts']).domains.includes('import'));
  assert.ok(classifyChanges(['apps/web/src/generation/core/service.ts']).domains.includes('generation'));
  assert.equal(classifyChanges(['scripts/alignment-platforms.json']).python, true);
  const layout = selectedCases('normal', ['layout']);
  assert.equal(layout.filter(item => item.file === 'wrapping.spec.ts').length, 6);
  assert.equal(layout.filter(item => item.file === 'responsive.spec.ts').length, 6);
  assert.equal(layout.filter(item => item.file === 'guide.spec.ts').length, 2);
});
test('full includes all registered reader and Pages cases; selection is a union', () => {
  const original = browserCases.filter(item => item.project !== 'pages-chromium');
  assert.equal(original.length, 140);
  assert.equal(original.filter(item => item.lane === 'normal').length, 12);
  assert.equal(original.filter(item => item.lane === 'local_opt_in').length, 4);
  assert.equal(selectedCases('full').length, 142);
  assert.equal(selectedCases('normal').length, 14);
  assert.equal(selectedCases('normal', DOMAINS).length, 96);
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
