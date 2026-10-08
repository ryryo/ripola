import { expect, test } from '@playwright/test';

test('青空文庫全文のルビ・仮想文一覧・章移動・保存設定', async ({ page, context, baseURL }, testInfo) => {
  testInfo.setTimeout(90_000);
  const mobile = testInfo.project.name.includes('mobile'); const failures: string[] = []; const external: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  context.on('request', request => { if (!request.url().startsWith(baseURL!) && !request.url().startsWith('data:')) external.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: '全文で読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toContainText('吾輩');
  await expect(page.locator('.phrase rt')).toHaveText('わがはい');
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('400');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const toggle = page.getByRole('button', { name: '文一覧を開く', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
  await toggle.click();
  if (mobile) await expect(page.getByRole('dialog')).toBeVisible();
  else {
    await expect(page.getByRole('button', { name: '文一覧を閉じる', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '文一覧を閉じる', exact: true }).click();
    await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.getByTestId('sentence-count')).toContainText('/ 9151 文');
  expect(await page.locator('.sentence-row').count()).toBeLessThanOrEqual(13);
  await page.getByLabel('移動する文番号', { exact: true }).fill('3'); await page.getByRole('button', { name: '移動', exact: true }).click();
  if (mobile) { await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('button', { name: '文一覧を開く', exact: true })).toBeFocused(); }
  await expect(page.getByTestId('current-phrase')).toContainText('どこで');
  if (mobile) await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await expect(page.locator('.sentence-row[aria-current="location"]')).toContainText('どこで生れたかとんと見当がつかぬ。');
  const chapter = page.getByLabel('章から移動', { exact: true });
  await expect(chapter.locator('option')).toHaveCount(12); await chapter.selectOption({ label: '第十一章' });
  if (mobile) await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await page.getByLabel('移動する文番号', { exact: true }).fill('9151'); await page.getByRole('button', { name: '移動', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await expect(page.locator('.sentence-row[aria-current="location"]')).toContainText('ありがたいありがたい。');
  expect(await page.locator('.sentence-row').count()).toBeLessThanOrEqual(13);
  if (mobile) await page.getByRole('button', { name: '文一覧を閉じる', exact: true }).click();
  await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('800');
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('本文・現在位置・設定');
  await page.reload(); await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByLabel('読む速さ（字/分）', { exact: true })).toHaveValue('800');
  await expect(page.getByTestId('current-phrase')).toContainText('ありがたい');
  await page.getByText('作品の出典・ルビ・外字・入力者注', { exact: true }).click();
  await expect(page.locator('.aozora-provenance')).toContainText('9,214件'); await expect(page.locator('.aozora-provenance')).toContainText('36件');
  await expect(page.locator('.aozora-provenance')).toContainText('入力者注6件'); await expect(page.locator('.aozora-provenance')).toContainText('柴田卓治');
  await page.getByText('保存した外字と入力者注（42件）', { exact: true }).click();
  await expect(page.locator('.aozora-provenance')).toContainText('外字：');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(external).toEqual([]); expect(failures).toEqual([]);
});

test('実保存ずんだもん冒頭3文は9フレーズ・ルビ・2.5倍で読み、文移動で止まる', async ({ page }, testInfo) => {
  test.skip(process.env.RSVP_TEST_AOZORA_AUDIO !== '1', '許可済みの保存音声だけを使う明示的なローカル検証です。');
  const mobile = testInfo.project.name.includes('mobile');
  await page.goto('/library?book=book-10ad8cbcdc778f11f2a4f41d&revision=6ec1ceb996c46bdc56a7824d8b0502061c19aad2c8597741306912f439a83284');
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true }); await position.fill('0.3');
  await expect(page.locator('[data-testid="audio-phrase"] rt')).toHaveText('わがはい');
  await expect(page.getByTestId('audio-precision')).toHaveAttribute('data-method', 'voicevox-mora');
  await expect(page.getByTestId('audio-precision')).toContainText('合成時に保存');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(2.5);
  const phrases: string[] = [];
  const expected = ['吾輩', '猫である', '名前は', 'まだ', '無い', 'どこで', '生れたかとんと', '見当', 'つかぬ'];
  for (let index = 0; index < 9; index++) {
    if (index > 0) await page.getByRole('button', { name: '次のフレーズ', exact: true }).click();
    await expect(page.getByTestId('audio-phrase')).toBeVisible();
    await expect(page.getByTestId('audio-phrase')).toContainText(expected[index]);
    phrases.push(await page.getByTestId('audio-phrase').evaluate(element => [...element.childNodes].map(node => node.textContent).join('')));
    await expect(page.getByTestId('audio-precision')).toHaveAttribute('data-method', 'voicevox-mora');
    expect(await page.getByTestId('audio-precision').getAttribute('data-score')).toBeNull();
  }
  expect(phrases).toEqual(['吾輩わがはいは', '猫である。', '名前は', 'まだ', '無い。', 'どこで', '生れたかとんと', '見当けんとうが', 'つかぬ。']);
  const toggle = page.getByRole('button', { name: '文一覧を開く', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
  await toggle.click();
  await page.getByLabel('移動する文番号', { exact: true }).fill('1'); await page.getByRole('button', { name: '移動', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await expect(page.getByTestId('audio-stage')).toContainText('1 / 3 文');
  if (mobile) {
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(toggle).toBeFocused();
    await toggle.click();
  } else {
    await expect(page.getByRole('button', { name: '文一覧を閉じる', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '次のフレーズ', exact: true }).click();
    await expect(page.getByTestId('sentence-list')).toBeVisible();
  }
  await page.getByRole('button', { name: '文一覧を閉じる', exact: true }).click();
  await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

// Opening a different reading starts collapsed; movement and rerenders keep an explicit open state.
test('文一覧は初期状態で閉じ、開閉と文移動を保ち、別の読書は閉じて開始する', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.includes('mobile');
  await page.goto('/');
  await page.getByRole('button', { name: 'テキストで読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  const toggle = page.getByRole('button', { name: '文一覧を開く', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('sentence-list')).toBeVisible();
  await page.getByRole('button', { name: '文一覧を閉じる', exact: true }).click();
  await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  if (mobile) {
    await page.getByRole('button', { name: '次の文へ移動', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(toggle).toBeFocused();
  } else {
    await page.getByRole('button', { name: '次の文へ移動', exact: true }).click();
    await expect(page.getByTestId('sentence-list')).toBeVisible();
    await page.getByLabel('読む速さ（字/分）', { exact: true }).fill('600');
    await expect(page.getByRole('button', { name: '文一覧を閉じる', exact: true })).toHaveAttribute('aria-expanded', 'true');
  }
  await page.getByRole('button', { name: '別の文章を開く', exact: true }).click();
  await page.getByLabel('読む文章', { exact: true }).fill('新しい読書を始める。次の文を読む。');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toContainText('新しい');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sentence-list')).toHaveCount(0);
});
