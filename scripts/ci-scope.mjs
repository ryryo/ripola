import { readFileSync } from 'node:fs';

export const DOMAINS = ['import', 'audio', 'generation', 'layout', 'distribution', 'setup'];
export const browserCases = JSON.parse(readFileSync(new URL('./ci-browser-cases.json', import.meta.url), 'utf8'));
const all = () => [...DOMAINS];
const docs = path => /^(?:README\.md|CONTRIBUTING\.md|docs\/README\.md)$/.test(path)
  || /^docs\/(?:guides|development|research|validation\/public-release)\/.+\.(?:md|json)$/.test(path);

/** Allowlist pure documentation; unknown paths fail closed to the complete suite. */
export function classifyChanges(paths, { manual = false, uncertain = false } = {}) {
  if (manual || uncertain || !paths.length) return { code: true, mode: 'full', domains: all(), python: true, reason: manual ? 'manual full' : 'unknown diff' };
  const changed = paths.filter(path => !docs(path));
  if (!changed.length) return { code: false, mode: 'docs', domains: [], python: false, reason: 'documentation only' };
  const domains = new Set();
  let unknown = false;
  for (const path of changed) {
    const add = (...items) => items.forEach(item => domains.add(item));
    if (/^(?:\.github\/|package\.json$|pnpm-|playwright\.config\.ts$|eslint\.config\.js$|\.node-version$|\.gitignore$|\.env\.example$|LICENSE$|apps\/web\/(?:package\.json|tsconfig\.json|vite\.config\.ts|\.npmignore)$)/.test(path)) add(...all());
    else if (/^docs\/licenses\//.test(path)) add('distribution');
    else if (/^docs\/validation\/fixtures\//.test(path)) add('import');
    else if (/^apps\/web\/public\//.test(path)) add('distribution', 'layout', 'import', 'audio');
    else if (/^apps\/web\/tests\//.test(path)) add(...all());
    else if (/^scripts\/(?:ci-|serve-pages-test|build-distribution|distribution-utils|audit-audio|stage-library|collect-third-party)/.test(path)) add(...all());
    else if (/^scripts\/(?:align|alignment|setup-alignment|check-alignment|download_alignment|test_align|test_check)/.test(path)) add('setup', 'generation', 'audio');
    else if (/^scripts\/(?:generate-audio|compress-library|media-timing|public-alignment)/.test(path)) add('audio', 'generation', 'distribution');
    else if (/^scripts\/(?:prepare-pdf|generate-pdf|prepare-aozora|report-segmentation)/.test(path)) add('import', 'distribution');
    else if (/^scripts\/(?:public-audio-worker|capture-ux)/.test(path)) add('distribution', 'audio', 'layout');
    else if (/^apps\/web\/src\/reader\/pages-demo\.ts$/.test(path)) { /* Text fixture: the normal compiled Pages smoke covers it. */ }
    else if (/^apps\/web\/src\/reader\/(?:pdf-|text-|aozora-|segmentation|model|input-format)/.test(path)) add('import', 'layout');
    else if (/^apps\/web\/src\/reader\/(?:audio-|playback|storage|sentences|shortcuts|document-title)/.test(path)) add('audio', 'import', 'generation', 'layout');
    else if (/^apps\/web\/src\/(?:generation\/|generation-ui\/|server\/)/.test(path)) add('generation', 'audio', 'distribution');
    else if (/^apps\/web\/src\/(?:distribution|sharing|assets|ui)\//.test(path)) add('distribution', 'audio', 'layout');
    else if (/^apps\/web\/src\/(?:distribution-ui\/|reader\/ui\/|reader\/(?:display-groups|reading-fonts|environment)|styles\.css|theme\.ts|router\.tsx|routes\/|start)/.test(path)) add(...all());
    else unknown = true;
  }
  return { code: true, mode: unknown ? 'full' : 'normal', domains: unknown ? all() : DOMAINS.filter(domain => domains.has(domain)), python: unknown || domains.has('setup') || domains.has('generation'), reason: unknown ? 'unclassified path: full suite' : 'normal plus related domains' };
}

export function selectedCases(mode = 'full', domains = []) {
  if (!['full', 'normal'].includes(mode) || domains.some(domain => !DOMAINS.includes(domain))) throw new Error('Invalid CI browser scope');
  return browserCases.filter(item => mode === 'full' || item.lane === 'normal' || item.lane === 'related' && item.domains.some(domain => domains.includes(domain)));
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function projectGrep(project, mode, domains) {
  if (mode === 'full') return undefined;
  const patterns = selectedCases(mode, domains).filter(item => item.project === project).map(item => `${escape(item.file)}.*${escape(item.title)}$`);
  return new RegExp(patterns.length ? patterns.join('|') : '(?!)');
}
export const caseKey = item => JSON.stringify([item.project, item.file, item.title]);
export function assertCaseInventory(actual, expected = browserCases) {
  const actualKeys = actual.map(caseKey).sort();
  const expectedKeys = expected.map(caseKey).sort();
  if (new Set(actualKeys).size !== actualKeys.length || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    const missing = expectedKeys.filter(key => !actualKeys.includes(key));
    const unknown = actualKeys.filter(key => !expectedKeys.includes(key));
    throw new Error(`CI case registry mismatch: missing=${JSON.stringify(missing)} unknown=${JSON.stringify(unknown)}. Update scripts/ci-browser-cases.json; never silently omit new tests.`);
  }
}
