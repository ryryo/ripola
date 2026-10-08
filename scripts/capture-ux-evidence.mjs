/* global document, innerWidth, innerHeight -- evaluated in the browser callbacks */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseURL = process.env.RSVP_TEST_BASE_URL ?? 'http://127.0.0.1:4174';
const prefix = process.env.RSVP_EVIDENCE_PREFIX ?? 'after';
const directory = resolve('docs/validation/ui-2026-10-06');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const measurements = [];
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile', deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole('button', { name: '短い文章で試す', exact: true }).click();
    await expect(page.getByTestId('current-phrase')).toHaveText('朝の');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    measurements.push({ name, ...await page.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, stage: bounds('.reader-stage'), phrase: bounds('.phrase'), controls: bounds('.reader-controls') };
    }) });
    await page.screenshot({ path: `${directory}/${prefix}-reader-${name}.png`, fullPage: true });
    await page.getByRole('button', { name: '表示設定', exact: true }).click();
    await expect(page.getByLabel('文字サイズ', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${directory}/${prefix}-settings-${name}.png`, fullPage: true });
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.locator('.mantine-Drawer-content')).toHaveCount(0);
    await page.getByRole('button', { name: '原文', exact: true }).click();
    await expect(page.getByLabel('抽出した全文')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${directory}/${prefix}-source-${name}.png`, fullPage: true });
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.locator('.mantine-Drawer-content')).toHaveCount(0);
    await page.getByRole('button', { name: '表示設定', exact: true }).click();
    await page.getByLabel('暗い背景', { exact: true }).check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${directory}/${prefix}-settings-night-${name}.png`, fullPage: true });
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.locator('.mantine-Drawer-content')).toHaveCount(0);
    await page.screenshot({ path: `${directory}/${prefix}-reader-night-${name}.png`, fullPage: true });
    await context.close();
  }
  await writeFile(`${directory}/${prefix}-layout.json`, `${JSON.stringify({ measuredAt: new Date().toISOString(), baseURL, measurements }, null, 2)}\n`);

  if (prefix === 'after') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: '/tmp/rsvp-reader-ux-recording', size: { width: 1280, height: 900 } } });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole('button', { name: '短い文章で試す', exact: true }).click();
    await expect(page.getByTestId('current-phrase')).toHaveText('朝の');
    await page.waitForTimeout(300);
    const started = Date.now();
    const checkpoints = [];
    const checkpoint = async (label) => checkpoints.push({ label, ms: Date.now() - started, ...await page.evaluate(() => ({ fraction: Number(document.querySelector('.reading-track').dataset.progress), phrase: document.querySelector('[data-testid="current-phrase"]').textContent })) });
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await page.waitForTimeout(2200); await checkpoint('playing');
    await page.getByRole('button', { name: '一時停止', exact: true }).click(); await checkpoint('paused');
    await page.waitForTimeout(800); await checkpoint('paused-after-wait');
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await page.waitForTimeout(3500); await checkpoint('resumed');
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
    await page.waitForTimeout(400);
    const video = page.video();
    await context.close();
    await copyFile(await video.path(), `${directory}/progress-demo.webm`);
    await writeFile(`${directory}/video-checkpoints.json`, `${JSON.stringify({ baseURL, measuredAt: new Date().toISOString(), checkpoints }, null, 2)}\n`);
  }
} finally { await browser.close(); }
console.log(`UX evidence captured from ${baseURL}.`);
