import { expect, type Page } from '@playwright/test';

export function readerStage(page: Page) {
  return page.locator('[data-testid="reader-stage"], [data-testid="audio-stage"]');
}

export async function withFullscreenSettings(page: Page, change: () => Promise<void>) {
  const toggle = page.getByRole('button', { name: '読書設定を開く', exact: true });
  const compact = await toggle.isVisible();
  if (compact) await toggle.click();
  await change();
  if (compact) {
    await page.getByRole('button', { name: '設定を閉じる', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '読書設定', exact: true })).toHaveCount(0);
  }
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
