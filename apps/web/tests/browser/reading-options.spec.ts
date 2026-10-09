import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { inspectGuides } from './guide-inspection';
import { browserMp3 } from '../helpers/browser-media';

const manuscript = '私は<ruby>図書館<rt>としょかん</rt></ruby>へ向かった。次に2026年10月6日の記録を読む。𠮷とが、👩‍💻も。\n\n最後の短い文を読む。';
async function read(page: Page, text = manuscript) {
  await page.goto('/');
  if (text.length > 20000) await page.getByLabel('読む文章', { exact: true }).evaluate((element, value) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  else await page.getByLabel('読む文章', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
}
async function settings(page: Page) { await page.getByRole('button', { name: '表示設定', exact: true }).click(); }
async function close(page: Page) { await page.getByRole('button', { name: '閉じる', exact: true }).click(); }

test('optional fonts load from the same origin only, keep anchor paused and fit ruby at both sizes', async ({ page, baseURL }, info) => {
  const transfers: Array<Promise<{ url: string; bytes: number }>> = [];
  page.on('response', response => { if (response.status() === 200 && /\.woff2?(?:\?|$)/.test(response.url())) transfers.push(response.body().then(body => ({ url: response.url(), bytes: body.length }))); });
  const fonts: string[] = []; const external: string[] = [];
  page.on('request', request => {
    if (/\.woff2?(?:\?|$)/.test(request.url())) fonts.push(request.url());
    if (!request.url().startsWith(baseURL!) && !request.url().startsWith('data:')) external.push(request.url());
  });
  await read(page);
  expect(fonts).toEqual([]);
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await page.locator('.source-unit').filter({ hasText: '図書館' }).first().click(); await close(page);
  const anchor = await page.getByTestId('current-phrase').innerText();
  for (const id of ['noto-sans-jp', 'noto-serif-jp', 'biz-udpgothic']) {
    const first = fonts.length;
    await settings(page); await page.getByLabel('本文の書体', { exact: true }).selectOption(id);
    await expect(page.locator('.font-status')).toHaveText('書体の準備完了');
    expect(fonts.slice(first).length).toBeGreaterThan(0);
    expect(fonts.slice(first).every(url => url.includes(id))).toBe(true);
    expect(fonts.slice(first).every(url => url.includes('400-normal'))).toBe(true);
    for (const size of ['24', '72']) {
      await page.getByLabel('文字サイズ', { exact: true }).fill(size); await close(page);
      await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
      await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
      const result = await inspectGuides(page, '[data-testid="reader-stage"]');
      expect(result.overlap).toBe(false); expect(result.minimumGap).toBeGreaterThan(2);
      await expect(page.getByTestId('current-phrase')).toHaveCSS('font-weight', '400');
      await settings(page);
    }
    await close(page);
  }
  expect(external).toEqual([]);
  const fontTransfers = await Promise.all(transfers);
  await info.attach('font-transfer', { body: JSON.stringify({ manuscript: 'Self-authored ruby/rare-kanji/combining/emoji fixture', profile: 'Vite local', responseBytes: fontTransfers.reduce((sum, item) => sum + item.bytes, 0), requests: fontTransfers }, null, 2), contentType: 'application/json' });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; const style = document.createElement('style'); style.textContent = '.phrase { line-height:1.5 !important; letter-spacing:.12em !important; word-spacing:.16em !important; }'; document.head.append(style); });
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  const zoomed = await inspectGuides(page, '[data-testid="reader-stage"]'); expect(zoomed.overlap).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await settings(page); await expect(page.getByLabel('本文の書体', { exact: true })).toHaveValue('biz-udpgothic');
});

test('font failures and stale A→B→system results leave the same anchor paused with system fallback', async ({ page }) => {
  await read(page);
  const anchor = await page.getByTestId('current-phrase').innerText();
  await page.route('**/*noto-serif-jp*', async route => {
    if (/\.woff2?(?:\?|$)/.test(route.request().url())) await route.abort(); else await route.continue();
  });
  await settings(page); await page.getByLabel('本文の書体', { exact: true }).selectOption('noto-serif-jp');
  await expect(page.locator('.font-status')).toContainText('端末標準'); await close(page);
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  expect(await page.getByTestId('current-phrase').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Yu Mincho');
  await page.unroute('**/*noto-serif-jp*');
  await page.route('**/*noto-sans-jp*', async route => { if (/\.woff2?(?:\?|$)/.test(route.request().url())) await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
  await settings(page);
  await page.getByLabel('本文の書体', { exact: true }).selectOption('noto-sans-jp');
  await page.getByLabel('本文の書体', { exact: true }).selectOption('biz-udpgothic');
  await page.getByLabel('本文の書体', { exact: true }).selectOption('system');
  await expect(page.locator('.font-status')).toHaveText('書体の準備完了'); await close(page);
  await page.waitForTimeout(900);
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  expect(await page.getByTestId('current-phrase').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Yu Mincho');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
});

test('grouping is a view; Guide and Flash share position, ruby and static text', async ({ page }) => {
  await read(page); await settings(page);
  await page.getByLabel('まとめる', { exact: true }).selectOption('8');
  await page.getByLabel('最小字数', { exact: true }).selectOption('3'); await close(page);
  const position = await page.locator('.playback-position-label').innerText();
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(page.getByTestId('guide-reader')).toBeVisible();
  await expect(page.locator('.playback-position-label')).toHaveText(position);
  await expect(page.locator('.guide-unit rt')).toContainText(['としょかん']);
  await page.getByLabel('Guide本文を検索').fill('最後'); await page.getByRole('button', { name: '検索して移動' }).click();
  await expect(page.locator('.guide-unit[aria-current="location"]').first()).toContainText('最後');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.getByText('全文を静止表示・コピー', { exact: true }).click();
  await expect(page.getByLabel('Guide静止全文')).toHaveValue(manuscript.replace('<ruby>図書館<rt>としょかん</rt></ruby>', '図書館'));
  await page.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toContainText('最後');
  const context = await page.getByTestId('stopped-context').textContent();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('stopped-context')).toBeHidden();
  expect(await page.getByTestId('stopped-context').textContent()).toBe(context);
});

test('Guide bounds long-document DOM; manual scrolling keeps the reading anchor and disables following', async ({ page }) => {
  test.setTimeout(60000);
  const text = '朝に本を読み、原文を確かめる。\n\n'.repeat(6000).slice(0, 100000);
  await read(page, text);
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  const position = await page.locator('.playback-position-label').innerText();
  await page.getByTestId('guide-viewport').hover(); await page.mouse.wheel(0, 5000);
  await expect(page.getByRole('button', { name: '現在位置を追従', exact: true })).toBeVisible();
  expect(await page.locator('.playback-position-label').innerText()).toBe(position);
  const scrolled = await page.getByTestId('guide-viewport').evaluate(element => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  await page.getByRole('button', { name: '現在位置を追従', exact: true }).click();
  await expect.poll(() => page.getByTestId('guide-viewport').evaluate(element => element.scrollTop)).toBeLessThan(scrolled);
});

test('Guide reveals the highlighted phrase within a tall virtual row after a search jump', async ({ page }) => {
  await read(page, '静かな図書館で記録を読む。'.repeat(14) + 'ここが現在位置の目印です。' + '続きをゆっくり読む。'.repeat(25));
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await page.getByLabel('Guide本文を検索', { exact: true }).fill('目印');
  await page.getByRole('button', { name: '検索して移動', exact: true }).click();
  await expect.poll(() => page.getByTestId('guide-viewport').evaluate(element => {
    const target = element.querySelector('.guide-unit[aria-current="location"]');
    if (!target) return false;
    const frame = element.getBoundingClientRect(); const rect = target.getClientRects()[0];
    return Boolean(rect && rect.top >= frame.top && rect.bottom <= frame.bottom);
  })).toBe(true);
});

test('shortcuts follow the proposal without stealing native slider/input or composing keys', async ({ page }) => {
  await read(page); await page.locator('.document-heading h1').click();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByTestId('current-phrase')).toContainText('次に');
  await page.keyboard.press('Home'); await expect(page.locator('.playback-position-label')).toContainText('1 /');
  const first = await page.getByTestId('current-phrase').innerText();
  await page.keyboard.press('End'); expect(await page.getByTestId('current-phrase').innerText()).not.toBe(first);
  await page.keyboard.press('Home');
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', isComposing: true, bubbles: true })));
  await expect(page.getByTestId('current-phrase')).toHaveText(first);
  const cpm = page.getByLabel('読む速さ（字/分）'); await cpm.fill('400'); await cpm.press('ArrowUp'); await expect(cpm).toHaveValue('450');
  await page.locator('.document-heading h1').click(); await page.keyboard.press('ArrowUp'); await expect(cpm).toHaveValue('550');
  await page.getByLabel('読む速さのスライダー').focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByTestId('current-phrase')).toHaveText(first);
  await page.locator('.document-heading h1').click();
  await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.up('Space');
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
});

function tone(seconds: number, frequency = 220) {
  const samples = seconds * 8000; const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8); output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22); output.writeUInt32LE(8000, 24); output.writeUInt32LE(16000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) output.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * frequency / 8000) * 500), 44 + i * 2);
  return output;
}
async function audioFixture(page: Page) {
  const revision = 'c'.repeat(64); const id = 'reading-options-fixture';
  const pieces = ['私は', '図書館へ。', '今日は', '静かに', '読む。'];
  let offset = 0;
  const units = pieces.map((text, index) => { const start = offset; offset += text.length; return { id: `u${index}`, blockId: 'b', kind: 'text', text, start, end: offset, ruby: index === 1 ? [{ start: 0, end: 3, reading: 'としょかん' }] : [], sources: [{ kind: 'text', start, end: offset }], mapping: 'exact', characters: text.length, cumulativeCharacters: start, pause: text.endsWith('。') ? 'sentence' : 'none' }; });
  const text = pieces.join('');
  const media = [0, 1].map(index => browserMp3(tone(12, 220 + index * 30)));
  const chunks = [[0, 2], [2, 5]].map(([from, to], index) => ({ id: `c${index}`, audioUrl: `library/books/${id}/${revision}/media/${media[index].sha256}.mp3`, mimeType: 'audio/mpeg', sha256: media[index].sha256, bytes: media[index].bytes.length, durationSeconds: 12, timing: { verification: 'pcm-correlated' },
    timeline: [{ blockId: 'b', start: units[from].start, end: units[to - 1].end, unitIds: units.slice(from, to).map(unit => unit.id) }],
    alignment: { precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .95, alignerVersion: 'ui-fixture-only', cues: units.slice(from, to).map((unit, i) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end, startSeconds: i * 12 / (to - from), endSeconds: (i + 1) * 12 / (to - from), score: .95 })) } }));
  const manifest = JSON.stringify({ schemaVersion: 1, id, revision, title: '自作・読書設定検証', document: { blocks: [{ id: 'b', kind: 'paragraph', text, ruby: [{ start: 2, end: 5, reading: 'としょかん' }], runs: [] }], units, versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' } }, chunks, warnings: [], totalChunks: 2, completedChunks: 2, durationSeconds: 24, precision: 'sentence', attribution: 'Self-authored text and synthetic tone. Not an acoustic accuracy test.' });
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', createdAt: '2026-10-06T00:00:00Z', books: [{ id, revision, title: '自作・読書設定検証', manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'), manifestBytes: Buffer.byteLength(manifest), durationSeconds: 24, precision: 'sentence', attribution: 'Self-authored UI fixture', publicDemo: true }] } }));
  await page.route(`**/library/books/${id}/${revision}/manifest.json`, route => route.fulfill({ body: manifest, contentType: 'application/json' }));
  for (const audio of media) await page.route(`**/media/${audio.sha256}.mp3`, route => route.fulfill({ body: audio.bytes, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' } }));
  await page.goto(`/books?book=${id}&revision=${revision}`); await expect(page.getByTestId('audio-phrase')).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
}

test('audio uses original ±5 seconds across chunks, retains play intent, supports rate/sentence/end shortcuts and Guide', async ({ page }) => {
  await audioFixture(page);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('9'); await page.locator('.generation-title h1').click(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(14, 2);
  await expect(page.getByTestId('audio-phrase')).toHaveText('今日は');
  await page.keyboard.press('ArrowLeft'); await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(9, 2);
  await page.keyboard.press('Shift+ArrowRight'); await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(12, 2);
  await page.keyboard.press('ArrowDown'); await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(2.25);
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '5倍', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(5);
  await page.locator('.generation-title h1').click(); await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('5倍');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(4.75);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(5);
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '2.25倍', exact: true }).click();
  await page.locator('.generation-title h1').click();
  await page.keyboard.press('End'); await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(24, 2);
  await page.getByRole('button', { name: 'もう一度', exact: true }).click(); await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '一時停止', exact: true }).click(); await slider.fill('9');
  await page.getByRole('button', { name: '再生', exact: true }).click(); await page.locator('.generation-title h1').click(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(14);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const position = Number(await slider.inputValue()); await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(page.getByTestId('guide-reader')).toBeVisible(); expect(Number(await slider.inputValue())).toBeCloseTo(position, 2);
  await page.getByRole('button', { name: 'フレーズ表示', exact: true }).click(); await settings(page);
  await page.getByLabel('まとめる', { exact: true }).selectOption('8'); await page.getByLabel('本文の書体', { exact: true }).selectOption('noto-sans-jp');
  await expect(page.locator('.font-status')).toHaveText('書体の準備完了'); await close(page);
  expect(Number(await slider.inputValue())).toBeCloseTo(position, 2); await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  expect((await inspectGuides(page, '[data-testid="audio-stage"]')).overlap).toBe(false);
});

test('sentence lists pause on opening/selection and close on every explicit resume, including keyboard', async ({ page }, info) => {
  await audioFixture(page); const mobile = info.project.name.startsWith('mobile');
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
  await page.getByRole('button', { name: '再生', exact: true }).click(); await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.locator('.sentence-row').nth(1).click();
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeCloseTo(12, 2);
  if (mobile) await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  if (mobile) { await page.getByRole('button', { name: '一覧を閉じて再生', exact: true }).focus(); await page.keyboard.press('Space'); }
  else { await page.locator('.generation-title h1').click(); await page.keyboard.press('Space'); }
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
});

test('audio fullscreen keeps the media clock, remembers rate and shares display reset with silent reading', async ({ page }, info) => {
  await audioFixture(page);
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '4.75倍', exact: true }).click();
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('3');
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  await expect(full).toBeVisible();
  await expect(full.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('4.75');
  await full.getByRole('combobox', { name: '音声の速さ', exact: true }).selectOption('1.25');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.25);
  const slider = full.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('9');
  const phrase = await full.getByTestId('audio-phrase').innerText();
  await full.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(full.getByTestId('guide-reader')).toBeVisible();
  await expect(slider).toHaveValue('9');
  await full.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await expect(full.getByTestId('audio-phrase')).toHaveText(phrase);
  await expect(slider).toHaveValue('9');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await page.mouse.move(100, 100);
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect(full.locator('.stage-topline')).toBeHidden();
  await expect(full.getByTestId('stopped-context')).toBeHidden();
  await expect(full.locator('.fullscreen-seek')).toHaveCSS('opacity', '0');
  if (!info.project.name.startsWith('mobile')) {
    await full.locator('.fullscreen-footer').hover();
    await expect(full.locator('.fullscreen-seek')).toHaveCSS('opacity', '1');
    await expect(full.locator('.fullscreen-actions')).toBeHidden();
    await slider.fill('13');
    await expect(full).toHaveAttribute('data-playing', 'true');
  }
  await full.getByTestId('audio-phrase').click();
  await expect(full).toHaveAttribute('data-playing', 'false');
  await slider.fill('14');
  await full.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await settings(page);
  await page.getByLabel('暗い背景', { exact: true }).check();
  await page.getByLabel('文字サイズ', { exact: true }).fill('72');
  await close(page);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('1.25倍');
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeCloseTo(14, 2);
  await settings(page);
  await expect(page.getByLabel('暗い背景', { exact: true })).toBeChecked();
  await expect(page.getByLabel('文字サイズ', { exact: true })).toHaveValue('72');
  await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(page.getByLabel('文字サイズ', { exact: true })).toHaveValue('56');
  await close(page);
  await expect(page.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('1.25倍');
  await page.goto('/');
  await read(page);
  await settings(page);
  await expect(page.getByLabel('文字サイズ', { exact: true })).toHaveValue('56');
  await expect(page.getByLabel('暗い背景', { exact: true })).not.toBeChecked();
});

test('vertical phrases fit ruby and guides, retain position and restore/reset the writing direction', async ({ page }) => {
  await read(page);
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await page.locator('.source-unit').filter({ hasText: '図書館' }).first().click(); await close(page);
  const anchor = await page.getByTestId('current-phrase').innerText();
  const position = await page.locator('.playback-position-label').innerText();
  await settings(page); await page.getByLabel('本文の向き', { exact: true }).selectOption('vertical-rl');
  await page.getByLabel('本文の書体', { exact: true }).selectOption('noto-serif-jp');
  await expect(page.locator('.font-status')).toHaveText('書体の準備完了');
  for (const size of ['24', '96']) {
    await page.getByLabel('文字サイズ', { exact: true }).fill(size); await close(page);
    await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
    await expect(page.locator('.playback-position-label')).toHaveText(position);
    await expect(page.getByTestId('current-phrase')).toHaveCSS('writing-mode', 'vertical-rl');
    await expect.poll(() => verticalGlyphsFit(page, 'reader-stage')).toBe(true);
    await settings(page);
  }
  await close(page);
  await page.getByRole('button', { name: /^全画面(?:で読む)?$/ }).click();
  await expect.poll(() => verticalGlyphsFit(page, 'reader-stage')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('vertical-phrase-fullscreen.png') });
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await settings(page); await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(page.getByLabel('本文の向き', { exact: true })).toHaveValue('horizontal-tb'); await close(page);
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await expect(page.getByTestId('current-phrase')).toHaveCSS('writing-mode', 'horizontal-tb');
  await settings(page);
  await page.getByLabel('本文の向き', { exact: true }).selectOption('vertical-rl');
  await page.getByLabel('まとめる', { exact: true }).selectOption('24');
  await page.getByLabel('文字サイズ', { exact: true }).fill('96'); await close(page);
  await expect.poll(() => verticalGlyphsFit(page, 'reader-stage')).toBe(true);
});

async function verticalGlyphsFit(page: Page, stage: string) {
  return page.getByTestId(stage).evaluate(element => {
    const frame = element.getBoundingClientRect();
    const phrase = element.querySelector('.phrase')!;
    const markers = [...element.querySelectorAll<HTMLElement>('.guide')].map(node => node.getBoundingClientRect());
    const walker = document.createTreeWalker(phrase, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        count++;
        if (rect.left < frame.left || rect.right > frame.right || rect.top < frame.top || rect.bottom > frame.bottom) return false;
        if (markers.some(marker => rect.left < marker.right && rect.right > marker.left && rect.top < marker.bottom && rect.bottom > marker.top)) return false;
      }
    }
    return count > 0;
  });
}

test('vertical Guide virtualizes right-to-left columns, follows search and preserves the anchor on manual scroll', async ({ page }) => {
  const text = '静かな<ruby>図書館<rt>としょかん</rt></ruby>で記録を読む。'.repeat(14) + '現在位置の目印です。' + '続きをゆっくり読む。'.repeat(25) + '\n\n' + '朝に本を読み、原文を確かめる。\n\n'.repeat(1200) + '末尾の標識です。';
  await read(page, text); await settings(page);
  await page.getByLabel('本文の向き', { exact: true }).selectOption('vertical-rl'); await close(page);
  await page.getByRole('button', { name: /^(Guide全文|全文表示)$/ }).click();
  const viewport = page.getByTestId('guide-viewport');
  await expect(viewport).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.locator('.guide-unit rt').first()).toHaveText('としょかん');
  expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  for (const query of ['目印', '末尾の標識']) {
    await page.getByLabel('Guide本文を検索', { exact: true }).fill(query);
    await page.getByRole('button', { name: '検索して移動', exact: true }).click();
    await expect(page.locator('.guide-unit[aria-current="location"]').first()).toContainText(query === '目印' ? '目印' : '末尾');
    await expect.poll(() => viewport.evaluate(element => {
      const target = element.querySelector('.guide-unit[aria-current="location"]');
      const frame = element.getBoundingClientRect(); const rect = target?.getClientRects()[0];
      return Boolean(rect && rect.left >= frame.left && rect.right <= frame.right && rect.top >= frame.top && rect.bottom <= frame.bottom);
    })).toBe(true);
    expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  }
  const position = await page.locator('.playback-position-label').innerText();
  const before = await viewport.evaluate(element => element.scrollLeft);
  await viewport.hover(); await page.mouse.wheel(0, -2000);
  await expect(page.getByRole('button', { name: '現在位置を追従', exact: true })).toBeVisible();
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(before);
  await expect(page.locator('.playback-position-label')).toHaveText(position);
  await page.getByRole('button', { name: '現在位置を追従', exact: true }).click();
  await expect.poll(() => viewport.evaluate(element => {
    const target = element.querySelector('.guide-unit[aria-current="location"]');
    const frame = element.getBoundingClientRect(); const rect = target?.getClientRects()[0];
    return Boolean(rect && rect.left >= frame.left && rect.right <= frame.right);
  })).toBe(true);
  await page.getByRole('button', { name: /^全画面(?:で読む)?$/ }).click();
  await expect(viewport).toHaveCSS('writing-mode', 'vertical-rl');
  await expect.poll(() => viewport.evaluate(element => {
    const target = element.querySelector('.guide-unit[aria-current="location"]');
    const frame = element.getBoundingClientRect(); const rect = target?.getClientRects()[0];
    return Boolean(rect && rect.left >= frame.left && rect.right <= frame.right);
  })).toBe(true);
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await page.getByRole('button', { name: /^(Flash|フレーズ表示)$/ }).click();
  await expect(page.getByTestId('current-phrase')).toContainText('末尾');
  await expect(page.getByTestId('current-phrase')).toHaveCSS('writing-mode', 'vertical-rl');
});

test('audio vertical layout keeps timing, works fullscreen and restores direction after reload', async ({ page }) => {
  await audioFixture(page);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('6');
  await settings(page); await page.getByLabel('本文の向き', { exact: true }).selectOption('vertical-rl'); await close(page);
  await expect(page.getByTestId('audio-sentence')).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.locator('.audio-sentence rt')).toHaveText('としょかん');
  expect(Number(await slider.inputValue())).toBeCloseTo(6, 2);
  await expect.poll(() => verticalGlyphsFit(page, 'audio-stage')).toBe(true);
  await page.getByRole('button', { name: /^全画面(?:で読む)?$/ }).click();
  await expect.poll(() => verticalGlyphsFit(page, 'audio-stage')).toBe(true);
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await page.getByRole('button', { name: /^(Guide全文|全文表示)$/ }).click();
  await expect(page.getByTestId('guide-viewport')).toHaveCSS('writing-mode', 'vertical-rl');
  expect(Number(await slider.inputValue())).toBeCloseTo(6, 2);
  await page.getByRole('button', { name: /^(Flash|フレーズ表示)$/ }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(6);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('audio-sentence')).toHaveCSS('writing-mode', 'vertical-rl');
  await settings(page); await page.getByLabel('本文の向き', { exact: true }).selectOption('horizontal-tb'); await close(page);
  await expect(page.getByTestId('audio-sentence')).toHaveCSS('writing-mode', 'horizontal-tb');
});
