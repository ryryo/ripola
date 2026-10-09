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
  let python = false;
  for (const path of changed) {
    const add = (...items) => items.forEach(item => domains.add(item));
    if (/^(?:\.github\/|package\.json$|pnpm-|playwright\.config\.ts$|eslint\.config\.js$|\.node-version$|\.gitignore$|\.env\.example$|LICENSE$|apps\/web\/(?:package\.json|tsconfig\.json|vite\.config\.ts|\.npmignore)$)/.test(path)) { add(...all()); python = true; }
    else if (/^docs\/licenses\//.test(path)) add('distribution');
    else if (/^docs\/validation\/fixtures\//.test(path)) add('import');
    else if (/^apps\/web\/public\//.test(path)) add('distribution', 'layout', 'import', 'audio');
    else if (/^apps\/web\/tests\/browser\/[^/]+\.spec\.ts$/.test(path)) {
      const cases = browserCases.filter(item => path === `apps/web/tests/browser/${item.file}`);
      if (!cases.length) unknown = true;
      else cases.forEach(item => add(...item.domains));
    }
    // Unit tests always run. Editing one does not change the shipped browser code.
    else if (/^apps\/web\/tests\/[^/]+\.test\.ts$/.test(path)) { /* no extra browser domains */ }
    else if (/^apps\/web\/tests\//.test(path)) add(...all());
    else if (/^scripts\/(?:ci-|serve-pages-test|build-distribution|distribution-utils|audit-audio|stage-library|collect-third-party)/.test(path)) add(...all());
    else if (/^scripts\/(?:align|alignment|setup-alignment|check-alignment|download_alignment|test_align|test_check)/.test(path)) { add('setup', 'generation', 'audio'); python = true; }
    else if (/^scripts\/(?:generate-audio|compress-library|media-timing|public-alignment)/.test(path)) add('audio', 'generation', 'distribution');
    else if (/^scripts\/(?:prepare-pdf|generate-pdf|prepare-aozora|report-segmentation)/.test(path)) add('import', 'distribution');
    else if (/^scripts\/(?:public-audio-worker|capture-ux)/.test(path)) add('distribution', 'audio', 'layout');
    else if (/^apps\/web\/src\/reader\/pages-demo\.ts$/.test(path)) { /* Text fixture: the normal compiled Pages smoke covers it. */ }
    else if (/^apps\/web\/src\/reader\/(?:pdf-|text-|aozora-|segmentation|model|input-format)/.test(path)) add('import', 'layout');
    else if (/^apps\/web\/src\/reader\/(?:audio-|playback|storage|sentences|shortcuts|document-title)/.test(path)) add('audio', 'import', 'generation', 'layout');
    else if (/^apps\/web\/src\/reader\/(?:preferences\.ts$|ui\/|display-groups|reading-fonts)/.test(path)) add('import', 'audio', 'layout');
    else if (/^apps\/web\/src\/(?:styles\.css|theme\.ts)$/.test(path)) add('layout');
    else if (/^apps\/web\/src\/(?:generation\/|generation-ui\/|server\/)/.test(path)) add('generation', 'audio', 'distribution');
    else if (/^apps\/web\/src\/(?:distribution|sharing|assets|ui)\//.test(path)) add('distribution', 'audio', 'layout');
    else if (/^apps\/web\/src\/(?:distribution-ui\/|reader\/environment|router\.tsx|routes\/|start)/.test(path)) add(...all());
    else unknown = true;
  }
  return { code: true, mode: unknown ? 'full' : 'normal', domains: unknown ? all() : DOMAINS.filter(domain => domains.has(domain)), python: unknown || python, reason: unknown ? 'unclassified path: full suite' : 'normal plus related domains' };
}

/** Every viewport covers all fonts and both size/ruby states; full keeps the Cartesian matrix. */
export function wrappingVariants(mode, viewportIndex, fonts) {
  if (!['full', 'normal'].includes(mode) || !Number.isInteger(viewportIndex) || viewportIndex < 0 || viewportIndex > 2) throw new Error('Invalid wrapping scope');
  const silent = fonts.flatMap((family, index) => mode === 'full'
    ? [24, 96].flatMap(size => [false, true].map(ruby => ({ family, size, ruby })))
    : [{ family, size: (index + viewportIndex) % 2 ? 96 : 24, ruby: Boolean((Math.floor(index / 2) + viewportIndex) % 2) }]);
  const audio = fonts.flatMap((family, index) => mode === 'full'
    ? [false, true].map(ruby => ({ family, ruby }))
    : [{ family, ruby: Boolean((index + viewportIndex) % 2) }]);
  return { silent, audio };
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

export function assertBrowserFiles(files) {
  const registered = new Set(browserCases.map(item => item.file));
  if (files.some(file => !registered.has(file)) || [...registered].some(file => !files.includes(file))) throw new Error('Browser file registry mismatch: register every new .spec.ts file and its Playwright project before running CI');
}
