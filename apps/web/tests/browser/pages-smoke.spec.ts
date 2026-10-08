import { test, expect } from '@playwright/test';
import { AUDIO_DEMOS } from '../../src/reader/audio-demo';

test('完成Pagesの初期本文・読書・明示保存前の再読み込み', async ({ page, context, baseURL }) => {
  const errors: string[] = []; const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL!).origin) external.push(request.url()); });
  await page.goto('./');
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
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('完成Pagesの全音声サンプル・直リンク・seek・公開API境界', async ({ page, request }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const metadata = await request.get('distribution.json');
  expect(metadata.ok()).toBe(true);
  expect(await metadata.json()).toMatchObject({ profile: 'pages', base: '/ripola/', audience: 'demo', localGenerationApi: false });
  const catalogResponse = await request.get('samples/audio/library/index.json');
  expect(catalogResponse.ok()).toBe(true);
  const catalog = await catalogResponse.json(); expect(catalog.books).toHaveLength(3);
  await page.goto('./');
  await expect(page.getByRole('group', { name: '音声サンプルを開く' }).getByRole('link')).toHaveCount(3);
  for (const sample of AUDIO_DEMOS) {
    const entry = catalog.books.find((item: { id: string; revision: string }) => item.id === sample.id && item.revision === sample.revision);
    expect(entry?.publicDemo).toBe(true);
    await page.goto(`demo/?sample=${sample.key}`);
    await expect(page.getByTestId('audio-phrase')).toBeVisible();
    await page.reload(); await expect(page.getByTestId('audio-phrase')).toBeVisible();
    await expect(page.getByTestId('audio-presentation-report')).toContainText('欠落 0 · 重複 0');
    const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
    await slider.fill('10'); await expect(slider).toHaveValue('10');
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(10.2);
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
  }
  for (const path of ['api/local-generation/config', 'api/local-audio/missing.wav', 'generate/']) expect((await request.get(path)).status(), path).toBe(404);
  expect(errors).toEqual([]);
});
