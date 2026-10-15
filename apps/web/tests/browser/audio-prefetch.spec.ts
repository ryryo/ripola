import { expect, test, type Page } from '@playwright/test';
import { audioResponse } from '../../src/server/audio-response';
import { createHash } from 'node:crypto';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';
import { browserMp3 } from '../helpers/browser-media';
import { AUDIO_DEMOS } from '../../src/reader/audio-demo';
import { audioSegments, locateAudioTime, type PlayableAudioBook } from '../../src/reader/audio-clock';

function tone(seconds = 2, frequency = 440) {
  const frames = 24000 * seconds; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * frequency / 24000) * 500), 44 + i * 2);
  return bytes;
}
async function fixture(page: Page, slow: boolean | 'all' = false) {
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
  let finishSlow!: () => void;
  const slowFinished = new Promise<void>(resolve => { finishSlow = resolve; });
  const readingDocument = await prepareDocument(importText('朝の窓を開きます。次の頁を読みます。最後に本を閉じます。', 'txt', '先読みの自作fixture'));
  const id = 'prefetch-fixture'; const revision = 'prefetch-v1';
  const media = [0, 1, 2].map(index => browserMp3(tone(2, 220 + index * 50)));
  const chunks = readingDocument.blocks.flatMap(block => [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(block.text)].map((value, i) => ({
    id: `c${i}`, audioUrl: `library/books/${id}/${revision}/media/${media[i].sha256}.mp3`, durationSeconds: 2, sourceDurationSeconds: 2,
    mimeType: 'audio/mpeg', sha256: media[i].sha256, bytes: media[i].bytes.length, timing: { verification: 'pcm-correlated' },
    timeline: [{ blockId: block.id, chunkId: `c${i}`, start: value.index, end: value.index + value.segment.length,
      unitIds: readingDocument.units.filter(unit => unit.start >= value.index && unit.end <= value.index + value.segment.length).map(unit => unit.id), startSeconds: 0, endSeconds: 2, precision: 'sentence' }],
  })));
  const manifest = JSON.stringify({ schemaVersion: 1, id, revision, title: readingDocument.title, updatedAt: '2026-10-12T00:00:00Z', document: readingDocument, chunks, warnings: [], completedChunks: 3, totalChunks: 3, durationSeconds: 6, precision: 'sentence', attribution: '自作文と合成tone' });
  const catalog = { schemaVersion: 1, target: 'worker', createdAt: '2026-10-12T00:00:00Z', books: [{ id, revision, title: readingDocument.title, manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'), manifestBytes: Buffer.byteLength(manifest), durationSeconds: 6, precision: 'sentence', attribution: '自作文', publicDemo: false }] };
  await page.route('**/library/index.json', route => route.fulfill({ json: catalog }));
  await page.route('**/manifest.json', route => route.fulfill({ body: manifest, contentType: 'application/json' }));
  const requested: number[] = [];
  await page.route('**/media/*.mp3', async route => {
    const hash = new URL(route.request().url()).pathname.split('/').at(-1)!.split('.')[0];
    const index = media.findIndex(audio => audio.sha256 === hash); requested.push(index);
    const delayed = slow && index === 1 && (slow === 'all' || route.request().resourceType() === 'fetch');
    if (delayed) await slowGate;
    const response = audioResponse(media[index].bytes, new Request(route.request().url(), { headers: route.request().headers() }), 'audio/mpeg');
    await route.fulfill({ body: Buffer.from(await response.arrayBuffer()), status: response.status, headers: Object.fromEntries(response.headers) }).catch(() => undefined);
    if (delayed) finishSlow();
  });
  await page.addInitScript(() => {
    const target = window as typeof window & { prefetchEvidence: { aborted: number; abortedSources: string[]; urls: string[]; revoked: string[]; requestedAt: Array<{ active: string; seconds: number; receiverIsWindow: boolean }>; clocks: Array<{ absolute: number; local: number }> } };
    target.prefetchEvidence = { aborted: 0, abortedSources: [], urls: [], revoked: [], requestedAt: [], clocks: [] };
    const fetchOriginal = window.fetch;
    window.fetch = function (this: typeof window, input, options) {
      if (String(input).includes('/media/') && options?.signal) {
        const media = document.querySelector('audio');
        target.prefetchEvidence.requestedAt.push({ active: media?.src ?? '', seconds: media?.currentTime ?? 0, receiverIsWindow: this === window });
        options.signal.addEventListener('abort', () => { target.prefetchEvidence.aborted++; target.prefetchEvidence.abortedSources.push(String(input)); });
      }
      return fetchOriginal.call(this, input, options);
    };
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); target.prefetchEvidence.urls.push(url); return url; };
    URL.revokeObjectURL = url => { target.prefetchEvidence.revoked.push(url); revoke(url); };
    document.addEventListener('playing', event => {
      const media = event.target as HTMLAudioElement;
      if (media.tagName === 'AUDIO') target.prefetchEvidence.clocks.push({ absolute: Number((document.querySelector('#audio-position') as HTMLInputElement)?.value), local: media.currentTime });
    }, true);
  });
  await page.goto(`/books?book=${id}&revision=${revision}`);
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  return { requested, releaseSlow, slowFinished, successorHash: media[1].sha256 };
}

test('次音声は切替前に取得し、source順とmedia時計を保って連続再生する', async ({ page }) => {
  const { requested: requests } = await fixture(page);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => requests.includes(1)).toBe(true);
  await expect.poll(() => page.locator('audio').getAttribute('src')).toMatch(/^blob:/);
  expect(requests.filter(index => index === 1)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'もう一度', exact: true })).toBeVisible();
  await expect(page.getByTestId('audio-phrase')).toContainText('閉じます');
  const evidence = await page.evaluate(() => (window as typeof window & { prefetchEvidence: { requestedAt: Array<{ active: string; seconds: number; receiverIsWindow: boolean }>; clocks: Array<{ absolute: number; local: number }> } }).prefetchEvidence);
  expect(evidence.requestedAt.length).toBeGreaterThan(0);
  expect(evidence.requestedAt.every(request => request.receiverIsWindow)).toBe(true);
  expect(evidence.requestedAt[0].active).not.toMatch(/^blob:/);
  expect(evidence.requestedAt[0].seconds).toBeLessThan(2);
  const offsets = evidence.clocks.map(clock => Math.max(0, Math.round((clock.absolute - clock.local) / 2) * 2));
  expect(offsets.filter((offset, i) => i === 0 || offset !== offsets[i - 1])).toEqual([0, 2, 4]);
});

for (const fullscreen of [false, true]) test(`次音声の読込待ちを表示し、停止・再開できる（${fullscreen ? '全画面' : '通常'}）`, async ({ page }, testInfo) => {
  const { releaseSlow, successorHash } = await fixture(page, 'all');
  if (fullscreen) {
    await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('test denied')); });
    await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  }
  const stage = page.getByTestId('audio-stage');
  const status = stage.getByRole('status');
  try {
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect(page.locator('audio')).toHaveAttribute('src', new RegExp(`${successorHash}\\.mp3$`));
    await expect(status).toContainText('音声を読み込み中');
    await expect(status).toBeVisible();
    await expect(status.locator('.mantine-Loader-root')).toBeVisible();
    expect(await status.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await testInfo.attach('音声の読込待ち', { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Space');
    await expect(status).toHaveText('一時停止');
    expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect(status).toContainText('音声を読み込み中');
    releaseSlow();
    await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeGreaterThan(.2);
    await expect(status).not.toContainText('読み込み中');
    await expect(stage).toHaveAttribute('data-buffering', 'false');
  } finally { releaseSlow(); }
});

test('slow networkの先読みはseek・停止・book離脱で取消され、遅延音声を再生しない', async ({ page }) => {
  const { releaseSlow } = await fixture(page, true);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { prefetchEvidence: { urls: string[] } }).prefetchEvidence.urls.length)).toBeGreaterThan(0);
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('4.2');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { prefetchEvidence: { aborted: number } }).prefetchEvidence.aborted)).toBeGreaterThan(0);
  await page.locator('audio').evaluate((media: HTMLAudioElement) => media.pause());
  const targetSource = await page.locator('audio').getAttribute('src');
  const stoppedPhrase = await page.getByTestId('audio-phrase').getAttribute('data-unit-id');
  releaseSlow();
  await page.waitForTimeout(1300);
  await expect(page.locator('audio')).toHaveAttribute('src', targetSource!);
  await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', stoppedPhrase!);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(page.locator('audio')).toHaveCount(0);
  const evidence = await page.evaluate(() => (window as typeof window & { prefetchEvidence: { urls: string[]; revoked: string[] } }).prefetchEvidence);
  expect(evidence.urls.length).toBeGreaterThan(0);
  expect(evidence.urls.every(url => evidence.revoked.includes(url))).toBe(true);
});

test('未完了の先読みをactiveにするとnative音声へ引き渡し、pause・再seekでもsource時計を保つ', async ({ page }) => {
  const { requested, releaseSlow, slowFinished, successorHash } = await fixture(page, true);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => requested.includes(1)).toBe(true);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('2.25');
  await expect(page.locator('audio')).toHaveAttribute('src', new RegExp(`${successorHash}\\.mp3$`));
  await expect.poll(() => page.evaluate(hash => (window as typeof window & { prefetchEvidence: { abortedSources: string[] } }).prefetchEvidence.abortedSources.some(url => url.includes(hash)), successorHash)).toBe(true);
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeGreaterThan(.3);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await slider.fill('2.65');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(.65, 1);
  const source = await page.locator('audio').getAttribute('src');
  const urls = await page.evaluate(() => (window as typeof window & { prefetchEvidence: { urls: string[] } }).prefetchEvidence.urls);
  releaseSlow(); await slowFinished;
  await expect(page.locator('audio')).toHaveAttribute('src', source!);
  const clock = await page.locator('audio').evaluate((media: HTMLAudioElement) => ({ paused: media.paused, local: media.currentTime,
    absolute: Number((document.querySelector('#audio-position') as HTMLInputElement).value) }));
  expect(clock.paused).toBe(true);
  expect(clock.local).toBeCloseTo(.65, 1);
  expect(clock.absolute).toBeCloseTo(2 + clock.local, 1);
  expect(await page.evaluate(() => (window as typeof window & { prefetchEvidence: { urls: string[] } }).prefetchEvidence.urls)).toEqual(urls);
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(page.locator('audio')).toHaveCount(0);
  const evidence = await page.evaluate(() => (window as typeof window & { prefetchEvidence: { urls: string[]; revoked: string[] } }).prefetchEvidence);
  expect(evidence.urls.every(url => evidence.revoked.includes(url))).toBe(true);
});

test('完成したactive blobはpause・再seek中も保持し、book離脱時に解放する', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { prefetchEvidence: { urls: string[] } }).prefetchEvidence.urls.length)).toBe(2);
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('2.25');
  await expect(page.locator('audio')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeGreaterThan(.2);
  const source = await page.locator('audio').getAttribute('src');
  await page.locator('audio').evaluate((media: HTMLAudioElement) => media.pause());
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await slider.fill('2.65');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(.65, 1);
  await expect(page.locator('audio')).toHaveAttribute('src', source!);
  const clock = await page.locator('audio').evaluate((media: HTMLAudioElement) => ({ paused: media.paused, local: media.currentTime,
    absolute: Number((document.querySelector('#audio-position') as HTMLInputElement).value) }));
  expect(clock.paused).toBe(true);
  expect(clock.absolute).toBeCloseTo(2 + clock.local, 1);
  expect(await page.evaluate(() => (window as typeof window & { prefetchEvidence: { revoked: string[] } }).prefetchEvidence.revoked)).not.toContain(source);
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await expect(page.locator('audio')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { prefetchEvidence: { revoked: string[] } }).prefetchEvidence.revoked)).toContain(source);
});

test('旧AACの静的サンプルでmedia時計・倍速・明示seekを保つ', async ({ page }) => {
  const sample = AUDIO_DEMOS[0];
  const response = await page.request.get(`/samples/audio/library/books/${sample.id}/${sample.revision}/manifest.json`);
  expect(response.ok()).toBe(true);
  const segments = audioSegments(await response.json() as PlayableAudioBook);
  await page.goto(`/demo?sample=${AUDIO_DEMOS[0].key}`);
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  const slider = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await slider.fill('10');
  await expect.poll(() => page.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeCloseTo(locateAudioTime(segments, 10).localSeconds, 1);
  expect(await page.locator('audio').getAttribute('src')).toMatch(/\.m4a$/);
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '1.5倍', exact: true }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(10.2);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const clock = await page.locator('audio').evaluate((media: HTMLAudioElement) => ({ local: media.currentTime, rate: media.playbackRate, ended: media.ended, duration: media.duration, src: media.src,
    unitId: document.querySelector('[data-testid="audio-phrase"]')?.getAttribute('data-unit-id'), absolute: Number((document.querySelector('#audio-position') as HTMLInputElement).value) }));
  const active = segments.find(segment => segment.displayCues.some(cue => cue.unitIds.includes(clock.unitId ?? '')))!;
  expect(active).toBeDefined(); expect(clock.rate).toBe(1.5);
  if (!clock.src.startsWith('blob:')) expect(clock.src).toContain(active.chunk.audioUrl.split('/').at(-1)!);
  // At natural completion the saved boundary is also the next chunk's start.
  // Match the captured source, including decoder rounding, before inverting it.
  expect(clock.absolute).toBeCloseTo(clock.ended ? active.endSeconds : active.startSeconds + Math.min(active.chunk.durationSeconds, clock.local), 1);
  if (clock.ended) expect(clock.local).toBeCloseTo(clock.duration, 1);
  const previous = await page.getByTestId('audio-phrase').getAttribute('data-unit-id');
  await page.getByRole('button', { name: '一文進む', exact: true }).click();
  await expect(page.getByTestId('audio-phrase')).not.toHaveAttribute('data-unit-id', previous!);
  expect(await page.locator('audio').evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
});
