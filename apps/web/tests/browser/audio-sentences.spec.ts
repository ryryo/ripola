import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { ReadingUnit } from '../../src/reader/model';
import { browserMp3 } from '../helpers/browser-media';

// Self-authored text and synthetic tones verify navigation, not acoustic accuracy.
function tone(seconds: number, frequency: number) {
  const frames = 24000 * seconds; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++) bytes.writeInt16LE(Math.round(Math.sin(index * Math.PI * frequency / 24000) * 500), 44 + index * 2);
  return bytes;
}

async function fixture(page: Page, split: boolean) {
  const id = split ? 'split-sentence-fixture' : 'merged-sentences-fixture'; const revision = 'a'.repeat(64);
  const pieces = split ? ['長い文を', '二つの音声で', '読みます。', '次です。'] : ['朝です。', '窓を', '開く。', '最後です。'];
  let offset = 0;
  const units: ReadingUnit[] = pieces.map((text, index) => {
    const start = offset; offset += text.length;
    return { id: `u${index}`, text, blockId: 'b', start, end: offset, kind: 'text', ruby: [], sources: [{ kind: 'text', start, end: offset }],
      mapping: 'exact', characters: text.length, cumulativeCharacters: start, pause: 'none' };
  });
  const text = pieces.join(''); const ranges = split ? [[0, 2], [2, 4]] : [[0, 4]]; const seconds = split ? 8 : 9;
  const media = ranges.map((_, index) => browserMp3(tone(seconds, 220 + index * 50)));
  const chunks = ranges.map(([from, to], index) => ({ id: `c${index}`,
    audioUrl: `library/books/${id}/${revision}/media/${media[index].sha256}.mp3`, mimeType: 'audio/mpeg', sha256: media[index].sha256, bytes: media[index].bytes.length,
    durationSeconds: seconds, timing: { verification: 'pcm-correlated' },
    timeline: [{ blockId: 'b', start: units[from].start, end: units[to - 1].end, unitIds: units.slice(from, to).map(unit => unit.id) }],
    alignment: { precision: 'phrase', method: 'forced-alignment', status: 'aligned', alignerVersion: 'ui-fixture-only', score: .95,
      cues: units.slice(from, to).map((unit, localIndex) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end,
        startSeconds: split ? localIndex * 4 : [0, 3, 5, 7][localIndex], endSeconds: split ? (localIndex + 1) * 4 : [3, 5, 7, 9][localIndex], score: .95 })) } }));
  const title = split ? '一文を二つの音声に分割' : '三文を一つの音声に集約';
  const manifest = JSON.stringify({ schemaVersion: 1, id, revision, title, document: { blocks: [{ id: 'b', kind: 'paragraph', text, ruby: [], runs: [] }], units,
    versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' } }, chunks, warnings: [], completedChunks: chunks.length, totalChunks: chunks.length,
    durationSeconds: seconds * chunks.length, precision: 'sentence', attribution: '自作文・合成toneによるUI検証' });
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', createdAt: '2026-10-12T00:00:00Z', books: [{ id, revision, title,
    manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'), manifestBytes: Buffer.byteLength(manifest),
    durationSeconds: seconds * chunks.length, precision: 'sentence', attribution: '自作文・合成toneによるUI検証', publicDemo: false }] } }));
  await page.route(`**/library/books/${id}/${revision}/manifest.json`, route => route.fulfill({ body: manifest, contentType: 'application/json' }));
  for (const audio of media) await page.route(`**/media/${audio.sha256}.mp3`, route => route.fulfill({ body: audio.bytes, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' } }));
  await page.goto(`/books?book=${id}&revision=${revision}`);
  await expect(page.getByTestId('audio-phrase')).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0);
}

test('三文が一音声でも前後ボタン・Shift矢印・文一覧は原文の文単位で移動する', async ({ page }, info) => {
  await fixture(page, false);
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  const source = await page.locator('audio').getAttribute('src');
  await page.locator('audio').evaluate(audio => { audio.dataset.identity = 'same-file'; });
  await expect(page.getByRole('button', { name: '一文戻る', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '一文進む', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '一文進む', exact: true }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(3, 2);
  await expect(page.getByTestId('audio-phrase')).toHaveText('窓を');
  await expect(page.locator('.playback-position-label')).toContainText('2 / 3 文');
  await page.locator('.generation-title h1').click(); await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(7, 2);
  await expect(page.getByTestId('audio-phrase')).toHaveText('最後です。');
  await expect(page.getByRole('button', { name: '一文進む', exact: true })).toBeDisabled();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(3, 2);
  await page.getByRole('button', { name: '一文戻る', exact: true }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(0, 2);
  await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await expect(page.getByTestId('sentence-count')).toContainText('1 / 3 文');
  await expect(page.locator('.sentence-row')).toHaveCount(3);
  await expect(page.locator('.sentence-row').nth(1)).toContainText('窓を開く。');
  await page.locator('.sentence-row').nth(1).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(3, 2);
  if (info.project.name.startsWith('mobile')) await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await expect(page.getByTestId('sentence-count')).toContainText('2 / 3 文');
  await expect(page.locator('audio')).toHaveAttribute('src', source!);
  await expect(page.locator('audio')).toHaveAttribute('data-identity', 'same-file');
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await page.reload();
  await expect.poll(async () => Number(await page.getByRole('slider', { name: '音声の再生位置', exact: true }).inputValue())).toBeCloseTo(3, 2);
  await expect(page.locator('.playback-position-label')).toContainText('2 / 3 文');
});

test('一文が二音声でも文一覧は一項目で、後半から次の原文文へ移動する', async ({ page }) => {
  await fixture(page, true);
  const position = page.getByRole('slider', { name: '音声の再生位置', exact: true });
  await position.fill('10');
  await expect(page.getByTestId('audio-phrase')).toHaveText('読みます。');
  await expect(page.locator('.playback-position-label')).toContainText('1 / 2 文');
  await page.getByRole('button', { name: '一文進む', exact: true }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(12, 2);
  await expect(page.getByTestId('audio-phrase')).toHaveText('次です。');
  await page.getByRole('button', { name: '文一覧を開く', exact: true }).click();
  await expect(page.getByTestId('sentence-count')).toContainText('2 / 2 文');
  await expect(page.locator('.sentence-row')).toHaveCount(2);
  await expect(page.locator('.sentence-row').nth(0)).toContainText('長い文を二つの音声で読みます。');
  await page.locator('.sentence-row').nth(0).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(0, 2);
  await expect(page.getByTestId('audio-phrase')).toHaveText('長い文を');
});
