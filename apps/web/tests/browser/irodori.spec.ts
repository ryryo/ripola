import { expect, test } from '@playwright/test';

function property(node: unknown, key: string): { s?: unknown } | undefined {
  if (!node || typeof node !== 'object' || !('p' in node)) return;
  const props = (node as { p: { k: string[]; v: Array<{ s?: unknown }> } }).p;
  return props.v[props.k.indexOf(key)];
}
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('Irodori未導入は容量と追加入口を示し通常利用では取得しない', async ({ page, context }, testInfo) => {
  const mutations: string[] = []; const downloads: string[] = []; const errors: string[] = [];
  await page.route('**/_serverFn/**', route => route.request().method() === 'POST' ? route.abort('blockedbyclient') : route.continue());
  context.on('request', request => {
    if (/huggingface\.co|hf\.co|xethub\.hf\.co/.test(request.url())) downloads.push(request.url());
    if (request.method() === 'POST' && request.url().includes('/_serverFn/')) {
      mutations.push('server function POST');
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/generate');
  await expect(page.getByRole('combobox', { name: '生成手段', exact: true })).toHaveValue('無料 · VOICEVOX');
  await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
  await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true });
  await expect(panel).toContainText('未導入'); await expect(panel).toContainText('約1.92GB'); await expect(panel).toContainText('約2.2GB');
  await expect(panel).toContainText('固定voiceが別途必要'); await expect(panel).toContainText('製品voiceを同梱していません');
  await expect(panel.getByRole('button', { name: 'Irodoriを追加する（約1.92GB）', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成計画を確認する', exact: true })).toBeDisabled();
  await panel.getByText('合成設定・取得資材の詳細', { exact: true }).click();
  await expect(panel).toContainText('減らしてもモデルの保存容量は減りません');
  await page.screenshot({ path: `docs/validation/screenshots/irodori-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(mutations).toEqual([]); expect(downloads).toEqual([]); expect(errors).toEqual([]);
});

test('Irodori導入UIはmock進捗・取消し・検証・失敗再開を表示する', async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  let phase = 'not-installed', bytes = 0, template = ''; const actions: string[] = [];
  let expectedAction: 'install' | 'cancel' | 'stop' | undefined;
  let runtime = 'stopped';
  let releaseInstall: () => void = () => undefined;
  const installationReply = new Promise<void>(resolve => { releaseInstall = resolve; });
  await page.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') {
      // Never forward any mutation, including unknown production RPC IDs, to the PC.
      if (!expectedAction || !template) { await route.abort('blockedbyclient'); throw new Error('Unexpected mutation in Irodori UI fixture'); }
      // Never forward the download mutation to the PC. Reuse only the successful RPC envelope.
      const action = expectedAction; expectedAction = undefined;
      actions.push(action);
      if (action === 'stop') runtime = 'stopped';
      else { phase = action === 'cancel' ? 'cancelled' : actions.length === 1 ? 'downloading' : 'verifying'; bytes = phase === 'verifying' ? 1_920_321_792 : 960_000_000; }
      if (actions.length === 1) await installationReply;
      await route.fulfill({ status: 200, contentType: 'application/json', body: template }); return;
    }
    const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
    if (!property(result, 'downloadedBytes') || !property(result, 'totalBytes')) { await route.fulfill({ response }); return; }
    for (const [key, value] of Object.entries({ phase, runtime, downloadedBytes: bytes, message: phase === 'failed' ? '通信が中断しました。再開できます。' : 'mock導入状態の検査です。' })) {
      const field = property(result, key); if (field) field.s = value;
    }
    template = JSON.stringify(body); await route.fulfill({ response, json: body });
  });
  await page.goto('/generate'); await page.getByRole('combobox', { name: '生成手段', exact: true }).click(); await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true }); await expect(panel).toContainText('未導入'); await expect(panel).toContainText('mock導入状態');
  expectedAction = 'install';
  await panel.getByRole('button', { name: 'Irodoriを追加する（約1.92GB）', exact: true }).click();
  try { await expect(page.getByRole('combobox', { name: '生成手段', exact: true })).toBeDisabled(); } finally { releaseInstall(); }
  await expect(panel).toContainText('取得中'); await expect(panel).toContainText('0.96 / 1.92GB');
  expectedAction = 'cancel'; await panel.getByRole('button', { name: '取得・検証を取り消す', exact: true }).click(); await expect(panel).toContainText('取消し・中断');
  expectedAction = 'install'; await panel.getByRole('button', { name: '途中から導入を再開する', exact: true }).click(); await expect(panel).toContainText('検証中'); await expect(panel).toContainText('途中の資材はまだ利用できません');
  phase = 'failed'; await expect(panel).toContainText('導入失敗'); await expect(panel.getByRole('button', { name: '途中から導入を再開する', exact: true })).toBeVisible();
  expectedAction = 'install'; await panel.getByRole('button', { name: '途中から導入を再開する', exact: true }).click(); await expect(panel).toContainText('検証中');
  await page.screenshot({ path: `docs/validation/screenshots/irodori-mock-progress-${testInfo.project.name}.png`, fullPage: true });
  // A running owned process must remain stoppable if model/voice/binary assets disappear.
  phase = 'failed'; runtime = 'running';
  const stop = panel.getByRole('button', { name: 'このPCのIrodoriを停止', exact: true }); await expect(stop).toBeEnabled();
  expectedAction = 'stop'; await stop.click(); await expect(stop).toHaveCount(0);
  expect(actions).toEqual(['install', 'cancel', 'install', 'install', 'stop']);
});

test('Irodoriの起動待ちを取り消し、古い起動エラーを表示せず再試行できる', async ({ page }) => {
  let runtime = 'stopped', template = '', action: 'start' | 'stop' | undefined;
  let releaseStart: () => void = () => undefined;
  const firstStart = new Promise<void>(resolve => { releaseStart = resolve; });
  const actions: string[] = [];
  await page.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') {
      const next = action; action = undefined;
      if (!next || !template) { await route.abort('blockedbyclient'); throw new Error('Unexpected Irodori launch mutation'); }
      actions.push(next); runtime = next === 'stop' ? 'stopped' : 'starting';
      if (actions.length === 1) {
        await firstStart;
        await route.fulfill({ status: 500, body: 'cancelled old launch' }); return;
      }
      if (next === 'start') runtime = 'running';
      await route.fulfill({ status: 200, contentType: 'application/json', body: template }); return;
    }
    const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
    if (property(result, 'downloadedBytes')) {
      for (const [key, value] of Object.entries({ phase: 'ready', runtime, downloadedBytes: 1_920_321_792, executableAvailable: true, voiceAvailable: true, message: 'mock起動取消しの検査' })) {
        const field = property(result, key); if (field) field.s = value;
      }
      template = JSON.stringify(body);
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/generate'); await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
  await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true });
  const start = panel.getByRole('button', { name: 'このPCで起動', exact: true });
  await expect(start).toBeEnabled(); action = 'start'; await start.click();
  try {
    const cancel = panel.getByRole('button', { name: 'Irodoriの起動を取り消す', exact: true });
    await expect(cancel).toBeEnabled(); action = 'stop'; await cancel.click(); await expect(start).toBeEnabled();
  } finally { releaseStart(); }
  await expect(panel.getByRole('alert')).toHaveCount(0);
  action = 'start'; await start.click();
  await expect(panel.getByRole('button', { name: 'このPCのIrodoriを停止', exact: true })).toBeEnabled();
  expect(actions).toEqual(['start', 'stop', 'start']);
});
