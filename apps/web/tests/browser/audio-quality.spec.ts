import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';
import type { AudioBookManifest } from '../../src/generation/contracts';
import { digest, LibraryDisk } from '../../src/generation/core/disk';
import { AudioInspectionService } from '../../src/generation/audio-quality/service';
import { QA_TEXT, qaWave } from '../fixtures/audio-quality/fixture';

test('保存音声QAを実local APIで保存・再検査し、元範囲と判定不能を確認する', async ({ page }, testInfo) => {
  testInfo.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'ripola-browser-qa-')), disk = new LibraryDisk(join(root, 'library'));
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = (portServer.address() as { port: number }).port; await new Promise<void>(resolve => portServer.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, repository = fileURLToPath(new URL('../../../../', import.meta.url));
  const sourceDocument = await prepareDocument(importText(QA_TEXT, 'txt', '自作・保存音声QA'));
  const bytes = qaWave(5, 'silence'), key = digest('qa-browser-audio'), block = sourceDocument.blocks[0];
  const book: AudioBookManifest = { schemaVersion: 1, id: sourceDocument.id, revision: sourceDocument.contentHash, title: sourceDocument.title, document: sourceDocument, updatedAt: '2026-10-12T00:00:00Z',
    options: { provider: 'gemini', voice: 'fixture', transport: 'direct', readings: [] }, warnings: [], precision: 'sentence', completedChunks: 1, totalChunks: 1, durationSeconds: 5,
    chunks: [{ id: 'qa-chunk', speechKey: key, audioUrl: `/api/local-audio/${key}.wav`, mimeType: 'audio/wav', durationSeconds: 5, timeline: [{ chunkId: 'qa-chunk', blockId: block.id, start: 0, end: block.text.length, unitIds: sourceDocument.units.map(u => u.id), startSeconds: 0, endSeconds: 5, precision: 'sentence' }] }] };
  const bookPath = ['books', `${book.id}_${book.revision}.json`];
  await disk.write(bookPath, book); await disk.writeBytes(['audio', `${key}.wav`], bytes); await disk.write(['cache', `${key}.json`], { schemaVersion: 1, status: 'ready', provider: 'gemini', hash: digest(bytes), durationSeconds: 5 });
  const before = await disk.readBytes(bookPath);
  const child = spawn(process.execPath, [join(repository, 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: join(repository, 'apps/web'), stdio: 'ignore', detached: process.platform !== 'win32',
    env: { ...process.env, RSVP_LIBRARY_DIR: disk.root, RSVP_LOCAL_ORIGIN: origin, RSVP_ENABLE_PAID_GENERATION: 'false', GEMINI_API_KEY: '', RSVP_ALIGNMENT_PYTHON: '', RSVP_ALIGNMENT_MODEL_DIR: '' },
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const deadline = Date.now() + 60_000; let ready = false;
    while (!ready && Date.now() < deadline) { try { const response = await fetch(`${origin}/@vite/client`, { signal: AbortSignal.timeout(2000) }); ready = response.ok; await response.body?.cancel(); } catch { /* Wait for the isolated owned server. */ } if (!ready) await delay(100); }
    expect(ready).toBe(true);
    await page.goto(`${origin}/library?book=${book.id}&revision=${book.revision}`);
    const panel = page.locator('section[aria-label="保存音声の品質検査"]');
    await expect(page.getByRole('heading', { name: '保存音声の品質を確認' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: '保存音声を検査する', exact: true }).click();
    const result = page.getByTestId('audio-inspection-result'); await expect(result).toContainText('要確認');
    await result.locator('summary').first().click(); await expect(result).toContainText('音声全体が無音'); await expect(result).toContainText('UTF-16 0–26');
    await expect(result).toContainText('内容検査：判定不能'); await expect(result).toContainText('元音声hash');
    const preview = result.locator('audio'); await preview.evaluate((audio: HTMLAudioElement) => audio.play());
    await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
    await page.getByRole('button', { name: '保存音声を検査する', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('cache再利用 1文');
    await page.getByLabel('手元Reazonモデルで内容の認識候補も比較する').check();
    await page.getByRole('button', { name: '再検査する（再合成なし）', exact: true }).click(); await expect(result).toContainText('手元ASRが未設定');
    await page.reload(); await result.locator('summary').first().click(); await expect(result).toContainText('手元ASRが未設定');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const saved = await new AudioInspectionService(disk).read(book.id, book.revision); expect(saved?.chunks[0].audioHash).toBe(digest(bytes));
    expect(await disk.readBytes(bookPath)).toEqual(before); expect(await disk.readBytes(['audio', `${key}.wav`])).toEqual(bytes); expect(await disk.list('jobs')).toEqual([]); expect(await disk.list('receipts')).toEqual([]); expect(errors).toEqual([]);
  } finally {
    if (child.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
    const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
    await Promise.race([exited, delay(3000)]);
    if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
