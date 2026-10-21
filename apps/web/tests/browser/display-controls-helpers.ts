import { expect, type Page } from '@playwright/test';

export function readerStage(page: Page) {
  return page.locator('[data-testid="reader-stage"], [data-testid="audio-stage"]');
}

/** Opens the guide search panel (desktop popover or inline mobile row) and types a query. */
export async function searchGuide(page: Page, query: string) {
  const input = page.getByLabel('本文を検索', { exact: true });
  const panel = page.getByTestId('guide-search-panel');
  if (!(await input.isVisible()) || !(await panel.isVisible())) await page.getByRole('button', { name: '検索', exact: true }).click();
  await input.fill(query);
}

export async function chooseGuideMatch(page: Page, index = 0) {
  // The search overlay can cover a selected phrase. Dismiss it before choosing
  // text, just as a reader would; closing preserves the selected match.
  const close = page.getByRole('button', { name: '検索を閉じる', exact: true });
  if (await close.isVisible()) await close.click();
  await page.locator('.guide-unit[data-search-current="true"]').nth(index).click();
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
