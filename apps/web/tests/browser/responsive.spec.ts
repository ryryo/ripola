import { test, expect } from '@playwright/test';
for (const [width, height] of [[320, 740], [375, 812], [390, 844], [430, 932], [844, 390]]) {
  test(`スマホ ${width}×${height}: 片手操作・長句ruby・横溢れなし`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await page.goto('/');
    if (width === 390) await page.screenshot({ path: 'docs/validation/screenshots/welcome-mobile.png', fullPage: true });
    await page.getByLabel('読む文章', { exact: true }).fill('<ruby>超長距離観測装置<rt>ちょうちょうきょりかんそくそうち</rt></ruby>とTypeScriptの長い記録を、👩‍💻が読む。\n\n（2026年10月5日の穏やかな図書館の記録）');
    await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
    await expect(page.getByTestId('current-phrase')).toBeVisible();
    await page.getByRole('button', { name: '再生', exact: true }).scrollIntoViewIfNeeded();
    const transport = page.locator('.transport');
    for (const button of await transport.getByRole('button').all()) {
      const box = await button.boundingBox(); expect(box?.height).toBeGreaterThanOrEqual(44); expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
    if (width === 390 || width === 844) await page.screenshot({ path: `docs/validation/screenshots/reader-${width === 390 ? 'mobile' : 'landscape'}.png`, fullPage: true });
    await page.getByRole('button', { name: '原文', exact: true }).click();
    await expect(page.getByLabel('抽出した全文')).toBeVisible();
  });
}
test('回転は停止、長い単位の全体を表示、200%拡大で主要操作可能', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'テキストで読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  await page.getByRole('button', { name: '再生', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
