import { defineConfig } from '@playwright/test';
import { projectGrep } from './scripts/ci-scope.mjs';
const mode = process.env.RIPOLA_CI_MODE ?? 'full';
const domains = (process.env.RIPOLA_CI_DOMAINS ?? '').split(',').filter(Boolean);
const baseURL = process.env.RSVP_TEST_BASE_URL ?? 'http://127.0.0.1:4173';
const pagesURL = process.env.RSVP_PAGES_TEST_BASE_URL ?? 'http://127.0.0.1:4175/ripola/';
const local = new URL(baseURL);
const pages = new URL(pagesURL);
if ([local, pages].some(url => url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port))) throw new Error('Test servers must use explicit loopback ports');
export default defineConfig({
  testDir: './apps/web/tests/browser',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', grep: projectGrep('desktop-chromium', mode, domains), testMatch: ['reader.spec.ts', 'progress.spec.ts', 'generation.spec.ts', 'local-security.spec.ts', 'audio-alignment.spec.ts', 'audio-presentation.spec.ts', 'guide.spec.ts', 'aozora.spec.ts', 'reading-options.spec.ts', 'fullscreen.spec.ts', 'titles.spec.ts', 'creation-options.spec.ts'], use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-chromium', grep: projectGrep('mobile-chromium', mode, domains), testMatch: ['responsive.spec.ts', 'generation.spec.ts', 'audio-alignment.spec.ts', 'audio-presentation.spec.ts', 'guide.spec.ts', 'aozora.spec.ts', 'reading-options.spec.ts', 'fullscreen.spec.ts', 'titles.spec.ts', 'creation-options.spec.ts', 'wrapping.spec.ts'], use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'pages-chromium', testMatch: ['pages-smoke.spec.ts'], use: { browserName: 'chromium', baseURL: pagesURL, viewport: { width: 1280, height: 900 } } },
  ],
  webServer: [ { command: baseURL === 'http://127.0.0.1:4174' ? 'pnpm preview' : `node scripts/prepare-pdf-assets.mjs && pnpm --filter @ripola/web exec vite --host 127.0.0.1 --port ${local.port} --strictPort`, env: { RSVP_LOCAL_ORIGIN: local.origin }, url: baseURL, reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: 'node scripts/serve-pages-test.mjs', env: { RSVP_PAGES_TEST_PORT: pages.port }, url: pagesURL, reuseExistingServer: false, timeout: 15_000 },
  ],
});
