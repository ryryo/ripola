import { test, expect } from '@playwright/test';
import { chooseTheme } from './theme-helpers';
import { AUDIO_DEMOS } from '../../src/reader/audio-demo';

test('完成Pagesの初期本文・読書・明示保存前の再読み込み', async ({ page, context, request, baseURL }) => {
  const errors: string[] = []; const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL!).origin) external.push(request.url()); });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');
  const catalog = await (await request.get('library/index.json')).json();
  if (catalog.books.length) {
    await expect(page.locator('.home-continue-home-link')).toBeVisible();
    await expect(page.getByRole('heading', { name: '続きを読む', exact: true })).toHaveCount(0);
  } else {
    const section = page.getByRole('region', { name: '続きを読む', exact: true });
    await expect(section).toBeVisible();
    await expect(section).toContainText('保存音声はまだありません');
    await expect(page.locator('.home-continue-home-link')).toHaveCount(0);
  }
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 33, 44)');
  await chooseTheme(page, 'ライト');
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(/^吾輩は猫である。/);
  await expect(page.locator('.input-format-result')).toContainText('テキスト');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await expect(page.locator('.phrase rt')).toHaveCount(0);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '続きから開く', exact: true })).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('配布版の続きを読むは保存位置と全幅バーを表示し音声を停止して再開する', async ({ page, request }) => {
  const catalog = await (await request.get('samples/audio/library/index.json')).json();
  const entry = catalog.books.find((book: { id: string }) => book.id === AUDIO_DEMOS[0].id);
  const metadata = await (await request.get('distribution.json')).json();
  const route = metadata.profile === 'pages' ? 'demo/' : 'books/';
  await page.addInitScript(entry => localStorage.setItem(`rsvp-audio-position:${entry.id}:${entry.revision}`, '12'), entry);
  const unexpected: string[] = [];
  page.on('request', request => { if (/\/_serverFn\/|\/api\/local-|\/media\//.test(request.url())) unexpected.push(request.url()); });
  await page.goto('./');
  const section = page.getByRole('region', { name: '続きを読む', exact: true });
  await expect(section.getByRole('article')).toHaveCount(1);
  await expect(section.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(Math.floor(12 / entry.durationSeconds * 100)));
  await expect(section).toContainText('0分12秒から再開');
  await expect(section).not.toContainText('保存位置なし');
  const card = await section.getByRole('article').boundingBox(), track = await section.locator('.bookshelf-progress-track').boundingBox();
  expect(track!.width).toBeCloseTo(card!.width, 0);
  expect(card!.height).toBeLessThanOrEqual(94);
  await expect(section.getByRole('link', { name: '本棚ですべて見る' })).toHaveAttribute('href', new RegExp(`/${route}$`));
  expect(unexpected).toEqual([]);
  const open = section.getByRole('link', { name: `${entry.title}の続きを読む`, exact: true });
  await expect(open).toHaveAttribute('href', new RegExp(`/${route}\\?sample=voicevox&`));
  await open.click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await expect(page.getByRole('slider', { name: '音声の再生位置', exact: true })).toHaveValue('12');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.readyState)).toBeGreaterThan(0);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
});

test('配布版の続きを読むは一覧取得の再試行と別タブの保存位置変更に対応する', async ({ page, request }) => {
  const catalog = await (await request.get('samples/audio/library/index.json')).json();
  const entry = catalog.books.find((book: { id: string }) => book.id === AUDIO_DEMOS[0].id);
  const key = `rsvp-audio-position:${entry.id}:${entry.revision}`;
  await page.addInitScript(key => localStorage.setItem(key, '12'), key);
  await page.route(/\/library\/index\.json$/, route => route.request().url().includes('/samples/audio/') ? route.continue() : route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('./');
  const section = page.getByRole('region', { name: '続きを読む', exact: true });
  await expect(section.getByRole('alert')).toBeVisible();
  await page.getByLabel('読む文章', { exact: true }).fill('書きかけの文章を保ちます。');
  await page.unroute(/\/library\/index\.json$/);
  await section.getByRole('button', { name: '保存音声を再確認' }).click();
  await expect(section.getByRole('article')).toHaveCount(1);
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('書きかけの文章を保ちます。');
  await page.evaluate(key => { localStorage.removeItem(key); window.dispatchEvent(new StorageEvent('storage', { key })); }, key);
  await expect(section.getByRole('article')).toHaveCount(0);
});

test('配布本棚の続きを読むは保存済みの本を優先しサンプル障害時も再開できる', async ({ page, request }) => {
  const catalog = await (await request.get('samples/audio/library/index.json')).json();
  const metadata = await (await request.get('distribution.json')).json();
  const entry = catalog.books[2];
  await page.addInitScript(entry => localStorage.setItem(`rsvp-audio-position:${entry.id}:${entry.revision}`, '12'), entry);
  await page.route(/\/library\/index\.json$/, route => route.request().url().includes('/samples/audio/') ? route.fulfill({ status: 503 })
    : route.fulfill({ json: { ...catalog, target: metadata.profile, audience: 'demo' } }));
  await page.route(/\/library\/books\//, async route => {
    if (route.request().url().includes('/samples/audio/')) return route.continue();
    await route.fulfill({ response: await route.fetch({ url: route.request().url().replace('/library/books/', '/samples/audio/library/books/') }) });
  });
  await page.goto('./');
  const section = page.getByRole('region', { name: '続きを読む', exact: true });
  await expect(section.getByRole('article')).toHaveCount(1);
  await expect(section.getByRole('heading', { level: 3 }).first()).toHaveText(entry.title);
  await expect(section.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', String(Math.floor(12 / entry.durationSeconds * 100)));
  await expect(section.getByRole('progressbar')).toHaveCount(1);
  const open = section.getByRole('link', { name: `${entry.title}の続きを読む`, exact: true });
  await expect(open).toHaveAttribute('href', new RegExp(`/${metadata.profile === 'pages' ? 'demo/' : 'books/'}\\?book=`));
  await open.click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await expect(page.getByRole('slider', { name: '音声の再生位置', exact: true })).toHaveValue('12');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.readyState)).toBeGreaterThan(0);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
});

test('配布本棚は読了を絞り込みタイトルから保存位置を開く', async ({ page, request }) => {
  const catalog = await (await request.get('samples/audio/library/index.json')).json();
  const metadata = await (await request.get('distribution.json')).json();
  const entry = catalog.books[1];
  await page.addInitScript(({ completed, reading }) => {
    localStorage.setItem(`rsvp-audio-position:${completed.id}:${completed.revision}`, String(completed.durationSeconds));
    localStorage.setItem(`rsvp-audio-position:${reading.id}:${reading.revision}`, '12');
  }, { completed: catalog.books[0], reading: entry });
  await page.route(/\/library\/index\.json$/, route => route.request().url().includes('/samples/audio/') ? route.continue()
    : route.fulfill({ json: { ...catalog, target: metadata.profile, audience: 'demo' } }));
  await page.route(/\/library\/books\//, async route => {
    if (route.request().url().includes('/samples/audio/')) return route.continue();
    await route.fulfill({ response: await route.fetch({ url: route.request().url().replace('/library/books/', '/samples/audio/library/books/') }) });
  });
  await page.goto(metadata.profile === 'pages' ? 'demo/' : 'books/');
  const titles = page.locator('.bookshelf-book h2');
  await expect(titles).toHaveCount(5);
  await expect(page.getByRole('button', { name: '著者・音声', exact: true })).toHaveCount(0);
  await page.getByLabel('絞り込み', { exact: true }).selectOption('unfinished');
  await expect(titles).toHaveCount(4);
  await page.getByLabel('絞り込み', { exact: true }).selectOption('completed');
  await expect(titles).toHaveText([catalog.books[0].title]);
  await page.getByLabel('絞り込み', { exact: true }).selectOption('reading');
  await expect(titles).toHaveText([entry.title]);
  await page.getByRole('link', { name: entry.title, exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await expect(page.getByRole('slider', { name: '音声の再生位置', exact: true })).toHaveValue('12');
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('作品情報');
});

test('完成Pagesの全音声サンプル・直リンク・seek・公開API境界', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('ripola-color-scheme', 'dark'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const metadata = await request.get('distribution.json');
  expect(metadata.ok()).toBe(true);
  expect(await metadata.json()).toMatchObject({ profile: 'pages', base: '/ripola/', audience: 'demo', localGenerationApi: false });
  const catalogResponse = await request.get('samples/audio/library/index.json');
  expect(catalogResponse.ok()).toBe(true);
  const catalog = await catalogResponse.json(); expect(catalog.books).toHaveLength(5);
  await page.goto('./');
  await expect(page.getByRole('group', { name: '音声サンプルを開く' }).getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('link', { name: /Irodori.*で読む/ })).toHaveCount(0);
  for (const sample of AUDIO_DEMOS) {
    const entry = catalog.books.find((item: { id: string; revision: string }) => item.id === sample.id && item.revision === sample.revision);
    expect(entry?.publicDemo).toBe(true);
    await page.goto(`demo/?sample=${sample.key}`);
    await expect(page.getByTestId('audio-phrase')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
    await page.reload(); await expect(page.getByTestId('audio-phrase')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
    await expect(page.getByTestId('audio-presentation-report')).toHaveCount(0);
    const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
    await slider.fill('10'); await expect(slider).toHaveValue('10');
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(10.2);
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
  }
  for (const path of ['api/local-generation/config', 'api/local-audio/missing.wav', 'generate/']) expect((await request.get(path)).status(), path).toBe(404);
  expect(errors).toEqual([]);
});

test('完成Pagesでも黙読と音声サンプルの履歴が原稿と位置を保ち停止して戻る', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('タイトル', { exact: true }).fill('履歴の原稿');
  await page.getByLabel('読む文章', { exact: true }).fill('これは未保存の原稿です。次の頁も残します。');
  await page.getByRole('group', { name: '音声サンプルを開く' }).getByRole('link').first().click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/ripola/demo');
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('これは未保存の原稿です。次の頁も残します。');
  await page.reload(); await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('履歴の原稿');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const anchor = await page.getByTestId('current-phrase').innerText();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('これは未保存の原稿です。次の頁も残します。');
  await page.goForward(); await expect(page.getByTestId('current-phrase')).toHaveText(anchor);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
});


test('完成Pagesの編集原稿はnative Back後に別画面を再読み込みしても進むで復元できる', async ({ page }) => {
  await page.goto('demo/');
  await page.getByRole('link', { name: '黙読', exact: true }).click();
  await page.getByLabel('読む文章', { exact: true }).fill('履歴項目に残す未保存の原稿です。');
  await page.goBack(); await expect(page.getByRole('heading', { name: '音声に合わせて、読む。' })).toBeVisible();
  await page.reload();
  await page.goForward(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('履歴項目に残す未保存の原稿です。');
});
