import { expect, test } from '@playwright/test';

test('A samples are three visible rows below the form with direct silent entry and 44px controls', async ({page}, testInfo) => {
  await page.goto('/');const panel=page.getByRole('region',{name:'サンプルで試す'});
  await expect(panel.locator('article')).toHaveCount(3);
  await expect(panel.getByRole('article',{name:'音声付きデモ'})).toContainText('吾輩は猫である · 冒頭');
  await expect(panel.getByRole('article',{name:'短い黙読サンプル'})).toContainText('音声なし');
  await expect(panel.getByRole('article',{name:'全文の黙読サンプル'})).toContainText('全11章');
  await expect(panel.getByRole('button',{name:'全文で読む'})).toBeVisible();expect(await panel.locator('details').count()).toBe(0);
  const form=await page.locator('.home-composer').boundingBox();const samples=await panel.boundingBox();expect(samples!.y).toBeGreaterThanOrEqual(form!.y+form!.height);
  for(const item of await panel.locator('article').all()) {const control=item.locator('button,a.mantine-Button-root,a.sample-voice-link').last();await expect(control).toBeVisible();expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);}
  await page.screenshot({path:`docs/validation/creation-options-2026-10-06/local-${testInfo.project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await panel.getByRole('button',{name:'テキストで読む',exact:true}).click();await expect(page.getByTestId('current-phrase')).toBeVisible();await expect(page.locator('.document-heading')).toContainText('朝の図書館');
});

test('auto result and manual override preserve raw input across audio toggle and failed import', async ({page}) => {
  await page.goto('/');const text=page.getByLabel('読む文章',{exact:true});await text.fill('C# と #記号、a*b をそのまま読む。');
  await expect(page.locator('.input-format-result')).toContainText('自動判定 · テキスト');const markdown='# 見出し\n\n[本](https://example.com)を読む。';await text.fill(markdown);
  await expect(page.locator('.input-format-result')).toContainText('自動判定 · Markdown');await page.getByRole('button',{name:'変更',exact:true}).click();await page.getByRole('combobox',{name:'貼り付け形式'}).click();await page.getByRole('option',{name:'テキスト',exact:true}).click();
  await expect(page.locator('.input-format-result')).toContainText('手動指定 · テキスト');const toggle=page.getByRole('switch',{name:'音声も生成する'});await toggle.press('Space');await toggle.press('Space');await expect(text).toHaveValue(markdown);await expect(page.getByRole('combobox',{name:'貼り付け形式'})).toHaveValue('テキスト');
  await page.getByLabel('読み込むファイル').setInputFiles({name:'unsupported.png',mimeType:'image/png',buffer:Buffer.from('x')});await expect(page.getByRole('alert')).toContainText('MD・TXT・PDF・青空文庫HTML');await expect(text).toHaveValue(markdown);
  await page.getByRole('button',{name:'テキストのみ生成して読む',exact:true}).click();await expect(page.getByTestId('current-phrase')).toBeVisible();await page.getByRole('button',{name:'原文',exact:true}).click();await expect(page.getByLabel('元の入力',{exact:true})).toHaveValue(markdown);await expect(page.getByLabel('抽出した全文',{exact:true})).toHaveValue(markdown);
});

test('file extensions control text/Markdown and dedicated PDF survives generation toggles', async ({page}) => {
  await page.goto('/');const raw='# 原稿\n\n本文を読む。';
  for(const [extension,label] of [['txt','テキスト'],['md','Markdown']]) {await page.getByLabel('読み込むファイル').setInputFiles({name:`原稿.${extension}`,mimeType:'text/plain',buffer:Buffer.from(raw)});await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();await expect(page.locator('.input-format-result')).toContainText(`自動判定 · ${label}`);await expect(page.getByLabel('読む文章',{exact:true})).toHaveValue(raw);}
  await page.getByLabel('読み込むファイル').setInputFiles(new URL('../fixtures/japanese-text-layer.pdf',import.meta.url).pathname);await expect(page.locator('.input-format-result')).toContainText('自動判定 · PDF');await page.getByLabel('読み込むファイル').setInputFiles({name:'invalid.pdf',mimeType:'application/pdf',buffer:Buffer.from('invalid')});await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.input-format-result')).toContainText('PDF');const toggle=page.getByRole('switch',{name:'音声も生成する'});await toggle.press('Space');await toggle.press('Space');await expect(page.locator('.input-format-result')).toContainText('PDF');await page.getByRole('button',{name:'テキストのみ生成して読む',exact:true}).click();await expect(page.getByLabel('抽出した全文')).toHaveValue(/私は朝の図書館で本を読む。/);await expect(page.locator('.pdf-canvas canvas')).toBeVisible();
});

const audioSamples = [
  { label: 'VOICEVOX', key: 'voicevox' },
  { label: 'Gemini（男）', key: 'gemini-male' },
  { label: 'Gemini（女）', key: 'gemini-female' },
];
for (const sample of audioSamples) test(`音声サンプル ${sample.key} は1クリックで開き、戻る・連打でも生成しない`, async ({ page }, testInfo) => {
  let generationCalls = 0;
  page.on('request', request => { if (/\/api\/local-generation|\/_serverFn\//.test(request.url())) generationCalls++; });
  const open = page.getByRole('link', { name: `${sample.label}で読む`, exact: true });
  await page.goto('/');
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible();
  const group = page.getByRole('group', { name: '音声サンプルを開く' });
  await expect(group.getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('link', { name: '音声付きで読む', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (sample.key === 'voicevox') await page.locator('.home-samples').screenshot({ path: `docs/validation/audio-one-click-2026-10-07/${testInfo.project.name}-group.png` });
  await open.click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sample')).toBe(sample.key);
  await expect(page.getByTestId('audio-presentation-report')).toContainText('表示 96 / 96');
  await expect(page.locator('audio')).toHaveAttribute('src', /\/samples\/audio\//);
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await page.getByRole('button', { name: 'トップへ戻る', exact: true }).click();
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible();
  await expect(open).toBeVisible();
  await open.dblclick({ delay: 20 });
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sample')).toBe(sample.key);
  await page.goBack();
  await expect(group.getByRole('link')).toHaveCount(3);
  expect(generationCalls).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});

test('音声サンプルはTab・Shift+TabとEnterで3種類を直接開ける', async ({ page }) => {
  await page.goto('/');
  for (const [index, sample] of audioSamples.entries()) {
    const links = page.getByRole('group', { name: '音声サンプルを開く' }).getByRole('link');
    await expect(links).toHaveCount(3);
    await links.first().focus();
    for (let step = 0; step < index; step++) await page.keyboard.press('Tab');
    await expect(links.nth(index)).toBeFocused();
    if (index > 0) { await page.keyboard.press('Shift+Tab'); await expect(links.nth(index - 1)).toBeFocused(); await page.keyboard.press('Tab'); }
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('audio-stage')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('sample')).toBe(sample.key);
    await page.getByRole('button', { name: 'トップへ戻る', exact: true }).click();
  }
});

test('音声サンプル取得失敗から再確認でき、320pxでも1枠のまま直接開く', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/samples/audio/library/index.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '音声サンプルを再確認', exact: true })).toBeVisible();
  const group = page.getByRole('group', { name: '音声サンプルを開く' });
  await expect(group.getByRole('link')).toHaveCount(0);
  for (const button of await group.getByRole('button').all()) await expect(button).toBeDisabled();
  await page.unroute('**/samples/audio/library/index.json');
  await page.getByRole('button', { name: '音声サンプルを再確認', exact: true }).click();
  await expect(group.getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '音声サンプルを再確認', exact: true })).toHaveCount(0);
  expect(await page.locator('.home-audio-demo').count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await group.getByRole('link', { name: 'Gemini（女）で読む', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
});
