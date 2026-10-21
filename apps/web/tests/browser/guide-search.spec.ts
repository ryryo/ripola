import { readerStage } from './display-controls-helpers';
import { expect, test, type Page } from '@playwright/test';

const searchable = '# 見出し\n\nAlpha alpha ALPHA。同じ段落に検索語、検索語。\n\n'
  + '遠い段落です。'.repeat(30) + '目印の検索語。\n\n最後の段落。検索語。';

async function readGuide(page: Page, text = searchable) {
  await page.goto('/');
  await page.getByLabel('読む文章', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(page.getByTestId('guide-reader')).toBeVisible();
}

async function openPanel(page: Page) {
  const panel = page.getByTestId('guide-search-panel');
  if (!(await panel.isVisible())) await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}


test('search counts every occurrence and cycles, keeps zero/one states, preserves on reopen and resets for another document', async ({ page }) => {
  await readGuide(page);
  const panel = await openPanel(page);
  const input = page.getByLabel('本文を検索', { exact: true });
  const playback = await readerStage(page).getAttribute('data-unit-index');

  await input.fill('検索語');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中1件目');
  await expect(page.locator('.guide-search-mark[data-search-selected="true"]')).toHaveCount(1);
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);

  for (const expected of ['全4件中2件目', '全4件中3件目', '全4件中4件目']) {
    await input.press('Enter');
    await expect(panel.getByTestId('guide-search-count')).toHaveText(expected);
    await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  }
  await input.press('Enter');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中1件目');
  await expect(panel.getByRole('status')).toContainText('末尾から先頭に戻りました。');
  await input.press('Shift+Enter');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中4件目');
  await expect(panel.getByRole('status')).toContainText('先頭から末尾へ移動しました。');

  await input.fill('alpha');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中1件目');
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);

  await input.fill('');
  await expect(page.getByTestId('guide-search-count')).toHaveCount(0);
  await expect(page.locator('.guide-search-mark')).toHaveCount(0);

  await page.keyboard.press('Escape');
  for (let step = 0; step < 12; step++) await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const origin = Number(await readerStage(page).getAttribute('data-unit-index'));
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await input.fill('検索語');
  const selectedUnit = Number(await page.locator('.guide-unit[data-search-current="true"]').getAttribute('data-unit-index'));
  expect(selectedUnit).toBeGreaterThanOrEqual(origin);
  await expect(panel.getByTestId('guide-search-count')).not.toHaveText('全4件中1件目');

  await input.fill('見つからない文字列');
  await expect(panel.getByRole('status')).toHaveText('一致する文字列がありません。');
  await expect(panel.getByRole('button', { name: '前へ', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '次へ', exact: true })).toBeDisabled();

  await input.fill('最後');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  await expect(panel.getByRole('button', { name: '前へ', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '次へ', exact: true })).toBeDisabled();

  await input.press('Escape');
  await expect(page.getByTestId('guide-search-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '検索', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByLabel('本文を検索', { exact: true })).toHaveValue('最後');
  await expect(page.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await openPanel(page);
  await expect(page.getByLabel('本文を検索', { exact: true })).toHaveValue('最後');
  await expect(page.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  await page.getByLabel('本文を検索', { exact: true }).fill('見出し');
  await expect(page.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  await expect(page.locator('.guide-row-heading .guide-search-mark[data-search-selected="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByRole('button', { name: '別の文章を開く', exact: true }).click();
  await page.getByLabel('読む文章', { exact: true }).fill('別の本には検索語があります。');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  if (!(await page.getByTestId('guide-reader').isVisible())) await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(page.getByTestId('guide-reader')).toBeVisible();
  await openPanel(page);
  await expect(page.getByLabel('本文を検索', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('guide-search-count')).toHaveCount(0);
  await expect(page.locator('.guide-search-mark')).toHaveCount(0);
});

test('search selection stays independent from playback; play-from-here and return-to-reading use the selected phrase', async ({ page }) => {
  await readGuide(page, '静かな図書館で記録を読む。'.repeat(14) + 'ここが現在位置の目印です。' + '続きをゆっくり読む。'.repeat(25));
  const panel = await openPanel(page);
  const input = page.getByLabel('本文を検索', { exact: true });
  const playback = await readerStage(page).getAttribute('data-unit-index');

  await input.fill('目印');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  const selectedUnit = await page.locator('.guide-unit[data-search-current="true"]').getAttribute('data-unit-index');
  expect(Number(selectedUnit)).toBeGreaterThan(0);
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  await expect.poll(() => page.getByTestId('guide-viewport').evaluate(element => {
    const mark = element.querySelector('.guide-search-mark[data-search-selected="true"]');
    const frame = element.getBoundingClientRect();
    const rect = mark?.getClientRects()[0];
    return Boolean(rect && rect.top >= frame.top && rect.bottom <= frame.bottom && rect.left >= frame.left && rect.right <= frame.right);
  })).toBe(true);

  await panel.getByRole('button', { name: '読書位置に戻る', exact: true }).click();
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  await expect.poll(() => page.getByTestId('guide-viewport').evaluate(element => {
    const current = element.querySelector('.guide-unit[aria-current="location"]');
    const frame = element.getBoundingClientRect();
    const rect = current?.getClientRects()[0];
    return Boolean(rect && rect.top >= frame.top && rect.bottom <= frame.bottom && rect.left >= frame.left && rect.right <= frame.right);
  })).toBe(true);

  await panel.getByRole('button', { name: 'ここから再生', exact: true }).click();
  await expect(page.getByTestId('guide-search-panel')).toHaveCount(0);
  await expect.poll(async () => Number(await readerStage(page).getAttribute('data-unit-index'))).toBe(Number(selectedUnit));
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '一時停止', exact: true }).click();

  const reopened = await openPanel(page);
  await expect(page.getByLabel('本文を検索', { exact: true })).toHaveValue('目印');
  await expect(reopened.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
});

test('vertical fullscreen search highlights ruby and far text, keeps matches distinguishable and Escape only closes search', async ({ page }) => {
  const text = '静かな<ruby>図書館<rt>としょかん</rt></ruby>で記録を読む。'.repeat(14) + '現在位置の目印です。'
    + '続きをゆっくり読む。'.repeat(25) + '\n\n' + '朝に本を読み、原文を確かめる。\n\n'.repeat(1200) + '末尾の標識です。';
  await readGuide(page, text);
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await page.getByLabel('本文の向き', { exact: true }).selectOption('vertical-rl');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('test fallback')); });
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  const viewport = full.getByTestId('guide-viewport');
  await expect(viewport).toHaveCSS('writing-mode', 'vertical-rl');

  const panel = await openPanel(page);
  const input = page.getByLabel('本文を検索', { exact: true });
  await input.fill('末尾の標識');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  await expect.poll(() => viewport.evaluate(element => {
    const mark = element.querySelector('.guide-search-mark[data-search-selected="true"]');
    const frame = element.getBoundingClientRect();
    const rect = mark?.getClientRects()[0];
    return Boolean(rect && rect.left >= frame.left && rect.right <= frame.right && rect.top >= frame.top && rect.bottom <= frame.bottom);
  })).toBe(true);
  expect(await full.locator('.guide-unit').count()).toBeLessThan(250);
  await input.fill('図書館');
  const marks = full.locator('.guide-search-mark');
  const selected = full.locator('.guide-search-mark[data-search-selected="true"]');
  await expect(selected).toHaveCount(1);
  expect(await marks.count()).toBeGreaterThan(1);
  const selectedStyle = await selected.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, background: getComputedStyle(element).backgroundColor }));
  const otherStyle = await full.locator('.guide-search-mark:not(.is-selected)').first().evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }));
  expect(selectedStyle.outline).toBe('solid');
  expect(otherStyle.outline).toBe('none');
  expect(selectedStyle.background).not.toBe(otherStyle.background);
  expect(otherStyle.shadow).not.toBe('none');
  await expect(full.locator('.guide-unit rt').first()).toHaveText('としょかん');

  await input.fill('としょかん');
  await expect(panel.getByRole('status')).toHaveText('一致する文字列がありません。');
  await expect(full.locator('.guide-search-mark')).toHaveCount(0);

  await viewport.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('guide-search-panel')).toHaveCount(0);
  await expect(full).toBeVisible();
  await expect(full.getByRole('button', { name: '検索', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(full).toHaveCount(0);
});

test('IME-composing Enter does not move, and the search panel is keyboard operable with focus returned on close', async ({ page }) => {
  await readGuide(page);
  const panel = await openPanel(page);
  const input = page.getByLabel('本文を検索', { exact: true });
  await expect(input).toBeFocused();
  await input.fill('検索語');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中1件目');

  await panel.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中2件目');
  await expect(input).toBeFocused();
  await input.press('Shift+Enter');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中1件目');

  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })));
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中1件目');
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await input.press('Enter');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全4件中1件目');
  await input.evaluate(element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, 'alpha');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'alpha' }));
  });
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中1件目');
  await expect(input).toHaveValue('alpha');
  await input.press('Enter');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中2件目');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('guide-search-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '検索', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByRole('button', { name: '検索を閉じる', exact: true }).click();
  await expect(page.getByTestId('guide-search-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '検索', exact: true })).toBeFocused();
});

test('search disables play-from-here for static code while keeping the match selectable', async ({ page }) => {
  await readGuide(page, '本文の検索語です。\n\n```\nconst 検索語 = 1;\n```\n\n後ろの段落。');
  const panel = await openPanel(page);
  await page.getByLabel('本文を検索', { exact: true }).fill('const');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全1件中1件目');
  await expect(page.locator('.guide-row-code .guide-search-mark[data-search-selected="true"]')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'ここから再生', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '読書位置に戻る', exact: true })).toBeEnabled();
});

test('manual scroll keeps return-to-reading available and returning restores the paused phrase before prev/next continue', async ({ page }) => {
  await readGuide(page, '始まりの検索語。\n\n' + '遠い段落です。'.repeat(160) + '遠い検索語。\n\n最後の検索語。');
  const panel = await openPanel(page);
  const input = page.getByLabel('本文を検索', { exact: true });
  await input.fill('検索語');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中1件目');
  const playback = await readerStage(page).getAttribute('data-unit-index');
  await input.press('Enter');
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中2件目');
  const viewport = page.getByTestId('guide-viewport');
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const beforeWheel = await viewport.evaluate(element => element.scrollTop);
  await viewport.hover();
  await page.mouse.wheel(0, -180);
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).not.toBe(beforeWheel);
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  const returnButton = panel.getByRole('button', { name: '読書位置に戻る', exact: true });
  await expect(returnButton).toBeEnabled();
  await returnButton.click();
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  await expect(page.locator('.fullscreen-reader')).toHaveAttribute('data-playing', 'false');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect.poll(() => viewport.evaluate(element => {
    const current = element.querySelector('.guide-unit[aria-current="location"]');
    const frame = element.getBoundingClientRect(); const rect = current?.getClientRects()[0];
    return Boolean(rect && rect.top >= frame.top && rect.bottom <= frame.bottom && rect.left >= frame.left && rect.right <= frame.right);
  })).toBe(true);

  await panel.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中3件目');
  await expect(page.locator('.guide-unit[data-search-current="true"]')).toBeVisible();
  await panel.getByRole('button', { name: '前へ', exact: true }).click();
  await expect(panel.getByTestId('guide-search-count')).toHaveText('全3件中2件目');

  const beforeKey = await viewport.evaluate(element => element.scrollTop);
  await viewport.focus();
  await page.keyboard.press('PageUp');
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).not.toBe(beforeKey);
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  await expect(returnButton).toBeEnabled();
  await returnButton.click();
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', playback!);
  await expect(page.locator('.fullscreen-reader')).toHaveAttribute('data-playing', 'false');
  await expect.poll(() => viewport.evaluate(element => {
    const current = element.querySelector('.guide-unit[aria-current="location"]');
    const frame = element.getBoundingClientRect(); const rect = current?.getClientRects()[0];
    return Boolean(rect && rect.top >= frame.top && rect.bottom <= frame.bottom && rect.left >= frame.left && rect.right <= frame.right);
  })).toBe(true);
});
