import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
async function read(page: Page, text = '私は朝の電車で本を読んでいます。\n\n立ち止まり、原文を確かめる。') {
  await page.getByLabel('読む文章', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
}
test('貼付・空本文・原文シーク・Unicode・ruby・外部送信なし', async ({ page, context, baseURL }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const external: string[] = [];
  context.on('request', request => { if (!request.url().startsWith(baseURL!) && !request.url().startsWith('data:')) external.push(request.url()); });
  await page.goto('/');
  await page.screenshot({ path: 'docs/validation/screenshots/welcome-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('文章を入力');
  await read(page, '私は<ruby>図書館<rt>としょかん</rt></ruby>へ向かった。\n\n👩‍💻が書いたが、2026年10月5日の記録。\n\n![画像](https://example.com/private.png)');
  await expect(page.getByTestId('character-progress')).toContainText('0 /');
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('抽出した全文')).toHaveValue('私は図書館へ向かった。\n\n👩‍💻が書いたが、2026年10月5日の記録。');
  const source = page.locator('.source-unit').filter({ hasText: '図書館' }).first();
  await source.click();
  await expect(page.locator('.phrase rt')).toHaveText('としょかん');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.locator('.mantine-Drawer-content')).toHaveCount(0);
  await page.screenshot({ path: 'docs/validation/screenshots/reader-desktop.png', fullPage: true });
  expect(external).toEqual([]); expect(failures).toEqual([]);
});
test('MDファイルはcode/tableで止まり、元入力と同じ本文の位置を保つ', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('読み込むファイル').setInputFiles(fileURLToPath(new URL('../../../../docs/validation/fixtures/import-sample.md', import.meta.url)));
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  const full = await page.getByLabel('抽出した全文').inputValue();
  expect(full).toContain('試読'); expect(full).toContain('TypeScript');
  await page.locator('.source-static').first().click();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByText('コード・表は原文で。')).toBeVisible();
  await page.getByRole('button', { name: '次のフレーズへ', exact: true }).click();
  // The fixture has consecutive code and table blocks; neither is silently skipped.
  if (await page.getByRole('button', { name: '次のフレーズへ', exact: true }).isVisible()) await page.getByRole('button', { name: '次のフレーズへ', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
});
test('再生連打・速度変更・戻る・設定・背景停止は単位を飛ばさない', async ({ page }) => {
  await page.goto('/'); await read(page);
  // Pause retains elapsed time. Keep this rapid-toggle check well inside one
  // phrase duration rather than assuming every pause restarts its timer.
  await page.getByLabel('読む速さ（字/分）').fill('100');
  const before = await page.getByTestId('current-phrase').innerText();
  for (let i = 0; i < 5; i++) { await page.getByRole('button', { name: '再生', exact: true }).click(); await page.getByRole('button', { name: '一時停止', exact: true }).click(); }
  await expect(page.getByTestId('current-phrase')).toHaveText(before);
  await page.getByLabel('読む速さ（字/分）').fill('3000');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  const stopped = await page.getByTestId('current-phrase').innerText();
  await page.waitForTimeout(600); await expect(page.getByTestId('current-phrase')).toHaveText(stopped);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await page.getByRole('button', { name: '1つ戻る', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveText(stopped);
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await page.getByLabel('文字サイズ', { exact: true }).fill('72');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
});
test('最後の1フレーズは時間を確保してから読了し、再読は停止状態', async ({ page }) => {
  await page.goto('/'); await read(page, '一。');
  await page.getByLabel('読む速さ（字/分）').fill('3000');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'もう一度', exact: true })).toBeVisible();
  await expect(page.getByTestId('character-progress')).toHaveText('1 / 1 字');
  await page.getByRole('button', { name: 'もう一度', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.getByTestId('character-progress')).toHaveText('0 / 1 字');
});
test('端末に明示保存、再開と削除', async ({ page }) => {
  await page.goto('/'); await read(page);
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const position = await page.getByTestId('current-phrase').innerText();
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveText(position);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await page.getByRole('button', { name: '保存を削除', exact: true }).click();
  await page.reload(); await expect(page.getByRole('button', { name: '続きから開く', exact: true })).toHaveCount(0);
});

test('UTF-8 TXT・小数速度の整数化・Space長押し', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('読み込むファイル').setInputFiles({ name: '自作.txt', mimeType: 'text/plain', buffer: Buffer.from('一度止まって、ゆっくり原文を確かめる。') });
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByLabel('読む速さ（字/分）').fill('101.5');
  await page.locator('.document-heading h1').click();
  await expect(page.getByLabel('読む速さ（字/分）')).toHaveValue('102');
  await page.keyboard.down('Space'); await page.keyboard.down('Space');
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.keyboard.up('Space'); await page.keyboard.press('Space');
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
});

test('日本語PDFの文字層とページ表示', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('読み込むファイル').setInputFiles(fixture('japanese-text-layer.pdf'));
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByLabel('抽出した全文')).toHaveValue(/私は朝の図書館で本を読む。/);
  await expect(page.locator('.pdf-canvas canvas')).toBeVisible();
  await expect.poll(() => page.locator('.pdf-canvas canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(100);
  await page.screenshot({ path: 'docs/validation/screenshots/pdf-japanese-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('横書きテキストPDFの抽出プレビューと元ページ、保存したPDF再開', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.getByLabel('読み込むファイル').setInputFiles(fixture('text-layer.pdf'));
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByLabel('抽出した全文')).toHaveValue(/Morning reading/);
  await expect(page.locator('.pdf-canvas canvas')).toBeVisible();
  await expect.poll(() => page.locator('.pdf-canvas canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(100);
  await page.screenshot({ path: 'docs/validation/screenshots/pdf-preview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.locator('.pdf-canvas canvas')).toBeVisible();
  expect(errors).toEqual([]);
});
for (const [file, explanation] of [['image-only.pdf', '文字'], ['partial-blank.pdf', '2'], ['invalid.pdf', 'PDF'], ['two-column.pdf', '段組']] as const) {
  test(`非対応PDF ${file} は説明して空の本を作らない`, async ({ page }) => {
    await page.goto('/'); await page.getByLabel('読み込むファイル').setInputFiles(fixture(file));
    await expect(page.getByRole('alert')).toContainText(explanation);
    await expect(page.getByTestId('current-phrase')).toHaveCount(0);
  });
}
test('PDF処理を取消して別の本文を読み、古い結果が上書きしない', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('読み込むファイル').setInputFiles(fixture('cancel-many-pages.pdf'));
  await page.getByRole('button', { name: '読み込みを取り消す', exact: true }).click();
  await read(page, '新しい文章だけを読む。');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('抽出した全文')).toHaveValue('新しい文章だけを読む。');
});
test('キーボード操作・静的原文・高速live通知なし', async ({ page }) => {
  await page.goto('/'); await read(page);
  await page.locator('.document-heading h1').click();
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.getByTestId('current-phrase')).toHaveAttribute('aria-live', 'off');
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('抽出した全文')).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('button', { name: '原文', exact: true })).toBeFocused();
});

test('10万文字を貼り付けてWorkerで処理し、原文のDOMを現在位置の前後に限定する', async ({ page, context, baseURL }) => {
  await page.goto('/');
  const phrase = '朝に本を読み、原文を確かめる。\n\n';
  const text = phrase.repeat(Math.ceil(100_000 / phrase.length)).slice(0, 100_000);
  await page.getByRole('button', {name:'変更', exact:true}).click();
  await page.getByRole('combobox', {name:'貼り付け形式'}).click();
  await page.getByRole('option', {name:'テキスト',exact:true}).click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.getByLabel('読む文章', { exact: true }).click();
  const pasteStarted = Date.now();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await expect.poll(async () => (await page.getByLabel('読む文章', { exact: true }).inputValue()).length).toBe(100_000);
  expect(await page.getByLabel('読む文章', { exact: true }).inputValue()).toBe(text);
  const pasteElapsedMs = Date.now() - pasteStarted;
  await page.evaluate(() => {
    const sample = { started: performance.now(), last: performance.now(), ticks: 0, maxDelayMs: 0 };
    const timer = window.setInterval(() => { const now = performance.now(); sample.maxDelayMs = Math.max(sample.maxDelayMs, now - sample.last - 10); sample.last = now; sample.ticks++; }, 10);
    Object.assign(window, { readerMetrics: { sample, timer } });
  });
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  const metrics = await page.evaluate(() => {
    const state = (window as unknown as { readerMetrics: { sample: { started: number; ticks: number; maxDelayMs: number }; timer: number } }).readerMetrics;
    clearInterval(state.timer);
    return { inputUtf16Length: 100_000, elapsedMs: Math.round(performance.now() - state.sample.started), intervalTicks: state.sample.ticks, maxIntervalDelayMs: Math.round(state.sample.maxDelayMs), userAgent: navigator.userAgent };
  });
  expect(metrics.intervalTicks).toBeGreaterThan(0);
  await page.getByRole('button', { name: '原文', exact: true }).click();
  expect(await page.getByLabel('抽出した全文').inputValue()).toBe(text);
  expect(await page.locator('.source-unit').count()).toBeLessThanOrEqual(41);
  await writeFile('docs/validation/metrics.json', `${JSON.stringify({ measuredAt: new Date().toISOString(), baseURL, pasteElapsedMs, ...metrics, conditions: 'local browser; synthetic TXT; actual clipboard paste; Playwright; cold page; other tests may share host; not a device benchmark or memory measurement' }, null, 2)}\n`);
});

test('Worker起動失敗時も原文を確認できる', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { value: class { constructor() { throw new Error('test Worker denial'); } } }); });
  await page.goto('/');
  await page.getByLabel('読む文章', { exact: true }).fill('処理に失敗しても、この原文を残す。');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('本文処理を開始');
  await expect(page.getByLabel('処理前の原文・抽出本文')).toHaveValue('処理に失敗しても、この原文を残す。');
});
