import { test, expect, type Page } from '@playwright/test';

const manuscript = '静かな朝に図書館で本を読みます。窓の向こうに青い空が広がっています。次の頁をゆっくりめくります。'.repeat(5);
async function read(page: Page) {
  await page.goto('/');
  await page.getByLabel('読む文章', { exact: true }).fill(manuscript);
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
}
async function viewportSurface(page: Page) {
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  await expect(full).toBeVisible();
  const bounds = await full.evaluate(element => {
    const stage = element.querySelector('.reader-stage, .audio-stage')!;
    const r = stage.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(bounds.x).toBeCloseTo(0, 0); expect(bounds.y).toBeCloseTo(0, 0);
  expect(bounds.width).toBeCloseTo(bounds.viewportWidth, 0);
  expect(bounds.height).toBeCloseTo(bounds.viewportHeight, 0);
  return full;
}
test('fullscreen expands the text surface, isolates playback, reveals only seek on hover and restores focus', async ({ page }, info) => {
  await read(page);
  await page.getByRole('button', { name: '全画面', exact: true }).click();
  const full = await viewportSurface(page);
  if (!info.project.name.startsWith('mobile')) await expect.poll(() => full.evaluate(element => document.fullscreenElement === element)).toBe(true);
  await expect(full.getByTestId('stopped-context')).toBeVisible();
  await expect(full.getByRole('slider', { name: '読書の再生位置' })).toBeVisible();
  await expect(full.getByLabel('読む速さ（字/分）', { exact: true })).toBeVisible();
  await full.getByRole('slider', { name: '読書の再生位置' }).fill('3');
  await expect(full.locator('.playback-position-label')).toContainText('4 /');
  await full.getByLabel('読む速さ（字/分）', { exact: true }).fill('800');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await page.mouse.move(100, 100);
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect(full.locator('.stage-topline')).toBeHidden();
  await expect(full.locator('.guide-top')).toBeHidden();
  await expect(full.locator('.guide-bottom')).toBeHidden();
  await expect(full.getByTestId('stopped-context')).toBeHidden();
  await expect(full.locator('.fullscreen-seek')).toHaveCSS('opacity', '0');
  await expect(full.locator('.fullscreen-actions')).toBeHidden();
  await expect(page.getByRole('button', { name: '原文', exact: true })).toHaveCount(0);
  if (!info.project.name.startsWith('mobile')) {
    const before = await full.getByTestId('current-phrase').boundingBox();
    await full.locator('.fullscreen-footer').hover();
    await expect(full.locator('.fullscreen-seek')).toHaveCSS('opacity', '1');
    await expect(full.locator('.fullscreen-actions')).toBeHidden();
    const after = await full.getByTestId('current-phrase').boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    await page.mouse.move(100, 100);
    await expect(full.locator('.fullscreen-seek')).toHaveCSS('opacity', '0');
  }
  await full.getByTestId('current-phrase').click();
  await expect(full).toHaveAttribute('data-playing', 'false');
  await expect(full.getByTestId('stopped-context')).toBeVisible();
  await page.keyboard.press('Space'); await expect(full).toHaveAttribute('data-playing', 'true');
  await page.keyboard.press('Space'); await expect(full).toHaveAttribute('data-playing', 'false');
  await info.attach('fullscreen-paused', { body: await page.screenshot(), contentType: 'image/png' });
  await full.getByRole('button', { name: '全画面を終了' }).click();
  await expect(full).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全画面', exact: true })).toBeFocused();
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('800');
  if (!info.project.name.startsWith('mobile')) {
    await page.getByRole('button', { name: '全画面', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect(full).toHaveCount(0);
  }
});
test('fullscreen falls back when denied, traps keyboard focus, supports Guide and exits on Escape', async ({ page }) => {
  await page.addInitScript(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('test denied')); });
  await read(page);
  await page.getByRole('button', { name: 'Guide全文', exact: true }).click();
  await page.getByRole('button', { name: '全画面', exact: true }).click();
  const full = await viewportSurface(page);
  expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(full.getByTestId('guide-reader')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(full.getByRole('button', { name: '全画面を終了' })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await full.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await expect(full.locator('.guide-toolbar')).toBeHidden();
  await page.keyboard.press('Space');
  await expect(full.locator('.guide-toolbar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(full).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(page.getByRole('button', { name: '全画面', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole('button', { name: 'Flash', exact: true }).click();
  await page.getByRole('button', { name: '全画面', exact: true }).click();
  await viewportSurface(page);
  const body = await full.getByTestId('current-phrase').boundingBox();
  const context = await full.getByTestId('stopped-context').boundingBox();
  expect(body!.y + body!.height).toBeLessThan(context!.y);
  await page.keyboard.press('Escape');
});
test('display and silent speed persist across reload; reset keeps speed and saved reading position', async ({ page }) => {
  await read(page);
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('900');
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const phrase = await page.getByTestId('current-phrase').innerText();
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await page.getByLabel('文字サイズ', { exact: true }).fill('72');
  await page.getByLabel('暗い背景', { exact: true }).check();
  await page.getByLabel('ルビを表示', { exact: true }).uncheck();
  await page.getByLabel('まとめる', { exact: true }).selectOption('8');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('900');
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await expect(page.getByLabel('文字サイズ', { exact: true })).toHaveValue('72');
  await expect(page.getByLabel('暗い背景', { exact: true })).toBeChecked();
  await expect(page.getByLabel('ルビを表示', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('まとめる', { exact: true })).toHaveValue('8');
  await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(page.getByLabel('文字サイズ', { exact: true })).toHaveValue('56');
  await expect(page.getByLabel('暗い背景', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveText(phrase);
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('900');
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveText(phrase);
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('900');
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await expect(page.getByLabel('文字サイズ', { exact: true })).toHaveValue('56');
});
