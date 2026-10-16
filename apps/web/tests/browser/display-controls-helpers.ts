import { expect, type Page } from '@playwright/test';

export function readerStage(page: Page) {
  return page.locator('[data-testid="reader-stage"], [data-testid="audio-stage"]');
}

export async function adjustReaderDisplay(page: Page, label: '表示量' | 'フォントサイズ' | '本文の向き', value: string) {
  const drawer = page.getByRole('dialog', { name: '表示設定', exact: true });
  const restoreAppearance = await drawer.isVisible();
  if (restoreAppearance) {
    await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(drawer).toHaveCount(0);
  }
  const control = page.getByLabel(label, { exact: true });
  if (label === '本文の向き') await control.selectOption(value);
  else await control.fill(value);
  if (restoreAppearance) await page.getByRole('button', { name: '表示設定', exact: true }).click();
}
