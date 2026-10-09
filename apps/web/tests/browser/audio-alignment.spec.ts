import { createHash } from 'node:crypto';
import { inspectCalmPlayback } from './calm-inspection';
import { inspectGuides } from './guide-inspection';
import { expect, test, type Page } from '@playwright/test';
import type { ReadingDocument, ReadingUnit } from '../../src/reader/model';
import { browserMp3 } from '../helpers/browser-media';
import { installWakeLock } from '../helpers/screen-wake-lock';

// Synthetic local tone + authored text test only the player's clock and mapping.
// These cue scores are fixtures, not evidence about an acoustic model's accuracy.
const revision = 'b'.repeat(64);
const bookId = 'alignment-fixture';
const text = '私は図書館へ。今日は読む。';
function unit(id: string, value: string, start: number): ReadingUnit {
  return { id, text: value, start, end: start + value.length, blockId: 'b', kind: 'text', characters: value.length,
    cumulativeCharacters: start, mapping: 'exact', ruby: [], pause: 'none', sources: [{ kind: 'text', start, end: start + value.length }] };
}
function toneWave(seconds = 4, frequency = 220): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) output.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * frequency / rate) * 600), 44 + index * 2);
  return output;
}

async function installAudioFixture(page: Page, fallback?: 'low-score' | 'silence' | 'reading-mismatch', publicDemo = true) {
  const units = [unit('u0', '私は', 0), unit('u1', '図書館へ。', 2), unit('u2', '今日は', 7), unit('u3', '読む。', 10)];
  units[1].ruby = [{ start: 0, end: 3, reading: 'としょかん' }];
  const document: ReadingDocument = { id: bookId, contentHash: revision, title: 'フレーズ同期のUI検証', format: 'txt', rawText: text,
    blocks: [{ id: 'b', text, kind: 'paragraph', runs: [], ruby: [{ start: 2, end: 5, reading: 'としょかん' }] }], units,
    warnings: [], totalCharacters: text.length, versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' } };
  const media = [0, 1].map(index => browserMp3(toneWave(4, 220 + index * 30)));
  const chunks = media.map((audio, index) => ({ id: `c${index}`, audioUrl: `library/books/${bookId}/${revision}/media/${audio.sha256}.mp3`, mimeType: 'audio/mpeg', sha256: audio.sha256, bytes: audio.bytes.length, durationSeconds: 4,
    // This is a UI contract fixture, not a PCM-correlation or model accuracy measurement.
    timing: { verification: 'pcm-correlated' },
    timeline: [{ chunkId: `c${index}`, blockId: 'b', start: index ? 7 : 0, end: index ? 13 : 7, unitIds: units.slice(index * 2, index * 2 + 2).map(unit => unit.id), startSeconds: 0, endSeconds: 4, precision: 'sentence' }],
    alignment: { precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .95, alignerVersion: 'ui-fixture-only', normalizeVersion: 'ui-fixture-only',
      cues: units.slice(index * 2, index * 2 + 2).map((unit, offset) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end, startSeconds: offset ? 1.7 : .1, endSeconds: offset ? 3.8 : 1.5, score: .95 })), warnings: [] } }));
  if (fallback === 'low-score') {
    chunks[0].alignment.score = .3;
    chunks[0].alignment.cues.forEach(cue => { cue.score = .3; });
  } else if (fallback) {
    chunks[0].alignment = { ...chunks[0].alignment, precision: 'sentence', method: 'sentence-fallback', status: 'fallback', score: 0, cues: [],
      ...{ reason: fallback === 'silence' ? '無音のため整列できません。' : '読みが一致せず、フレーズ時刻を確定できません。' } };
  }
  const manifest = JSON.stringify({ schemaVersion: 1, id: bookId, revision, title: document.title, updatedAt: '2026-10-06T00:00:00Z',
    document, chunks, warnings: ['UIテスト用の合成音と整列fixtureです。'], completedChunks: 2, totalChunks: 2, durationSeconds: 8, precision: 'sentence', attribution: 'UIテスト用の自作文' });
  const catalog = { schemaVersion: 1, target: 'worker', createdAt: '2026-10-06T00:00:00Z', books: [{ id: bookId, revision, title: document.title,
    manifestUrl: `library/books/${bookId}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    manifestBytes: Buffer.byteLength(manifest), durationSeconds: 8, precision: 'sentence', attribution: 'UIテスト用の自作文', publicDemo }] };
  await page.route('**/library/index.json', route => route.fulfill({ json: catalog }));
  await page.route(`**/library/books/${bookId}/${revision}/manifest.json`, route => route.fulfill({ body: manifest, contentType: 'application/json' }));
  for (const audio of media) await page.route(`**/media/${audio.sha256}.mp3`, route => route.fulfill({ body: audio.bytes, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' } }));
  await page.goto(`/books?book=${bookId}&revision=${revision}`);
  await expect(page.getByTestId('audio-stage')).toBeVisible();
}

test('同一音声内のフレーズ・ruby・seek・速度・chunk越え・背景停止・位置復元', async ({ page }) => {
  await installAudioFixture(page);
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await position.fill('0.4');
  await expect(page.getByTestId('audio-phrase')).toHaveText('私は');
  await page.locator('audio').evaluate(element => { (element as HTMLAudioElement & { uiIdentity?: string }).uiIdentity = 'same-media-node'; });
  const source = await page.locator('audio').getAttribute('src');
  await page.getByRole('button', { name: '次のフレーズ', exact: true }).click();
  await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', 'u1');
  await expect(page.locator('[data-testid="audio-phrase"] rt')).toHaveText('としょかん');
  expect(await page.locator('audio').getAttribute('src')).toBe(source);
  expect(await page.locator('audio').evaluate(element => (element as HTMLAudioElement & { uiIdentity?: string }).uiIdentity)).toBe('same-media-node');
  await expect(page.getByTestId('audio-precision')).toHaveAttribute('data-precision', 'phrase');
  await expect(page.getByTestId('audio-precision')).toHaveAttribute('data-method', 'forced-alignment');
  await expect(page.getByTestId('audio-precision')).toContainText('時刻：整列結果（推定）');
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByRole('dialog').locator('mark')).toHaveText('図書館へ。');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('combobox', { name: '音声の速さ', exact: true }).click();
  await page.getByRole('option', { name: '1.5倍', exact: true }).click();
  const centerPlay = page.getByRole('button', { name: '再生（画面中央）', exact: true });
  await centerPlay.click();
  await expect(centerPlay).toBeHidden();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(1.9);
  await position.fill('2.2'); await position.fill('2.4');
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
  await page.locator('audio').evaluate((element: HTMLAudioElement) => element.pause());
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(centerPlay).toBeVisible();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await position.fill('4.4');
  await expect(page.getByTestId('audio-phrase')).toHaveText('今日は');
  expect(await page.locator('audio').getAttribute('src')).not.toBe(source);
  await page.reload();
  await expect(page.getByTestId('audio-phrase')).toHaveText('今日は');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('screen wake lock follows audio intent across seek, buffering, chunks, hidden pause and completion', async ({ page }) => {
  await installWakeLock(page);
  await installAudioFixture(page);
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  const firstSource = await page.locator('audio').getAttribute('src');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.held)).toBe(1);
  await page.locator('audio').evaluate(element => element.dispatchEvent(new Event('waiting')));
  await position.fill('2');
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('audio').getAttribute('src')).not.toBe(firstSource);
  expect(await page.evaluate(() => window.testWakeLock.requests)).toEqual(['screen']);
  expect(await page.evaluate(() => window.testWakeLock.held)).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.held)).toBe(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(await page.evaluate(() => window.testWakeLock.requests.length)).toBe(1);
  await position.fill('6');
  await page.getByRole('button', { name: '全画面で読む', exact: true }).click();
  const full = page.locator('.fullscreen-reader[data-fullscreen="true"]');
  await full.getByRole('button', { name: '再生（画面中央）', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.held)).toBe(1);
  await expect(full.locator('.reader-play-overlay')).toBeHidden();
  await expect(full).toHaveAttribute('data-playing', 'false');
  await expect(full.getByRole('button', { name: 'もう一度（画面中央）', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.held)).toBe(0);
  expect(await page.evaluate(() => window.testWakeLock.requests)).toEqual(['screen', 'screen']);
});

test('screen wake lock releases on audio error and unmount and tolerates refusal', async ({ page }) => {
  await installWakeLock(page);
  await installAudioFixture(page, undefined, false);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.held)).toBe(1);
  await page.locator('audio').evaluate(element => element.dispatchEvent(new Event('error')));
  await expect(page.getByRole('alert')).toContainText('保存音声を開けませんでした');
  await expect.poll(() => page.evaluate(() => window.testWakeLock.held)).toBe(0);
  await page.getByRole('button', { name: '保存音声を再読込', exact: true }).click();
  await page.evaluate(() => { window.testWakeLock.mode = 'deny'; });
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.requests.length)).toBe(2);
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  expect(await page.evaluate(() => window.testWakeLock.held)).toBe(0);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.evaluate(() => { window.testWakeLock.mode = 'defer'; });
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testWakeLock.requests.length)).toBe(3);
  await page.getByRole('button', { name: '本棚へ戻る', exact: true }).click();
  await page.evaluate(() => window.testWakeLock.resolvePending());
  await expect.poll(() => page.evaluate(() => window.testWakeLock.releases)).toBe(2);
  expect(await page.evaluate(() => window.testWakeLock.held)).toBe(0);
});

for (const reason of ['low-score', 'silence', 'reading-mismatch'] as const) {
  test(`${reason} でも全区切りを表示し推定時刻を明示する`, async ({ page }) => {
    await installAudioFixture(page, reason);
    await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('0.4');
    await expect(page.getByTestId('audio-phrase')).toHaveText('私は');
    await expect(page.getByTestId('audio-precision')).toHaveAttribute('data-method', 'estimated');
    await expect(page.getByTestId('audio-precision')).toContainText('時刻未検証');
    await expect(page.getByTestId('audio-precision')).not.toHaveAttribute('data-score');
    await page.getByRole('button', { name: '次のフレーズ', exact: true }).click();
    await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', 'u1');
    await expect(page.locator('[data-testid="audio-phrase"] rt')).toHaveText('としょかん');
    await page.getByRole('button', { name: '次のフレーズ', exact: true }).click();
    await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', 'u2');
    await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('8');
    await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', 'u3');
    await expect(page.getByTestId('audio-sentence')).not.toHaveText('今日は読む。');
  });
}

test('音声の自然終了で次の文へ連続再生し、最後まで完了する', async ({ page }) => {
  await installAudioFixture(page);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toContainText('2 / 2 文');
  await expect(page.getByRole('button', { name: 'もう一度', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: '音声の再生位置', exact: true })).toHaveValue('8');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.ended)).toBe(true);
});

// The clock deliberately crosses estimated/accepted timing and a chunk boundary.
test('音声再生中は本文だけが切り替わり、番号・説明・時間・文一覧を動かさない', async ({ page }) => {
  await installAudioFixture(page, 'low-score');
  if (page.viewportSize()!.width > 900) await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect(page.getByTestId('audio-precision')).toContainText('推定を含む');
  const observed = await inspectCalmPlayback(page);
  expect(observed.changedOutsideBody).toBe(false); expect(observed.bodyChanges).toBeGreaterThanOrEqual(2);
  expect(observed.progressIncreases).toBeGreaterThan(20); expect(observed.maxLayoutShift).toBeLessThan(1);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect(page.getByTestId('audio-stage')).toContainText('2 / 2 文');
  // Stopping can land in a legitimate timing gap; select a known accepted cue
  // to verify that paused details refresh without depending on wall-clock scheduling.
  await page.getByRole('slider', { name: '音声の再生位置', exact: true }).fill('4.4');
  await expect(page.getByTestId('audio-precision')).toContainText('整列結果（推定）');
});

test('音声の上下ガイドはrubyと大きな文字にも重ならず、音声切替中も本文領域を避ける', async ({ page }) => {
  await installAudioFixture(page);
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  for (const fontSize of [24, 72]) {
    await position.fill('2');
    await page.getByTestId('audio-sentence').evaluate((element, size) => { element.style.fontSize = `${size}px`; }, fontSize);
    for (const ruby of [true, false]) {
      await page.getByRole('switch', { name: 'ルビを表示', exact: true }).setChecked(ruby);
      const paused = await inspectGuides(page, '[data-testid="audio-stage"]');
      expect(paused.guides).toBe(2); expect(paused.overlap, JSON.stringify(paused)).toBe(false); expect(paused.minimumGap).toBeGreaterThan(2);
      expect(paused.ruby).toBe(ruby ? 1 : 0);
    }
  }
  await page.getByRole('switch', { name: 'ルビを表示', exact: true }).setChecked(true);
  await position.fill('3.4');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const playing = await inspectGuides(page, '[data-testid="audio-stage"]', 700);
  expect(playing.samples).toBeGreaterThan(10); expect(playing.overlap).toBe(false); expect(playing.minimumGap).toBeGreaterThan(2);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
});

test('切替commit直後の古いframeも新しい音声の時計を使い、進捗が逆行しない', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as Window & { clockSamples?: Array<{ position: number; local: number; ready: number; source: string }>; flushedFrames?: number };
    state.clockSamples = []; state.flushedFrames = 0;
    const nativeFrame = requestAnimationFrame.bind(window); const nativeCancel = cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    window.requestAnimationFrame = callback => {
      const id = nativeFrame(time => { pending.delete(id); callback(time); }); pending.set(id, callback); return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); nativeCancel(id); };
    let lastMedia: HTMLAudioElement | null = null;
    // Reproduce a frame already queued when React swaps media, before passive
    // effect cleanup. Media time remains real; no progress value is mocked.
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const media = document.querySelector('audio');
        if (media && lastMedia && media !== lastMedia && media.readyState === 0) {
          for (const [id, callback] of [...pending]) { pending.delete(id); nativeCancel(id); state.flushedFrames!++; callback(performance.now()); }
        }
        if (media) lastMedia = media;
      }).observe(document.documentElement, { childList: true, subtree: true });
      const sample = () => {
        const media = document.querySelector('audio'); const slider = document.querySelector<HTMLInputElement>('#audio-position');
        if (media && slider) state.clockSamples!.push({ position: Number(slider.value), local: media.currentTime, ready: media.readyState, source: media.src });
        nativeFrame(sample);
      }; nativeFrame(sample);
    });
  });
  await installAudioFixture(page, 'low-score');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: 'もう一度', exact: true })).toBeVisible();
  const observation = await page.evaluate(() => {
    const state = window as Window & { clockSamples?: Array<{ position: number; local: number; ready: number; source: string }>; flushedFrames?: number };
    return { samples: state.clockSamples!, flushed: state.flushedFrames! };
  });
  expect(observation.flushed).toBeGreaterThan(0);
  expect(observation.samples.length).toBeGreaterThan(80);
  for (let i = 1; i < observation.samples.length; i++) expect(observation.samples[i].position, JSON.stringify(observation.samples.slice(i - 1, i + 1))).toBeGreaterThanOrEqual(observation.samples[i - 1].position);
  for (const value of observation.samples.filter(value => value.source.includes('fixture-1') && value.ready === 0)) expect(value.position).toBe(4);
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await position.fill('6'); await expect(page.getByTestId('audio-phrase')).toHaveText('読む。');
  await position.fill('1.2'); await expect(position).toHaveValue('1.2');
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(1.2, 3);
  await expect(page.getByTestId('audio-phrase')).toHaveAttribute('data-unit-id', 'u1');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(1.3);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const stopped = Number(await position.inputValue());
  await page.getByRole('button', { name: '前のフレーズ', exact: true }).click();
  expect(Number(await position.inputValue())).toBeLessThan(stopped);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(.2);
});
