import { expect, test } from '@playwright/test';
import { inspectGuides } from './guide-inspection';

test('通常読書の上下ガイドは文字サイズ・ruby・再生停止に関係なく文字と重ならない', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('読む文章', { exact: true }).fill('<ruby>図書館<rt>としょかん</rt></ruby>へ。' .repeat(20));
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  for (const fontSize of ['24', '72']) {
    for (const ruby of [true, false]) {
      await page.getByRole('button', { name: '表示設定', exact: true }).click();
      await page.getByLabel('文字サイズ', { exact: true }).fill(fontSize);
      await page.getByRole('switch', { name: 'ルビを表示', exact: true }).setChecked(ruby);
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      const paused = await inspectGuides(page, '[data-testid="reader-stage"]');
      expect(paused.guides).toBe(2); expect(paused.overlap).toBe(false); expect(paused.minimumGap).toBeGreaterThan(2);
      await page.getByRole('button', { name: '再生', exact: true }).click();
      const playing = await inspectGuides(page, '[data-testid="reader-stage"]', 450);
      expect(playing.samples).toBeGreaterThan(10); expect(playing.overlap).toBe(false); expect(playing.minimumGap).toBeGreaterThan(2);
      await page.getByRole('button', { name: '一時停止', exact: true }).click();
    }
  }
});
