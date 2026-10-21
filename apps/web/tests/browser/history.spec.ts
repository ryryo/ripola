import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { browserMp3 } from '../helpers/browser-media';
import { fixtureWav } from '../helpers/mp3-fixture';

const manuscript = '朝の図書館で本を読みます。\n\n窓辺で昨日の記録を確かめます。最後の頁は明日に残します。';
const phrase = (page: Page) => page.getByTestId('current-phrase');
async function read(page: Page, text = manuscript) {
  await page.getByLabel('読む文章', { exact: true }).fill(text);
  const previous = await phrase(page).count() ? page.url() : undefined;
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  if (previous) await expect(page).not.toHaveURL(previous);
  await expect(phrase(page)).toBeVisible();
}
async function paused(page: Page) {
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toHaveCount(0);
}

test('黙読の戻る・進むは原稿と各読書位置を復元し再生を停止する', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('タイトル', { exact: true }).fill('未保存の原稿');
  const startLength = await page.evaluate(() => history.length);
  await read(page);
  const firstURL = page.url();
  expect(await page.evaluate(() => history.length)).toBe(startLength + 1);
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('100');
  const anchor = await phrase(page).innerText();
  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('Use viewport fullscreen in the history test')); });
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.locator('.fullscreen-reader')).toHaveAttribute('data-playing', 'true');
  await page.goBack();
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(manuscript);
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('未保存の原稿');
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toHaveCount(0);
  await page.goForward(); await expect(phrase(page)).toHaveText(anchor); await paused(page);
  await expect(page.locator('.fullscreen-reader')).toHaveAttribute('data-fullscreen', 'false');
  await page.waitForTimeout(350); await expect(phrase(page)).toHaveText(anchor);
  expect(page.url()).toBe(firstURL);
  expect(await page.evaluate(() => history.length)).toBe(startLength + 1);
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByRole('button', { name: '別の文章を開く', exact: true }).click();
  await read(page, '二冊目の原稿です。別の本と混ざらず読むことができます。');
  const secondURL = page.url(); expect(secondURL).not.toBe(firstURL);
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const secondAnchor = await phrase(page).innerText();
  await page.getByRole('link', { name: 'Ripola ホーム' }).click();
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('二冊目の原稿です。別の本と混ざらず読むことができます。');
  await page.getByRole('link', { name: 'このPCの本棚', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'このPCの本棚' })).toBeVisible();
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('二冊目の原稿です。別の本と混ざらず読むことができます。');
  await page.goBack(); await expect(phrase(page)).toHaveText(secondAnchor); await paused(page);
  expect(page.url()).toBe(secondURL);
  await page.goBack(); await expect(phrase(page)).toHaveText(anchor); await paused(page);
  expect(page.url()).toBe(firstURL);
  await page.goForward(); await expect(phrase(page)).toHaveText(secondAnchor); await paused(page);
  await page.getByRole('link', { name: 'Ripola ホーム' }).click();
  await read(page, `https://example.com/${'abcdefghij'.repeat(100)}`);
  await page.getByRole('slider', { name: '表示量', exact: true }).fill('2');
  const set = page.getByTestId('display-set-text');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  const offset = await set.getAttribute('data-source-start');
  expect(Number(offset)).toBeGreaterThan(0);
  const block = await set.getAttribute('data-block-id');
  await page.getByRole('link', { name: 'Ripola ホーム' }).click();
  await page.goBack();
  await expect(set).toHaveAttribute('data-block-id', block!);
  await expect(set).toHaveAttribute('data-source-start', offset!);
  await paused(page);
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.reload();
  await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(set).toHaveAttribute('data-block-id', block!);
  await expect(set).toHaveAttribute('data-source-start', offset!);
  await paused(page);
  expect(errors).toEqual([]);
});

test('PDFの原稿と原文は戻る・進むと本棚からの復帰でも失われない', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('読み込むファイル').setInputFiles(fileURLToPath(new URL('../fixtures/text-layer.pdf', import.meta.url)));
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  const draft = await page.getByLabel('読む文章', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const anchor = await phrase(page).innerText();
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(draft);
  await page.goForward(); await expect(phrase(page)).toHaveText(anchor); await paused(page);
  await page.getByRole('link', { name: 'このPCの本棚', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'このPCの本棚' })).toBeVisible();
  await page.goBack(); await expect(phrase(page)).toHaveText(anchor);
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
});

async function distributionFixture(page: Page, titles = ['履歴の本1', '履歴の本2']) {
  const media = browserMp3(fixtureWav(12));
  const revision = 'd'.repeat(64);
  const books = ['history-a', 'history-b'].map((id, index) => {
    const text = index ? '二冊目の本を読みます。' : '朝の頁を読みます。';
    const unit = { id: 'u0', blockId: 'b', kind: 'text', text, start: 0, end: text.length, ruby: [], sources: [{ kind: 'text', start: 0, end: text.length }], mapping: 'exact', characters: text.length, cumulativeCharacters: 0, pause: 'sentence' };
    const manifest = JSON.stringify({ schemaVersion: 1, id, revision, title: titles[index], document: { blocks: [{ id: 'b', kind: 'paragraph', text, ruby: [], runs: [] }], units: [unit], versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' } }, chunks: [{ id: 'c0', audioUrl: `library/books/${id}/${revision}/media/${media.sha256}.mp3`, mimeType: 'audio/mpeg', sha256: media.sha256, bytes: media.bytes.length, durationSeconds: 12, timing: { verification: 'pcm-correlated' }, timeline: [{ blockId: 'b', start: 0, end: text.length, unitIds: ['u0'] }] }], warnings: [], totalChunks: 1, completedChunks: 1, durationSeconds: 12, precision: 'sentence', attribution: 'Self-authored navigation fixture and synthetic tone.' });
    return { id, revision, title: titles[index], manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'), manifestBytes: Buffer.byteLength(manifest), durationSeconds: 12, precision: 'sentence', attribution: 'Self-authored navigation fixture', publicDemo: false, manifest };
  });
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', createdAt: '2026-10-16T00:00:00Z', books: books.map(book => ({ ...book, manifest: undefined })) } }));
  for (const book of books) await page.route(`**/${book.manifestUrl}`, route => route.fulfill({ body: book.manifest, contentType: 'application/json' }));
  await page.route(`**/media/${media.sha256}.mp3`, route => route.fulfill({ body: media.bytes, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' } }));
  return books;
}

test('配信本棚の履歴は一覧・各本・音声位置を復元し戻ると音声が止まる', async ({ page }) => {
  await distributionFixture(page); await page.goto('/books');
  await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: '音声付きで読む', exact: true }).first().click();
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  const firstURL = page.url();
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('4');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(4.1);
  await page.locator('audio').evaluate(audio => { (window as unknown as { departedAudio: HTMLAudioElement }).departedAudio = audio as HTMLAudioElement; });
  await page.goBack();
  await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { departedAudio: HTMLAudioElement }).departedAudio.paused)).toBe(true);
  await page.goForward(); await expect(page.getByTestId('audio-phrase')).toBeVisible(); await paused(page);
  expect(page.url()).toBe(firstURL);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(4);
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '音声付きで読む', exact: true }).nth(1).click();
  await expect(page.getByRole('heading', { name: '履歴の本2', exact: true })).toBeVisible();
  await slider.fill('7');
  await page.goBack(); await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  await page.goForward(); await expect(page.getByRole('heading', { name: '履歴の本2', exact: true })).toBeVisible();
  await expect(slider).toHaveValue('7'); await paused(page);
  await page.reload(); await expect(slider).toHaveValue('7'); await paused(page);
});

test('本棚の遅い取得が戻る操作後の一覧を読書画面へ戻さない', async ({ page }) => {
  const books = await distributionFixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route(`**/${books[0].manifestUrl}`, async route => { requested(); await pending; await route.fulfill({ body: books[0].manifest, contentType: 'application/json' }); });
  await page.goto('/books'); await page.getByRole('button', { name: '音声付きで読む', exact: true }).first().click();
  await started;
  await page.goBack(); await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  release(); await page.waitForTimeout(300);
  await expect(page.getByTestId('audio-phrase')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
});


test('名前変更の保存待ちが戻った原稿へ旧本文を再表示しない', async ({ page }) => {
  await page.goto('/'); await read(page);
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByLabel('タイトルを変更', { exact: true }).fill('処理待ちの名前');
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
      indexedDB.open = original;
      const request = original(...args);
      let resume: (() => void) | undefined;
      Object.defineProperty(request, 'onsuccess', { set(handler: ((event: Event) => void) | null) {
        request.addEventListener('success', event => { (window as unknown as { historyStoragePending: boolean }).historyStoragePending = true; resume = () => handler?.call(request, event); });
      } });
      (window as unknown as { releaseHistoryStorage: () => void }).releaseHistoryStorage = () => resume?.();
      return request;
    }) as IDBFactory['open'];
  });
  await page.getByRole('button', { name: '名前を変更', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { historyStoragePending: boolean }).historyStoragePending)).toBe(true);
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(manuscript);
  await page.evaluate(() => (window as unknown as { releaseHistoryStorage: () => void }).releaseHistoryStorage());
  await page.waitForTimeout(250);
  await expect(phrase(page)).toHaveCount(0);
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(manuscript);
});


test('別原稿のファイル読み込み待ちで戻っても遅い完了が画面を移動しない', async ({ page }) => {
  await page.goto('/'); await read(page);
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByRole('button', { name: '別の文章を開く', exact: true }).click();
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function() {
      File.prototype.text = original;
      (window as unknown as { historyFilePending: boolean }).historyFilePending = true;
      return new Promise(resolve => { (window as unknown as { releaseHistoryFile: () => void }).releaseHistoryFile = () => resolve('遅れて返る別原稿です。'); });
    };
  });
  await page.getByLabel('読み込むファイル').setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('遅れて返る別原稿です。') });
  await expect.poll(() => page.evaluate(() => (window as unknown as { historyFilePending: boolean }).historyFilePending)).toBe(true);
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(manuscript);
  await page.evaluate(() => (window as unknown as { releaseHistoryFile: () => void }).releaseHistoryFile());
  await page.waitForTimeout(250);
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(manuscript);
  await expect(phrase(page)).toHaveCount(0);
});

test('配布本棚の前後ナビは順序・保存位置・戻る進む・全画面を保つ', async ({ page }) => {
  const longTitle = 'とても長いタイトルが続いても本棚の前後ナビからはみ出さないことを確かめるための長い本の名前です';
  const books = await distributionFixture(page, ['履歴の本1', longTitle]);
  await page.addInitScript(({ first, second }) => {
    localStorage.setItem(`rsvp-audio-position:${first.id}:${first.revision}`, '4');
    localStorage.setItem(`rsvp-audio-position:${second.id}:${second.revision}`, '7');
  }, { first: books[0], second: books[1] });
  await page.goto('/books');
  await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '音声付きで読む', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '履歴の本1', exact: true })).toBeVisible();
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await expect(slider).toHaveValue('4');
  const nav = page.getByRole('navigation', { name: '本棚の前後の本' });
  await expect(nav).toBeVisible();
  await expect(nav).toHaveJSProperty('tagName', 'NAV');
  expect(await nav.evaluate(element => getComputedStyle(element).position)).toBe('static');
  expect(await nav.evaluate(element => element.previousElementSibling?.classList.contains('reader-player'))).toBe(true);
  const player = await page.locator('.reader-player').boundingBox();
  const navBox = await nav.boundingBox();
  expect(navBox!.y).toBeGreaterThan(player!.y + player!.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(await page.evaluate(() => window.innerHeight));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(async () => (await nav.boundingBox())!.y).toBeLessThan(navBox!.y);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(nav.locator('.book-navigation-previous')).toContainText('先頭の本です');
  const next = nav.getByRole('link', { name: `次の本: ${longTitle}` });
  await expect(next).toHaveAttribute('href', /\/books\/?\?book=history-b&revision=/);
  await expect(next).toContainText(longTitle);
  const nextTitle = nav.locator('.book-navigation-next .book-navigation-title');
  expect(await nextTitle.evaluate(element => ({ clipped: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(element).textOverflow }))).toEqual({ clipped: true, ellipsis: 'ellipsis' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await expect(nav.getByRole('link', { name: '本棚へ戻る', exact: true })).toHaveAttribute('href', /\/books\/?$/);

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(4.2);
  await page.locator('audio').evaluate((media: HTMLAudioElement) => { (window as unknown as { shelfAudio?: HTMLAudioElement }).shelfAudio = media; });
  await next.click();
  await expect(page).toHaveURL(/book=history-b/);
  await expect(page.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
  await expect.poll(async () => Number(await slider.inputValue())).toBe(7);
  expect(await page.evaluate(() => (window as unknown as { shelfAudio?: HTMLAudioElement }).shelfAudio?.paused)).toBe(true);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(nav.locator('.book-navigation-next')).toContainText('最後の本です');
  await expect(nav.getByRole('link', { name: '前の本: 履歴の本1' })).toHaveAttribute('href', /\/books\/?\?book=history-a&revision=/);

  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('Use viewport fullscreen in the navigation test')); });
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  await expect(nav).toHaveCount(0);
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await expect(nav).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: '履歴の本1', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(4.2);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
  await expect(slider).toHaveValue('7');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();

  await nav.getByRole('link', { name: '本棚へ戻る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本棚', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/books\/?$/);

  await page.goto(`/books?book=${books[1].id}&revision=${books[1].revision}`);
  await expect(page.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
  await expect(slider).toHaveValue('7');
  await expect(page.getByRole('navigation', { name: '本棚の前後の本' })).toBeVisible();
  await expect(page.getByRole('link', { name: '前の本: 履歴の本1' })).toBeVisible();
});
