import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { assertBrowserFiles, assertCaseInventory, browserCases, selectedCases } from './ci-scope.mjs';

assertBrowserFiles(readdirSync(new URL('../apps/web/tests/browser/', import.meta.url), { recursive: true }).filter(file => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file)).map(file => basename(file)));
const mode = process.env.RIPOLA_CI_MODE ?? 'full';
const domains = (process.env.RIPOLA_CI_DOMAINS ?? '').split(',').filter(Boolean);
function listing(listMode, listDomains) {
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RIPOLA_CI_MODE: listMode, RIPOLA_CI_DOMAINS: listDomains.join(',') },
  });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || 'Playwright inventory failed');
  const report = JSON.parse(result.stdout);
  const cases = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) for (const item of spec.tests) cases.push({ project: item.projectName, file: basename(spec.file), title: spec.title });
    for (const child of suite.suites ?? []) visit(child);
  }
  report.suites.forEach(visit);
  return cases;
}
assertCaseInventory(listing('full', []));
const expected = selectedCases(mode, domains);
assertCaseInventory(listing(mode, domains), expected);
console.log(`Browser scope: ${mode}; domains: ${domains.join(',') || 'none'}; selected ${expected.length}/${browserCases.length} (all registered cases retained in full).`);
if (process.argv.includes('--list')) process.exit(0);
const run = spawnSync('pnpm', ['exec', 'playwright', 'test'], { stdio: 'inherit', env: { ...process.env, RIPOLA_CI_MODE: mode, RIPOLA_CI_DOMAINS: domains.join(',') } });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
