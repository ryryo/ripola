import { readFile } from 'node:fs/promises';
import { GenerationService } from '../../src/generation/core/service';
import { LibraryDisk } from '../../src/generation/core/disk';
import { wavDuration, type SpeechAdapter } from '../../src/generation/core/providers';
import type { AlignmentAdapter } from '../../src/generation/core/alignment-adapter';
import { prepareDocument } from '../../src/reader/segmentation';
import { importText } from '../../src/reader/text-import';

/** Synthetic nonperiodic PCM and self-written text; no speech service/network. */
export function fixtureWav(seconds = 3) {
  const rate = 24000, frames = Math.round(rate * seconds), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  let state = 12345, filtered = 0;
  for (let i = 0; i < frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    filtered = filtered * .97 + (state / 2 ** 32 - .5) * .03;
    const time = i / rate, envelope = .6 + .35 * Math.sin(time * 6.71) ** 2;
    bytes.writeInt16LE(Math.round((filtered + .01 * Math.sin(time * time * 37)) * envelope * 150000), 44 + i * 2);
  }
  return bytes;
}
export async function createMp3Fixture(libraryDir: string, seconds = 3) {
  let synthesisCalls = 0, alignmentCalls = 0;
  const voice: SpeechAdapter = { async voices() { return [{ id: '3', name: 'Fixture' }]; }, async fingerprint() { return 'voicevox-engine:fixture-mp3'; },
    async synthesize(_request, beforeSend) { await beforeSend(); synthesisCalls++; return fixtureWav(seconds); } };
  const alignment: AlignmentAdapter = { version: 'fixture-mp3-aligner', async available() { return true; }, async align(request) {
    alignmentCalls++;
    const durationSeconds = wavDuration(await readFile(request.audioPath));
    let offset = 0;
    const characters = Array.from(request.normalizedText);
    const segments = characters.map((char, i) => { const start = offset; offset += char.length; return { start, end: offset, startSeconds: .1 + i * (durationSeconds - .2) / characters.length,
      endSeconds: .1 + (i + 1) * (durationSeconds - .2) / characters.length, confidence: .95, status: 'aligned' as const }; });
    return { schemaVersion: 1, alignerVersion: request.alignerVersion, normalizeVersion: request.normalizeVersion, offsetUnit: 'utf16', normalizedText: request.normalizedText, durationSeconds, segments };
  } };
  const config = { libraryDir, localOrigin: 'http://127.0.0.1:4181', paidEnabled: false, automaticCompression: false, alignmentPython: '/fixture/python', alignmentModelDir: '/fixture/model' };
  const service = new GenerationService(config, { voicevox: voice, alignment });
  const document = await prepareDocument(importText('朝の光が窓に届く。静かな庭を歩く。', 'txt', 'MP3形式の自作検証'));
  const options = { provider: 'voicevox' as const, voice: '3', transport: 'direct' as const, readings: [] };
  const plan = await service.prepareGeneration({ document, options });
  const started = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'fixture-generate', paidConfirmed: false });
  const job = await service.waitForJob(started.id);
  if (job.status !== 'completed' || job.automaticAlignment?.status !== 'completed') throw new Error('Fixture correction failed.');
  const book = await service.getBook(job.bookId, job.revision);
  return { service, config, voice, alignment, document, options, plan, job, book, disk: new LibraryDisk(libraryDir), selection: { libraryDir, books: [{ id: book.id, revision: book.revision }] }, calls: () => ({ synthesisCalls, alignmentCalls }) };
}
