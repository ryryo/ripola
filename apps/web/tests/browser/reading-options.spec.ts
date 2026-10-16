import { denseAudioFixture } from './dense-audio-fixture';
import { adjustReaderDisplay, readerStage } from './display-controls-helpers';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { chooseTheme } from './theme-helpers';
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
async function bookActions(page: Page) { await page.getByRole('button', { name: '本の操作', exact: true }).click(); }
async function close(page: Page) {
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function fixationLayout(page: Page) {
  return page.locator('.phrase-container').evaluate(frame => {
    const bounds = frame.getBoundingClientRect();
    const phrase = frame.querySelector<HTMLElement>('.phrase')!;
    return { size: parseFloat(getComputedStyle(phrase).fontSize), markers: [...frame.querySelectorAll('.guide')].map(guide => {
      const rect = guide.getBoundingClientRect();
      return { x: rect.x + rect.width / 2 - bounds.x, y: rect.y + rect.height / 2 - bounds.y };
    }) };
  });
}
function expectStableFixation(before: Awaited<ReturnType<typeof fixationLayout>>, after: Awaited<ReturnType<typeof fixationLayout>>) {
  expect(Math.abs(after.size - before.size)).toBeGreaterThan(2);
  for (let index = 0; index < before.markers.length; index++) {
    expect(after.markers[index].x).toBeCloseTo(before.markers[index].x, 0);
    expect(after.markers[index].y).toBeCloseTo(before.markers[index].y, 0);
  }
}

test('single-line phrases shrink before wrapping and subdivide long natural units on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await read(page, 'Visualization。');
  const phrase = page.getByTestId('current-phrase');
  const lines = () => phrase.evaluate(element => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height / parseFloat(style.lineHeight);
  });
  await expect.poll(lines).toBeLessThan(1.1);
  await read(page, '国際情報通信技術研究開発機構の研究員です。');
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('100');
  await expect(phrase).not.toHaveText('国際情報通信技術研究開発機構の');
  await expect.poll(lines).toBeLessThan(1.1);
  for (const fullscreen of [false, true]) {
    if (fullscreen) await page.getByRole('button', { name: '1つ戻る', exact: true }).click();
    if (fullscreen) {
      await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('test denied')); });
      await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
    }
    const before = await fixationLayout(page);
    if (fullscreen) await page.getByRole('slider', { name: '読書の再生位置', exact: true }).fill('1');
    else await page.getByRole('button', { name: '1つ進む', exact: true }).click();
    expectStableFixation(before, await fixationLayout(page));
    if (fullscreen) await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: '1つ戻る', exact: true }).click();
  const first = await phrase.innerText();
  const beforePlayback = await fixationLayout(page);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(phrase).not.toHaveText(first, { timeout: 15000 });
  expectStableFixation(beforePlayback, await fixationLayout(page));
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect.poll(lines).toBeLessThan(1.1);
  // Protected runs retain their existing multiline fallback without crossing the guides.
  await read(page, 'https://example.com/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz');
  for (const fullscreen of [false, true]) {
    if (fullscreen) await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
    await expect.poll(async () => (await inspectGuides(page, '[data-testid="reader-stage"]')).minimumGap).toBeGreaterThan(2);
    if (fullscreen) await page.keyboard.press('Escape');
  }
});

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
  await page.getByRole('button', { name: '本の操作', exact: true }).click(); await page.getByRole('button', { name: '原文', exact: true }).click(); await expect(page.getByRole('dialog', { name: '本の操作', exact: true })).toHaveCount(0);
  await page.locator('.source-unit').filter({ hasText: '図書館' }).first().click(); await close(page);
  const anchor = await page.getByTestId('current-phrase').innerText();
  for (const id of ['noto-sans-jp', 'noto-serif-jp', 'biz-udpgothic']) {
    const first = fonts.length;
    await settings(page); await page.getByLabel('本文の書体', { exact: true }).selectOption(id);
    await expect(page.locator('.font-status')).toHaveAttribute('data-state', 'ready');
    expect(fonts.slice(first).length).toBeGreaterThan(0);
    expect(fonts.slice(first).every(url => url.includes(id))).toBe(true);
    expect(fonts.slice(first).every(url => url.includes('400-normal'))).toBe(true);
    for (const size of ['24', '72']) {
      await adjustReaderDisplay(page, 'フォントサイズ', size); await close(page);
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
  await expect(page.locator('.font-status')).toHaveAttribute('data-state', 'ready'); await close(page);
  await page.waitForTimeout(900);
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  expect(await page.getByTestId('current-phrase').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Yu Mincho');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
});

test('grouping is a view; Guide and Flash share position, ruby and static text', async ({ page }) => {
  await read(page); await settings(page);
  await adjustReaderDisplay(page, '表示量', '1');
  await close(page);
  const position = await readerStage(page).getAttribute('data-unit-index');
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(page.getByTestId('guide-reader')).toBeVisible();
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', position!);
  await expect(page.locator('.guide-unit rt')).toContainText(['としょかん']);
  await page.getByLabel('本文を検索').fill('最後'); await page.getByRole('button', { name: '検索して移動' }).click();
  await expect(page.locator('.guide-unit[aria-current="location"]').first()).toContainText('最後');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.getByText('全文を静止表示・コピー', { exact: true }).click();
  await expect(page.getByLabel('コピーする全文')).toHaveValue(manuscript.replace('<ruby>図書館<rt>としょかん</rt></ruby>', '図書館'));
  await page.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toContainText('最後');
  await expect(page.getByTestId('stopped-context')).toHaveCount(0);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('stopped-context')).toHaveCount(0);
});

test('Guide bounds long-document DOM; manual scrolling keeps the reading anchor and disables following', async ({ page }) => {
  test.setTimeout(60000);
  const text = '朝に本を読み、原文を確かめる。\n\n'.repeat(6000).slice(0, 100000);
  await read(page, text);
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  const position = await readerStage(page).getAttribute('data-unit-index');
  await page.getByTestId('guide-viewport').hover(); await page.mouse.wheel(0, 5000);
  await expect(page.getByRole('button', { name: '現在位置を追従', exact: true })).toBeVisible();
  expect(await readerStage(page).getAttribute('data-unit-index')).toBe(position);
  const scrolled = await page.getByTestId('guide-viewport').evaluate(element => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  await page.getByRole('button', { name: '現在位置を追従', exact: true }).click();
  await expect.poll(() => page.getByTestId('guide-viewport').evaluate(element => element.scrollTop)).toBeLessThan(scrolled);
});

test('Guide reveals the highlighted phrase within a tall virtual row after a search jump', async ({ page }) => {
  await read(page, '静かな図書館で記録を読む。'.repeat(14) + 'ここが現在位置の目印です。' + '続きをゆっくり読む。'.repeat(25));
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await page.getByLabel('本文を検索', { exact: true }).fill('目印');
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
  await page.keyboard.press('Home'); await expect(readerStage(page)).toHaveAttribute('data-unit-index', '0');
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
async function audioFixture(page: Page, seconds: 12 | 60 = 12, long: boolean | string = false, fractional: boolean | number = false, gaps = false) {
  const revision = 'c'.repeat(64); const id = 'reading-options-fixture';
  const pieces = [typeof long === 'string' ? long : long ? '国際情報通信技術研究開発機構の' : '私は', '図書館へ。', '今日は', '静かに', '読む。'];
  let offset = 0;
  const units = pieces.map((text, index) => { const start = offset; offset += text.length; return { id: `u${index}`, blockId: 'b', kind: 'text', text, start, end: offset, ruby: index === 1 ? [{ start: 0, end: 3, reading: 'としょかん' }] : [], sources: [{ kind: 'text', start, end: offset }], mapping: 'exact', characters: text.length, cumulativeCharacters: start, pause: text.endsWith('。') ? 'sentence' : 'none' }; });
  const text = pieces.join('');
  const media = [0, 1].map(index => browserMp3(tone(seconds, 220 + index * 30)));
  // The last cue absorbs extra time; existing seek targets stay at 6/12 seconds.
  const chunks = [[0, 2], [2, 5]].map(([from, to], index) => ({ id: `c${index}`, audioUrl: `library/books/${id}/${revision}/media/${media[index].sha256}.mp3`, mimeType: 'audio/mpeg', sha256: media[index].sha256, bytes: media[index].bytes.length, durationSeconds: seconds, timing: { verification: 'pcm-correlated' },
    timeline: [{ blockId: 'b', start: units[from].start, end: units[to - 1].end, unitIds: units.slice(from, to).map(unit => unit.id) }],
    alignment: { precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .95, alignerVersion: 'ui-fixture-only', cues: units.slice(from, to).map((unit, i) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end, startSeconds: fractional && index === 0 ? i * (typeof fractional === 'number' ? fractional : 1 / 3) : i * 12 / (to - from), endSeconds: (i === to - from - 1 ? seconds : fractional && index === 0 ? (i + 1) * (typeof fractional === 'number' ? fractional : 1 / 3) : (i + 1) * 12 / (to - from)) - (gaps ? .08 : 0), score: .95 })) } }));
  const manifest = JSON.stringify({ schemaVersion: 1, id, revision, title: '自作・読書設定検証', document: { blocks: [{ id: 'b', kind: 'paragraph', text, ruby: [{ start: units[1].start, end: units[1].start + 3, reading: 'としょかん' }], runs: [] }], units, versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' } }, chunks, warnings: [], totalChunks: 2, completedChunks: 2, durationSeconds: seconds * 2, precision: 'sentence', attribution: 'Self-authored text and synthetic tone. Not an acoustic accuracy test.' });
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', createdAt: '2026-10-06T00:00:00Z', books: [{ id, revision, title: '自作・読書設定検証', manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'), manifestBytes: Buffer.byteLength(manifest), durationSeconds: seconds * 2, precision: 'sentence', attribution: 'Self-authored UI fixture', publicDemo: true }] } }));
  await page.route(`**/library/books/${id}/${revision}/manifest.json`, route => route.fulfill({ body: manifest, contentType: 'application/json' }));
  for (const audio of media) await page.route(`**/media/${audio.sha256}.mp3`, route => route.fulfill({ body: audio.bytes, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' } }));
  await page.goto(`/books?book=${id}&revision=${revision}`); await expect(page.getByTestId('audio-phrase')).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
}

test('single-line audio subdivisions follow media seek and rate without changing cue or file identity', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await audioFixture(page, 12, true);
  const phrase = page.getByTestId('audio-phrase');
  const sentence = page.getByTestId('audio-sentence');
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await expect(sentence).toHaveAttribute('data-pages', /^[2-9]$/);
  const first = await phrase.innerText();
  const source = await page.locator('audio').getAttribute('src');
  await page.locator('audio').evaluate(audio => { audio.dataset.identity = 'same-media'; });
  await slider.fill('4.9');
  await expect(phrase).not.toHaveText(first);
  await expect(sentence).toHaveAttribute('data-method', 'estimated');
  await expect(sentence).not.toHaveAttribute('data-score');
  await slider.fill('6');
  await expect(phrase).toHaveText('図書館としょかんへ。');
  await expect(sentence).toHaveAttribute('data-method', 'forced-alignment');
  await expect(sentence).toHaveAttribute('data-score', '0.95');
  const short = await fixationLayout(page);
  await slider.fill('0');
  await expect(phrase).toHaveText(first);
  expectStableFixation(short, await fixationLayout(page));
  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('test denied')); });
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const fullscreenLong = await fixationLayout(page);
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('6');
  await expect(phrase).toHaveText('図書館としょかんへ。');
  expectStableFixation(fullscreenLong, await fixationLayout(page));
  await page.keyboard.press('Escape');
  await slider.fill('0');
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '1.25倍', exact: true }).click();
  const beforePlayback = await fixationLayout(page);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(phrase).not.toHaveText(first, { timeout: 10000 });
  expectStableFixation(beforePlayback, await fixationLayout(page));
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  expect(await sentence.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeLessThan(1.1);
  const clock = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({ seconds: audio.currentTime, rate: audio.playbackRate }));
  expect(Number(await slider.inputValue())).toBeCloseTo(clock.seconds, 1);
  expect(clock.rate).toBe(1.25);
  await expect(page.locator('audio')).toHaveAttribute('src', source!);
  await expect(page.locator('audio')).toHaveAttribute('data-identity', 'same-media');
});

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
  await adjustReaderDisplay(page, '表示量', '1'); await page.getByLabel('本文の書体', { exact: true }).selectOption('noto-sans-jp');
  await expect(page.locator('.font-status')).toHaveAttribute('data-state', 'ready'); await close(page);
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
  if (mobile) {
    const resume = page.getByRole('button', { name: '一覧を閉じて再生', exact: true });
    await resume.click({ trial: true });
    await resume.focus();
    await expect(resume).toBeFocused();
    await page.keyboard.press('Space');
  }
  else { await page.locator('.generation-title h1').click(); await page.keyboard.press('Space'); }
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeGreaterThan(12);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
});

test('audio fullscreen keeps the media clock, remembers rate and shares display reset with silent reading', async ({ page }, info) => {
  await audioFixture(page);
  await chooseTheme(page, 'ダーク');
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await expect(page.locator('.mantine-Select-dropdown')).toHaveCSS('background-color', 'rgb(29, 47, 61)');
  await page.getByRole('option', { name: '4.75倍', exact: true }).click();
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('3');
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  await expect(full).toBeVisible();
  await expect(full.locator('.audio-stage')).toHaveCSS('background-color', 'rgb(29, 47, 61)');
  await expect(full.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('4.75');
  await full.getByRole('combobox', { name: '音声の速さ', exact: true }).selectOption('1.25');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.25);
  const slider = full.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('9');
  const phrase = await full.getByTestId('audio-phrase').innerText();
  await full.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(full.getByTestId('guide-reader')).toBeVisible();
  await expect(slider).toHaveValue('9');
  await expect(full.locator('.reader-play-overlay')).toHaveCount(0);
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(9);
  await expect(full.locator('.reader-play-overlay')).toHaveCount(0);
  await full.locator('.guide-viewport').click({ position: { x: 20, y: 20 } });
  await expect(full).toHaveAttribute('data-playing', 'false');
  await expect(page.locator('audio')).toHaveJSProperty('paused', true);
  await expect(full.locator('.reader-play-overlay')).toHaveCount(0);
  await expect(full.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await slider.fill('9');
  await full.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await expect(full.getByRole('button', { name: '再生（画面中央）', exact: true })).toBeVisible();
  await expect(full.getByTestId('audio-phrase')).toHaveText(phrase);
  await expect(slider).toHaveValue('9');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await page.mouse.move(100, 100);
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect(full.locator('.stage-topline')).toBeHidden();
  await expect(full.locator('.guide-top')).toBeVisible();
  await expect(full.locator('.guide-bottom')).toBeVisible();
  await expect(full.locator('.guide-top')).not.toHaveCSS('opacity', '0');
  await expect(full.locator('.guide-bottom')).not.toHaveCSS('opacity', '0');
  await expect(full.getByTestId('stopped-context')).toHaveCount(0);
  await expect(full.locator('.fullscreen-seek')).toBeVisible();
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
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await chooseTheme(page, 'ダーク');
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  await adjustReaderDisplay(page, 'フォントサイズ', '72');
  await close(page);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('1.25倍');
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeCloseTo(14, 2);
  await settings(page);
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await expect(page.getByLabel('フォントサイズ', { exact: true })).toHaveValue('72');
  await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(page.getByLabel('フォントサイズ', { exact: true })).toHaveValue('56');
  await close(page);
  await expect(page.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('1.25倍');
  await page.goto('/');
  await read(page);
  await settings(page);
  await expect(page.getByLabel('フォントサイズ', { exact: true })).toHaveValue('56');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
});

test('vertical phrases fit ruby and guides, retain position and restore/reset the writing direction', async ({ page }) => {
  await read(page);
  await page.getByRole('button', { name: '本の操作', exact: true }).click(); await page.getByRole('button', { name: '原文', exact: true }).click(); await expect(page.getByRole('dialog', { name: '本の操作', exact: true })).toHaveCount(0);
  await page.locator('.source-unit').filter({ hasText: '図書館' }).first().click(); await close(page);
  const anchor = await page.getByTestId('current-phrase').innerText();
  const position = await readerStage(page).getAttribute('data-unit-index');
  await settings(page); await adjustReaderDisplay(page, '本文の向き', 'vertical-rl');
  await page.getByLabel('本文の書体', { exact: true }).selectOption('noto-serif-jp');
  await expect(page.locator('.font-status')).toHaveAttribute('data-state', 'ready');
  for (const size of ['24', '96']) {
    await adjustReaderDisplay(page, 'フォントサイズ', size); await close(page);
    await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
    await expect(readerStage(page)).toHaveAttribute('data-unit-index', position!);
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
  await expect(page.getByText('本文・現在位置・設定を、このブラウザに保存しました。', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await settings(page); await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(page.getByLabel('本文の向き', { exact: true })).toHaveValue('horizontal-tb'); await close(page);
  await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await expect(page.getByTestId('current-phrase')).toHaveCSS('writing-mode', 'horizontal-tb');
  await settings(page);
  await adjustReaderDisplay(page, '本文の向き', 'vertical-rl');
  await adjustReaderDisplay(page, '表示量', '1');
  await adjustReaderDisplay(page, 'フォントサイズ', '96'); await close(page);
  await expect.poll(() => verticalGlyphsFit(page, 'reader-stage')).toBe(true);
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('100');
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect(full.locator('.guide-top')).toBeVisible();
  await expect(full.locator('.guide-bottom')).toBeVisible();
  await expect(full.locator('.guide-top')).not.toHaveCSS('opacity', '0');
  await expect(full.locator('.guide-bottom')).not.toHaveCSS('opacity', '0');
  await page.screenshot({ path: test.info().outputPath('vertical-guides-playing.png') });
  await full.getByTestId('current-phrase').click();
  await full.getByRole('button', { name: '全画面を終了', exact: true }).click();
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
  await adjustReaderDisplay(page, '本文の向き', 'vertical-rl'); await close(page);
  await page.getByRole('button', { name: /^(Guide全文|全文表示)$/ }).click();
  const viewport = page.getByTestId('guide-viewport');
  await expect(viewport).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.locator('.guide-unit rt').first()).toHaveText('としょかん');
  expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  for (const query of ['目印', '末尾の標識']) {
    await page.getByLabel('本文を検索', { exact: true }).fill(query);
    await page.getByRole('button', { name: '検索して移動', exact: true }).click();
    await expect(page.locator('.guide-unit[aria-current="location"]').first()).toContainText(query === '目印' ? '目印' : '末尾');
    await expect.poll(() => viewport.evaluate(element => {
      const target = element.querySelector('.guide-unit[aria-current="location"]');
      const frame = element.getBoundingClientRect(); const rect = target?.getClientRects()[0];
      return Boolean(rect && rect.left >= frame.left && rect.right <= frame.right && rect.top >= frame.top && rect.bottom <= frame.bottom);
    })).toBe(true);
    expect(await page.locator('.guide-unit').count()).toBeLessThan(250);
  }
  const position = await readerStage(page).getAttribute('data-unit-index');
  const before = await viewport.evaluate(element => element.scrollLeft);
  await page.getByTestId('guide-viewport').hover(); await page.mouse.wheel(0, -2000);
  await expect(page.getByRole('button', { name: '現在位置を追従', exact: true })).toBeVisible();
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(before);
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', position!);
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
  await audioFixture(page, 60);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('6');
  await settings(page); await adjustReaderDisplay(page, '本文の向き', 'vertical-rl'); await close(page);
  await expect(page.getByTestId('audio-sentence')).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.locator('.audio-sentence rt')).toHaveText('としょかん');
  expect(Number(await slider.inputValue())).toBeCloseTo(6, 2);
  await expect.poll(() => verticalGlyphsFit(page, 'audio-stage')).toBe(true);
  await page.getByRole('button', { name: /^全画面(?:で読む)?$/ }).click();
  await expect.poll(() => verticalGlyphsFit(page, 'audio-stage')).toBe(true);
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect(full.locator('.guide-top')).toBeVisible();
  await expect(full.locator('.guide-bottom')).toBeVisible();
  await expect(full.locator('.guide-top')).not.toHaveCSS('opacity', '0');
  await expect(full.locator('.guide-bottom')).not.toHaveCSS('opacity', '0');
  await full.getByTestId('audio-phrase').click();
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await slider.fill('6');
  await page.getByRole('button', { name: /^(Guide全文|全文表示)$/ }).click();
  await expect(page.getByTestId('guide-viewport')).toHaveCSS('writing-mode', 'vertical-rl');
  expect(Number(await slider.inputValue())).toBeCloseTo(6, 2);
  await page.getByRole('button', { name: /^(Flash|フレーズ表示)$/ }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(6);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('audio-sentence')).toHaveCSS('writing-mode', 'vertical-rl');
  await settings(page);
  await page.getByLabel('注視点ガイド', { exact: true }).uncheck(); await close(page);
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect(full.locator('.guide-top')).toHaveCSS('opacity', '0');
  await expect(full.locator('.guide-bottom')).toHaveCSS('opacity', '0');
  await full.getByTestId('audio-phrase').click();
  await full.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await settings(page); await adjustReaderDisplay(page, '本文の向き', 'horizontal-tb'); await close(page);
  await expect(page.getByTestId('audio-sentence')).toHaveCSS('writing-mode', 'horizontal-tb');
});

test('黙読ペース評価は同じ速度で比較でき、停止・seek・下限・保存復元が一致する', async ({ page }, info) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await read(page, 'あいうえ。\n\n1234。\n\n（ABCD）を読む。\n\n𠮷が👩‍💻と、長い句の続きを落ち着いて確認する。\n\n' + '最後の文を落ち着いて確かめる。'.repeat(20));
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('600');
  await expect(page.getByTestId('reading-pace-controls')).toHaveCount(0);
  await bookActions(page);
  await expect(page.getByRole('heading', { name: '黙読のペース', exact: true })).toBeVisible();
  const controls = page.getByTestId('reading-pace-controls');
  await expect(controls).toHaveCount(1);
  const select = controls.getByRole('combobox', { name: '黙読ペース', exact: true });
  await expect(select).toHaveValue('legacy');
  const budget = await controls.getByTestId('pace-budget').innerText();
  await select.selectOption('text-load');
  await expect(controls.getByTestId('pace-budget')).toHaveText(budget);
  await close(page);
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('600');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  const track = page.getByRole('progressbar', { name: '読書の進捗' });
  const fraction = () => track.evaluate(element => Number((element as HTMLElement).dataset.progress));
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(fraction).toBeGreaterThan(0);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const frozen = await fraction();
  await page.waitForTimeout(150); expect(await fraction()).toBe(frozen);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(fraction).toBeGreaterThan(frozen);
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const position = await page.getByTestId('current-phrase').innerText();
  await bookActions(page); await select.selectOption('legacy'); await select.selectOption('text-load'); await close(page);
  await expect(page.getByTestId('current-phrase')).toHaveText(position);
  await page.locator('.document-heading h1').click(); await page.keyboard.press('Home');
  await expect(page.getByTestId('current-phrase')).toContainText('あいうえ');
  await page.getByRole('button', { name: '本の操作', exact: true }).click(); await page.getByRole('button', { name: '原文', exact: true }).click(); await expect(page.getByRole('dialog', { name: '本の操作', exact: true })).toHaveCount(0);
  await page.locator('.source-unit').filter({ hasText: '1234' }).first().click(); await close(page);
  await expect(page.getByTestId('current-phrase')).toContainText('1234');
  expect(await fraction()).toBeGreaterThan(0);
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('3000');
  await bookActions(page); await expect(controls.getByTestId('pace-constraint')).toBeVisible(); await close(page);
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toContainText('1234');
  await bookActions(page); await expect(select).toHaveValue('text-load'); await close(page);
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('3000');
  await settings(page); await page.getByRole('button', { name: '表示設定をリセット', exact: true }).click();
  await expect(controls).toHaveCount(0);
  await close(page);
  await bookActions(page); await expect(select).toHaveValue('text-load'); await close(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
  await bookActions(page); const box = await select.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
  await info.attach('pace-controls', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  expect(failures).toEqual([]);
});

test('黙読評価の保存設定は音声のmedia時計・倍速・seekへ影響しない', async ({ page }) => {
  await read(page, '数字1234と英字ABCDを確認する。');
  await bookActions(page);
  await page.getByRole('dialog').getByRole('combobox', { name: '黙読ペース', exact: true }).selectOption('text-load'); await close(page);
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('3000');
  await audioFixture(page, 60);
  await expect(page.getByRole('combobox', { name: '黙読ペース', exact: true })).toHaveCount(0);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('6');
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeCloseTo(6, 2);
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).playbackRate)).toBe(2.5);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(6);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const frozen = await audio.evaluate(element => (element as HTMLAudioElement).currentTime);
  await page.waitForTimeout(150);
  expect(await audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBe(frozen);
  await slider.fill('6');
  await expect(page.getByTestId('audio-phrase')).toContainText('図書館');
  await page.reload(); await slider.fill('6');
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeCloseTo(6, 2);
  await expect(page.getByRole('combobox', { name: '音声の速さ', exact: true })).toHaveValue('2.5倍');
});

for (const kind of ['silent', 'audio'] as const) {
  test(`${kind} reader exposes common display controls and separates book actions from appearance`, async ({ page }) => {
    if (kind === 'audio') await audioFixture(page); else await read(page);
    const phrase = page.getByTestId(kind === 'audio' ? 'audio-phrase' : 'current-phrase');
    const anchor = await phrase.textContent();
    const toolbar = page.getByLabel('読書の表示', { exact: true });
    await expect(page.getByRole('button', { name: '再生（画面中央）', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('group', { name: '文字の大きさ', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('switch', { name: 'ルビを表示', exact: true })).toHaveCount(0);
    await expect(phrase).toHaveText(anchor!);
    await toolbar.getByRole('button', { name: '表示設定', exact: true }).click();
    const appearance = page.getByRole('dialog');
    for (const name of ['本文の向き', '表示量', 'フォントサイズ', '停止時に前後の文脈を表示']) await expect(appearance.getByLabel(name, { exact: true })).toHaveCount(0);
    await appearance.getByRole('switch', { name: 'ルビを表示', exact: true }).uncheck();
    await appearance.getByRole('switch', { name: '全画面で進行バーを表示', exact: true }).uncheck();
    await expect(page.getByLabel('フォントサイズ', { exact: true })).toHaveValue('56');
    await expect(appearance.getByLabel('タイトルを変更', { exact: true })).toHaveCount(0);
    await expect(appearance.getByRole('button', { name: '保存を削除', exact: true })).toHaveCount(0);
    await expect(appearance.getByRole('switch', { name: '句読点で間をとる', exact: true })).toHaveCount(0);
    await adjustReaderDisplay(page, 'フォントサイズ', '96');
    await close(page);
    await toolbar.getByRole('button', { name: '表示設定', exact: true }).click();
    await expect(appearance.getByRole('switch', { name: 'ルビを表示', exact: true })).not.toBeChecked();
    await appearance.getByRole('switch', { name: 'ルビを表示', exact: true }).check();
    await close(page);
    await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
    const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
    await expect(full.locator('.fullscreen-seek')).toBeHidden();
    const before = await full.locator('.phrase-container').boundingBox();
    await full.getByRole('button', { name: '再生（画面中央）', exact: true }).click();
    await expect(full).toHaveAttribute('data-playing', 'true');
    await expect(full.locator('.fullscreen-seek')).toBeHidden();
    await page.keyboard.press('Space');
    await expect(full).toHaveAttribute('data-playing', 'false');
    const after = await full.locator('.phrase-container').boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.height).toBeCloseTo(before!.height, 0);
    await page.keyboard.press('Escape');
    const guides = await inspectGuides(page, kind === 'audio' ? '[data-testid="audio-stage"]' : '[data-testid="reader-stage"]');
    expect(guides.guides).toBe(2); expect(guides.clipped).toBe(false); expect(guides.overlap).toBe(false);
    expect(await page.getByLabel('再生操作', { exact: true }).evaluate(element => {
      const frame = element.getBoundingClientRect(); const play = element.querySelector('.play-button')!.getBoundingClientRect();
      return Math.abs((frame.left + frame.right) / 2 - (play.left + play.right) / 2);
    })).toBeLessThan(1);
    if (kind === 'audio') {
      await expect(page.getByRole('group', { name: '文の先頭へ移動', exact: true })).toHaveCount(0);
      await expect(page.getByRole('slider', { name: '表示量', exact: true })).toBeVisible();
      await expect(page.getByRole('slider', { name: 'フォントサイズ', exact: true })).toBeVisible();
      await expect(page.getByRole('group', { name: '文の中の短い区切りへ移動', exact: true })).toHaveCount(0);
    }
    await expect(page.getByTestId('stopped-context')).toHaveCount(0);
    await expect(page.locator('.playback-position-label')).toHaveCount(0);
    const unit = await readerStage(page).getAttribute('data-unit-index');
    await page.locator('.reader-book-heading h1').click();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(readerStage(page)).not.toHaveAttribute('data-unit-index', unit!);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await page.getByRole('button', { name: '本の操作', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '先頭へ戻る', exact: true })).toBeVisible();
    if (kind === 'audio') expect(await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    await close(page);
    await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    await expect(page.getByTestId('audio-presentation-report')).toHaveCount(0);
    await expect(page.locator('.audio-alignment-status, .keyboard-hint, .reader-note')).toHaveCount(0);
  });
}

test('vertical fullscreen touch scrolling keeps visible text stable across virtual row measurements and retains search and following', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'Native touch regression uses the mobile viewport.');
  test.setTimeout(90000);
  const text = Array.from({ length: 150 }, (_, index) => `第${index + 1}段落です。` + '静かな図書館で記録を読み進めます。窓の向こうに青い空が広がっています。'.repeat(2 + index % 7)).join('\n\n');
  await read(page, text);
  await settings(page); await adjustReaderDisplay(page, '本文の向き', 'vertical-rl'); await close(page);
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('mobile fallback')); });
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  const viewport = full.getByTestId('guide-viewport');
  const visibleCurrent = () => viewport.evaluate(element => {
    const frame = element.getBoundingClientRect();
    return [...element.querySelectorAll('[aria-current="location"]')].some(unit => [...unit.getClientRects()].some(rect => rect.left >= frame.left && rect.right <= frame.right && rect.top >= frame.top && rect.bottom <= frame.bottom));
  });
  await full.getByLabel('本文を検索', { exact: true }).fill('第80段落');
  await full.getByRole('button', { name: '検索して移動', exact: true }).click();
  await expect.poll(visibleCurrent).toBe(true);
  const position = await readerStage(page).getAttribute('data-unit-index');
  await viewport.evaluate(element => {
    const state = { running: true, direction: -1, samples: 0, reversals: [] as number[], anchor: undefined as { node: Element; fragment: number; right: number } | undefined };
    const target = window as typeof window & { guideSwipe: typeof state }; target.guideSwipe = state;
    const sample = () => {
      if (!state.running) return;
      const frame = element.getBoundingClientRect();
      const previous = state.anchor;
      const rect = previous?.node.isConnected ? previous.node.getClientRects()[previous.fragment] : undefined;
      if (previous && rect) {
        const movement = rect.right - previous.right;
        if (movement * state.direction < -2) state.reversals.push(movement);
        state.samples++;
      }
      state.anchor = undefined;
      for (const node of element.querySelectorAll('.guide-unit')) {
        const fragments = [...node.getClientRects()];
        const fragment = fragments.findIndex(rect => rect.left < frame.right - 15 && rect.right > frame.left + 15 && rect.bottom > frame.top && rect.top < frame.bottom);
        if (fragment >= 0) { state.anchor = { node, fragment, right: fragments[fragment].right }; break; }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const visibleText = () => viewport.evaluate(element => {
    const frame = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('.guide-unit')].find(unit => [...unit.getClientRects()].some(rect => rect.left < frame.right - 15 && rect.right > frame.left + 15 && rect.bottom > frame.top && rect.top < frame.bottom))?.dataset.unitId;
  });
  const initialText = await visibleText();
  let backwardText: string | undefined;
  const client = await page.context().newCDPSession(page);
  const box = (await viewport.boundingBox())!;
  for (let swipe = 0; swipe < 12; swipe++) {
    const direction = swipe < 9 ? -1 : 1;
    await page.evaluate(direction => {
      const state = (window as typeof window & { guideSwipe: { direction: number; anchor: unknown } }).guideSwipe;
      state.direction = direction; state.anchor = undefined;
    }, direction);
    const start = direction < 0 ? box.x + box.width - 35 : box.x + 35;
    const end = direction < 0 ? box.x + 35 : box.x + box.width - 35;
    const y = box.y + Math.min(130, box.height / 2);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
    for (let step = 1; step <= 10; step++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (end - start) * step / 10, y }] });
      await page.waitForTimeout(16);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    if (swipe === 8) backwardText = await visibleText();
  }
  expect(backwardText).toBeTruthy();
  expect(backwardText).not.toBe(initialText);
  expect(await visibleText()).not.toBe(backwardText);
  const result = await page.evaluate(() => {
    const state = (window as typeof window & { guideSwipe: { running: boolean; samples: number; reversals: number[] } }).guideSwipe;
    state.running = false; return { samples: state.samples, reversals: state.reversals };
  });
  await info.attach('touch-scroll-motion', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.samples).toBeGreaterThan(50);
  expect(result.reversals).toEqual([]);
  await expect(full).toHaveAttribute('data-playing', 'false');
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', position!);
  await expect(full.getByRole('button', { name: '現在位置を追従', exact: true })).toBeVisible();
  expect(await full.locator('.guide-unit').count()).toBeLessThan(250);
  await full.getByRole('button', { name: '現在位置を追従', exact: true }).click();
  await expect.poll(visibleCurrent).toBe(true);
  await full.getByLabel('本文を検索', { exact: true }).fill('第140段落');
  await full.getByRole('button', { name: '検索して移動', exact: true }).click();
  await expect(full.locator('.guide-unit[aria-current="location"]').first()).toContainText('第140');
  await expect.poll(visibleCurrent).toBe(true);
  const current = await full.locator('.guide-unit[aria-current="location"]').first().getAttribute('data-unit-id');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  await expect(full).toHaveAttribute('data-playing', 'true');
  await expect.poll(() => full.locator('.guide-unit[aria-current="location"]').first().getAttribute('data-unit-id')).not.toBe(current);
  await expect.poll(visibleCurrent).toBe(true);
  await page.keyboard.press('Space');
  await expect(full).toHaveAttribute('data-playing', 'false');
  await page.keyboard.press('Escape');
});

test('multiline sets cover paragraph remainders and fill every requested amount from two to ten', async ({ page }) => {
  const paragraph = '朝の静かな図書館で、新しい本を開いて読み始めます。窓の向こうには青い空が広がり、ゆっくり流れる雲を眺めながらページをめくります。知らなかった世界に出会い、言葉の意味を確かめていきます。';
  const paragraphs = [paragraph, '次の短い段落です。', paragraph];
  await page.setViewportSize({ width: 390, height: 844 }); await read(page, paragraphs.join('\n\n'));
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '56'); await close(page);
  const amount = page.getByRole('slider', { name: '表示量', exact: true });
  const visible = page.getByTestId('display-set-text');
  await expect(amount.getByRole('option', { name: '1文', exact: true })).toHaveCount(1);
  await amount.fill('2');
  const collected = new Map<string, string>(); const ends = new Map<string, number>();
  for (let i = 0; i < 50; i++) {
    const ranges = JSON.parse((await visible.getAttribute('data-source-ranges'))!) as { blockId: string; start: number; end: number }[];
    const rendered = (await visible.textContent())!.split('\n');
    for (const [index, range] of ranges.entries()) {
      expect(range.start).toBe(ends.get(range.blockId) ?? 0);
      collected.set(range.blockId, (collected.get(range.blockId) ?? '') + rendered[index]); ends.set(range.blockId, range.end);
    }
    const next = page.getByRole('button', { name: '次へ', exact: true });
    if (await next.isDisabled()) break;
    const id = await visible.getAttribute('data-set-id');
    if (test.info().project.use.hasTouch) await next.tap(); else await next.click(); await expect(visible).not.toHaveAttribute('data-set-id', id!);
  }
  expect([...collected.values()]).toEqual(paragraphs);
  await amount.fill('1'); await expect(page.getByTestId('current-phrase')).toBeVisible();
});

test('multiline requested rows determine normal and fullscreen layout instead of being a loose upper bound', async ({ page }) => {
  test.setTimeout(120000);
  await read(page, Array.from({ length: 100 }, (_, i) => i % 2 ? '短い段落も続けて表示します。' : '朝の静かな<ruby>図書館<rt>としょかん</rt></ruby>で新しい本を開き、窓辺で文章の意味をゆっくり確かめながら読み進めます。'.repeat(5)).join('\n\n'));
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '96'); await close(page);
  const amount = page.getByRole('slider', { name: '表示量', exact: true });
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const mode of ['horizontal-tb', 'vertical-rl']) {
      await settings(page); await adjustReaderDisplay(page, '本文の向き', mode); await close(page);
      for (let rows = 2; rows <= 10; rows++) {
        await amount.fill(String(rows));
        for (const fullscreen of [false, true]) {
          if (fullscreen) await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
          const visible = page.getByTestId('display-set-text');
          await expect(visible).toHaveAttribute('data-lines', String(rows));
          const actual = await visible.evaluate((element, vertical) => {
            const font = parseFloat(getComputedStyle(element).fontSize); const bands: number[] = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node: Node | null;
            while ((node = walker.nextNode())) {
              if (node.parentElement?.closest('rt')) continue;
              const range = document.createRange(); range.selectNodeContents(node);
              for (const rect of range.getClientRects()) if (rect.width > .1 && rect.height > .1) {
                const value = vertical ? rect.right : rect.top;
                if (!bands.some(other => Math.abs(other - value) < font * .6)) bands.push(value);
              }
            }
            const rect = element.getBoundingClientRect(); const slot = element.parentElement!.getBoundingClientRect();
            const stage = element.closest('section')!;
            const status = stage.querySelector('.stage-topline')!.getBoundingClientRect();
            const nextButton = stage.querySelector('.display-set-next')!;
            const next = nextButton.getBoundingClientRect();
            const nextStyle = getComputedStyle(nextButton);
            const enter = stage.querySelector('.fullscreen-enter')?.getBoundingClientRect();
            const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            return { next: { text: nextButton.textContent?.trim(), icon: Boolean(nextButton.querySelector('svg')), border: nextStyle.borderTopWidth, background: nextStyle.backgroundColor, width: next.width, height: next.height, after: vertical ? next.right <= slot.left : next.top >= slot.bottom, centered: vertical ? Math.abs((next.top + next.bottom - slot.top - slot.bottom) / 2) < 1 : Math.abs((next.left + next.right - slot.left - slot.right) / 2) < 1, overlapsText: intersects(next, rect), overlapsEnter: Boolean(enter && intersects(next, enter)) }, stageHeight: stage.getBoundingClientRect().height, belowStatus: rect.top >= status.bottom - 1, bounds: [rect.x, rect.y, rect.width, rect.height], slot: [slot.x, slot.y, slot.width, slot.height], rows: bands.length, inside: rect.left >= slot.left - 1 && rect.right <= slot.right + 1 && rect.top >= slot.top - 1 && rect.bottom <= slot.bottom + 1, font };
          }, mode === 'vertical-rl');
          expect(actual.rows, JSON.stringify({ size, mode, rows, fullscreen, actual })).toBe(rows); expect(actual.inside, JSON.stringify({ size, mode, rows, fullscreen, actual })).toBe(true); expect(actual.font).toBeLessThanOrEqual(96); expect(actual.belowStatus).toBe(true);
          expect(actual.next.after).toBe(true); expect(actual.next.centered).toBe(true);
          expect(actual.next.text).toBe(''); expect(actual.next.icon).toBe(true);
          expect(actual.next.border).toBe('0px'); expect(actual.next.background).toBe('rgba(0, 0, 0, 0)');
          expect(actual.next.width).toBeGreaterThanOrEqual(44); expect(actual.next.height).toBeGreaterThanOrEqual(44);
          expect(actual.next.width).toBeLessThan(150); expect(actual.next.overlapsText).toBe(false); expect(actual.next.overlapsEnter).toBe(false);
          if (!fullscreen && mode === 'vertical-rl') expect(actual.stageHeight).toBeGreaterThanOrEqual(460);
          if (fullscreen) expect(actual.stageHeight).toBeCloseTo(size.height, 0);
          if (fullscreen) await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
        }
      }
    }
  }
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(page.getByTestId('guide-reader')).toBeVisible();
  expect(await readerStage(page).evaluate(element => parseFloat(getComputedStyle(element).minHeight))).toBeLessThan(460);
});

test('multiline mobile portrait and landscape keep ruby, text selection and fullscreen pause controls separate from advance', async ({ page }) => {
  await read(page, '朝に<ruby>図書館<rt>としょかん</rt></ruby>を訪ね、静かな窓辺で新しい本を開きます。知らなかった世界に出会い、次の頁の言葉を確かめます。');
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '32'); await close(page);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('3');
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const mode of ['horizontal-tb', 'vertical-rl']) {
      await settings(page); await adjustReaderDisplay(page, '本文の向き', mode); await close(page);
      await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
      const full = page.locator('.fullscreen-reader[data-fullscreen=true]');
      const text = full.getByTestId('display-set-text');
      await expect(text).toHaveCSS('writing-mode', mode);
      expect(Number(await text.getAttribute('data-lines'))).toBeLessThanOrEqual(3);
      await expect(full.getByRole('button', { name: /画面中央/ })).toHaveCount(0);
      const initial = await text.getAttribute('data-set-id');
      await text.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
      await text.click(); await expect(text).toHaveAttribute('data-set-id', initial!);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await full.getByRole('button', { name: '再生', exact: true }).click();
      await expect(full.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
      await full.getByRole('button', { name: '一時停止', exact: true }).click();
      await expect(full).toHaveAttribute('data-playing', 'false');
      const overlap = await text.evaluate(element => {
        const rect = element.getBoundingClientRect(); const footer = document.querySelector('.fullscreen-footer')!.getBoundingClientRect();
        const stage = element.closest('section')!.getBoundingClientRect();
        return rect.bottom > footer.top || rect.left < stage.left || rect.right > stage.right;
      });
      expect(overlap).toBe(false);
      await page.screenshot({ path: test.info().outputPath(`multiline-${size.width}-${mode}.png`) });
      await full.getByRole('button', { name: '全画面を終了', exact: true }).click();
    }
  }
});

test('multiline audio markers follow original cues and advance seeks media while preserving play intent and rate', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await audioFixture(page, 12, true);
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '72'); await close(page);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  const text = page.getByTestId('display-set-text'); const audio = page.locator('audio');
  await expect(text.getByTestId('reading-marker')).toHaveAttribute('data-precision', 'spoken');
  const initialSource = await audio.getAttribute('src');
  const firstLength = '国際情報通信技術研究開発機構の'.length;
  const end = Number(await text.getAttribute('data-source-end'));
  const expectedSeconds = end < firstLength ? 6 * end / firstLength : 6 + 6 * (end - firstLength) / 5;
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(expectedSeconds, 4);
  await expect(text).toHaveAttribute('data-source-start', String(end));
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(text.getByTestId('reading-marker').first()).toHaveAttribute('data-precision', 'spoken');
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen=true]');
  await full.getByRole('button', { name: '再生', exact: true }).click();
  for (let i = 0; i < 12 && await audio.getAttribute('src') === initialSource; i++) {
    await full.getByRole('button', { name: '次へ', exact: true }).click();
    await expect(full).toHaveAttribute('data-playing', 'true');
  }
  await expect(audio).not.toHaveAttribute('src', initialSource!);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(2.5);
  await full.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect(full).toHaveAttribute('data-playing', 'false');
});

test('multiline long words advance automatically with no scrolling and tapping retains the same source remainder', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const text = 'https://example.com/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';
  await read(page, text);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  const visible = page.getByTestId('display-set-text');
  const first = await visible.getAttribute('data-set-id');
  const end = Number(await visible.getAttribute('data-source-end'));
  expect(end).toBeLessThan(text.length);
  expect(await page.locator('.display-set-viewport').evaluate(element => ({ x: element.scrollWidth > element.clientWidth + 1, y: element.scrollHeight > element.clientHeight + 1 }))).toEqual({ x: false, y: false });
  await page.getByRole('button', { name: '次へ' }).click();
  await expect(visible).toHaveAttribute('data-source-start', String(end));
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('3000');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const second = await visible.getAttribute('data-set-id'); expect(second).not.toBe(first);
  await expect(visible).not.toHaveAttribute('data-set-id', second!, { timeout: 10000 });
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  expect(Number(await visible.getAttribute('data-source-start'))).toBeGreaterThan(end);
});

test('multiline reduced ruby still respects two actual lines and full text remembers a separate font size', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await read(page, '<ruby>国際情報通信技術研究開発機構<rt>こくさいじょうほうつうしんぎじゅつけんきゅうかいはつきこう</rt></ruby>で新しい本を開いて文章の意味を確かめます。次の頁もゆっくり読み進めていきます。');
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '96'); await close(page);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  const actual = await page.getByTestId('display-set-text').evaluate(element => {
    const size = parseFloat(getComputedStyle(element).fontSize); const bands: number[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('rt')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.height > 0 && !bands.some(value => Math.abs(value - rect.top) < size * .4)) bands.push(rect.top);
    }
    return { size, lines: bands.length };
  });
  expect(actual.size).toBeLessThan(96); expect(actual.lines).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '28'); await close(page);
  await expect(page.locator('.guide-row').first()).toHaveCSS('font-size', '28px');
  await page.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await settings(page); await expect(page.getByLabel('フォントサイズ', { exact: true })).toHaveValue('96'); await close(page);
});

test('multiline paused audio advances across fractional cue and internal subdivision boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await audioFixture(page, 12, true, true);
  await settings(page); await adjustReaderDisplay(page, 'フォントサイズ', '72'); await close(page);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  const text = page.getByTestId('display-set-text');
  for (let i = 0; i < 8; i++) {
    const end = Number(await text.getAttribute('data-source-end'));
    await page.getByRole('button', { name: '次へ' }).click();
    await expect(text).toHaveAttribute('data-source-start', String(end));
    await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    if (end >= '国際情報通信技術研究開発機構の'.length) break;
  }
  expect(Number(await text.getAttribute('data-source-start'))).toBeGreaterThanOrEqual('国際情報通信技術研究開発機構の'.length);
});

test('audio highlight changes keep glyph positions fixed and remain visible between speech cues', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await audioFixture(page, 12, true);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('10');
  const text = page.getByTestId('display-set-text');
  const positions = () => text.evaluate(element => {
    const result: number[][] = []; const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('rt')) continue;
      for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect(); result.push([rect.x, rect.y, rect.width, rect.height]);
      }
    }
    return result;
  });
  for (const mode of ['horizontal-tb', 'vertical-rl']) {
    await settings(page); await adjustReaderDisplay(page, '本文の向き', mode); await close(page);
    await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('0');
    const before = await positions(); const id = await text.getAttribute('data-set-id');
    await text.evaluate(element => {
      element.setAttribute('data-text-mutations', '0');
      const observer = new MutationObserver(records => {
        const textChanges = records.filter(record => record.type === 'characterData' || [...record.addedNodes, ...record.removedNodes].some(node => Boolean(node.textContent))).length;
        element.setAttribute('data-text-mutations', String(Number(element.getAttribute('data-text-mutations')) + textChanges));
      });
      observer.observe(element, { childList: true, subtree: true, characterData: true });
    });
    for (const seconds of ['2', '6', '8']) {
      await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill(seconds);
      await expect(text).toHaveAttribute('data-set-id', id!);
      const after = await positions(); expect(after.length).toBe(before.length);
      expect(Math.max(...after.flatMap((rect, i) => rect.map((value, j) => Math.abs(value - before[i][j]))))).toBeLessThan(.1);
      await expect(text).toHaveAttribute('data-text-mutations', '0');
    }
      expect(await text.evaluate(() => Array.from(document.querySelectorAll('.reading-marker-layer>span')).some(box => box.getBoundingClientRect().width > 0 && getComputedStyle(box).backgroundColor !== 'rgba(0, 0, 0, 0)'))).toBe(true);
  }
  await page.getByRole('button', { name: '全文表示', exact: true }).click();
  for (const font of ['noto-sans-jp', 'system']) {
    await settings(page); await page.getByLabel('本文の書体', { exact: true }).selectOption(font);
    await expect(page.locator('.font-status')).toHaveAttribute('data-state', 'ready'); await close(page);
    await expect(page.getByTestId('reading-marker')).toHaveCount(0);
    const active = page.locator('.guide-unit.active').first();
    await expect(active).toBeVisible();
    const style = await active.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, highlight: style.getPropertyValue('--guide-active').trim(), shadow: style.boxShadow };
    });
    expect(style.highlight).not.toBe('');
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(style.shadow).toContain(style.background);
  }
});

test('five-times audio retains a painted highlight through cue gaps and display page changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await audioFixture(page, 12, true, false, true);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  await page.getByRole('slider', { name: 'フォントサイズ', exact: true }).fill('96');
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '5倍', exact: true }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(.05);
  await page.evaluate(() => {
    const target = window as typeof window & { markerFrames: { total: number; empty: number; pages: string[] } };
    target.markerFrames = { total: 0, empty: 0, pages: [] };
    const tick = () => {
      const root = document.querySelector('.fullscreen-reader'); const slot = root?.querySelector('.display-set-viewport')?.getBoundingClientRect();
      if (root?.getAttribute('data-playing') !== 'true' || !slot) return;
      const state = target.markerFrames; state.total++;
      const id = root.querySelector('[data-set-id]')?.getAttribute('data-set-id') ?? '';
      if (state.pages.at(-1) !== id) state.pages.push(id);
      const painted = [...root.querySelectorAll('.reading-marker-layer>span')].some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > slot.left && rect.left < slot.right && rect.bottom > slot.top && rect.top < slot.bottom;
      });
      if (!painted) state.empty++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { markerFrames: { total: number } }).markerFrames.total), { timeout: 10000 }).toBeGreaterThan(190);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { markerFrames: { pages: string[] } }).markerFrames.pages.length), { timeout: 10000 }).toBeGreaterThan(2);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const frames = await page.evaluate(() => (window as typeof window & { markerFrames: { total: number; empty: number; pages: string[] } }).markerFrames);
  expect(frames.empty).toBe(0); expect(frames.pages.length).toBeGreaterThan(2);
});

for (const kind of ['silent', 'audio'] as const) test(`${kind} reader uses display sliders below playback and centers the unframed mode switch`, async ({ page }) => {
  if (kind === 'silent') await read(page, manuscript.repeat(20)); else await audioFixture(page, 60, true);
  const player = page.getByRole('region', { name: '再生操作', exact: true });
  const amount = page.getByRole('slider', { name: '表示量', exact: true });
  const size = page.getByRole('slider', { name: 'フォントサイズ', exact: true });
  const direction = player.getByRole('combobox', { name: '本文の向き', exact: true });
  await expect(direction).toBeVisible();
  await direction.selectOption('vertical-rl');
  await expect(page.getByTestId(kind === 'audio' ? 'audio-phrase' : 'current-phrase')).toHaveCSS('writing-mode', 'vertical-rl');
  await direction.selectOption('horizontal-tb');
  await expect(player.getByRole('button', { name: /^(原文|一文戻る|一文進む|前の文|次の文)$/ })).toHaveCount(0);
  await expect(amount).toHaveAttribute('aria-valuetext', '1文');
  await expect(size).toHaveValue('56');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('.reader-display-toolbar').evaluate(toolbar => {
      const modes = toolbar.querySelector('.reading-mode-controls')!;
      const parent = toolbar.getBoundingClientRect(), group = modes.getBoundingClientRect();
      return { centered: Math.abs((parent.left + parent.right - group.left - group.right) / 2), border: getComputedStyle(modes).borderTopWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(geometry.centered).toBeLessThan(1);
    expect(geometry.border).toBe('0px'); expect(geometry.overflow).toBe(false);
    expect((await amount.boundingBox())!.width).toBeGreaterThan(100);
    const fields = await player.evaluate(element => {
      const speed = element.querySelector('.reader-player-speed label')!;
      const direction = element.querySelector('.writing-mode-setting label > span')!;
      const labels = [speed, direction, element.querySelector('.display-amount > span')!, element.querySelector('.font-size-setting > span')!];
      const labelStyles = labels.map(label => { const style = getComputedStyle(label); return `${style.fontFamily}:${style.fontSize}:${style.lineHeight}:${style.fontWeight}`; });
      const select = element.querySelector('.writing-mode-setting select')!;
      return { labelStyles, speed: speed.getBoundingClientRect().toJSON(), direction: direction.getBoundingClientRect().toJSON(), select: select.getBoundingClientRect().toJSON() };
    });
    expect(new Set(fields.labelStyles).size).toBe(1);
    expect(fields.direction.left).toBeGreaterThan(fields.speed.left);
    expect(fields.direction.top).toBeCloseTo(fields.speed.top, 0);
    expect(fields.select.top).toBeGreaterThanOrEqual(fields.direction.bottom);
    expect(fields.select.height).toBeGreaterThanOrEqual(44);
    if (kind === 'audio') {
      const arrows = await player.evaluate(element => ['.reader-player-speed .mantine-Select-input', '.writing-mode-setting select'].map(selector => {
        const control = element.querySelector(selector)!;
        const icon = control.closest('.mantine-Input-wrapper')!.querySelector('[data-position="right"] svg')!;
        const input = control.getBoundingClientRect(), arrow = icon.getBoundingClientRect();
        return { color: getComputedStyle(icon).color, width: arrow.width, height: arrow.height, right: input.right - arrow.right,
          center: Math.abs((input.top + input.bottom - arrow.top - arrow.bottom) / 2), controlHeight: input.height };
      }));
      expect(arrows[1].color).toBe(arrows[0].color);
      for (const property of ['width', 'height', 'right'] as const) expect(arrows[1][property]).toBeCloseTo(arrows[0][property], 0);
      for (const arrow of arrows) { expect(arrow.center).toBeLessThan(.5); expect(arrow.controlHeight).toBeGreaterThanOrEqual(44); }
    }
  }
  await amount.focus(); await page.keyboard.press('ArrowRight');
  await expect(amount).toHaveValue('2');
  await expect(page.getByTestId('display-set-reader')).toBeVisible();
  await size.fill('96');
  await expect(size).toHaveAttribute('aria-valuetext', '上限 96ピクセル');
  await amount.fill('10');
  await expect(amount).toHaveAttribute('aria-valuetext', '10行');
  if (kind === 'silent') await expect(page.getByTestId('display-set-text')).toHaveAttribute('data-lines', '10');
  await amount.fill('1');
  const before = await readerStage(page).getAttribute('data-unit-index');
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.getByRole('region', { name: '全画面の読書', exact: true });
  await expect(page.getByRole('combobox', { name: '本文の向き', exact: true })).toHaveCount(1);
  await full.getByRole('combobox', { name: '本文の向き', exact: true }).selectOption('vertical-rl');
  await expect(full.getByTestId(kind === 'audio' ? 'audio-phrase' : 'current-phrase')).toHaveCSS('writing-mode', 'vertical-rl');
  await full.getByRole('combobox', { name: '本文の向き', exact: true }).selectOption('horizontal-tb');
  await full.getByRole('slider', { name: '表示量', exact: true }).fill('3');
  await expect(full.getByRole('slider', { name: '表示量', exact: true })).toHaveAttribute('aria-valuetext', '3行');
  await full.getByRole('slider', { name: '表示量', exact: true }).fill('1');
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', before!);
  await full.getByRole('button', { name: '全文表示', exact: true }).click();
  await expect(full.getByRole('slider', { name: '表示量', exact: true })).toBeDisabled();
  await expect(full.getByRole('slider', { name: '表示量', exact: true })).toHaveAttribute('aria-valuetext', '全文');
  await full.getByRole('slider', { name: 'フォントサイズ', exact: true }).fill('32');
  await expect(full.locator('.guide-row').first()).toHaveCSS('font-size', '32px');
  await full.getByRole('button', { name: 'フレーズ表示', exact: true }).click();
  await expect(full.getByRole('slider', { name: 'フォントサイズ', exact: true })).toHaveValue('96');
  await expect(readerStage(page)).toHaveAttribute('data-unit-index', before!);
  await full.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await expect(direction).toHaveValue('horizontal-tb');
  await expect(player.getByRole('slider', { name: '表示量', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await size.fill('72');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  if (kind === 'audio') expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
});

test('multiline audio can seek backwards inside a long cue without losing its current page or marker', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await audioFixture(page, 12, '国際情報通信技術研究開発機構の'.repeat(40));
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  await page.getByRole('slider', { name: 'フォントサイズ', exact: true }).fill('96');
  const text = page.getByTestId('display-set-text');
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const mode of ['horizontal-tb', 'vertical-rl']) {
    await page.getByLabel('本文の向き', { exact: true }).selectOption(mode);
    await slider.fill('3');
    await expect.poll(async () => Number(await text.getAttribute('data-source-start'))).toBeGreaterThan(0);
    await slider.fill('0');
    await expect(text).toHaveAttribute('data-source-start', '0');
    await expect(page.getByTestId('reading-marker')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('multiline audio keeps the spoken marker on screen when short cues use estimated phrase timing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await audioFixture(page, 12, '国際情報通信技術研究開発機構の'.repeat(4), .08);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  await page.getByRole('slider', { name: 'フォントサイズ', exact: true }).fill('96');
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  for (const mode of ['horizontal-tb', 'vertical-rl']) {
    await page.getByLabel('本文の向き', { exact: true }).selectOption(mode);
    for (const fullscreen of [false, true]) {
      if (fullscreen) {
        await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('test denied')); });
        await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
      }
      await slider.fill('0');
      const text = page.getByTestId('display-set-text');
      const next = await text.getAttribute('data-source-end');
      await page.getByRole('button', { name: '次へ', exact: true }).click();
      await expect(text).toHaveAttribute('data-source-start', next!);
      expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeLessThan(.08);
      await slider.fill('0.2');
      const marker = page.getByTestId('reading-marker');
      await expect(marker).toHaveAttribute('data-precision', 'spoken');
      expect(await marker.evaluate(element => {
        const slot = element.closest('.display-set-viewport')!.getBoundingClientRect();
        return [...element.querySelectorAll('.reading-marker-layer>span')].some(box => {
          const rect = box.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > slot.left && rect.left < slot.right && rect.bottom > slot.top && rect.top < slot.bottom;
        });
      })).toBe(true);
      if (fullscreen) await page.keyboard.press('Escape');
    }
  }
});


test('five-times multiline markers track dense speech cues independently of transport repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const clock = await denseAudioFixture(page);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('5');
  await page.getByRole('slider', { name: 'フォントサイズ', exact: true }).fill('56');
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '5倍', exact: true }).click();
  for (const mode of ['horizontal-tb', 'vertical-rl']) {
    await page.getByLabel('本文の向き', { exact: true }).selectOption(mode);
    await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('0');
    await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.seeking)).toBe(true);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
    const frames = await page.evaluate(clock => new Promise<{ frames: number; distinct: number; empty: number; stale: number; paused: boolean }>(resolve => {
      let frames = 0, empty = 0, stale = 0; const observed = new Set<number>();
      const sample = () => {
        const audio = document.querySelector('audio')!;
        const marker = document.querySelector('[data-testid="reading-marker"]');
        const from = marker?.getAttribute('data-marker-start');
        const cue = from === null || from === undefined ? undefined : Math.floor(Number(from) / clock.characters);
        frames++;
        if (cue === undefined || !marker?.querySelector('.reading-marker-layer>span')) empty++;
        else {
          observed.add(cue); const expected = Math.floor(audio.currentTime / clock.cueSeconds);
          if (expected - cue > 2 || cue - expected > 1) stale++;
        }
        if (audio.currentTime >= 12 || audio.paused) resolve({ frames, distinct: observed.size, empty, stale, paused: audio.paused });
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }), clock);
    expect(frames.paused).toBe(false); expect(frames.empty).toBe(0);
    expect(frames.distinct).toBeGreaterThan(Math.min(70, frames.frames * .7));
    expect(frames.stale).toBeLessThan(frames.frames * .1);
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
    const media = await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime);
    expect(Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeCloseTo(media, 2);
  }
});
