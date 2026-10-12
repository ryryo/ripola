import { expect, test, type Page } from '@playwright/test';
import { chooseTheme } from './theme-helpers';

async function darkSurface(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 33, 44)');
  await expect(page.locator('.brand-lockup')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.brand-lockup img')).toHaveCSS('mix-blend-mode', 'screen');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
}

test('site theme follows navigation, portals and reload while display reset keeps dark mode', async ({ page }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await chooseTheme(page, 'ダーク');
  await darkSurface(page);
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveCSS('background-color', 'rgb(29, 47, 61)');
  await page.screenshot({ path: info.outputPath('home-dark.png'), fullPage: true });
  await page.getByRole('button', { name: '使い方', exact: true }).click();
  await expect(page.locator('.mantine-Drawer-content')).toHaveCSS('background-color', 'rgb(29, 47, 61)');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  for (const route of ['/library', '/generate', '/books']) {
    await page.goto(route);
    await expect(page.getByRole('button', { name: '配色を変更', exact: true })).toBeVisible({ timeout: 30_000 });
    await darkSurface(page);
  }
  await page.goto('/');
  await page.getByLabel('読む文章', { exact: true }).fill('静かな夜に本を読む。窓の向こうには月が見えます。');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await darkSurface(page);
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  await expect(page.locator('.fullscreen-reader[data-fullscreen="true"] .reader-stage')).toHaveCSS('background-color', 'rgb(29, 47, 61)');
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await expect(page.getByLabel('暗い背景', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await page.screenshot({ path: info.outputPath('settings-dark.png') });
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.screenshot({ path: info.outputPath('reader-dark.png'), fullPage: true });
  await page.reload();
  await darkSurface(page);
  await page.getByRole('button', { name: '配色を変更', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCSS('background-color', 'rgb(29, 47, 61)');
  await page.getByRole('menuitem', { name: 'ライト', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  await page.screenshot({ path: info.outputPath('home-light.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('system theme updates live, explicit choices win and legacy dark preference migrates', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '配色を変更', exact: true })).toBeVisible();
  await darkSurface(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  await chooseTheme(page, 'ダーク');
  await page.reload();
  await darkSurface(page);
  await chooseTheme(page, '端末に合わせる');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await darkSurface(page);
  await page.evaluate(() => {
    localStorage.removeItem('ripola-color-scheme');
    localStorage.setItem('ripola-reader-preferences-v1', JSON.stringify({ schemaVersion: 1, settings: { contrast: 'night' } }));
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await darkSurface(page);
  expect(await page.evaluate(() => localStorage.getItem('ripola-color-scheme'))).toBe('dark');
});

test('theme changes remain usable when local storage is blocked', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '配色を変更', exact: true })).toBeVisible();
  await darkSurface(page);
  await chooseTheme(page, 'ダーク');
  await darkSurface(page);
  await chooseTheme(page, 'ライト');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
});
