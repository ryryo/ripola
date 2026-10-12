import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AudioBookManifest, GenerationJob, GenerationOptions } from '../../src/generation/contracts';
import { digest, LibraryDisk } from '../../src/generation/core/disk';
import { wavDuration, type SpeechAdapter } from '../../src/generation/core/providers';
import { GenerationService } from '../../src/generation/core/service';
import { inspectAudioPresentation } from '../../src/reader/audio-presentation';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';

const TITLE = '自作・保存音声の公開回復';
const PENDING_TITLE = '未送信分を含む有料生成';
const repository = fileURLToPath(new URL('../../../../', import.meta.url));

function nonzeroWave(): Buffer {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
  for (let sample = 0; sample < 16000; sample++) bytes.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * 440 * sample / 16000)), 44 + sample * 2);
  return bytes;
}

async function setupPrivateLibraryDisk(root: string, unknownLast: boolean) {
  const disk = new LibraryDisk(join(root, 'library')), bytes = nonzeroWave();
  let sends = 0;
  const gemini: SpeechAdapter = {
    async voices() { return [{ id: 'Kore', name: 'fixture' }]; },
    async synthesize(_request, beforeSend) { await beforeSend(); sends++; return bytes; },
  };
  const service = new GenerationService({ libraryDir: disk.root, localOrigin: 'http://127.0.0.1:4173', paidEnabled: true, geminiApiKey: 'test-only', automaticCompression: false }, { gemini });
  const document = await prepareDocument(importText('朝の光が窓に差します。本を開いて静かに読みます。夕方には机を片付けます。', 'txt', TITLE));
  const options: GenerationOptions = { provider: 'gemini', voice: 'Kore', transport: 'direct', readings: [] };
  const plan = await service.prepareGeneration({ document, options });
  expect(plan.chunks).toHaveLength(3);
  const started = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'publication-browser-fixture', paidConfirmed: true });
  const completed = await service.waitForJob(started.id);
  expect(completed.status).toBe('completed'); expect(sends).toBe(3); expect(wavDuration(bytes)).toBe(1);
  expect(bytes.subarray(44).some(byte => byte !== 0)).toBe(true);
  expect(completed.chunks.map(chunk => [chunk.status, chunk.attempts])).toEqual(Array.from({ length: 3 }, () => ['completed', 1]));
  const bookPath = ['books', `${plan.bookId}_${plan.revision}.json`];
  const completeBook = (await disk.read<AudioBookManifest>(bookPath))!;
  expect(inspectAudioPresentation(completeBook).status).toBe('valid');
  const truncated: AudioBookManifest = { ...completeBook, chunks: completeBook.chunks.slice(0, 1), completedChunks: 1, durationSeconds: completeBook.chunks[0].durationSeconds };
  truncated.presentation = inspectAudioPresentation(truncated);
  expect(truncated.presentation.status).toBe('valid');
  await disk.write(bookPath, truncated);
  const failed: GenerationJob = { ...completed, status: 'failed', error: 'fixture: 保存音声の公開中に書き込みに失敗しました。', updatedAt: new Date().toISOString(), chunks: completed.chunks.map(chunk => ({ ...chunk })) };
  if (unknownLast) {
    failed.chunks[2].status = 'outcome-unknown'; failed.chunks[2].error = 'fixture: 送信後の結果を確認できません。'; failed.completedChunks = 2;
    const key = failed.chunks[2].speechKey;
    await disk.removeVerified(['audio', `${key}.wav`], digest(bytes));
    await unlink(await disk.existingPath(['cache', `${key}.json`]));
  }
  await disk.write(['jobs', `${failed.id}.json`], failed);
  let pending: GenerationJob | undefined;
  if (!unknownLast) {
    // Distinct speech keys make the ordinary resume genuinely require unsent paid speech.
    const pendingPlan = await service.prepareGeneration({ document, options: { ...options, style: '通常の有料再開の確認' } });
    expect(pendingPlan.chunks.every(chunk => !chunk.cacheHit)).toBe(true);
    pending = { ...failed, id: `pending-${failed.id}`, planId: pendingPlan.id, title: PENDING_TITLE, completedChunks: 0,
      chunks: pendingPlan.chunks.map(chunk => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'pending', attempts: 0, reused: false })) };
    await disk.write(['jobs', `${pending.id}.json`], pending);
  }
  const savedKeys = failed.chunks.slice(0, unknownLast ? 2 : 3).map(chunk => chunk.speechKey);
  for (const key of savedKeys) expect(await disk.readBytes(['audio', `${key}.wav`])).toEqual(bytes);
  return { disk, job: failed, bookPath, truncated, bytes, savedKeys, pending };
}

// The build exports a Fetch handler. Keep real server functions/SSR while isolating
// configuration discovery and blocking every provider request before any connection.
const builtPreview = String.raw`
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
const [origin, serverFile, clientRoot, outboundLog] = process.argv.slice(1);
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin !== origin) {
    appendFileSync(outboundLog, JSON.stringify({ method: request.method, url: request.url }) + '\n');
    throw new Error('isolated publication test blocked provider connection');
  }
  return originalFetch(input, init);
};
const { default: entry } = await import(pathToFileURL(serverFile).href);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain' };
createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    const file = resolve(clientRoot, '.' + decodeURIComponent(url.pathname));
    const within = relative(clientRoot, file);
    if (['GET', 'HEAD'].includes(incoming.method) && !within.startsWith('..')) {
      try {
        const bytes = await readFile(file);
        outgoing.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        outgoing.end(incoming.method === 'HEAD' ? undefined : bytes); return;
      } catch (error) { if (!['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(key, item);
    const request = new Request(url, { method: incoming.method, headers, ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) });
    const response = await entry.fetch(request);
    outgoing.statusCode = response.status;
    for (const [key, value] of response.headers) outgoing.setHeader(key, value);
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing); else outgoing.end();
  } catch (error) { console.error(error); outgoing.statusCode = 500; outgoing.end('isolated built preview failed'); }
}).listen(Number(new URL(origin).port), '127.0.0.1');
`;

async function selectJob(page: Page, title: string): Promise<void> {
  await page.getByLabel('ジョブを選択', { exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^${title} ·`) }).click();
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
  const signal = (value: NodeJS.Signals) => { if (child.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, value); } catch { /* Owned server already exited. */ } } };
  signal('SIGTERM'); await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
  await exited;
}

for (const unknownLast of [false, true]) {
  test(unknownLast ? '結果不明の有料音声を再送せず、保存済み2音声だけの公開を回復する' : '有料ジョブの公開失敗を保存済み3音声だけで再試行し、課金確認と再合成を要求しない', async ({ page }, testInfo) => {
    testInfo.setTimeout(180_000);
    const root = await mkdtemp(join(tmpdir(), 'ripola-browser-publication-'));
    let child: ChildProcess | undefined, serverLog = '';
    const outboundLog = join(root, 'blocked-provider-requests.jsonl');
    try {
      const fixture = await setupPrivateLibraryDisk(root, unknownLast);
      // Empty private root prevents .env.local, alignment setup and Irodori discovery.
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ripola', private: true, type: 'module' }));
      await writeFile(outboundLog, '');
      const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
      const port = (portServer.address() as { port: number }).port; await new Promise<void>(resolve => portServer.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, ['--input-type=module', '-e', builtPreview, origin, join(repository, 'apps/web/dist/server/server.js'), join(repository, 'apps/web/dist/client'), outboundLog], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        // No inherited credentials or executable discovery; optional compression is unavailable.
        env: { PATH: root, LANG: 'en_US.UTF-8', RSVP_LIBRARY_DIR: fixture.disk.root, RSVP_LOCAL_ORIGIN: origin, RSVP_ENABLE_PAID_GENERATION: 'false', GEMINI_API_KEY: '', RSVP_IRODORI_EXECUTABLE: join(root, 'unavailable-native') },
      });
      const log = (data: Buffer) => { serverLog = (serverLog + data.toString()).slice(-65536); };
      child.stdout!.on('data', log); child.stderr!.on('data', log);
      child.on('error', error => log(Buffer.from(error.message)));
      const errors: string[] = [], externalBrowserRequests: string[] = [], localPosts: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).origin === origin) localPosts.push(request.url()); });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) await route.continue();
        else { externalBrowserRequests.push(url.href); await route.abort('blockedbyclient'); }
      });
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (!ready && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try { const response = await fetch(`${origin}/THIRD-PARTY-LICENSES.md`, { signal: AbortSignal.timeout(1000) }); ready = response.ok; await response.body?.cancel(); } catch { /* Wait for the owned loopback listener. */ }
        if (!ready) await delay(100);
      }
      expect(ready, serverLog).toBe(true);
      await page.goto(`${origin}/generate`, { timeout: 60_000 });
      await expect(page.getByRole('heading', { name: '生成ジョブ', exact: true })).toBeVisible({ timeout: 60_000 });
      await selectJob(page, TITLE);
      const retry = page.getByRole('button', { name: '保存済み音声の公開を再試行', exact: true });
      await expect(retry).toBeEnabled();
      await expect(page.getByRole('heading', { name: '有料生成の再開前に確認' })).toHaveCount(0);
      await retry.click();
      const readJob = () => fixture.disk.read<GenerationJob>(['jobs', `${fixture.job.id}.json`]);
      await expect.poll(async () => (await readJob())?.status, { timeout: 30_000 }).toBe(unknownLast ? 'outcome-unknown' : 'completed');
      const expectedCount = unknownLast ? 2 : 3;
      await expect(page.locator('.generation-job-heading')).toContainText(`${expectedCount} / 3文`);
      await expect(retry).toHaveCount(0);
      const recovered = (await fixture.disk.read<AudioBookManifest>(fixture.bookPath))!;
      expect(recovered.completedChunks).toBe(expectedCount); expect(recovered.totalChunks).toBe(3);
      expect(recovered.chunks.map(chunk => chunk.speechKey)).toEqual(fixture.savedKeys);
      expect(recovered.generation?.jobId).toBe(fixture.job.id);
      expect(recovered.generation!.sequence).toBeGreaterThan(fixture.truncated.generation!.sequence);
      expect(inspectAudioPresentation(recovered).status).toBe('valid');
      const after = (await readJob())!;
      expect(after.chunks.map(chunk => chunk.attempts)).toEqual(fixture.job.chunks.map(chunk => chunk.attempts));
      for (const key of fixture.savedKeys) expect(await fixture.disk.readBytes(['audio', `${key}.wav`])).toEqual(fixture.bytes);
      expect(await fixture.disk.list('receipts')).toHaveLength(0);
      expect(localPosts).toHaveLength(1);
      if (unknownLast) {
        const unknown = after.chunks[2]; expect(unknown.status).toBe('outcome-unknown');
        expect(await fixture.disk.readBytes(['audio', `${unknown.speechKey}.wav`])).toBeUndefined();
        expect(await fixture.disk.read(['cache', `${unknown.speechKey}.json`])).toBeUndefined();
        await expect(page.getByText('送信後の結果が不明な文は自動再送しません。', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: '再開する対象と費用を確認', exact: true })).toHaveCount(0);
      } else {
        await selectJob(page, PENDING_TITLE);
        await expect(retry).toHaveCount(0);
        await page.getByRole('button', { name: '再開する対象と費用を確認', exact: true }).click();
        await expect(page.getByRole('heading', { name: '有料生成の再開前に確認' })).toBeVisible();
        const confirmation = page.getByRole('checkbox', { name: '未完了分の送信先・本文・費用を確認し、有料生成を再開します。', exact: true });
        await expect(confirmation).not.toBeChecked();
        const submit = page.getByRole('button', { name: '確認した未完了分だけを有料生成する', exact: true });
        await expect(submit).toBeDisabled();
        expect((await fixture.disk.read<GenerationJob>(['jobs', `${fixture.pending!.id}.json`]))?.chunks.map(chunk => chunk.attempts)).toEqual([0, 0, 0]);
        expect(localPosts).toHaveLength(1);
        await selectJob(page, TITLE);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('link', { name: '保存音声を読む', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/library\\?book=${recovered.id}&revision=${recovered.revision}`));
      await expect(page.locator('audio').first()).toHaveAttribute('src', /\/api\/local-audio\//);
      expect(externalBrowserRequests).toEqual([]); expect(errors).toEqual([]);
      const blocked: Array<{ method: string; url: string }> = (await readFile(outboundLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      // Config may probe local VOICEVOX availability; even that GET was blocked.
      expect(blocked.filter(request => request.method !== 'GET' || request.url !== 'http://127.0.0.1:50021/speakers')).toEqual([]);
    } finally {
      if (child) await stopServer(child);
      await testInfo.attach('publication built server', { body: Buffer.from(serverLog), contentType: 'text/plain' });
      await rm(root, { recursive: true, force: true });
    }
  });
}
