import { expect, test } from '@playwright/test';

function rpcName(url: string): string {
  const id = new URL(url).pathname.split('/_serverFn/')[1];
  try { return id ? String(JSON.parse(Buffer.from(id, 'base64url').toString()).export) : ''; } catch { return ''; }
}
function property(node: unknown, key: string): { s?: unknown } | undefined {
  if (!node || typeof node !== 'object' || !('p' in node)) return;
  const props = (node as { p: { k: string[]; v: Array<{ s?: unknown }> } }).p;
  return props.v[props.k.indexOf(key)];
}
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('Irodori未導入は容量と追加入口を示し通常利用では取得しない', async ({ page, context }, testInfo) => {
  const mutations: string[] = []; const downloads: string[] = []; const errors: string[] = [];
  context.on('request', request => {
    if (/huggingface\.co|hf\.co|xethub\.hf\.co/.test(request.url())) downloads.push(request.url());
    if (request.method() === 'POST' && request.url().includes('/_serverFn/')) {
      const encoded = new URL(request.url()).pathname.split('/_serverFn/')[1];
      if (encoded) { try { const name = JSON.parse(Buffer.from(encoded, 'base64url').toString()).export; if (/installIrodori|startIrodoriRuntime|startGeneration/.test(name)) mutations.push(name); } catch { /* Not a server function identity. */ } }
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/generate');
  await expect(page.getByRole('combobox', { name: '生成手段', exact: true })).toHaveValue('無料 · VOICEVOX');
  await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
  await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true });
  await expect(panel).toContainText('未導入'); await expect(panel).toContainText('約1.92GB'); await expect(panel).toContainText('約2.2GB');
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
  await page.route('**/_serverFn/**', async route => {
    const name = rpcName(route.request().url());
    if (name.startsWith('installIrodori') || name.startsWith('cancelIrodoriInstall')) {
      // Never forward the download mutation to the PC. Reuse only the successful RPC envelope.
      actions.push(name); phase = name.startsWith('cancel') ? 'cancelled' : actions.length === 1 ? 'downloading' : 'verifying';
      bytes = phase === 'verifying' ? 1_920_321_792 : 960_000_000;
      await route.fulfill({ status: 200, contentType: 'application/json', body: template }); return;
    }
    if (!name.startsWith('getIrodoriStatus')) return route.continue();
    const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
    for (const [key, value] of Object.entries({ phase, downloadedBytes: bytes, message: phase === 'failed' ? '通信が中断しました。再開できます。' : 'mock導入状態の検査です。' })) {
      const field = property(result, key); if (field) field.s = value;
    }
    template = JSON.stringify(body); await route.fulfill({ response, json: body });
  });
  await page.goto('/generate'); await page.getByRole('combobox', { name: '生成手段', exact: true }).click(); await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true }); await expect(panel).toContainText('未導入');
  await panel.getByRole('button', { name: 'Irodoriを追加する（約1.92GB）', exact: true }).click(); await expect(panel).toContainText('取得中'); await expect(panel).toContainText('0.96 / 1.92GB');
  await panel.getByRole('button', { name: '取得・検証を取り消す', exact: true }).click(); await expect(panel).toContainText('取消し・中断');
  await panel.getByRole('button', { name: '途中から導入を再開する', exact: true }).click(); await expect(panel).toContainText('検証中'); await expect(panel).toContainText('途中の資材はまだ利用できません');
  phase = 'failed'; await expect(panel).toContainText('導入失敗'); await expect(panel.getByRole('button', { name: '途中から導入を再開する', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '途中から導入を再開する', exact: true }).click(); await expect(panel).toContainText('検証中');
  await page.screenshot({ path: `docs/validation/screenshots/irodori-mock-progress-${testInfo.project.name}.png`, fullPage: true });
  expect(actions.filter(name => name.startsWith('installIrodori'))).toHaveLength(3); expect(actions.filter(name => name.startsWith('cancelIrodoriInstall'))).toHaveLength(1);
});
