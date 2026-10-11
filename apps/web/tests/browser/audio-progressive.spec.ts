import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AudioBookManifest, GenerationJob, JobStatus } from '../../src/generation/contracts';
import { LibraryDisk } from '../../src/generation/core/disk';
import { audioSegments } from '../../src/reader/audio-clock';
import { playbackAnchor, restoreAnchor } from '../../src/reader/audio-progressive';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';
import { browserMp3 } from '../helpers/browser-media';

function tone(seconds: number, frequency: number) {
  const frames = 24000 * seconds; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * frequency / 24000) * 500), 44 + i * 2);
  return bytes;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string, origin: string, server: ChildProcess, disk: LibraryDisk, full: AudioBookManifest;
const jobId = 'progressive-test-job';
let job: GenerationJob;
async function publish(indices: number[], status: JobStatus = 'running', sequence = indices.length, override?: Partial<AudioBookManifest>) {
  const chunks = indices.map(index => full.chunks[index]);
  await disk.write(['books', `${full.id}_${full.revision}.json`], { ...full, chunks, completedChunks: chunks.length, durationSeconds: chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0), generation: { ...full.generation!, sequence }, ...override });
  job = { ...job, status, updatedAt: new Date().toISOString(), completedChunks: chunks.length, chunks: job.chunks.map((chunk, i) => ({ ...chunk, status: indices.includes(i) ? 'completed' : 'pending' })) };
  await disk.write(['jobs', `${jobId}.json`], job);
}
async function open(page: Page) {
  await page.goto(`${origin}/library?book=${full.id}&revision=${full.revision}&job=${jobId}`);
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0);
}
async function pendingPriority() {
  return (await disk.read<GenerationJob>(['jobs', `${jobId}.json`]))?.executionOrder;
}
test.beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'ripola-progressive-')); disk = new LibraryDisk(root);
  const document = await prepareDocument(importText('朝の窓を開きます。次の頁を読みます。最後に本を閉じます。', 'txt', '生成中の自作fixture'));
  const block = document.blocks[0];
  const chunks = [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(block.text)].map((value, i) => ({ id: `c${i}`, sourceOrder: i, speechKey: hash(`progressive-${i}`), audioUrl: `/api/local-audio/${hash(`progressive-${i}`)}.wav`, mimeType: 'audio/wav' as const, durationSeconds: i === 0 ? 2 : 12,
    timeline: [{ blockId: block.id, chunkId: `c${i}`, start: value.index, end: value.index + value.segment.length, unitIds: document.units.filter(unit => unit.start >= value.index && unit.end <= value.index + value.segment.length).map(unit => unit.id), startSeconds: 0, endSeconds: i === 0 ? 2 : 12, precision: 'sentence' as const }] }));
  full = { schemaVersion: 1, id: document.id, revision: hash('progressive-revision'), title: document.title, document, chunks, plannedChunkIds: chunks.map(chunk => chunk.id), generation: { jobId, planId: 'test-plan', planHash: hash('test-plan'), sequence: 3 }, completedChunks: 3, totalChunks: 3, durationSeconds: 26, updatedAt: new Date().toISOString(), precision: 'sentence', options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] }, warnings: [] };
  job = { schemaVersion: 1, id: jobId, operationId: 'test-operation', planId: 'test-plan', bookId: full.id, revision: full.revision, title: full.title, provider: 'voicevox', status: 'running', createdAt: full.updatedAt, updatedAt: full.updatedAt, completedChunks: 1, totalChunks: 3, chunks: chunks.map(chunk => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'pending', attempts: 0, reused: false })) };
  for (let i = 0; i < chunks.length; i++) {
    const bytes = tone(chunks[i].durationSeconds, 220 + i * 50);
    await disk.writeBytes(['audio', `${chunks[i].speechKey}.wav`], bytes);
    await disk.write(['cache', `${chunks[i].speechKey}.json`], { schemaVersion: 1, provider: 'voicevox', status: 'ready', hash: hash(bytes), durationSeconds: chunks[i].durationSeconds });
  }
  // A live owner suppresses restart recovery; tests publish fixtures, never run synthesis.
  await disk.write(['owners', `${jobId}.json`], { pid: process.pid });
  await publish([0]);
  const port = await new Promise<number>(resolvePort => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = (socket.address() as { port: number }).port; socket.close(() => resolvePort(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  let output = '';
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('apps/web'), env: { ...process.env, RSVP_LIBRARY_DIR: root, RSVP_LOCAL_ORIGIN: origin, RSVP_ENABLE_PAID_GENERATION: 'false', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', bytes => { output += String(bytes); }); server.stderr!.on('data', bytes => { output += String(bytes); });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { try { if ((await fetch(origin)).ok) return; } catch { /* Preview is still starting. */ } if (server.exitCode !== null) throw new Error(output); await delay(500); }
  throw new Error(`Isolated preview did not start: ${output}`);
});
test.afterAll(async () => { server?.kill('SIGTERM'); if (root) await rm(root, { recursive: true, force: true }); });

test('生成holeで待機し、次chunk保存後に本文順で再開する', async ({ page }) => {
  await publish([0]); await open(page);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toContainText('次の音声の生成を待っています');
  await expect.poll(pendingPriority).toEqual(['c1', 'c2', 'c0']);
  const replacement = browserMp3(tone(2, 220));
  await page.route('**/fixture-waiting.mp3', route => route.fulfill({ body: replacement.bytes, contentType: 'audio/mpeg' }));
  await publish([0], 'running', 1, { chunks: [{ ...full.chunks[0], audioUrl: '/fixture-waiting.mp3', mimeType: 'audio/mpeg' }] });
  await expect(page.locator('audio')).toHaveAttribute('src', '/fixture-waiting.mp3');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(2, 1);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
  await publish([0, 2]);
  await expect(page.getByText('保存済み 2 / 3 文を再生します。', { exact: false })).toBeVisible();
  await expect(page.getByTestId('audio-stage')).toContainText('次の音声の生成を待っています');
  expect(await page.locator('audio').getAttribute('src')).toContain(full.chunks[0].speechKey);
  await publish([0, 1, 2], 'completed');
  await expect.poll(() => page.locator('audio').getAttribute('src')).toMatch(new RegExp(`${full.chunks[1].speechKey}|^blob:`));
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => !media.paused && media.currentTime > 0)).toBe(true);
  await page.locator('audio').evaluate((media: HTMLAudioElement) => media.pause());
  await expect(page.getByTestId('audio-phrase')).toContainText('次の');
});

test('追加保存と同sequence整列はnative位置を保ち、MP3差替えは同じsourceへ戻る', async ({ page }) => {
  await publish([0, 2]); await open(page);
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('5');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(3, 1);
  await page.locator('audio').evaluate(media => media.setAttribute('data-original', 'retained'));
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await publish([0, 1, 2], 'running');
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeGreaterThan(17);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(false);
  await page.locator('audio').evaluate((media: HTMLAudioElement) => { media.pause(); media.currentTime = 3; });
  await expect.poll(() => page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue()).toBe('17');
  await expect(page.locator('audio')).toHaveAttribute('data-original', 'retained');
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(3, 1);
  const chunk = full.chunks[2];
  const cache = await disk.read<{ hash: string }>(['cache', `${chunk.speechKey}.json`]);
  await publish([0, 1, 2], 'running', 3, { chunks: full.chunks.map(value => value.id === chunk.id ? { ...value, alignment: { schemaVersion: 1, key: hash('fixture-alignment'), audioHash: cache!.hash, normalizeVersion: 'ctc-ja-nfkc-v1', alignerVersion: 'fixture-only', precision: 'sentence', method: 'sentence-fallback', status: 'fallback', cues: [], units: [], warnings: ['更新の証拠'] } } : value) });
  await expect(page.getByText('更新の証拠', { exact: true })).toBeAttached();
  await expect(page.locator('audio')).toHaveAttribute('data-original', 'retained');
  const mp3 = browserMp3(tone(12, 320));
  await page.route('**/fixture-replacement.mp3', route => route.fulfill({ body: mp3.bytes, contentType: 'audio/mpeg' }));
  const before = playbackAnchor(audioSegments(full)[2], 3);
  const changed = { ...full, chunks: full.chunks.map(value => value.id === chunk.id ? { ...value, audioUrl: '/fixture-replacement.mp3', mimeType: 'audio/mpeg' as const } : value) };
  await publish([0, 1, 2], 'running', 3, { chunks: changed.chunks });
  await expect(page.locator('audio')).toHaveAttribute('src', '/fixture-replacement.mp3');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(restoreAnchor(audioSegments(changed), before)!.localSeconds, 1);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
});

test('生成失敗・取消しで待機を解除し、旧jobを拒否して停止位置を保持する', async ({ page }) => {
  for (const status of ['failed', 'cancelled'] as const) {
    await publish([0]); await open(page);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect(page.getByTestId('audio-stage')).toContainText('次の音声の生成を待っています');
    await publish([0], status);
    await expect(page.getByTestId('audio-stage')).not.toContainText('次の音声の生成を待っています');
    expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
    await publish([0, 1], 'running');
    await expect(page.getByText('保存済み 2 / 3 文を再生します。', { exact: false })).toBeVisible();
    expect(await page.locator('audio').getAttribute('src')).toContain(full.chunks[0].speechKey);
    expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(2, 1);
  }
  await publish([0, 1, 2], 'running', 4, { generation: { ...full.generation!, jobId: 'old-job', sequence: 4 } });
  await expect(page.getByText('古い生成結果の更新を停止しました。保存済み音声は保持します。')).toBeVisible();
  expect(await page.locator('audio').getAttribute('src')).toContain(full.chunks[0].speechKey);
});

test('遅いmanifest応答をbook切替で取消し、新しい本へ古い時計を混ぜない', async ({ page }) => {
  await publish([0]);
  const other = { ...full, id: `${full.id}-other`, revision: hash('other-revision'), title: '切替先の自作fixture', document: { ...full.document, id: `${full.id}-other`, title: '切替先の自作fixture' }, generation: undefined, plannedChunkIds: undefined, chunks: [full.chunks[0]], completedChunks: 1, totalChunks: 1, durationSeconds: 2 };
  await disk.write(['books', `${other.id}_${other.revision}.json`], other);
  await open(page);
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('1');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(1, 1);
  let release!: () => void, reached!: () => void, returned!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const held = new Promise<void>(resolveHeld => { reached = resolveHeld; });
  const finished = new Promise<void>(resolveFinished => { returned = resolveFinished; });
  let holding = false;
  await page.route('**/_serverFn/**', async route => {
    const id = new URL(route.request().url()).pathname.split('/_serverFn/')[1];
    let name = '';
    try { name = (JSON.parse(Buffer.from(id, 'base64url').toString()) as { export: string }).export; } catch { /* Other requests pass through. */ }
    if (holding || !name.startsWith('getBook')) return route.continue();
    holding = true;
    const response = await route.fetch(); reached(); await gate;
    try { await route.fulfill({ response }); } catch { /* The reader aborted this old request. */ } finally { returned(); }
  });
  try {
    await held;
    await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
    await page.locator('article').filter({ hasText: other.title }).getByRole('button', { name: '保存音声を読む', exact: true }).click();
    await expect(page.getByRole('heading', { name: other.title, exact: true })).toBeVisible();
    await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.readyState)).toBeGreaterThan(0);
    release(); await finished;
    await expect(page.getByRole('heading', { name: other.title, exact: true })).toBeVisible();
    expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => ({ paused: media.paused, seconds: media.currentTime }))).toEqual({ paused: true, seconds: 0 });
  } finally { release(); }
});
