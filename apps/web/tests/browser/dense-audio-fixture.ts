import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { browserMp3 } from '../helpers/browser-media';

/** Self-authored text and one synthetic tone; no speech or private library access. */
export async function denseAudioFixture(page: Page) {
  const seconds = 60, sampleRate = 8000, samples = sampleRate * seconds;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / sampleRate) * 500), 44 + i * 2);
  const media = browserMp3(wave), id = 'dense-reader-fixture', revision = 'd'.repeat(64), cueSeconds = .12;
  let offset = 0;
  const units = Array.from({ length: 500 }, (_, index) => {
    const text = '静かな窓辺で本を読む。', start = offset; offset += text.length;
    return { id: `u${index}`, blockId: 'b', kind: 'text', text, start, end: offset, ruby: [], sources: [{ kind: 'text', start, end: offset }], mapping: 'exact', characters: text.length, cumulativeCharacters: start, pause: 'sentence' };
  });
  const chunk = { id: 'c', audioUrl: `library/books/${id}/${revision}/media/${media.sha256}.mp3`, mimeType: 'audio/mpeg', sha256: media.sha256, bytes: media.bytes.length, durationSeconds: seconds, timing: { verification: 'pcm-correlated' },
    timeline: [{ blockId: 'b', start: 0, end: offset, unitIds: units.map(unit => unit.id) }],
    alignment: { precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .95, alignerVersion: 'dense-fixture-only',
      cues: units.map((unit, index) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end, startSeconds: index * cueSeconds, endSeconds: (index + 1) * cueSeconds, score: .95 })) } };
  const manifest = JSON.stringify({ schemaVersion: 1, id, revision, title: '短い音声区切りの表示検証',
    document: { blocks: [{ id: 'b', kind: 'paragraph', text: units.map(unit => unit.text).join(''), ruby: [], runs: [] }], units, versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' } },
    chunks: [chunk], warnings: [], totalChunks: 1, completedChunks: 1, durationSeconds: seconds, precision: 'sentence', attribution: 'Self-authored text and synthetic tone. Not an acoustic accuracy test.' });
  await page.route('**/library/index.json', route => route.fulfill({ json: { schemaVersion: 1, target: 'worker', createdAt: '2026-10-16T00:00:00Z', books: [{
    id, revision, title: '短い音声区切りの表示検証', manifestUrl: `library/books/${id}/${revision}/manifest.json`, manifestSha256: createHash('sha256').update(manifest).digest('hex'), manifestBytes: Buffer.byteLength(manifest), durationSeconds: seconds, precision: 'sentence', attribution: 'Self-authored fixture', publicDemo: true,
  }] } }));
  await page.route(`**/library/books/${id}/${revision}/manifest.json`, route => route.fulfill({ body: manifest, contentType: 'application/json' }));
  await page.route(`**/media/${media.sha256}.mp3`, route => route.fulfill({ body: media.bytes, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' } }));
  await page.goto(`/books?book=${id}&revision=${revision}`);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  await page.locator('audio').evaluate((audio: HTMLAudioElement) => { audio.muted = true; });
  return { cueSeconds, characters: units[0].text.length };
}
