import { expect, test } from '@playwright/test';

test.afterEach(async ({page}) => { await page.unrouteAll({behavior: 'wait'}); });

test('無料生成の確認・停止再開・保存再利用と音声時計による同期', async ({ page, context, baseURL }, testInfo) => {
  test.skip(process.env.RSVP_TEST_VOICEVOX !== '1', '起動中のローカルVOICEVOXを使う明示的な検証です。');
  testInfo.setTimeout(90_000);
  const external: string[] = [];
  const errors: string[] = [];
  context.on('request', request => { if (!request.url().startsWith(baseURL!) && !request.url().startsWith('data:')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const mobile = testInfo.project.name.includes('mobile');
  const color = mobile ? '青い' : '赤い';
  const manuscript = `今朝は窓を開けて、静かな風の音を聞きながら一冊の本を選びました。机の上に置いた${color}ノートには、昨日見つけた言葉が丁寧に書かれています。今日は急がず、一文ずつ声を聞いてから原文を確かめて読み進めます。`;
  await page.goto('/generate');
  await expect(page.getByRole('heading', { name: '文章を、音声に。' })).toBeVisible();
  await page.getByLabel('タイトル', { exact: true }).fill(`音声UI検証 ${mobile ? 'スマホ' : 'PC'}`);
  await page.getByLabel('原稿を貼り付け', { exact: true }).fill(manuscript);
  await page.getByRole('button', { name: '本文を確認する', exact: true }).click();
  await expect(page.getByText(/抽出した本文を確認して/)).toBeVisible();
  await page.getByLabel('読み辞書', { exact: true }).fill('窓=マド');
  await page.getByRole('button', { name: '生成計画を確認する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '4. 開始前に確認' })).toBeVisible();
  await expect(page.locator('.generation-confirm')).toContainText('VOICEVOX · このPC');
  await expect(page.locator('.generation-confirm')).toContainText('127.0.0.1:50021');
  await page.getByText(/正確な送信本文を確認/).click();
  const sending = await page.locator('.generation-confirm pre').innerText();
  if (sending) {
    const spokenSentences = manuscript.replaceAll('窓', 'マド').split('。').filter(Boolean).map(text => `${text}。`);
    for (const line of sending.split('\n').filter(line => line.trim())) expect(spokenSentences).toContain(line.trim());
  }
  else await expect(page.locator('.generation-confirm')).toContainText('保存音声の再利用 3文');
  await expect(page.locator('.generation-confirm')).toContainText('無料');
  await page.screenshot({ path: `docs/validation/screenshots/generation-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  await page.getByRole('button', { name: '確認した対象を無料生成する', exact: true }).click();
  await expect(page.locator('.generation-job-heading')).toBeVisible();
  const stop = page.getByRole('button', { name: 'ここで停止する', exact: true });
  if (await stop.isVisible()) {
    await stop.click();
    await expect(page.locator('.generation-job-heading')).toContainText(/停止済み|完了/, { timeout: 30_000 });
    const resume = page.getByRole('button', { name: '保存済み音声を使って未完了分を再開', exact: true });
    if (await resume.isVisible()) await resume.click();
  }
  await expect(page.locator('.generation-job-heading')).toContainText('完了', { timeout: 60_000 });
  await expect(page.locator('.generation-job-heading')).toContainText('3 / 3文');
  await page.getByRole('link', { name: '保存音声を読む', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await expect(page.getByTestId('audio-stage')).toContainText('1 / 3 文');
  await expect(page.getByText('文内のフレーズ時刻は未検証です。', { exact: false })).toBeVisible();
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  await expect(page.getByTestId('audio-sentence')).not.toHaveText(manuscript.split('。')[0] + '。');
  await expect(page.getByTestId('audio-presentation-report')).toContainText('欠落 0');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime), { intervals: [50] }).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const paused = await page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime);
  await page.waitForTimeout(300);
  expect(await page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(paused, 1);
  await page.getByRole('button', { name: '次の文', exact: true }).click();
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  await expect(page.getByTestId('audio-stage')).toContainText('2 / 3 文');
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '1.5倍', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.screenshot({ path: `docs/validation/screenshots/audio-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  const source = await page.getByTestId('audio-sentence').innerText();
  await page.reload();
  await expect(page.getByTestId('audio-sentence')).toHaveText(source);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(manuscript);
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('有料モデルはLite既定・Flashだけ、Gatewayはサーバー未設定なら無効', async ({ page }) => {
  await availableAudio(page);
  await page.goto('/generate');
  await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
  await page.getByRole('option', { name: '有料 · Gemini', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Geminiモデル', exact: true })).toHaveValue('Flash-Lite · 既定');
  await page.getByRole('combobox', { name: 'Geminiモデル', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.getByRole('option', { name: 'Flash', exact: true }).click();
  await page.getByRole('combobox', { name: '接続経路', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Cloudflare · AI Gateway', exact: true })).toHaveAttribute('data-combobox-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '確認した対象を有料生成する', exact: true })).toHaveCount(0);
});

function rpcName(url: string): string {
  const id = new URL(url).pathname.split('/_serverFn/')[1];
  if (!id) return '';
  try { return String((JSON.parse(Buffer.from(id, 'base64url').toString()) as {export: string}).export); } catch { return ''; }
}

// The server function transport is serialized. Change availability only, never
// credentials or synthesis: these tests stop at the review screen.
function encodedProperty(node: unknown, name: string): unknown {
  if (!node || typeof node !== 'object' || !('p' in node)) return undefined;
  const properties = (node as {p: {k: string[]; v: unknown[]}}).p;
  return properties?.v[properties.k.indexOf(name)];
}
async function availableAudio(page: import('@playwright/test').Page, gateway = false, direct = true) {
  await page.route('**/_serverFn/**', async route => {
    const name = rpcName(route.request().url());
    if (/^(startGeneration|resumeJob)/.test(name)) return route.abort();
    if (!name.startsWith('getGenerationConfig') && !name.startsWith('prepareGeneration')) return route.continue();
    const response = await route.fetch();
    const body: unknown = await response.json();
    const result = encodedProperty(body, 'result');
    if (name.startsWith('getGenerationConfig')) {
      const enable = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        const id = encodedProperty(node, 'id');
        if (id && typeof id === 'object' && 's' in id && (id.s === 'gateway' || id.s === 'direct')) {
          const available = encodedProperty(node, 'available');
          if (available && typeof available === 'object') Object.assign(available, {t: 2, s: id.s === 'gateway' ? gateway ? 2 : 1 : direct ? 2 : 1});
          const message = encodedProperty(node, 'message');
          if (message && typeof message === 'object') Object.assign(message, { t: 1, s: 'UI検証用の設定です。実生成は行いません。' });
        }
        for (const value of Object.values(node)) enable(value);
      };
      enable(result);
    }
    if (name.startsWith('getGenerationConfig')) {
      for (const provider of ['voicevox', 'gemini']) {
        const available = encodedProperty(encodedProperty(result, provider), 'available');
        if (available && typeof available === 'object') Object.assign(available, {t: 2, s: 2});
      }
    } else if (name.startsWith('prepareGeneration')) {
      const available = encodedProperty(result, 'available');
      if (available && typeof available === 'object') Object.assign(available, {t: 2, s: 2});
    }
    await route.fulfill({response, json: body});
  });
}

test('トップの展開を往復しても原稿・形式・読みを保持し、テキストのみでは音声生成しない', async ({page}) => {
  const calls: string[] = [];
  page.on('request', request => { const name=rpcName(request.url()); if(name) calls.push(name); });
  await availableAudio(page);
  await page.goto('/');
  await page.getByLabel('タイトル', {exact:true}).fill('同じ原稿');
  await page.getByLabel('読む文章', {exact:true}).fill('朝の図書館は静かです。');
  await page.getByRole('button', {name:'変更', exact:true}).click();
  await page.getByRole('combobox', {name:'貼り付け形式'}).click();
  await page.getByRole('option', {name:'テキスト', exact:true}).click();
  const toggle=page.getByRole('switch', {name:'音声も生成する'});
  await expect(toggle).not.toBeChecked();
  // Home may read the saved demo catalog; it must not configure or start TTS.
  expect(calls.filter(name => !name.startsWith('listLibrary'))).toEqual([]);
  await toggle.press('Space');
  await expect(page.getByRole('combobox', {name:'生成方法'})).toBeVisible();
  await page.getByText('読みを調整する（任意）', {exact:true}).click();
  await page.getByLabel('読み辞書', {exact:true}).fill('図書館=トショカン');
  await toggle.press('Space');
  await expect(page.getByRole('combobox', {name:'生成方法'})).toHaveCount(0);
  await expect(page.getByLabel('タイトル', {exact:true})).toHaveValue('同じ原稿');
  await expect(page.getByLabel('読む文章', {exact:true})).toHaveValue('朝の図書館は静かです。');
  await expect(page.getByRole('combobox', {name:'貼り付け形式'})).toHaveValue('テキスト');
  await page.locator('.audio-disclosure .mantine-Switch-track').click();
  await page.getByText('読みを調整する（任意）', {exact:false}).click();
  await expect(page.getByLabel('読み辞書', {exact:true})).toHaveValue('図書館=トショカン');
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await expect(page.locator('.document-heading h1')).toHaveText('同じ原稿');
  expect(calls.some(name=>name.startsWith('prepareGeneration')||name.startsWith('startGeneration'))).toBe(false);
});

test('トップの有料生成は送信内容・費用の確認を要求し、原稿変更で古い計画を破棄', async ({page}) => {
  const starts: string[]=[];
  page.on('request', request=>{if(rpcName(request.url()).startsWith('startGeneration'))starts.push(request.url());});
  await availableAudio(page);
  await page.goto('/');
  await page.getByLabel('読む文章', {exact:true}).fill('朝の図書館は静かです。窓辺で本を開きました。');
  await page.getByRole('switch', {name:'音声も生成する'}).press('Space');
  await page.getByRole('combobox', {name:'生成方法'}).click();
  await page.getByRole('option', {name:'有料 · Gemini',exact:true}).click();
  await expect(page.getByText('本文をGoogleに送信します。', {exact:false})).toBeVisible();
  await page.getByRole('button', {name:'生成内容を確認する',exact:true}).click();
  await expect(page.getByRole('heading', {name:'開始前に確認',exact:true})).toBeVisible();
  const confirmation=page.locator('.generation-confirm');
  await expect(confirmation).toContainText('Google');
  await expect(confirmation).toContainText('概算費用');
  await confirmation.locator('summary').click();
  await expect(confirmation.locator('pre')).toContainText('朝の図書館は静かです。');
  const start=page.getByRole('button', {name:'確認した対象を有料生成する',exact:true});
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox', {name:'対象、選択した接続先への送信本文と概算費用を確認し、有料生成を開始します。'}).check();
  await expect(start).toBeEnabled();
  await page.getByLabel('読む文章', {exact:true}).fill('変更後の文章だけを読む。');
  await expect(confirmation).toHaveCount(0);
  await page.getByRole('button', {name:'生成内容を確認する',exact:true}).click();
  await expect(confirmation).toBeVisible();
  await expect(start).toBeDisabled();
  expect(starts).toEqual([]);
});

test('音声接続を取得できなくてもトップでテキストのみを生成できる', async ({page}) => {
  await page.route('**/_serverFn/**', route => rpcName(route.request().url()).startsWith('getGenerationConfig') ? route.abort() : route.continue());
  await page.goto('/');
  await page.getByLabel('読む文章', {exact:true}).fill('音声なしでも読む。');
  await page.getByRole('switch', {name:'音声も生成する'}).press('Space');
  await expect(page.getByRole('button', {name:'生成内容を確認する',exact:true})).toBeDisabled();
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
});

test('音声用に取り込んだPDFはスイッチOFF後も同じ本文と元ページで読める', async ({page}) => {
  await page.goto('/');
  await page.getByRole('switch', {name:'音声も生成する'}).press('Space');
  await page.getByLabel('読み込むファイル').setInputFiles(new URL('../fixtures/japanese-text-layer.pdf', import.meta.url).pathname);
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  await expect(page.getByTestId('current-phrase')).toHaveCount(0);
  await page.getByRole('switch', {name:'音声も生成する'}).press('Space');
  await page.getByRole('button', {name:'テキストのみ生成して読む',exact:true}).click();
  await expect(page.getByLabel('抽出した全文')).toHaveValue(/私は朝の図書館で本を読む。/);
  await expect(page.locator('.pdf-canvas canvas')).toBeVisible();
});

test('初期OFFで取り込んだファイルから、同じ原稿のまま音声確認へ進める', async ({page}) => {
  await availableAudio(page);
  await page.goto('/');
  const text='同じ原稿に音声を付けます。次の文も読みます。';
  await page.getByLabel('読み込むファイル').setInputFiles({name:'共通原稿.txt',mimeType:'text/plain',buffer:Buffer.from(text)});
  await expect(page.getByText(/取り込んだ本文を確認/)).toBeVisible();
  await expect(page.getByTestId('current-phrase')).toHaveCount(0);
  await expect(page.getByLabel('読む文章', {exact:true})).toHaveValue(text);
  await page.getByRole('switch', {name:'音声も生成する'}).press('Space');
  await page.getByRole('combobox', {name:'生成方法'}).click();
  await page.getByRole('option', {name:'有料 · Gemini',exact:true}).click();
  await page.getByRole('button', {name:'生成内容を確認する',exact:true}).click();
  await expect(page.locator('.generation-confirm')).toBeVisible();
  await page.locator('.generation-confirm summary').click();
  await expect(page.locator('.generation-confirm pre')).toContainText('同じ原稿に音声を付けます。');
  await expect(page.getByLabel('タイトル', {exact:true})).toHaveValue('共通原稿.txt');
});


test('設定されたGatewayは明示選択し、接続先と本文を確認しても課金を開始しない', async ({page}) => {
  const calls: string[] = [];
  page.on('request', request => { const name = rpcName(request.url()); if (name) calls.push(name); });
  await availableAudio(page, true);
  await page.goto('/generate');
  await page.getByRole('combobox', {name: '生成手段', exact: true}).click();
  await page.getByRole('option', {name: '有料 · Gemini', exact: true}).click();
  await expect(page.getByRole('combobox', {name: '接続経路', exact: true})).toHaveValue('Gemini直結 · Google課金');
  await page.getByRole('combobox', {name: '接続経路', exact: true}).click();
  await page.getByRole('option', {name: 'Cloudflare · AI Gateway', exact: true}).click();
  await expect(page.getByText(/Wranglerの既存ログインを使います/)).toBeVisible();
  await page.getByLabel('原稿を貼り付け', {exact: true}).fill('朝の図書館は静かです。');
  await page.getByRole('button', {name: '本文を確認する', exact: true}).click();
  await page.getByRole('button', {name: '生成計画を確認する', exact: true}).click();
  await expect(page.locator('.generation-confirm')).toContainText('Cloudflare Workers AI binding');
  const start = page.getByRole('button', {name: '確認した対象を有料生成する', exact: true});
  await expect(start).toBeDisabled();
  await expect(page.getByRole('checkbox', {name: /選択した接続先への送信本文/})).not.toBeChecked();
  await page.getByRole('combobox', {name: '接続経路', exact: true}).click();
  await page.getByRole('option', {name: 'Gemini直結 · Google課金', exact: true}).click();
  await expect(page.locator('.generation-confirm')).toHaveCount(0);
  expect(calls.some(name => name.startsWith('startGeneration'))).toBe(false);
});

test('C shows checked time, unavailable and recheck without generating or switching paid', async ({page}, testInfo) => {
  let configCalls=0;const starts:string[]=[];
  await page.route('**/_serverFn/**', async route => {
    const name=rpcName(route.request().url());if(name.startsWith('startGeneration')||name.startsWith('resumeJob')){starts.push(name);return route.abort();}if(!name.startsWith('getGenerationConfig'))return route.continue();
    configCalls++;const response=await route.fetch();const body:unknown=await response.json();const available=encodedProperty(encodedProperty(encodedProperty(body,'result'),'voicevox'),'available');if(available&&typeof available==='object')Object.assign(available,{t:2,s:configCalls===1?2:1});await route.fulfill({response,json:body});
  });
  await page.goto('/');await page.getByLabel('読む文章',{exact:true}).fill('原稿は残ります。');await page.getByRole('switch',{name:'音声も生成する'}).press('Space');const status=page.getByRole('region',{name:'音声生成の利用状態'});
  await expect(status).toContainText('最終確認：VOICEVOXに接続あり');await expect(status.locator('time')).toHaveAttribute('datetime',/T/);await status.screenshot({path:`docs/validation/wrangler-binding-2026-10-07/local-${testInfo.project.name}-connected-mock.png`});await page.getByRole('button',{name:'接続を再確認',exact:true}).click();await expect(status).toContainText('最終確認：VOICEVOX未接続');await status.screenshot({path:`docs/validation/wrangler-binding-2026-10-07/local-${testInfo.project.name}-unavailable.png`});await expect(page.getByRole('button',{name:'生成内容を確認する',exact:true})).toBeDisabled();await expect(page.getByRole('combobox',{name:'声・スタイル',exact:true})).toBeDisabled();await expect(page.getByRole('combobox',{name:'生成方法',exact:true})).toHaveValue('無料 · VOICEVOX');await expect(page.getByLabel('読む文章',{exact:true})).toHaveValue('原稿は残ります。');await expect(page.getByRole('button',{name:'テキストで読む',exact:true})).toBeEnabled();expect(starts).toEqual([]);
});

test('C ignores an older delayed configuration after closing and reopening audio settings', async ({page}) => {
  let calls=0;let release:(()=>void)|undefined;const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/_serverFn/**',async route=>{
    if(!rpcName(route.request().url()).startsWith('getGenerationConfig'))return route.continue();const first=++calls===1;const response=await route.fetch();const body:unknown=await response.json();const available=encodedProperty(encodedProperty(encodedProperty(body,'result'),'voicevox'),'available');if(available&&typeof available==='object')Object.assign(available,{t:2,s:first?2:1});if(first)await held;await route.fulfill({response,json:body});
  });
  try {await page.goto('/');const toggle=page.getByRole('switch',{name:'音声も生成する'});await toggle.press('Space');const status=page.getByRole('region',{name:'音声生成の利用状態'});await expect(status).toContainText('確認中…');await expect(page.getByRole('button',{name:'接続を再確認',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'生成内容を確認する',exact:true})).toBeDisabled();await toggle.press('Space');await toggle.press('Space');await expect(status).toContainText('最終確認：VOICEVOX未接続');release!();await page.unrouteAll({behavior:'wait'});await expect(status).toContainText('最終確認：VOICEVOX未接続');}
  finally {release!();}
});


test('mock Cloudflare availability enables explicit credit selection and requires paid review', async ({page}, testInfo) => {
  const starts: string[] = [];
  page.on('request', request => {if (rpcName(request.url()).startsWith('startGeneration')) starts.push(request.url());});
  await availableAudio(page, true, false);
  await page.goto('/');
  await page.getByLabel('読む文章', {exact: true}).fill('朝の図書館で本を開きます。');
  await page.getByRole('switch', {name: '音声も生成する'}).press('Space');
  await page.getByRole('combobox', {name: '生成方法'}).click();
  await page.getByRole('option', {name: '有料 · Gemini', exact: true}).click();
  await expect(page.getByRole('button', {name: '生成内容を確認する', exact: true})).toBeDisabled();
  await page.getByRole('combobox', {name: '接続経路', exact: true}).click();
  await expect(page.getByRole('option', {name: 'Gemini直結 · Google課金', exact: true})).toHaveAttribute('data-combobox-disabled', 'true');
  await page.getByRole('option', {name: 'Cloudflare · AI Gateway', exact: true}).click();
  await expect(page.getByRole('combobox', {name: '声・スタイル', exact: true})).toBeEnabled();
  await expect(page.getByText('Cloudflare経路は読み上げ方の指示に未対応です。', {exact: false})).toBeVisible();
  await page.getByRole('button', {name: '生成内容を確認する', exact: true}).click();
  await expect(page.locator('.generation-confirm')).toContainText('Cloudflare Gatewayの設定に従います');
  await expect(page.locator('.generation-confirm')).toContainText('Cloudflare Workers AI binding');
  const start = page.getByRole('button', {name: '確認した対象を有料生成する', exact: true});
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox', {name: /選択した接続先への送信本文/}).check();
  await expect(start).toBeEnabled();
  await page.locator('.generation-confirm').screenshot({path: `docs/validation/wrangler-binding-2026-10-07/credit-review-${testInfo.project.name}.png`});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(starts).toEqual([]);
});

test('Direct style is retained across Cloudflare selection and excluded from its plan', async ({page}) => {
  await availableAudio(page, true);
  await page.goto('/generate');
  await page.getByRole('combobox', {name: '生成手段', exact: true}).click();
  await page.getByRole('option', {name: '有料 · Gemini', exact: true}).click();
  await page.getByLabel('読み上げ方の指示（任意）').fill('落ち着いた語りで');
  await page.getByRole('combobox', {name: '接続経路', exact: true}).click();
  await page.getByRole('option', {name: 'Cloudflare · AI Gateway', exact: true}).click();
  await expect(page.getByLabel('読み上げ方の指示（任意）')).toHaveCount(0);
  await page.getByLabel('原稿を貼り付け', {exact: true}).fill('窓辺で本を開きました。');
  await page.getByRole('button', {name: '本文を確認する', exact: true}).click();
  await page.getByRole('button', {name: '生成計画を確認する', exact: true}).click();
  await expect(page.locator('.generation-confirm')).toBeVisible();
  await expect(page.locator('.generation-confirm')).not.toContainText('落ち着いた語りで');
  await page.getByRole('combobox', {name: '接続経路', exact: true}).click();
  await page.getByRole('option', {name: 'Gemini直結 · Google課金', exact: true}).click();
  await expect(page.getByLabel('読み上げ方の指示（任意）')).toHaveValue('落ち着いた語りで');
  await expect(page.locator('.generation-confirm')).toHaveCount(0);
});


test('real Cloudflare state explains a missing Gateway without requesting a manual token', async ({page}, testInfo) => {
  const starts: string[] = [];
  page.on('request', request => {if (rpcName(request.url()).startsWith('startGeneration')) starts.push(request.url());});
  await page.goto('/generate');
  await page.getByRole('combobox', {name: '生成手段', exact: true}).click();
  await page.getByRole('option', {name: '有料 · Gemini', exact: true}).click();
  await expect(page.getByText(/Wranglerの既存ログインを利用します/)).toBeVisible();
  await expect(page.getByText(/手動tokenは不要|手動tokenは通常設定に不要/)).toBeVisible();
  await expect(page.getByText(/既存Gatewayの選択が未完了/)).toBeVisible();
  await page.getByRole('combobox', {name: '接続経路', exact: true}).click();
  await expect(page.getByRole('option', {name: 'Cloudflare · AI Gateway', exact: true})).toHaveAttribute('data-combobox-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.screenshot({path: `docs/validation/wrangler-normal-generation-2026-10-07/real-state-${testInfo.project.name}.png`, fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(starts).toEqual([]);
});


for (const state of ['ready', 'setup-required', 'failed'] as const) test(`音声補正の準備状態 ${state} を表示し、確認だけでは生成しない`, async ({ page }) => {
  const starts: string[] = [];
  await page.route('**/_serverFn/**', async route => {
    const name = rpcName(route.request().url());
    if (name.startsWith('startGeneration') || name.startsWith('resumeJob')) { starts.push(name); return route.abort(); }
    if (!name.startsWith('getGenerationConfig')) return route.continue();
    const response = await route.fetch(); const body: unknown = await response.json();
    const automatic = encodedProperty(encodedProperty(encodedProperty(body, 'result'), 'alignment'), 'automatic');
    const status = encodedProperty(automatic, 'status'), message = encodedProperty(automatic, 'message');
    if (status && typeof status === 'object') Object.assign(status, { s: state });
    if (message && typeof message === 'object') Object.assign(message, { s: state === 'ready' ? '保存後に自動補正します。' : 'pnpm setup:audio を実行してください。' });
    await route.fulfill({ response, json: body });
  });
  await page.goto('/'); await page.getByRole('switch', { name: '音声も生成する' }).press('Space');
  const status = page.getByTestId('alignment-setup-status');
  await expect(status).toContainText(state === 'ready' ? '音声補正：利用可能' : state === 'failed' ? '音声補正：準備の確認に失敗' : '音声補正：セットアップが必要');
  if (state !== 'ready') await expect(status).toContainText('pnpm setup:audio');
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(status).toContainText(state === 'ready' ? '利用可能' : state === 'failed' ? '準備の確認に失敗' : 'セットアップが必要');
  expect(starts).toEqual([]);
});

for (const route of ['/', '/generate']) test(`Gemini文字数費用は入力中に更新し、本文を送信しない ${route}`, async ({page}, testInfo) => {
  await availableAudio(page, true);
  const paid: string[] = [];
  const unexpected: string[] = [];
  page.on('request', request => { const name = rpcName(request.url()); if (/^(startGeneration|resumeJob)/.test(name)) paid.push(name); if(name && !/^(getGenerationConfig|listJobs)/.test(name)) unexpected.push(name); });
  await page.goto(route);
  const home = route === '/';
  const text = page.getByLabel(home ? '読む文章' : '原稿を貼り付け', {exact: true});
  await expect(text).toBeVisible();
  if(home) await page.getByRole('switch',{name:'音声も生成する'}).press('Space');
  await page.getByRole('combobox',{name:home ? '生成方法' : '生成手段',exact:true}).click();
  await page.getByRole('option',{name:'有料 · Gemini',exact:true}).click();
  const cost=page.getByTestId('gemini-cost-estimate');
  await text.fill('あ'.repeat(399)+'。');
  await expect(cost.getByTestId('cost-characters')).toHaveText('読み上げ 400文字');
  await expect(cost.getByTestId('cost-output')).toHaveText('$0.0090');
  await expect(cost).toContainText('音声 約1分00秒');
  await page.getByRole('combobox',{name:'Geminiモデル',exact:true}).click();
  await page.getByRole('option',{name:'Flash',exact:true}).click();
  await expect(cost.getByTestId('cost-output')).toHaveText('$0.0135');
  await cost.getByText('計算条件と料金',{exact:true}).click();
  await expect(cost).toContainText('400文字/分・25音声token/秒');
  await expect(cost).toContainText('再生速度を変えても生成費用は変わりません');
  await expect(page.getByRole('combobox',{name:'声・スタイル',exact:true})).toBeEnabled();
  await page.getByRole('combobox',{name:'接続経路',exact:true}).click();
  await expect(page.getByRole('option',{name:'Cloudflare · AI Gateway',exact:true})).not.toHaveAttribute('data-combobox-disabled','true');
  await page.getByRole('option',{name:'Cloudflare · AI Gateway',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'接続経路',exact:true})).toHaveValue('Cloudflare · AI Gateway');
  await expect(cost).toContainText('5%手数料は含みません');
  await expect(cost.getByTestId('cost-output')).toHaveText('$0.0135');
  await text.fill('<ruby>図書館<rt>としょかん</rt></ruby>で**本**を読む。\n\n```txt\nこれは音声生成しません。\n```');
  await expect(cost.getByTestId('cost-characters')).toHaveText('読み上げ 11文字');
  if(home) await page.locator('.home-advanced-row').filter({hasText:'読みを調整する'}).locator('summary').click();
  await page.getByLabel('読み辞書',{exact:true}).fill('本=ほん');
  await expect(cost.getByTestId('cost-characters')).toHaveText('読み上げ 12文字');
  await page.getByLabel('読み辞書',{exact:true}).fill('不正な行');
  await expect(cost).toContainText('「表記=読み」の形');
  await expect(cost.getByTestId('cost-output')).toHaveCount(0);
  await page.getByLabel('読み辞書',{exact:true}).fill('本=ほん');
  await expect(cost.getByTestId('cost-characters')).toHaveText('読み上げ 12文字');
  await text.fill('あ'.repeat(399)+'。');
  await expect(cost.getByTestId('cost-output')).toHaveText('$0.0135');
  await cost.getByText('計算条件と料金',{exact:true}).click();
  await page.screenshot({path:`docs/validation/gemini-cost-preview-2026-10-07/${home?'home':'generate'}-${testInfo.project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
  await page.getByRole('combobox',{name:home?'生成方法':'生成手段',exact:true}).click();
  await page.getByRole('option',{name:'無料 · VOICEVOX',exact:true}).click();
  await expect(cost).toHaveCount(0);
  expect(paid).toEqual([]); expect(unexpected).toEqual([]);
});
