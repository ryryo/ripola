import { expect, test } from '@playwright/test';
test.use({ timezoneId: 'Asia/Tokyo' });

test('blank and whitespace titles use local time, and renaming a saved browser document persists without moving its source anchor', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:20:30Z'));
  await page.goto('/');
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('タイトル', { exact: true })).not.toHaveAttribute('required');
  await page.getByLabel('タイトル', { exact: true }).fill(' 　');
  await page.getByLabel('読む文章', { exact: true }).fill('私は本を読む。次の頁も読む。');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.locator('.document-heading h1')).toHaveText('2026/10/06 19:20:30');
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const phrase = await page.getByTestId('current-phrase').innerText();
  const position = await page.locator('.playback-position-label').innerText();
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await page.getByLabel('タイトルを変更', { exact: true }).fill('自作の読書記録');
  await page.getByRole('button', { name: '名前を変更', exact: true }).click();
  await expect(page.locator('.title-status')).toContainText('名前を変更');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.locator('.document-heading h1')).toHaveText('自作の読書記録');
  await expect(page.getByTestId('current-phrase')).toHaveText(phrase); await expect(page.locator('.playback-position-label')).toHaveText(position);
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.locator('.document-heading h1')).toHaveText('自作の読書記録');
  await expect(page.getByTestId('current-phrase')).toHaveText(phrase); await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
});

test('detailed audio preparation accepts an omitted title and retains an explicit title', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:20:30Z'));
  await page.goto('/generate');
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('');
  await page.getByLabel('原稿を貼り付け', { exact: true }).fill('自作の文章を準備する。');
  await page.getByRole('button', { name: '本文を確認する', exact: true }).click();
  await expect(page.locator('.manuscript-preview h3')).toHaveText('2026/10/06 19:20:30');
  await page.getByLabel('タイトル', { exact: true }).fill('入力した名前');
  await expect(page.locator('.manuscript-preview h3')).toHaveText('入力した名前');
});
