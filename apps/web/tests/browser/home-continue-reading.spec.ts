import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AudioBookManifest } from '../../src/generation/contracts';
import { LibraryDisk } from '../../src/generation/core/disk';
import { AUDIO_DEMO_BOOK_ID } from '../../src/reader/audio-demo';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';

const evidence = resolve('.reader-data/home-continue-reading');
let root: string, origin: string, server: ChildProcess, disk: LibraryDisk, full: AudioBookManifest;
let rpcIds: Record<string, string>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const rpcId = (url: string) => new URL(url).pathname.split('/_serverFn/')[1];
function tone(seconds: number) {
  const frames = 24000 * seconds, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++) bytes.writeInt16LE(Math.round(Math.sin(index * Math.PI * 440 / 24000) * 500), 44 + index * 2);
  return bytes;
}
async function publish(indices = [0, 2]) {
  const chunks = indices.map(index => full.chunks[index]);
  await disk.write(['books', `${full.id}_${full.revision}.json`], { ...full, chunks, completedChunks: chunks.length, durationSeconds: chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0) });
}
test.beforeAll(async () => {
  const assets = resolve('apps/web/dist/server/assets');
  const functions = (await readdir(assets)).filter(name => /^functions-.*\.js$/.test(name));
  const metadata = (await Promise.all(functions.map(name => readFile(resolve(assets, name), 'utf8')))).join('\n');
  rpcIds = Object.fromEntries([...metadata.matchAll(/createServerRpc\(\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"/g)].map(match => [match[2], match[1]]));
  expect(rpcIds.getBook).toBeTruthy();
  expect(rpcIds.listLibrary).toBeTruthy();
  await mkdir(evidence, { recursive: true });
  root = await mkdtemp(resolve(tmpdir(), 'ripola-home-continue-')); disk = new LibraryDisk(root);
  const document = await prepareDocument(importText('朝の窓を開きます。次の頁を読みます。最後に本を閉じます。', 'txt', '途中まで音声がある本'));
  const block = document.blocks[0];
  const chunks = [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(block.text)].map((value, index) => ({ id: `c${index}`, speechKey: hash(`home-continue-${index}`), audioUrl: `/api/local-audio/${hash(`home-continue-${index}`)}.wav`, mimeType: 'audio/wav' as const, durationSeconds: index === 0 ? 2 : 12,
    timeline: [{ blockId: block.id, chunkId: `c${index}`, start: value.index, end: value.index + value.segment.length, unitIds: document.units.filter(unit => unit.start >= value.index && unit.end <= value.index + value.segment.length).map(unit => unit.id), startSeconds: 0, endSeconds: index === 0 ? 2 : 12, precision: 'sentence' as const }] }));
  full = { schemaVersion: 1, id: document.id, revision: hash('home-continue-revision'), title: document.title, document, chunks, completedChunks: 3, totalChunks: 3, durationSeconds: 26, updatedAt: '2026-10-02T13:00:00.000Z', precision: 'sentence', options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] }, warnings: [] };
  for (const chunk of chunks) {
    const bytes = tone(chunk.durationSeconds);
    await disk.writeBytes(['audio', `${chunk.speechKey}.wav`], bytes);
    await disk.write(['cache', `${chunk.speechKey}.json`], { schemaVersion: 1, provider: 'voicevox', status: 'ready', hash: hash(bytes), durationSeconds: chunk.durationSeconds });
  }
  for (let index = 1; index <= 4; index++) {
    const book = { ...full, id: `home-other-${index}`, title: `保存音声 ${index}`, updatedAt: `2026-10-0${index}T12:00:00.000Z` };
    await disk.write(['books', `${book.id}_${book.revision}.json`], book);
  }
  await disk.write(['books', `home-empty_${full.revision}.json`], { ...full, id: 'home-empty', title: '音声がまだない本', chunks: [], completedChunks: 0, durationSeconds: 0 });
  await disk.write(['books', `${AUDIO_DEMO_BOOK_ID}_${full.revision}.json`], { ...full, id: AUDIO_DEMO_BOOK_ID, title: '除外されるデモ' });
  await publish();
  await cp(root, resolve(evidence, 'fixture-library'), { recursive: true });
  await writeFile(resolve(evidence, 'fixture-book.json'), JSON.stringify({ id: full.id, revision: full.revision, title: full.title, expectedLocalSeconds: 3 }, null, 2));
  const port = await new Promise<number>(resolvePort => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = (socket.address() as { port: number }).port; socket.close(() => resolvePort(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  let output = '';
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), env: { ...process.env, RSVP_LIBRARY_DIR: root, RSVP_LOCAL_ORIGIN: origin, RSVP_ENABLE_PAID_GENERATION: 'false', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', bytes => { output += String(bytes); }); server.stderr!.on('data', bytes => { output += String(bytes); });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { try { if ((await fetch(origin)).ok) return; } catch { /* Preview is still starting. */ } if (server.exitCode !== null) throw new Error(output); await delay(250); }
  throw new Error(`Isolated preview did not start: ${output}`);
});
test.afterAll(async () => { server?.kill('SIGTERM'); if (root) await rm(root, { recursive: true, force: true }); });

test('トップは保存音声と途中本を3冊まで表示し、1クリックで区間内位置から停止して開く', async ({ page }, testInfo) => {
  await publish();
  const key = `rsvp-audio-position:${full.id}:${full.revision}`;
  await page.addInitScript(key => localStorage.setItem(key, '5'), key);
  const requests: string[] = [];
  page.on('request', request => { if (/\/api\/local-audio\//.test(request.url()) || /\/_serverFn\//.test(request.url()) && request.method() === 'POST') requests.push(request.url()); });
  await page.goto(origin);
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible({ timeout: 30000 });
  const section = page.getByRole('region', { name: '続きを読む', exact: true });
  await expect(section.locator('article')).toHaveCount(3);
  await expect(section.getByRole('heading', { level: 3 })).toHaveText([full.title, '保存音声 4', '保存音声 3']);
  const partialCard = section.getByRole('article').filter({ hasText: full.title });
  await expect(partialCard).not.toContainText('区間');
  await expect(partialCard).toContainText('生成途中');
  await expect(partialCard).toContainText('0分14秒');
  await expect(partialCard).toContainText('0分05秒から再開');
  await expect(partialCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
  await expect(section.getByRole('article').filter({ hasText: '保存音声 4' }).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(section).not.toContainText('保存位置なし');
  expect((await partialCard.boundingBox())!.height).toBeLessThanOrEqual(94);
  const track = await partialCard.locator('.bookshelf-progress-track').boundingBox();
  expect(track!.width).toBeCloseTo((await partialCard.boundingBox())!.width, 0);
  await expect(section).not.toContainText('音声がまだない本');
  await expect(section).not.toContainText('除外されるデモ');
  await expect(section.getByRole('link', { name: '本棚ですべて見る' })).toHaveAttribute('href', '/library');
  const composer = await page.locator('.home-composer').boundingBox(), cards = await section.boundingBox();
  expect(cards!.y + cards!.height).toBeLessThanOrEqual(composer!.y);
  expect(requests).toEqual([]);
  const open = partialCard.getByRole('link', { name: `${full.title}の続きを読む`, exact: true });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // A selected book must not depend on loading the rest of the catalog.
  await page.route('**/_serverFn/**', route => rpcId(route.request().url()) === rpcIds.listLibrary ? route.fulfill({ status: 503, body: 'catalog unavailable' }) : route.continue());
  await open.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('book')).toBe(full.id);
  expect(new URL(page.url()).searchParams.get('revision')).toBe(full.revision);
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(3, 1);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
  await page.unroute('**/_serverFn/**');
  await page.getByRole('link', { name: 'Ripola ホーム' }).click();
  await expect(section.locator('article')).toHaveCount(3);
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: resolve(evidence, `${testInfo.project.name}-home.png`), fullPage: true });
  await writeFile(resolve(evidence, `${testInfo.project.name}-resume.json`), JSON.stringify({ expectedLocalSeconds: 3, generationPosts: requests.filter(url => url.includes('/_serverFn/')).length }, null, 2));
});

test('トップの保存一覧は再確認で回復し、保存位置が使えなくても文章入力を保つ', async ({ page }) => {
  await publish();
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } }); });
  await page.route('**/_serverFn/**', route => route.request().method() === 'GET' ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue());
  await page.goto(origin);
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible({ timeout: 30000 });
  const section = page.getByRole('region', { name: '続きを読む', exact: true });
  await expect(section.getByRole('alert')).toContainText('保存音声を確認できませんでした');
  await page.getByLabel('読む文章', { exact: true }).fill('入力中の文章を残します。');
  await page.unroute('**/_serverFn/**');
  await section.getByRole('button', { name: '保存音声を再確認', exact: true }).click();
  await expect(section.locator('article')).toHaveCount(3);
  await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue('入力中の文章を残します。');
  await expect(section.getByRole('article').filter({ hasText: full.title })).toContainText('0分14秒');
  await expect(section.getByRole('article').filter({ hasText: full.title })).not.toContainText('から再開');
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await section.getByRole('link', { name: `${full.title}を読む`, exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.readyState)).toBeGreaterThan(0);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => ({ seconds: media.currentTime, paused: media.paused }))).toEqual({ seconds: 0, paused: true });
});

test('保存黙読もトップから保存位置で開ける', async ({ page }) => {
  await publish();
  await page.goto(origin);
  await expect(page.getByLabel('読む文章', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByLabel('読む文章', { exact: true }).fill('保存した黙読の文章です。次の文を読みます。');
  await page.getByLabel('タイトル', { exact: true }).fill('ブラウザの黙読');
  await page.getByRole('button', { name: 'テキストのみ生成して読む', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toBeVisible();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  await page.getByRole('button', { name: '1つ進む', exact: true }).click();
  const silentPosition = await page.getByTestId('current-phrase').innerText();
  await page.getByRole('button', { name: '端末に保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('本文・現在位置・設定');
  await page.getByRole('link', { name: 'Ripola ホーム' }).click();
  await expect(page.locator('.saved-card')).toContainText('ブラウザの黙読');
  await page.getByRole('button', { name: '続きから開く', exact: true }).click();
  await expect(page.getByTestId('current-phrase')).toHaveText(silentPosition);
});

test('本棚の読書位置はバーで表示し、途中生成・再開・別タブ・保存拒否を区別する', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await publish();
  await page.addInitScript(({ id, revision }) => {
    localStorage.setItem(`rsvp-audio-position:${id}:${revision}`, '5');
    localStorage.setItem(`rsvp-audio-position:home-other-1:older-revision`, '26');
    localStorage.setItem(`rsvp-audio-position:home-other-2:${revision}`, '13');
    localStorage.setItem(`rsvp-audio-position:home-other-3:${revision}`, '999');
    localStorage.setItem(`rsvp-audio-position:home-other-4:${revision}`, 'NaN');
  }, { id: full.id, revision: full.revision });
  const mediaRequests: string[] = [];
  page.on('request', request => { if (/\/api\/local-audio\//.test(request.url()) || /\/_serverFn\//.test(request.url()) && request.method() === 'POST') mediaRequests.push(request.url()); });
  await page.goto(`${origin}/library`);
  const card = (title: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const partial = card(full.title);
  await expect(partial.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
  await expect(partial.getByRole('progressbar')).toHaveAttribute('aria-valuetext', /生成途中の保存済み音声内の位置/);
  await expect(partial).toContainText('生成途中');
  await expect(card('保存音声 1').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(card('保存音声 1')).not.toContainText('保存位置なし');
  await expect(card('保存音声 1')).toContainText('0%');
  await expect(card('保存音声 2').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(card('保存音声 3').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(card('保存音声 4')).toContainText('保存位置を取得できません');
  await expect(card('保存音声 4').getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(card('音声がまだない本')).toContainText('音声を準備中');
  expect(mediaRequests).toEqual([]);
  await expect(partial).not.toContainText('更新：');
  await expect(partial).not.toContainText('2 / 3');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const rows = await page.locator('.bookshelf-book').evaluateAll(elements => elements.map(element => {
      const title = element.querySelector('h2')!, metadata = element.querySelector('.bookshelf-progress')!, track = metadata.querySelector('.bookshelf-progress-track')!, style = getComputedStyle(metadata);
      const percent = track.getAttribute('aria-valuenow');
      return { height: element.getBoundingClientRect().height, titleLines: title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight), metadataLines: (metadata.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight), trackWidth: track.getBoundingClientRect().width, metadataWidth: metadata.getBoundingClientRect().width, fillFraction: track.firstElementChild!.getBoundingClientRect().width / track.getBoundingClientRect().width, percent: percent === null ? undefined : Number(percent) };
    }));
    for (const row of rows) { expect(row.height).toBeLessThanOrEqual(94); expect(row.titleLines).toBeLessThan(1.1); expect(row.metadataLines).toBeLessThan(1.1); expect(row.trackWidth).toBeCloseTo(row.metadataWidth, 0); if (row.percent !== undefined) expect(row.fillFraction).toBeCloseTo(row.percent / 100, 2); }
  }
  await expect(page.getByRole('button', { name: '名前を変更', exact: true })).toHaveCount(0);
  await card('保存音声 1').getByRole('link', { name: '保存音声 1', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByLabel('タイトルを変更', { exact: true }).fill('一覧から変更した名前');
  await page.locator('.title-editor').getByRole('button', { name: '名前を変更', exact: true }).click();
  await expect(page.locator('.title-status')).toContainText('名前を変更しました');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '一覧から変更した名前', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(card('一覧から変更した名前')).toBeVisible();
  await page.screenshot({ path: resolve(evidence, `${testInfo.project.name}-bookshelf-light.png`), fullPage: true });
  let releaseBook!: () => void;
  const pendingBook = new Promise<void>(resolve => { releaseBook = resolve; });
  await page.route('**/_serverFn/**', async route => {
    if (rpcId(route.request().url()) === rpcIds.getBook) await pendingBook;
    await route.continue();
  });
  await partial.getByRole('button', { name: '保存音声を読む', exact: true }).click();
  await expect(page.getByLabel('本棚を読み込み中', { exact: true })).toBeVisible();
  const catalogRequests: string[] = [];
  page.on('request', request => { if (rpcId(request.url()) === rpcIds.listLibrary) catalogRequests.push(request.url()); });
  await page.evaluate(key => window.dispatchEvent(new StorageEvent('storage', { key })), `rsvp-audio-position:${full.id}:${full.revision}`);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(catalogRequests).toEqual([]);
  await expect(page.getByRole('button', { name: '保存音声を読む', exact: true })).toHaveCount(0);
  const openedBook = page.waitForResponse(response => rpcId(response.url()) === rpcIds.getBook && response.status() === 200);
  releaseBook();
  await (await openedBook).finished();
  await page.unroute('**/_serverFn/**');
  await expect(page.getByLabel('音声の再生位置', { exact: true })).toHaveValue('5');
  await page.getByLabel('音声の再生位置', { exact: true }).evaluate((element: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '14');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(partial.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(partial).toContainText('生成途中');
  await expect(partial).not.toContainText('読了');
  await page.getByRole('button', { name: 'グリッド', exact: true }).click();
  const beforePositionChange = catalogRequests.length;
  await page.evaluate(({ id, revision }) => {
    const key = `rsvp-audio-position:${id}:${revision}`;
    localStorage.setItem(key, '7');
    window.dispatchEvent(new CustomEvent('rsvp-audio-position-changed', { detail: key }));
    window.dispatchEvent(new StorageEvent('storage', { key: `${key}:source` }));
  }, { id: full.id, revision: full.revision });
  await expect(partial.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  expect(catalogRequests.length).toBe(beforePositionChange);
  await publish([0, 1, 2]);
  const otherTab = await page.context().newPage();
  await otherTab.goto(`${origin}/library`);
  await otherTab.evaluate(({ id, revision }) => localStorage.setItem(`rsvp-audio-position:${id}:${revision}`, '13'), { id: full.id, revision: full.revision });
  await otherTab.close();
  // Positions update independently; newly generated audio is discovered on lifecycle refresh.
  const refreshed = page.waitForResponse(response => rpcId(response.url()) === rpcIds.listLibrary && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await (await refreshed).finished();
  await expect(partial.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(partial).not.toContainText('生成途中');
  await expect(partial).toContainText('0分13秒から再開');
  await expect(partial).toContainText('0分26秒');
  await expect(page.getByRole('button', { name: 'グリッド', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '配色を変更', exact: true }).click();
  await page.getByRole('menuitem', { name: /^ダーク/ }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('button', { name: 'グリッド', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: resolve(evidence, `${testInfo.project.name}-bookshelf-dark.png`), fullPage: true });
  await page.evaluate(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(partial).toContainText('保存位置を取得できません');
  await expect(partial.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', audience: 'personal', createdAt: '2026-10-15T00:00:00Z', books: [{ id: full.id, revision: full.revision, title: full.title, manifestUrl: `library/books/${full.id}/${full.revision}/manifest.json`, manifestSha256: 'a'.repeat(64), manifestBytes: 1, durationSeconds: 26, precision: 'sentence', attribution: '著者：検証用・音声：合成音', publicDemo: false }] } }));
  await page.goto(`${origin}/books`);
  await expect(page.getByRole('heading', { name: full.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '音声付きで読む', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '著者・音声', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: full.title, exact: true })).toHaveAttribute('href', /book=/);
});

test('本棚は新しい順と古い順で並べ替えと絞り込みを行い途中生成を読了扱いしない', async ({ page }) => {
  await publish();
  await disk.write(['book-names', `home-other-1_${full.revision}.json`], { schemaVersion: 1, title: '保存音声 1' });
  await page.addInitScript(({ id, revision }) => {
    localStorage.setItem(`rsvp-audio-position:${id}:${revision}`, '14');
    localStorage.setItem(`rsvp-audio-position:home-other-2:${revision}`, '13');
    localStorage.setItem(`rsvp-audio-position:home-other-3:${revision}`, '26');
    localStorage.setItem(`rsvp-audio-position:home-other-4:${revision}`, 'NaN');
  }, { id: full.id, revision: full.revision });
  await page.goto(`${origin}/library`);
  const rows = page.locator('.bookshelf-book');
  const titles = page.locator('.bookshelf-book h2');
  const filter = page.getByLabel('絞り込み', { exact: true });
  const newest = page.getByRole('button', { name: '新しい順', exact: true });
  const oldest = page.getByRole('button', { name: '古い順', exact: true });
  await expect(rows).toHaveCount(6);
  await filter.selectOption('unfinished');
  await expect(rows).toHaveCount(5);
  await expect(titles).not.toContainText(['保存音声 3']);
  await expect(page.getByRole('heading', { name: full.title, exact: true })).toBeVisible();
  await filter.selectOption('reading');
  await expect(rows).toHaveCount(2);
  await newest.click();
  await expect(titles).toHaveText([full.title, '保存音声 2']);
  await oldest.click();
  await expect(titles).toHaveText(['保存音声 2', full.title]);
  await filter.selectOption('completed');
  await expect(titles).toHaveText(['保存音声 3']);
  await page.getByRole('button', { name: 'グリッド', exact: true }).click();
  await expect(titles).toHaveText(['保存音声 3']);
  await filter.selectOption('unread');
  await expect(titles).toHaveText(['保存音声 1', '音声がまだない本']);
  await filter.selectOption('all');
  await oldest.click();
  const chronological = await titles.allTextContents();
  await newest.click();
  await expect(titles).toHaveText([...chronological].reverse());
  const other = await page.context().newPage();
  await other.goto(origin);
  await other.evaluate(revision => localStorage.setItem(`rsvp-audio-position:home-other-1:${revision}`, '26'), full.revision);
  await other.close();
  await filter.selectOption('completed');
  await expect(titles).toHaveText(['保存音声 3', '保存音声 1']);
  await filter.selectOption('reading');
  await newest.click();
  await page.getByRole('link', { name: '保存音声 2', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(filter).toHaveValue('reading');
  await expect(newest).toHaveAttribute('aria-pressed', 'true');
  await expect(oldest).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'グリッド', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(titles).toHaveText([full.title, '保存音声 2']);
  for (const width of [320, 390, 701, 768, 780, 1024, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const toolbar = page.locator('.bookshelf-toolbar');
    for (const control of [newest, oldest, filter, page.getByRole('button', { name: 'グリッド', exact: true })]) {
      const frame = await toolbar.boundingBox(); const box = await control.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(frame!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const clippedLabels = await toolbar.locator('.bookshelf-toggle .mantine-Button-label').evaluateAll(labels => labels.filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent));
    expect(clippedLabels).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test('ローカル本棚も履歴で原稿・音声位置へ戻り、離れた音声は停止する', async ({ page }) => {
  await publish([0, 1, 2]);
  await page.goto(origin);
  const text = '未保存の原稿を残します。本棚を往復しても同じ内容を読めます。';
  await page.getByLabel('読む文章', { exact: true }).fill(text);
  await page.getByRole('link', { name: 'このPCの本棚', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'このPCの本棚', exact: true })).toBeVisible();
  const card = page.getByRole('article').filter({ hasText: full.title });
  await card.getByRole('button', { name: '保存音声を読む', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('6');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(4.1);
  await page.locator('audio').evaluate(audio => { (window as unknown as { departedAudio: HTMLAudioElement }).departedAudio = audio as HTMLAudioElement; });
  await page.goBack(); await expect(card).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { departedAudio: HTMLAudioElement }).departedAudio.paused)).toBe(true);
  await page.goForward(); await expect(page.getByTestId('audio-stage')).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  expect(Number(await slider.inputValue())).toBeGreaterThan(6);
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click(); await expect(card).toBeVisible();
  await page.goBack(); await expect(page.getByLabel('読む文章', { exact: true })).toHaveValue(text);
  await page.goForward(); await expect(card).toBeVisible();
});


test('本棚の古い名前変更の応答が履歴で開いた別の本を閉じない', async ({ page }) => {
  await publish([0, 1, 2]);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/_serverFn/**', async route => {
    if (rpcId(route.request().url()) !== rpcIds.renameBook) { await route.continue(); return; }
    const response = await route.fetch(); requested(); await pending; await route.fulfill({ response });
  });
  await page.goto(`${origin}/library`);
  await page.getByRole('article').filter({ hasText: full.title }).getByRole('button', { name: '保存音声を読む', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  await page.getByRole('button', { name: '本の操作', exact: true }).click();
  await page.getByLabel('タイトルを変更', { exact: true }).fill('遅れて返る名前変更');
  await page.getByRole('button', { name: '名前を変更', exact: true }).click(); await started;
  await page.goBack();
  await page.getByRole('article').filter({ hasText: '保存音声 4' }).getByRole('button', { name: '保存音声を読む', exact: true }).click();
  await expect(page.getByRole('heading', { name: '保存音声 4', exact: true })).toBeVisible();
  const url = page.url(); release(); await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
  await expect(page.getByRole('heading', { name: '保存音声 4', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
});
