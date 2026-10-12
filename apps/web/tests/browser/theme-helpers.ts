import { type Page } from '@playwright/test';

export async function chooseTheme(page: Page, theme: 'ライト' | 'ダーク' | '端末に合わせる') {
  await page.getByRole('button', { name: '配色を変更', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${theme}`) }).click();
}
