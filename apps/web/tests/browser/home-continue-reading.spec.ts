import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
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
  await expect(partialCard).toContainText('保存済み音声 2 / 3 区間');
  await expect(partialCard).toContainText('保存音声 0分14秒');
  await expect(partialCard).toContainText('保存した位置から再開');
  await expect(section).not.toContainText('音声がまだない本');
  await expect(section).not.toContainText('除外されるデモ');
  await expect(section.getByRole('link', { name: '本棚ですべて見る' })).toHaveAttribute('href', '/library');
  const composer = await page.locator('.home-composer').boundingBox(), cards = await section.boundingBox();
  expect(cards!.y + cards!.height).toBeLessThanOrEqual(composer!.y);
  expect(requests).toEqual([]);
  const open = partialCard.getByRole('link', { name: `${full.title}の続きを読む`, exact: true });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await open.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('audio-stage')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('book')).toBe(full.id);
  expect(new URL(page.url()).searchParams.get('revision')).toBe(full.revision);
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(3, 1);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
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
  await expect(section.getByRole('article').filter({ hasText: full.title })).toContainText('保存済みの音声から読む');
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
