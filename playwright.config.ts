import { defineConfig } from '@playwright/test';
const baseURL = process.env.RSVP_TEST_BASE_URL ?? 'http://127.0.0.1:4173';
export default defineConfig({
  testDir: './apps/web/tests/browser',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', testMatch: ['reader.spec.ts', 'progress.spec.ts', 'generation.spec.ts', 'local-security.spec.ts', 'audio-alignment.spec.ts', 'audio-presentation.spec.ts', 'guide.spec.ts', 'aozora.spec.ts', 'reading-options.spec.ts', 'titles.spec.ts', 'creation-options.spec.ts'], use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-chromium', testMatch: ['responsive.spec.ts', 'generation.spec.ts', 'audio-alignment.spec.ts', 'audio-presentation.spec.ts', 'guide.spec.ts', 'aozora.spec.ts', 'reading-options.spec.ts', 'titles.spec.ts', 'creation-options.spec.ts', 'wrapping.spec.ts'], use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
  webServer: { command: baseURL === 'http://127.0.0.1:4174' ? 'pnpm preview' : 'pnpm dev', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
