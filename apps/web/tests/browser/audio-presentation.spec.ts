import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { GenerationService } from '../../src/generation/core/service';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';
import { stageLibrary } from '../../../../scripts/stage-library';
import { buildDistribution } from '../../../../scripts/build-distribution.mjs';
import { contentHash } from '../../../../scripts/distribution-utils.mjs';
import type { PublicLibraryManifest } from '../../src/distribution/library';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
function tone() {
  const frames = 24000 * 3; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 24000) * 500), 44 + i * 2);
  return bytes;
}
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test('新規保存を実local APIで再開・seek・有音再生し、AAC静的配布でも全区切りを検査する', async ({ page }, testInfo) => {
  testInfo.setTimeout(180000);
  let staticServer: Server | undefined;
  const root = await mkdtemp(join(tmpdir(), 'rsvp-browser-presentation-'));
  const origin = `http://127.0.0.1:${await freePort()}`; const libraryDir = join(root, 'library'); let calls = 0;
  const config = { libraryDir, localOrigin: origin, paidEnabled: false };
  const provider = { async voices() { return [{ id: '3', name: 'Synthetic tone fixture' }]; }, async synthesize(_request: unknown, beforeSend: () => Promise<void>) { await beforeSend(); calls++; return tone(); } };
  const service = new GenerationService(config, { voicevox: provider });
  const sourceDocument = await prepareDocument(importText('<ruby>東京<rt>とうきょう</rt></ruby>の図書館で本を読みます。次の頁を静かに開きます。', 'md', '自作・新規保存から配布'));
  const plan = await service.prepareGeneration({ document: sourceDocument, options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] } });
  const job = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'browser-save', paidConfirmed: false });
  expect((await service.waitForJob(job.id)).status).toBe('completed'); const book = await service.getBook(job.bookId, job.revision);
  const expected = book.presentation!.chunks.flatMap(chunk => chunk.displayedUnitIds); expect(expected.length).toBeGreaterThan(2);
  const child = spawn(process.execPath, [join(repository, 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'], {
    cwd: join(repository, 'apps/web'), stdio: 'ignore', detached: process.platform !== 'win32',
    env: { ...process.env, RSVP_LIBRARY_DIR: libraryDir, RSVP_LOCAL_ORIGIN: origin, RSVP_ENABLE_PAID_GENERATION: 'false', GEMINI_API_KEY: '' },
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const deadline = Date.now() + 60000; let ready = false;
    while (Date.now() < deadline && !ready) { try { const response = await fetch(origin); ready = response.ok; await response.body?.cancel(); } catch { /* Wait only for this owned temporary server. */ } if (!ready) await delay(100); }
    expect(ready, 'temporary isolated local server').toBe(true);
    const localUrl = `${origin}/library?book=${book.id}&revision=${book.revision}`;
    await page.goto(localUrl); await expect(page.getByTestId('audio-phrase')).toBeVisible();
    await expect(page.getByTestId('audio-precision')).toContainText('表示用推定');
    await expect(page.getByTestId('audio-presentation-report')).toContainText(`表示 ${expected.length} / ${expected.length}`);
    const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true }); await slider.fill('1.3');
    const resumed = await page.getByTestId('audio-phrase').getAttribute('data-unit-id'); await page.reload();
    await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', resumed!); await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    // A real local POST renames metadata only; the saved audio and source anchors stay intact.
    const savedManifestPath = join(libraryDir, 'books', `${book.id}_${book.revision}.json`);
    const originalManifest = await readFile(savedManifestPath);
    const originalAudio = await readFile(join(libraryDir, 'audio', `${book.chunks[0].speechKey}.wav`));
    const beforeRename = await slider.inputValue();
    await page.getByRole('button', { name: '表示設定', exact: true }).click();
    await page.getByLabel('タイトルを変更', { exact: true }).fill('読書画面で変更した名前');
    await page.getByRole('button', { name: '名前を変更', exact: true }).click();
    await expect(page.locator('.title-status')).toContainText('名前を変更');
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.locator('.generation-title h1')).toHaveText('読書画面で変更した名前');
    expect(await slider.inputValue()).toBe(beforeRename);
    await page.reload(); await expect(page.locator('.generation-title h1')).toHaveText('読書画面で変更した名前');
    await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', resumed!);
    await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
    await page.locator('summary').filter({ hasText: '名前を変更' }).click();
    await page.getByLabel('タイトルを変更', { exact: true }).fill('本棚で変更した名前');
    await page.getByRole('button', { name: '名前を変更', exact: true }).click();
    await expect(page.locator('.library-grid h2')).toHaveText('本棚で変更した名前');
    await page.reload(); await expect(page.locator('.library-grid h2')).toHaveText('本棚で変更した名前');
    expect(await readFile(savedManifestPath)).toEqual(originalManifest);
    expect(await readFile(join(libraryDir, 'audio', `${book.chunks[0].speechKey}.wav`))).toEqual(originalAudio);
    expect(calls).toBe(2);
    const renamedBook = await service.getBook(book.id, book.revision);
    expect(renamedBook.id).toBe(book.id); expect(renamedBook.revision).toBe(book.revision);
    expect(renamedBook.document.units).toEqual(book.document.units);
    const stage = join(root, 'stage');
    await stageLibrary({ target: 'worker', libraryDir, books: [{ id: book.id, revision: book.revision, rightsConfirmed: true, publicDemo: true, attribution: 'Self-authored text and synthetic tone; no TTS or acoustic accuracy measurement.' }] }, { output: stage });
    const catalog = JSON.parse(await readFile(join(stage, 'library/index.json'), 'utf8')) as PublicLibraryManifest;
    const entry = catalog.books[0]; const bytes = await readFile(join(stage, entry.manifestUrl)); const publicBook = JSON.parse(bytes.toString());
    // Use the normal output paths in an isolated application copy. TanStack's SPA
    // prerenderer does not honor a CLI outDir override consistently; do not mutate
    // the user's live build or let the desktop/mobile builds share generated files.
    const buildApp = join(root, 'app'); await mkdir(buildApp);
    for (const name of ['src', 'public', 'vite.config.ts', 'tsconfig.json', 'package.json']) {
      await cp(join(repository, 'apps/web', name), join(buildApp, name), { recursive: true });
    }
    await symlink(join(repository, 'apps/web/node_modules'), join(buildApp, 'node_modules'), 'dir');
    await new Promise<void>((resolveBuild, reject) => {
      const build = spawn(process.execPath, [join(repository, 'apps/web/node_modules/vite/bin/vite.js'), 'build'], {
        cwd: buildApp, stdio: 'ignore', env: { ...process.env, VITE_RSVP_PROFILE: 'worker', GEMINI_API_KEY: '' },
      });
      build.on('error', reject); build.on('exit', code => code === 0 ? resolveBuild() : reject(new Error('Isolated public build failed')));
    });
    const publicRoot = join(root, 'public'); await buildDistribution({ profile: 'worker', client: join(buildApp, 'dist/worker/client'), staging: stage, output: publicRoot });
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.m4a': 'audio/mp4', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
    staticServer = createHttpServer((request, response) => { void (async () => {
      let path = resolve(publicRoot, '.' + new URL(request.url!, 'http://127.0.0.1').pathname);
      if (!path.startsWith(publicRoot + '/') && path !== publicRoot) { response.writeHead(404); response.end(); return; }
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      const media = await readFile(path); const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      const headers = { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Content-Length': String(media.length), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (range) {
        const begin = Number(range[1]); const finish = Math.min(media.length - 1, range[2] ? Number(range[2]) : media.length - 1);
        response.writeHead(206, { ...headers, 'Content-Length': String(finish - begin + 1), 'Content-Range': `bytes ${begin}-${finish}/${media.length}` }); response.end(media.subarray(begin, finish + 1));
      } else { response.writeHead(200, headers); response.end(request.method === 'HEAD' ? undefined : media); }
    })().catch(() => { response.writeHead(404); response.end(); }); });
    await new Promise<void>(resolveListen => staticServer!.listen(0, '127.0.0.1', resolveListen));
    const publicOrigin = `http://127.0.0.1:${(staticServer.address() as { port: number }).port}`;
    // Real local API/WAV and real compiled static HTTP/AAC share AudioReader; no network fulfillment mocks.
    for (const url of [localUrl, `${publicOrigin}/books/?book=${book.id}&revision=${book.revision}`]) {
      await page.evaluate(() => localStorage.clear()); await page.goto(url); await expect(page.getByTestId('audio-phrase')).toBeVisible();
      await page.getByRole('button', { name: '先頭へ戻る', exact: true }).click();
      await expect(page.locator('[data-testid="audio-phrase"] rt')).toHaveText('とうきょう');
      await page.evaluate(() => {
        const target = window as typeof window & { phraseSeen: Set<string> }; target.phraseSeen = new Set();
        const record = () => { const id = document.querySelector('[data-testid="audio-phrase"]')?.getAttribute('data-unit-id'); if (id) target.phraseSeen.add(id); };
        new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-unit-id'] }); record();
      });
      await page.getByRole('button', { name: '再生', exact: true }).click(); await expect(page.getByRole('button', { name: 'もう一度', exact: true })).toBeVisible();
      const seen = await page.evaluate(() => [...(window as typeof window & { phraseSeen: Set<string> }).phraseSeen]);
      expect(expected.filter(id => !seen.includes(id))).toEqual([]);
      expect(await page.locator('audio').evaluate((element: HTMLAudioElement) => element.muted)).toBe(false);
      expect(await page.getByTestId('audio-phrase').getAttribute('data-unit-id')).toBe(expected.at(-1));
      await expect(page.getByTestId('audio-presentation-report')).toContainText('欠落 0');
      await expect(page.getByTestId('audio-precision')).not.toContainText('文単位');
    }
    expect(calls).toBe(2); expect(errors).toEqual([]);
    // Uninspectable/stale data cannot be presented as a successful sentence fallback.
    const savedPath = join(libraryDir, 'books', `${book.id}_${book.revision}.json`); const saved = JSON.parse(await readFile(savedPath, 'utf8')); saved.document.units = [];
    await writeFile(savedPath, JSON.stringify(saved)); await page.goto(localUrl); await expect(page.getByRole('alert')).toContainText('検査に失敗'); await expect(page.locator('audio')).toHaveCount(0);
    publicBook.document.units = []; const broken = Buffer.from(JSON.stringify(publicBook)); entry.manifestSha256 = contentHash(broken); entry.manifestBytes = broken.length;
    await writeFile(join(publicRoot, entry.manifestUrl), broken); await writeFile(join(publicRoot, 'library/index.json'), JSON.stringify(catalog));
    await page.goto(`${publicOrigin}/books/?book=${book.id}&revision=${book.revision}`); await expect(page.getByRole('alert')).toContainText('検査に失敗'); await expect(page.locator('audio')).toHaveCount(0);
  } finally {
    if (staticServer) { staticServer.closeAllConnections(); await new Promise<void>(resolveClose => staticServer!.close(() => resolveClose())); }
    if (child.pid) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* Owned server already exited. */ } }
    await delay(200); await rm(root, { recursive: true, force: true });
  }
});
