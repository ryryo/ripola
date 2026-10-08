import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { inspectCalmPlayback } from './calm-inspection';

async function read(page: Page, text: string) {
  await page.goto('/');
  await page.getByLabel('読む文章', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
}
const value = (page: Page) => page.getByRole('progressbar', { name: '読書の進捗' }).evaluate(element => Number((element as HTMLElement).dataset.progress));

test('時間ゲージは長短フレーズと句読点の間を跨いで一定の速度で進む', async ({ page, baseURL }) => {
  await read(page, '朝。\n\n一番長いフレーズの中でも、ゲージは一定の速度で進む。\n\n小さな句読点の間も、同じ時計を使って進む。\n\n止めたら止まり、続きから再開する。');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const samples = await page.evaluate(() => new Promise<Array<{ ms: number; fraction: number; phrase: string }>>(resolve => {
    const values: Array<{ ms: number; fraction: number; phrase: string }> = [];
    const started = performance.now();
    const sample = () => {
      values.push({ ms: performance.now() - started, fraction: Number((document.querySelector('.reading-track') as HTMLElement).dataset.progress), phrase: document.querySelector('[data-testid="current-phrase"]')?.textContent ?? '' });
      if (performance.now() - started < 1900) requestAnimationFrame(sample);
      else resolve(values);
    }; sample();
  }));
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const first = samples[0], last = samples.at(-1)!;
  const rate = (last.fraction - first.fraction) / (last.ms - first.ms);
  const residual = Math.max(...samples.map(s => Math.abs(s.fraction - (first.fraction + rate * (s.ms - first.ms)))));
  expect(new Set(samples.map(s => s.phrase)).size).toBeGreaterThanOrEqual(3);
  expect(samples.filter((s, i) => i > 0 && s.fraction > samples[i - 1].fraction).length).toBeGreaterThan(20);
  expect(samples.every((s, i) => i === 0 || s.fraction >= samples[i - 1].fraction)).toBeTruthy();
  expect(residual).toBeLessThan(.012);
  await mkdir('docs/validation/ui-2026-10-06', { recursive: true });
  await writeFile('docs/validation/ui-2026-10-06/progress-samples.json', `${JSON.stringify({ baseURL, measuredAt: new Date().toISOString(), maxLinearResidual: residual, samples }, null, 2)}\n`);
});

test('時間ゲージは停止・再開・速度変更・戻る・シーク・非表示停止と整合する', async ({ page }) => {
  await read(page, 'abcdefghijklmnopqrstuvwx\n\nABCDEFGHIJKLMNOPQRSTUVWXYZ');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const frozen = await value(page); expect(frozen).toBeGreaterThan(0);
  await page.waitForTimeout(200); expect(await value(page)).toBe(frozen);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const beforeSpeed = await value(page);
  await page.getByLabel('読む速さ（字/分）').fill('1200');
  const afterSpeed = await value(page);
  expect(afterSpeed).toBeGreaterThanOrEqual(beforeSpeed); expect(afterSpeed - beforeSpeed).toBeLessThan(.03);
  await page.waitForTimeout(200); expect(await value(page)).toBeGreaterThan(afterSpeed);
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1つ戻る', exact: true }).click(); expect(await value(page)).toBe(0);
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await page.locator('.source-unit').filter({ hasText: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }).click();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  expect(await value(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  const background = await value(page); await page.waitForTimeout(200); expect(await value(page)).toBe(background);
});

test('ゲージは最終単位の表示中も進み、読了で100%、再読で0%', async ({ page }) => {
  await read(page, '一。');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.waitForTimeout(150);
  expect(await value(page)).toBeGreaterThan(0); expect(await value(page)).toBeLessThan(1);
  await expect(page.getByRole('button', { name: 'もう一度', exact: true })).toBeVisible(); expect(await value(page)).toBe(1);
  await page.getByRole('button', { name: 'もう一度', exact: true }).click(); expect(await value(page)).toBe(0);
});

test('reduced motionは連続描画を控え、静的原文と進捗の意味を残す', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await read(page, 'abcdefghijklmnopqrstuvwx\n\n続きの言葉。');
  const track = page.getByRole('progressbar', { name: '読書の進捗' });
  await expect(track).toHaveAttribute('aria-valuetext', /再生時間/);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const first = await value(page); await page.waitForTimeout(150); expect(await value(page)).toBe(first);
  await page.getByRole('button', { name: '一時停止', exact: true }).click(); expect(await value(page)).toBeGreaterThan(first);
  await expect(page.getByTestId('current-phrase')).toHaveAttribute('aria-live', 'off');
});

test('黙読再生中は本文だけが切り替わり、滑らかなゲージと停止時の詳細を保つ', async ({ page }) => {
  await read(page, '静かな朝に窓を開きます。図書館で一冊の本を読みます。頁をめくり、言葉を確かめます。次の文をゆっくり読み進めます。');
  await page.getByLabel('読む速さ（字/分）').fill('800');
  await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const observed = await inspectCalmPlayback(page);
  expect(observed.changedOutsideBody).toBe(false); expect(observed.bodyChanges).toBeGreaterThanOrEqual(2);
  expect(observed.progressIncreases).toBeGreaterThan(20); expect(observed.maxLayoutShift).toBeLessThan(1);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect(page.locator('.stage-topline')).toContainText('フレーズ');
  await expect(page.locator('.progress-percentage')).toHaveText(/\d+%/);
  await expect(page.locator('.progress-caption')).toContainText('残り 約');
});
