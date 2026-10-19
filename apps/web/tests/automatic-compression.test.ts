import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GenerationService, type ServiceDependencies } from '../src/generation/core/service';
import type { AlignmentAdapter } from '../src/generation/core/alignment-adapter';
import { wavDuration } from '../src/generation/core/providers';
import { fixtureWav } from './helpers/mp3-fixture';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import type { GenerationOptions } from '../src/generation/contracts';

const available = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0);
const text = '朝の光が窓に届く。静かな庭を歩く。';
async function fixture(t: { after(fn: () => Promise<void>): void }, provider: 'voicevox' | 'gemini', seconds: number, compression?: ServiceDependencies['compression'], configured = true, transport: 'direct' | 'gateway' = 'direct') {
  const root = await mkdtemp(join(tmpdir(), 'rsvp-automatic-compression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let speechCalls = 0, alignmentCalls = 0;
  const speech = { async voices() { return []; }, async fingerprint() { return 'fixture-auto-mp3'; }, async synthesize(_request: unknown, beforeSend: () => Promise<void>) { await beforeSend(); speechCalls++; return fixtureWav(seconds); } };
  const alignment: AlignmentAdapter = { version: 'fixture-auto-alignment', async available() { return true; }, async align(request) {
    alignmentCalls++;
    let offset = 0;
    const chars = [...request.normalizedText];
    return { schemaVersion: 1, alignerVersion: request.alignerVersion, normalizeVersion: request.normalizeVersion, offsetUnit: 'utf16', normalizedText: request.normalizedText, durationSeconds: seconds,
      segments: chars.map((ch, i) => { const start = offset; offset += ch.length; return { start, end: offset, startSeconds: .1 + i * (seconds - .2) / chars.length, endSeconds: .1 + (i + 1) * (seconds - .2) / chars.length, confidence: .95, status: 'aligned' as const }; }) };
  } };
  const config = { libraryDir: join(root, 'library'), localOrigin: 'http://127.0.0.1:4181', paidEnabled: true, geminiApiKey: 'test-placeholder', ...(transport === 'gateway' ? { gateway: { mode: 'rest' as const, accountId: 'a'.repeat(32), gatewayId: 'fixture', token: 'test-placeholder' } } : {}), ...(configured ? { alignmentPython: '/fixture/python', alignmentModelDir: '/fixture/model' } : {}) };
  const service = new GenerationService(config, { voicevox: speech, gemini: speech, alignment, ...(compression ? { compression } : {}) });
  const options: GenerationOptions = { provider, voice: provider === 'voicevox' ? '3' : 'Kore', transport, readings: [] };
  const generate = async (source = text, operationId = 'automatic-default') => {
    const document = await prepareDocument(importText(source, 'txt', '自動圧縮の自作検証'));
    const plan = await service.prepareGeneration({ document, options });
    const started = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId, paidConfirmed: true });
    const job = await service.waitForJob(started.id);
    return { plan, job, book: await service.getBook(job.bookId, job.revision) };
  };
  return { config, service, generate, calls: () => ({ speechCalls, alignmentCalls }) };
}
for (const provider of ['voicevox', 'gemini'] as const) test(`default ${provider} generation compresses, removes verified new intermediates, and reuses speech/cues without more synthesis`, { skip: !available }, async t => {
  const f = await fixture(t, provider, provider === 'voicevox' ? 3 : .75);
  const first = await f.generate();
  assert.equal(first.job.status, 'completed');
  assert.equal(first.job.automaticAlignment?.status, 'completed');
  assert.equal(first.job.automaticCompression?.status, 'completed');
  assert.equal(first.job.automaticCompression?.completedFiles, 2);
  assert.equal(first.job.automaticCompression?.retainedWavFiles, 0);
  assert.ok(first.job.automaticCompression!.compressedBytes < first.job.automaticCompression!.sourceBytes / 3);
  assert.equal(first.job.automaticCompression!.removedWavBytes, first.job.automaticCompression!.sourceBytes);
  assert.ok(first.book.chunks.every(c => c.mimeType === 'audio/mpeg'));
  for (const c of first.book.chunks) {
    await assert.rejects(access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav')));
    const profile = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,bit_rate,channels,sample_rate', '-of', 'json', join(f.config.libraryDir, 'audio', c.speechKey + '.mp3')], { encoding: 'utf8' });
    assert.equal(profile.status, 0);
    assert.deepEqual(JSON.parse(profile.stdout).streams[0], { codec_name: 'mp3', sample_rate: '24000', channels: 1, bit_rate: '48000' });
    const legacy = await f.service.getAudio(c.speechKey, 'wav');
    assert.equal(legacy.mimeType, 'audio/mpeg');
    assert.equal(legacy.sourceAudioHash, c.alignment!.audioHash);
  }
  const replay = await f.generate(text, 'cache-only');
  assert.equal(replay.plan.sendingText, '');
  assert.deepEqual(f.calls(), { speechCalls: 2, alignmentCalls: 2 });
  assert.deepEqual(replay.book.chunks.map(c => c.alignment), first.book.chunks.map(c => c.alignment));
  const shared = await f.generate('別の頁を開く。' + text, 'new-document-shared-speech');
  assert.equal(shared.job.automaticAlignment?.status, 'completed');
  assert.equal(shared.job.automaticCompression?.status, 'completed');
  assert.deepEqual(f.calls(), { speechCalls: 3, alignmentCalls: 3 });
  assert.equal(shared.book.presentation!.missingUnitIds.length, 0);
  assert.equal(shared.book.presentation!.duplicateUnitIds.length, 0);
});
for (const mode of ['unavailable', 'failure'] as const) test(`compression ${mode} keeps playable original audio and never retries speech`, async t => {
  const f = await fixture(t, 'gemini', 3, { async available() { return mode !== 'unavailable'; }, async encode() { throw new Error('private codec/runtime detail'); } });
  const result = await f.generate();
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.automaticCompression?.status, mode === 'unavailable' ? 'unavailable' : 'partial');
  assert.equal(result.job.automaticCompression?.retainedWavFiles, 2);
  assert.equal(JSON.stringify(result.job).includes('private codec/runtime detail'), false);
  assert.deepEqual(f.calls(), { speechCalls: 2, alignmentCalls: 2 });
  for (const c of result.book.chunks) assert.equal(wavDuration((await f.service.getAudio(c.speechKey)).bytes), 3);
});
test('compression keeps the source when synchronization is not yet configured', { skip: !available }, async t => {
  const f = await fixture(t, 'voicevox', 3, undefined, false);
  const result = await f.generate();
  assert.equal(result.job.automaticAlignment?.status, 'unavailable');
  assert.equal(result.job.automaticCompression?.status, 'completed');
  assert.equal(result.job.automaticCompression?.retainedWavFiles, 2);
  assert.equal(result.job.automaticCompression?.removedWavBytes, 0);
  for (const c of result.book.chunks) assert.equal(wavDuration((await f.service.getAudio(c.speechKey, 'wav')).bytes), 3);
});

for (const transport of ['direct', 'gateway'] as const) test(`interrupted ${transport} compression resumes without provider credentials or speech/model calls and preserves cleanup accounting`, { skip: !available }, async t => {
  const f = await fixture(t, 'gemini', 3, undefined, true, transport);
  const first = await f.generate();
  const { LibraryDisk } = await import('../src/generation/core/disk');
  const disk = new LibraryDisk(f.config.libraryDir);
  await disk.write(['jobs', first.job.id + '.json'], { ...first.job, status: 'running', automaticCompression: { ...first.job.automaticCompression!, status: 'running', completedFiles: 1, removedWavBytes: 0 } });
  await disk.write(['owners', first.job.id + '.json'], { pid: 99_999_999 });
  let calls = 0;
  const offline = { async voices() { return []; }, async synthesize() { calls++; throw new Error('Must not regenerate'); } };
  const service = new GenerationService({ ...f.config, geminiApiKey: undefined, gateway: undefined }, { voicevox: offline, gemini: offline, alignment: { version: 'fixture-auto-alignment', async available() { return false; }, async align() { calls++; throw new Error('Must not rerun model'); } } });
  await service.ready();
  const recovered = await service.waitForJob(first.job.id);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.automaticCompression?.status, 'completed');
  assert.equal(recovered.automaticCompression?.completedFiles, 2);
  assert.equal(recovered.automaticCompression?.removedWavBytes, first.job.automaticCompression?.removedWavBytes);
  assert.equal(calls, 0);
  assert.deepEqual((await service.getBook(first.book.id, first.book.revision)).chunks.map(c => c.alignment), first.book.chunks.map(c => c.alignment));
});

test('cancelling compression keeps its in-flight source and all completed speech', { skip: !available }, async t => {
  const { encodeVerifiedMp3 } = await import('../src/generation/core/audio-compression');
  let signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, 'voicevox', 3, { async available() { return true; }, async encode(...args) { signalStarted(); await gate; return encodeVerifiedMp3(...args); } });
  const generating = f.generate();
  await started;
  const [active] = await f.service.listJobs();
  assert.equal(active.status, 'running');
  await f.service.cancelJob(active.id);
  release();
  const result = await generating;
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.automaticCompression?.status, 'cancelled');
  assert.equal(result.job.automaticCompression?.removedWavBytes, 0);
  assert.equal(f.calls().speechCalls, 2);
  for (const c of result.book.chunks) assert.equal(wavDuration((await f.service.getAudio(c.speechKey, 'wav')).bytes), 3);
});

for (const mode of ['unmatched', 'stale'] as const) test(`another book with ${mode} correction prevents deleting its shared source`, { skip: !available }, async t => {
  const { encodeVerifiedMp3 } = await import('../src/generation/core/audio-compression');
  const { LibraryDisk } = await import('../src/generation/core/disk');
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(t, 'voicevox', 3, { async available() {
    const disk = new LibraryDisk(f.config.libraryDir);
    const [file] = await disk.list('books');
    const book = (await disk.read<import('../src/generation/contracts').AudioBookManifest>(['books', file]))!;
    const shared = { ...book, id: 'book-shared-correction', chunks: book.chunks.map((c, i) => i ? c : { ...c, alignment: mode === 'unmatched' ? undefined : { ...c.alignment!, audioHash: 'f'.repeat(64) } }) };
    await disk.write(['books', shared.id + '_' + shared.revision + '.json'], shared);
    return true;
  }, encode: encodeVerifiedMp3 });
  const result = await f.generate();
  assert.equal(result.job.automaticCompression?.status, 'completed');
  assert.equal(result.job.automaticCompression?.retainedWavFiles, 1);
  await access(join(f.config.libraryDir, 'audio', result.book.chunks[0].speechKey + '.wav'));
  await assert.rejects(access(join(f.config.libraryDir, 'audio', result.book.chunks[1].speechKey + '.wav')));
  assert.ok(result.book.chunks.every(c => c.mimeType === 'audio/mpeg'));
  assert.equal(f.calls().speechCalls, 2);
});

test('adopted raw audio is removed after its cache, synchronization and MP3 are verified', { skip: !available }, async t => {
  const f = await fixture(t, 'voicevox', 3);
  const { LibraryDisk } = await import('../src/generation/core/disk');
  const document = await prepareDocument(importText(text, 'txt', '自動圧縮の自作検証'));
  const plan = await f.service.prepareGeneration({ document, options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] } });
  const disk = new LibraryDisk(f.config.libraryDir);
  for (const chunk of plan.chunks) await disk.writeBytes(['audio', chunk.speechKey + '.wav'], fixtureWav(3));
  const result = await f.generate();
  assert.equal(result.job.automaticCompression?.status, 'completed');
  assert.ok(result.job.automaticCompression!.removedWavBytes > 0);
  assert.equal(result.job.automaticCompression?.retainedWavFiles, 0);
  assert.equal(f.calls().speechCalls, 0);
  for (const c of result.book.chunks) await assert.rejects(access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav')));
});

test('a shared book saved during encoding keeps the WAV it still needs for correction', { skip: !available }, async t => {
  const { encodeVerifiedMp3 } = await import('../src/generation/core/audio-compression');
  const { LibraryDisk } = await import('../src/generation/core/disk');
  let encoded = 0;
  const f = await fixture(t, 'voicevox', 3, { async available() { return true; }, async encode(...args) {
    const media = await encodeVerifiedMp3(...args);
    if (++encoded === 2) {
      const disk = new LibraryDisk(f.config.libraryDir);
      const [file] = await disk.list('books');
      const book = (await disk.read<import('../src/generation/contracts').AudioBookManifest>(['books', file]))!;
      const shared = { ...book, id: 'book-added-during-encoding', chunks: book.chunks.map((c, i) => i ? { ...c, alignment: undefined } : c) };
      await disk.write(['books', shared.id + '_' + shared.revision + '.json'], shared);
    }
    return media;
  } });
  const result = await f.generate();
  assert.equal(result.job.automaticCompression?.retainedWavFiles, 1);
  await assert.rejects(access(join(f.config.libraryDir, 'audio', result.book.chunks[0].speechKey + '.wav')));
  await access(join(f.config.libraryDir, 'audio', result.book.chunks[1].speechKey + '.wav'));
});

test('a cache-only retry removes previously retained WAV after compression becomes available', { skip: !available }, async t => {
  const { encodeVerifiedMp3 } = await import('../src/generation/core/audio-compression');
  let codecAvailable = false;
  const f = await fixture(t, 'gemini', 3, { async available() { return codecAvailable; }, encode: encodeVerifiedMp3 });
  const first = await f.generate();
  assert.equal(first.job.automaticCompression?.status, 'unavailable');
  for (const c of first.book.chunks) await access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav'));
  const before = f.calls();
  codecAvailable = true;
  const retry = await f.generate(text, 'codec-now-available');
  assert.equal(retry.plan.sendingText, '');
  assert.ok(retry.job.chunks.every(c => c.reused));
  assert.equal(retry.job.automaticCompression?.retainedWavFiles, 0);
  assert.ok(retry.job.automaticCompression!.removedWavBytes > 0);
  assert.deepEqual(f.calls(), before);
  assert.deepEqual(retry.book.chunks.map(c => c.alignment), first.book.chunks.map(c => c.alignment));
  for (const c of retry.book.chunks) await assert.rejects(access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav')));
});

for (const provider of ['voicevox', 'gemini'] as const) test(`deferred ${provider} correction cleans verified WAVs without speech or re-encoding and repeated cleanup is idempotent`, { skip: !available }, async t => {
  const f = await fixture(t, provider, 3, undefined, false);
  const first = await f.generate();
  const before = f.calls().speechCalls;
  const job = await f.service.startAlignment({ bookId: first.book.id, revision: first.book.revision, operationId: 'deferred-alignment' });
  const corrected = await f.service.waitForAlignmentJob(job.id);
  assert.equal(corrected.status, 'completed');
  assert.equal(corrected.wavCleanup?.status, 'completed');
  assert.equal(corrected.wavCleanup?.removedFiles, 2);
  assert.ok(corrected.wavCleanup!.removedWavBytes > 0);
  assert.equal(f.calls().speechCalls, before);
  const { cleanupSavedWavs } = await import('../src/generation/core/audio-cleanup');
  const { LibraryDisk } = await import('../src/generation/core/disk');
  const again = await cleanupSavedWavs(new LibraryDisk(f.config.libraryDir), { bookId: first.book.id, revision: first.book.revision,
    operationId: `alignment-cleanup-${(await import('../src/generation/core/disk')).digest(job.id)}`, apply: true });
  assert.equal(again.removedFiles, 2);
  assert.equal(again.removedWavBytes, corrected.wavCleanup!.removedWavBytes);
  // A crash after unlink but before the final journal update must retain exact accounting.
  const disk = new LibraryDisk(f.config.libraryDir);
  const { digest } = await import('../src/generation/core/disk');
  const operationId = `alignment-cleanup-${digest(job.id)}`;
  const journal = ['audio-cleanup-files', `${digest(`${digest(operationId)}:${first.book.chunks[0].speechKey}`)}.json`];
  const row = (await disk.read<Record<string, unknown>>(journal))!;
  await disk.write(journal, { ...row, status: 'planned' });
  const recovered = await cleanupSavedWavs(disk, { bookId: first.book.id, revision: first.book.revision, operationId, apply: true });
  assert.equal(recovered.removedWavBytes, again.removedWavBytes);
  await assert.rejects(cleanupSavedWavs(disk, { bookId: first.book.id, revision: first.book.revision, operationId,
    selectedChunkIds: [first.book.chunks[0].id], apply: true }), /別の対象/);
  for (const c of first.book.chunks) {
    await assert.rejects(access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav')));
    assert.equal((await f.service.getAudio(c.speechKey)).mimeType, 'audio/mpeg');
  }
});

test('deferred cleanup plans without removal, respects selection, shared references and MP3 corruption', { skip: !available }, async t => {
  const { cleanupSavedWavs } = await import('../src/generation/core/audio-cleanup');
  const { LibraryDisk } = await import('../src/generation/core/disk');
  const f = await fixture(t, 'voicevox', 3, undefined, false);
  const first = await f.generate(); const disk = new LibraryDisk(f.config.libraryDir);
  const shared = { ...first.book, id: 'book-shared-unaligned' };
  await disk.write(['books', `${shared.id}_${shared.revision}.json`], shared);
  const job = await f.service.startAlignment({ bookId: first.book.id, revision: first.book.revision, selectedChunkIds: [first.book.chunks[0].id], operationId: 'partial-correction' });
  const corrected = await f.service.waitForAlignmentJob(job.id);
  assert.equal(corrected.status, 'completed');
  assert.equal(corrected.wavCleanup?.retainedWavFiles, 1);
  for (const c of first.book.chunks) await access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav'));
  const updated = await f.service.getBook(first.book.id, first.book.revision);
  await disk.write(['books', `${shared.id}_${shared.revision}.json`], { ...updated, id: shared.id });
  const input = { bookId: first.book.id, revision: first.book.revision, selectedChunkIds: [first.book.chunks[0].id], operationId: 'explicit-cleanup' };
  const plan = await cleanupSavedWavs(disk, input);
  assert.equal(plan.files[0].status, 'planned');
  await access(join(f.config.libraryDir, 'audio', first.book.chunks[0].speechKey + '.wav'));
  await disk.writeBytes(['audio', first.book.chunks[0].speechKey + '.mp3'], new Uint8Array([1, 2, 3]));
  const corrupt = await cleanupSavedWavs(disk, { ...input, apply: true });
  assert.equal(corrupt.files[0].status, 'failed');
  assert.equal(corrupt.removedFiles, 0);
  for (const c of first.book.chunks) await access(join(f.config.libraryDir, 'audio', c.speechKey + '.wav'));
});
