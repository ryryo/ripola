import { test, expect } from '@playwright/test';
test('local server function rejects cross-origin, forged Host and missing browser evidence', async ({ page, request, baseURL }) => {
  const config = page.waitForResponse(response => response.url().includes('/_serverFn/') && response.request().method() === 'GET');
  await page.goto('/generate');
  const response = await config;
  expect(response.status()).toBe(200);
  const url = response.url();
  const headers: Record<string, string> = { ...response.request().headers(), origin: baseURL! };
  delete headers['sec-fetch-site']; delete headers['sec-fetch-mode']; delete headers['sec-fetch-dest'];
  expect((await request.get(url, { headers: { ...headers, origin: 'https://untrusted.example' } })).status()).toBe(403);
  expect((await request.get(url, { headers: { ...headers, host: 'untrusted.example' } })).status()).toBe(403);
  const withoutEvidence = { ...headers }; delete withoutEvidence.origin; delete withoutEvidence.referer;
  expect((await request.get(url, { headers: withoutEvidence })).status()).toBe(403);
  expect((await request.get(url, { headers })).status()).toBe(200);
  const body = await response.text();
  expect(body).not.toContain('GEMINI_API_KEY');
  expect(body).not.toContain('RSVP_LIBRARY_DIR');
  expect(body).not.toContain('x-goog-api-key');
});
