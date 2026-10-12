import { expect, test, type Page, type Route, type APIResponse } from '@playwright/test';
import { createRequire } from 'node:module';
import type { GenerationConfig, GenerationPlan, PrepareGenerationInput } from '../../src/generation/contracts';
import type { IrodoriSettings } from '../../src/generation/irodori-contracts';

function property(node: unknown, key: string): { t: number; s?: unknown } | undefined {
  if (!node || typeof node !== 'object' || !('p' in node)) return;
  const props = (node as { p: { k: string[]; v: Array<{ t: number; s?: unknown }> } }).p;
  return props.v[props.k.indexOf(key)];
}
function setProperty(node: unknown, key: string, value: string | number | boolean): void {
  const field = property(node, key);
  if (!field) return;
  // Seroval constant nodes use 2 for true and 3 for false, rather than JS booleans.
  if (typeof value === 'boolean') { expect(field.t).toBe(2); field.s = value ? 2 : 3; }
  else field.s = value;
}
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('Irodori未導入は容量と追加入口を示し通常利用では取得しない', async ({ page, context }, testInfo) => {
  const mutations: string[] = []; const downloads: string[] = []; const errors: string[] = [];
  await page.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') { await route.abort('blockedbyclient'); return; }
    const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
    if (property(result, 'downloadedBytes')) {
      for (const [key, value] of Object.entries({ phase: 'not-installed', downloadedBytes: 0, runtime: 'stopped', message: '未導入fixture' })) setProperty(result, key, value);
      await route.fulfill({ response, json: body }); return;
    }
    await route.fulfill({ response });
  });
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
  await expect(panel).toContainText('未導入'); await expect(panel).toContainText('約1.91GB'); await expect(panel).toContainText('約2.2GB');
  await expect(panel).toContainText('丁寧な受付'); await expect(panel).toContainText('指示文を変更');
  await expect(panel.getByRole('button', { name: 'Irodoriを追加する（約1.91GB）', exact: true })).toBeVisible();
  const voice = page.getByRole('combobox', { name: '声・スタイル', exact: true }); await expect(voice).toHaveValue('丁寧な受付（女）');
  await voice.click(); await page.getByRole('option', { name: '丁寧な受付（男）', exact: true }).click();
  await expect(panel.getByLabel('声・読み上げ方のプロンプト', { exact: true })).toHaveValue('明朗快活な男性の受付スタッフ。明るく丁寧にてきぱきと');
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
      else { phase = action === 'cancel' ? 'cancelled' : actions.length === 1 ? 'downloading' : 'verifying'; bytes = phase === 'verifying' ? 1_905_903_936 : 960_000_000; }
      if (actions.length === 1) await installationReply;
      await route.fulfill({ status: 200, contentType: 'application/json', body: template }); return;
    }
    const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
    if (!property(result, 'downloadedBytes') || !property(result, 'totalBytes')) { await route.fulfill({ response }); return; }
    for (const [key, value] of Object.entries({ phase, runtime, downloadedBytes: bytes, message: phase === 'failed' ? '通信が中断しました。再開できます。' : 'mock導入状態の検査です。' })) {
      setProperty(result, key, value);
    }
    template = JSON.stringify(body); await route.fulfill({ response, json: body });
  });
  await page.goto('/generate'); await page.getByRole('combobox', { name: '生成手段', exact: true }).click(); await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true }); await expect(panel).toContainText('未導入'); await expect(panel).toContainText('mock導入状態');
  expectedAction = 'install';
  await panel.getByRole('button', { name: 'Irodoriを追加する（約1.91GB）', exact: true }).click();
  try { await expect(page.getByRole('combobox', { name: '生成手段', exact: true })).toBeDisabled(); } finally { releaseInstall(); }
  await expect(panel).toContainText('取得中'); await expect(panel).toContainText('0.96 / 1.91GB');
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
      for (const [key, value] of Object.entries({ phase: 'ready', runtime, downloadedBytes: 1_905_903_936, executableAvailable: true, voiceAvailable: true, message: 'mock起動取消しの検査' })) {
        setProperty(result, key, value);
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

for (const oldReply of ['running', 'error'] as const) {
  test(`Irodoriの起動取消し後に古い状態GETの${oldReply === 'running' ? '実行中応答' : 'エラー'}を適用しない`, async ({ page }) => {
    const clockStart = new Date();
    await page.clock.install({ time: clockStart });
    let runtime = 'stopped', template = '', action: 'start' | 'stop' | undefined;
    let holdNextStatus = false, configRequests = 0, oldStatusUrl = '';
    let releaseStart: () => void = () => undefined, releaseStatus: () => void = () => undefined, statusStarted: () => void = () => undefined;
    const startReply = new Promise<void>(resolve => { releaseStart = resolve; });
    const oldStatusReply = new Promise<void>(resolve => { releaseStatus = resolve; });
    const oldStatusStarted = new Promise<void>(resolve => { statusStarted = resolve; });
    const actions: string[] = [];
    await page.route('**/_serverFn/**', async route => {
      if (route.request().method() === 'POST') {
        const next = action; action = undefined;
        if (!next || !template) { await route.abort('blockedbyclient'); throw new Error('Unexpected Irodori launch mutation'); }
        actions.push(next); runtime = next === 'stop' ? 'stopped' : 'starting';
        if (next === 'start') await startReply;
        await route.fulfill({ status: 200, contentType: 'application/json', body: template }); return;
      }
      const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
      if (property(result, 'voicevox')) configRequests++;
      if (!property(result, 'downloadedBytes')) { await route.fulfill({ response, json: body }); return; }
      const oldStatus = holdNextStatus; holdNextStatus = false;
      for (const [key, value] of Object.entries({ phase: 'ready', runtime: oldStatus ? 'running' : runtime, downloadedBytes: 1_905_903_936, executableAvailable: true, voiceAvailable: true, message: oldStatus ? '古い起動後の状態' : runtime === 'stopped' ? '停止を確認しました' : '起動待ちを確認しました' })) {
        setProperty(result, key, value);
      }
      if (oldStatus) {
        oldStatusUrl = route.request().url(); statusStarted();
        await oldStatusReply;
        if (oldReply === 'error') { await route.fulfill({ status: 500, body: 'old status GET failed' }); return; }
      } else template = JSON.stringify(body);
      await route.fulfill({ response, json: body });
    });
    await page.goto('/generate', { waitUntil: 'domcontentloaded' }); await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
    await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true });
    const start = panel.getByRole('button', { name: 'このPCで起動', exact: true });
    await expect(start).toBeEnabled();
    await page.clock.pauseAt(new Date(clockStart.getTime() + 60_000));
    const initialConfigRequests = configRequests;
    action = 'start'; await start.click();
    try {
      await page.clock.runFor(1000);
      const cancel = panel.getByRole('button', { name: 'Irodoriの起動を取り消す', exact: true });
      await expect(cancel).toBeEnabled();
      holdNextStatus = true; releaseStart(); await oldStatusStarted;
      action = 'stop'; await cancel.click();
      await expect(start).toBeEnabled(); await expect(panel).toContainText('停止を確認しました');
      await expect.poll(() => configRequests).toBe(initialConfigRequests + 1);
      const oldResponse = page.waitForResponse(response => response.url() === oldStatusUrl && response.request().method() === 'GET');
      releaseStatus(); await (await oldResponse).finished(); await page.clock.runFor(1);
      await expect(start).toBeEnabled(); await expect(panel).toContainText('停止を確認しました');
      await expect(panel.getByRole('alert')).toHaveCount(0);
      expect(configRequests).toBe(initialConfigRequests + 1);
      expect(actions).toEqual(['start', 'stop']);
    } finally { releaseStart(); releaseStatus(); }
  });
}

test('Irodoriの遅い状態取得はpollを重ねず完了した状態を表示する', async ({ page }) => {
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  let statusRequests = 0, statusUrl = '';
  let releaseStatus: () => void = () => undefined, statusStarted: () => void = () => undefined;
  const statusReply = new Promise<void>(resolve => { releaseStatus = resolve; });
  const pendingStatus = new Promise<void>(resolve => { statusStarted = resolve; });
  await page.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') { await route.abort('blockedbyclient'); throw new Error('Unexpected mutation while polling Irodori status'); }
    const dispatchedStatus = route.request().url() === statusUrl;
    if (dispatchedStatus) statusRequests++;
    const response = await route.fetch(); const body: unknown = await response.json(); const result = property(body, 'result');
    if (property(result, 'downloadedBytes')) {
      if (!dispatchedStatus) { statusUrl = route.request().url(); statusRequests++; }
      const field = property(result, 'message'); if (field) field.s = '遅い状態取得が完了しました';
      statusStarted(); await statusReply;
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/generate', { waitUntil: 'domcontentloaded' }); await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
  await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true });
  await pendingStatus; await page.clock.pauseAt(new Date(clockStart.getTime() + 60_000));
  try {
    await page.clock.runFor(3000);
    expect(statusRequests).toBe(1);
    releaseStatus();
    await expect(panel).toContainText('遅い状態取得が完了しました');
  } finally { releaseStatus(); }
});

const localRequire = createRequire(import.meta.url);
const routerRequire = createRequire(localRequire.resolve('@tanstack/react-router'));
const serializer = createRequire(routerRequire.resolve('@tanstack/router-core'))('seroval') as {
  fromCrossJSON<T>(value: unknown, options: { refs: Map<number, unknown> }): T;
  toCrossJSON(value: unknown, options: { refs: Map<number, unknown> }): unknown;
  fromJSON<T>(value: unknown): T;
};
const editedSettings: IrodoriSettings = { steps: 12, speed: 1.5, seed: 73, instructions: '落ち着いて読む' };
const newerSettings: IrodoriSettings = { steps: 8, speed: .8, seed: 89, instructions: '明るく読む' };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function settingsFixture(page: Page, mode: 'success' | 'error' | 'superseded-save') {
  const initial = gate(), initialStarted = gate(), save = gate(), saveStarted = gate();
  let settingsReads = 0, settingsUrl = '', saveUrl = '', runtime = 'running';
  let currentSettings: IrodoriSettings | undefined, savedSettings: IrodoriSettings | undefined;
  let template: { response: APIResponse; envelope: Record<string, unknown> } | undefined;
  let action: 'save' | 'stop' | 'plan' | undefined;
  const plans: IrodoriSettings[] = [], actions: string[] = [];
  async function reply(route: Route, response: APIResponse, envelope: Record<string, unknown>, result: unknown) {
    await route.fulfill({ response, json: serializer.toCrossJSON({ ...envelope, result }, { refs: new Map() }) });
  }
  await page.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') {
      const next = action; action = undefined;
      if (!next || !template) { await route.abort('blockedbyclient'); throw new Error('Unexpected settings fixture mutation'); }
      actions.push(next);
      const payload = route.request().postData();
      const data = payload ? serializer.fromJSON<{ data?: unknown }>(JSON.parse(payload)).data : undefined;
      if (next === 'save') {
        savedSettings = (data as { voice: string; settings: IrodoriSettings }).settings; currentSettings = savedSettings;
        saveUrl = route.request().url(); saveStarted.release();
        if (mode === 'superseded-save') await save.promise;
        await reply(route, template.response, template.envelope, undefined); return;
      }
      if (next === 'stop') { runtime = 'stopped'; await reply(route, template.response, template.envelope, undefined); return; }
      const input = data as PrepareGenerationInput;
      plans.push(input.options.irodori as IrodoriSettings);
      const plan: GenerationPlan = { schemaVersion: 1, id: 'fixture-plan', hash: 'fixture-plan-hash', bookId: input.document.id, revision: input.document.contentHash, title: input.document.title,
        createdAt: new Date().toISOString(), options: input.options, chunks: [], sendingText: '', endpoint: 'settings UI fixture · no native synthesis', available: false,
        unavailableReason: '生成はこのfixtureでは実行しません。', estimatedSeconds: 0, estimatedOutputUsd: 0, estimateNote: '設定の引き継ぎだけを検査します。', warnings: [] };
      await reply(route, template.response, template.envelope, plan); return;
    }
    const response = await route.fetch();
    const envelope = serializer.fromCrossJSON<Record<string, unknown>>(await response.json(), { refs: new Map() });
    const result = envelope.result as Record<string, unknown> | undefined;
    if (result && 'voicevox' in result) {
      const config = result as unknown as GenerationConfig;
      const provider = config.providers!.find(value => value.id === 'irodori')!;
      provider.available = true; provider.voices = [{ id: 'reception-female', name: '丁寧な受付（女）' }];
      await reply(route, response, envelope, config); return;
    }
    if (result && 'downloadedBytes' in result) {
      await reply(route, response, envelope, { ...result, phase: 'ready', runtime, executableAvailable: true, voiceAvailable: true, downloadedBytes: result.totalBytes, message: 'settings fixture ready' }); return;
    }
    if (result && typeof result.steps === 'number' && typeof result.speed === 'number') {
      template = { response, envelope }; settingsReads++;
      const value = currentSettings ?? result;
      if (settingsReads === 1 && mode !== 'superseded-save') {
        settingsUrl = route.request().url(); initialStarted.release(); await initial.promise;
        if (mode === 'error') { await route.fulfill({ status: 500, body: 'old settings GET failed' }); return; }
      } else initialStarted.release();
      await reply(route, response, envelope, value); return;
    }
    await route.fulfill({ response });
  });
  return { initialStarted: initialStarted.promise, saveStarted: saveStarted.promise, releaseInitial: initial.release, releaseSave: save.release,
    settingsUrl: () => settingsUrl, saveUrl: () => saveUrl, savedSettings: () => savedSettings, plans, actions,
    action: (next: typeof action) => { action = next; }, currentSettings: (value: IrodoriSettings) => { currentSettings = value; } };
}

async function openSettings(page: Page) {
  await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
  await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true });
  await expect(panel).toContainText('settings fixture ready');
  await panel.getByText('合成設定・取得資材の詳細', { exact: true }).click();
  await expect(panel.getByRole('button', { name: '設定を保存して計画を更新', exact: true })).toBeEnabled();
  return panel;
}

for (const oldReply of ['success', 'error'] as const) {
  test(`Irodoriの設定保存後に古い初期設定GETの${oldReply === 'success' ? '成功応答で設定と計画を戻さない' : 'エラーを表示しない'}`, async ({ page }) => {
    const fixture = await settingsFixture(page, oldReply);
    try {
      await page.goto('/generate', { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: '原稿を貼り付け', exact: true }).fill('朝の光が机に差します。');
      await page.getByRole('button', { name: '本文を確認する', exact: true }).click();
      const panel = await openSettings(page); await fixture.initialStarted;
      await panel.getByLabel('合成steps', { exact: true }).fill(String(editedSettings.steps));
      await panel.getByLabel('速度', { exact: true }).fill(String(editedSettings.speed));
      await panel.getByLabel('合成seed', { exact: true }).fill(String(editedSettings.seed));
      await panel.getByLabel('声・読み上げ方のプロンプト', { exact: true }).fill(editedSettings.instructions);
      fixture.action('save'); await panel.getByRole('button', { name: '設定を保存して計画を更新', exact: true }).click();
      await fixture.saveStarted;
      await expect(panel.getByRole('button', { name: '設定を保存して計画を更新', exact: true })).toBeEnabled();
      expect(fixture.savedSettings()).toEqual(editedSettings);
      const oldResponse = page.waitForResponse(response => response.url() === fixture.settingsUrl() && response.request().method() === 'GET');
      fixture.releaseInitial(); await (await oldResponse).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await expect(panel.getByLabel('合成steps', { exact: true })).toHaveValue(String(editedSettings.steps));
      await expect(panel.getByLabel('速度', { exact: true })).toHaveValue(String(editedSettings.speed));
      await expect(panel.getByLabel('合成seed', { exact: true })).toHaveValue(String(editedSettings.seed));
      await expect(panel.getByRole('alert')).toHaveCount(0);
      fixture.action('plan'); await page.getByRole('button', { name: '生成計画を確認する', exact: true }).click();
      await expect(page.locator('.generation-confirm')).toContainText('12 steps · 速度 1.5 · seed 73');
      expect(fixture.plans).toEqual([editedSettings]); expect(fixture.actions).toEqual(['save', 'plan']);
    } finally { fixture.releaseInitial(); fixture.releaseSave(); }
  });
}

test('Irodoriの古い設定保存完了は停止と再表示後の設定を次の計画へ戻さない', async ({ page }) => {
  const fixture = await settingsFixture(page, 'superseded-save');
  try {
    await page.goto('/generate', { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: '原稿を貼り付け', exact: true }).fill('本を閉じて窓を開きます。');
    await page.getByRole('button', { name: '本文を確認する', exact: true }).click();
    const panel = await openSettings(page); await fixture.initialStarted;
    await panel.getByLabel('合成steps', { exact: true }).fill(String(editedSettings.steps));
    await panel.getByLabel('速度', { exact: true }).fill(String(editedSettings.speed));
    await panel.getByLabel('合成seed', { exact: true }).fill(String(editedSettings.seed));
    await panel.getByLabel('声・読み上げ方のプロンプト', { exact: true }).fill(editedSettings.instructions);
    fixture.action('save'); await panel.getByRole('button', { name: '設定を保存して計画を更新', exact: true }).click(); await fixture.saveStarted;
    expect(fixture.savedSettings()).toEqual(editedSettings);
    fixture.action('stop'); await panel.getByRole('button', { name: 'このPCのIrodoriを停止', exact: true }).click();
    await page.getByRole('combobox', { name: '生成手段', exact: true }).click();
    await page.getByRole('option', { name: '無料 · VOICEVOX', exact: true }).click();
    await expect(panel).toHaveCount(0); fixture.currentSettings(newerSettings);
    const reopened = await openSettings(page);
    await expect(reopened.getByLabel('合成steps', { exact: true })).toHaveValue(String(newerSettings.steps));
    const oldResponse = page.waitForResponse(response => response.url() === fixture.saveUrl() && response.request().method() === 'POST');
    fixture.releaseSave(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(reopened.getByLabel('合成steps', { exact: true })).toHaveValue(String(newerSettings.steps));
    fixture.action('plan'); await page.getByRole('button', { name: '生成計画を確認する', exact: true }).click();
    await expect(page.locator('.generation-confirm')).toContainText('8 steps · 速度 0.8 · seed 89');
    expect(fixture.plans).toEqual([newerSettings]); expect(fixture.actions).toEqual(['save', 'stop', 'plan']);
  } finally { fixture.releaseInitial(); fixture.releaseSave(); }
});

test('受付の男女声はプロンプトを別々に保存し声の切替後に古い設定を適用しない', async ({ page }, testInfo) => {
  const firstFemale = gate(), firstFemaleStarted = gate(); let held = false;
  const saved = new Map<string, IrodoriSettings>(); const plans: PrepareGenerationInput[] = [];
  let template: { response: APIResponse; envelope: Record<string, unknown> } | undefined;
  async function reply(route: Route, response: APIResponse, envelope: Record<string, unknown>, result: unknown) {
    await route.fulfill({ response, json: serializer.toCrossJSON({ ...envelope, result }, { refs: new Map() }) });
  }
  await page.route('**/_serverFn/**', async route => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postData(); const data = payload ? serializer.fromJSON<{ data: unknown }>(JSON.parse(payload)).data : undefined;
      if (!template || !data || typeof data !== 'object') { await route.abort('blockedbyclient'); throw new Error('Unexpected reception mutation'); }
      if ('settings' in data && 'voice' in data) {
        const input = data as { voice: string; settings: IrodoriSettings }; saved.set(input.voice, input.settings);
        await reply(route, template.response, template.envelope, undefined); return;
      }
      if ('document' in data && 'options' in data) {
        const input = data as PrepareGenerationInput; plans.push(input);
        const plan: GenerationPlan = { schemaVersion: 1, id: 'reception-plan', hash: 'reception-hash', bookId: input.document.id, revision: input.document.contentHash, title: input.document.title, createdAt: new Date().toISOString(), options: input.options, chunks: [], sendingText: '', endpoint: 'reception fixture', available: false, unavailableReason: 'fixture', estimatedSeconds: 0, estimatedOutputUsd: 0, estimateNote: 'fixture', warnings: [] };
        await reply(route, template.response, template.envelope, plan); return;
      }
      await route.abort('blockedbyclient'); throw new Error('Unexpected reception mutation');
    }
    const response = await route.fetch(); const envelope = serializer.fromCrossJSON<Record<string, unknown>>(await response.json(), { refs: new Map() });
    const result = envelope.result as Record<string, unknown> | undefined;
    if (result && 'voicevox' in result) {
      const config = result as unknown as GenerationConfig; const provider = config.providers!.find(value => value.id === 'irodori')!;
      provider.available = true; provider.voices = [{ id: 'reception-female', name: '丁寧な受付（女）' }, { id: 'reception-male', name: '丁寧な受付（男）' }];
      await reply(route, response, envelope, config); return;
    }
    if (result && 'downloadedBytes' in result) { await reply(route, response, envelope, { ...result, phase: 'ready', runtime: 'running', executableAvailable: true, voiceAvailable: true, message: '受付設定fixture' }); return; }
    if (result && typeof result.steps === 'number') {
      template = { response, envelope }; const voice = String(result.instructions).includes('男性') ? 'reception-male' : 'reception-female';
      if (voice === 'reception-female' && !held) { held = true; firstFemaleStarted.release(); await firstFemale.promise; }
      await reply(route, response, envelope, saved.get(voice) ?? result); return;
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto('/generate', { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: '原稿を貼り付け', exact: true }).fill('本日はご来館ありがとうございます。'); await page.getByRole('button', { name: '本文を確認する', exact: true }).click();
    await page.getByRole('combobox', { name: '生成手段', exact: true }).click(); await page.getByRole('option', { name: '任意追加 · Irodori（このPC）', exact: true }).click(); await firstFemaleStarted.promise;
    const voice = page.getByRole('combobox', { name: '声・スタイル', exact: true }); await voice.click(); await page.getByRole('option', { name: '丁寧な受付（男）', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Irodoriの任意追加', exact: true }); await panel.getByText('合成設定・取得資材の詳細', { exact: true }).click();
    const prompt = panel.getByLabel('声・読み上げ方のプロンプト', { exact: true }); await expect(prompt).toHaveValue('明朗快活な男性の受付スタッフ。明るく丁寧にてきぱきと'); await expect(panel.getByLabel('合成steps', { exact: true })).toHaveValue('40');
    await prompt.fill('男性の受付スタッフ。穏やかに丁寧に話す'); await panel.getByRole('button', { name: '設定を保存して計画を更新', exact: true }).click(); await expect.poll(() => saved.size).toBe(1);
    firstFemale.release(); await expect(prompt).toHaveValue('男性の受付スタッフ。穏やかに丁寧に話す');
    await page.getByRole('button', { name: '生成計画を確認する', exact: true }).click(); await expect(page.locator('.generation-confirm')).toContainText('穏やかに丁寧に話す'); expect(plans[0].options.model).toBe('irodori-tts'); expect(plans[0].options.voice).toBe('reception-male');
    await voice.click(); await page.getByRole('option', { name: '丁寧な受付（女）', exact: true }).click(); await expect(page.locator('.generation-confirm')).toHaveCount(0);
    await panel.getByText('合成設定・取得資材の詳細', { exact: true }).click(); await expect(prompt).toHaveValue('明朗快活な受付嬢。明るく丁寧にてきぱきと');
    await voice.click(); await page.getByRole('option', { name: '丁寧な受付（男）', exact: true }).click(); await panel.getByText('合成設定・取得資材の詳細', { exact: true }).click(); await expect(prompt).toHaveValue('男性の受付スタッフ。穏やかに丁寧に話す');
    await panel.getByRole('button', { name: 'プロンプトを既定に戻す', exact: true }).click(); await expect(prompt).toHaveValue('明朗快活な男性の受付スタッフ。明るく丁寧にてきぱきと');
    await page.screenshot({ path: testInfo.outputPath('reception-settings.png'), fullPage: true });
  } finally { firstFemale.release(); }
});
