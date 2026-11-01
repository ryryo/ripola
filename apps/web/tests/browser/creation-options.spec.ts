import { expect, test } from '@playwright/test';
import { audioDemoHref } from '../../src/reader/audio-demo';
import { createHash } from 'node:crypto';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';

test('テキスト本の位置は自動保存され再読込と別冊からの復帰でも本ごとに復元する', async ({ page }) => {
  const document = await prepareDocument(importText('最初の文章を読みます。次の文章に進みます。最後の文章も読みます。', 'txt', '位置保存の検証'));
  const revision = document.contentHash;
  const books = ['text-a', 'text-b'].map(id => {
    const manifest = { schemaVersion: 1, kind: 'text', id, revision, title: document.title, document, updatedAt: '2026-11-01T00:00:00Z', chunks: [], completedChunks: 0, totalChunks: 0, durationSeconds: 0, precision: 'sentence', attribution: '自作', warnings: [] };
    const body = JSON.stringify(manifest);
    return { body, entry: { kind: 'text', id, revision, title: document.title, manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(body).digest('hex'), manifestBytes: Buffer.byteLength(body), durationSeconds: 0, precision: 'sentence', attribution: '自作', publicDemo: false, totalCharacters: document.totalCharacters } };
  });
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', audience: 'personal', createdAt: '2026-11-01', books: books.map(book => book.entry) } }));
  for (const book of books) await page.route(`**/${book.entry.manifestUrl}`, route => route.fulfill({ contentType: 'application/json', body: book.body }));
  const href = (id: string) => `/books?book=${id}&revision=${revision}`;
  const stage = page.getByTestId('reader-stage');
  await page.goto(href('text-a'));
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await expect(stage).toHaveAttribute('data-unit-index', '2');
  await page.reload(); await expect(stage).toHaveAttribute('data-unit-index', '2');
  await page.goto(href('text-b')); await expect(stage).toHaveAttribute('data-unit-index', '0');
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await page.goto(href('text-a')); await expect(stage).toHaveAttribute('data-unit-index', '2');
  await page.goto(href('text-b')); await expect(stage).toHaveAttribute('data-unit-index', '1');
});

test('本文とURLの入力欄は独立し、対応先とエラーを表示してBackでも両方を保持する', async ({ page }) => {
  await page.goto('/');
  const text = page.getByRole('textbox', { name: '読む文章', exact: true });
  const url = page.getByRole('textbox', { name: 'URL', exact: true });
  const manuscript = '入力した文章を保持します。URLは別の欄にあります。';
  const workUrl = 'https://kakuyomu.jp/works/16816927863114551346';
  await expect(text).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('対応URL：カクヨムの作品トップ、青空文庫の図書カード・本文HTML、noteの無料記事', { exact: true })).toBeVisible();
  await text.fill(manuscript);
  await url.fill('https://note.com/example/n/example');
  await page.getByRole('button', { name: 'URLから読み込む', exact: true }).click();
  await expect(url).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('カクヨムの作品トップ、青空文庫の図書カード・本文HTML、noteの記事のURLを入力してください。', { exact: true })).toBeVisible();
  await expect(text).toHaveValue(manuscript);
  await url.fill(workUrl);
  await expect(url).not.toHaveAttribute('aria-invalid', 'true');
  await text.fill(manuscript + '追記します。');
  await expect(url).toHaveValue(workUrl);
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.goBack();
  await expect(text).toHaveValue(manuscript + '追記します。');
  await expect(url).toHaveValue(workUrl);
});

test('本文に貼ったURLはページを取得せず本文として読み、URL欄は空のままにする', async ({ page }) => {
  await page.goto('/');
  const workUrl = 'https://kakuyomu.jp/works/16816927863114551346';
  await page.getByRole('textbox', { name: '読む文章', exact: true }).fill(workUrl);
  await expect(page.getByRole('textbox', { name: 'URL', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'URLから読み込む', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('元の入力', { exact: true })).toHaveValue(workUrl);
});

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
  await page.getByRole('button',{name:'テキストのみ生成して読む',exact:true}).click();await expect(page.getByTestId('current-phrase')).toBeVisible();await page.getByRole('button',{name:'本の操作',exact:true}).click();await page.getByRole('button',{name:'原文',exact:true}).click();await expect(page.getByLabel('元の入力',{exact:true})).toHaveValue(markdown);await expect(page.getByLabel('抽出した全文',{exact:true})).toHaveValue(markdown);
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
  { label: 'Irodori（男）', key: 'irodori-male' },
  { label: 'Irodori（女）', key: 'irodori-female' },
] as const;
for (const sample of audioSamples) test(sample.key.startsWith('irodori-') ? `非表示の音声サンプル ${sample.key} は保存済みURLから再生でき、生成しない` : `音声サンプル ${sample.key} は1クリックで開き、戻る・連打でも生成しない`, async ({ page }, testInfo) => {
  let generationCalls = 0;
  page.on('request', request => { if (/\/api\/local-generation/.test(request.url()) || /\/_serverFn\//.test(request.url()) && request.method() === 'POST') generationCalls++; });
  const open = page.getByRole('link', { name: `${sample.label}で読む`, exact: true });
  await page.goto('/');
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible();
  const group = page.getByRole('group', { name: '音声サンプルを開く' });
  await expect(group.getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('link', { name: '音声付きで読む', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  const hidden = sample.key.startsWith('irodori-');
  const href = audioDemoHref(sample.key, 'local', '/');
  if (hidden) await expect(open).toHaveCount(0);
  else expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (sample.key === 'voicevox') await page.locator('.home-samples').screenshot({ path: `docs/validation/audio-one-click-2026-10-07/${testInfo.project.name}-group.png` });
  if (hidden) await page.goto(href); else await open.click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sample')).toBe(sample.key);
  await expect(page.getByTestId('audio-presentation-report')).toHaveCount(0);
  await expect(page.locator('audio')).toHaveAttribute('src', /\/samples\/audio\//);
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await page.getByRole('button', { name: 'トップへ戻る', exact: true }).click();
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible();
  if (hidden) { await expect(open).toHaveCount(0); await page.goto(href); }
  else { await expect(open).toBeVisible(); await open.dblclick({ delay: 20 }); }
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sample')).toBe(sample.key);
  await page.goBack();
  await expect(group.getByRole('link')).toHaveCount(3);
  expect(generationCalls).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});

test('音声サンプルはTab・Shift+TabとEnterで3種類を直接開ける', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  for (const [index, sample] of audioSamples.filter(sample => !sample.key.startsWith('irodori-')).entries()) {
    await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible({ timeout: 30_000 });
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
  await expect(group.getByRole('link', { name: /Irodori/ })).toHaveCount(0);
  await group.getByRole('link', { name: 'Gemini（女）で読む', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
});
