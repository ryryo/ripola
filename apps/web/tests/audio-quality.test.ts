import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import type { AudioBookManifest } from '../src/generation/contracts';
import { digest, LibraryDisk } from '../src/generation/core/disk';
import { AUDIO_INSPECTION_VERSION, type AsrCandidate } from '../src/generation/audio-quality/contracts';
import { compareContent, foldedCharacters, spellingDistance } from '../src/generation/audio-quality/content';
import { inspectPcm } from '../src/generation/audio-quality/pcm';
import { decodeWave, InspectionUnavailable, validCandidate, type AsrAdapter } from '../src/generation/audio-quality/runtime';
import { AudioInspectionService } from '../src/generation/audio-quality/service';
import { audioCompressionAvailable, encodeVerifiedMp3 } from '../src/generation/core/audio-compression';
import type { AudioCacheRecord } from '../src/generation/core/audio-cache';
import { QA_CANDIDATES, QA_TEXT, qaWave } from './fixtures/audio-quality/fixture';

const candidate = (text: string, score = .95): AsrCandidate => ({ schemaVersion: 1, method: 'audio-only-greedy-ctc', version: 'fixture-candidate-v1', mediaHash: 'a'.repeat(64), text, tokenScore: score });
test('PCM warns on silence, plateau clipping, pauses and extreme rate without calling normal tones speech', () => {
  const inspect = (seconds: number, kind: Parameters<typeof qaWave>[1]) => { const pcm = decodeWave(qaWave(seconds, kind)); return inspectPcm(pcm.channels, pcm.sampleRate, 24, seconds); };
  assert.deepEqual(inspect(5, 'normal').issues, []);
  assert.ok(inspect(5, 'silence').issues.some(i => i.code === 'silent-audio'));
  assert.ok(inspect(5, 'clipping').issues.some(i => i.code === 'clipping'));
  assert.ok(inspect(5, 'pause').issues.some(i => i.code === 'long-silence'));
  assert.ok(inspect(.5, 'normal').issues.some(i => i.code === 'extreme-rate'));
  assert.ok(inspect(35, 'normal').issues.some(i => i.code === 'extreme-rate'));
  const sine = new Float32Array(16000); for (let i = 0; i < sine.length; i++) sine[i] = Math.sin(i * .2);
  assert.ok(!inspectPcm([sine], 16000, 8).issues.some(i => i.code === 'clipping'), 'isolated full-scale peaks are not a plateau');
  const left = new Float32Array(16000).fill(.1), right = new Float32Array(16000).fill(-.1);
  assert.ok(inspectPcm([left, right], 16000, 8).metrics.rms > .09, 'opposite channels must not cancel into silence');
  assert.throws(() => inspectPcm([new Float32Array([NaN])], 16000, 8), /invalid/);
  assert.throws(() => decodeWave(qaWave().slice(0, 50)), /invalid|truncated/);
  const unsupported = Buffer.from(qaWave()); unsupported.writeUInt16LE(65534, 20); assert.throws(() => decodeWave(unsupported), InspectionUnavailable);
  assert.ok(inspectPcm([new Float32Array(16000).fill(2)], 16000, 8).issues.some(i => i.code === 'clipping'), 'finite over-range float samples warn rather than becoming structural corruption');
  const pcm = decodeWave(qaWave()); assert.equal(inspectPcm(pcm.channels, pcm.sampleRate, 24, 6).issues[0].severity, 'fatal');
});

test('internal reading/spelling lattice absorbs variants and keeps semantic symbols, unknowns and sizes explicit', () => {
  assert.equal(spellingDistance('昨日は八時間寝ました。', 'きのうは8時間寝ました')?.distance, 0);
  assert.equal(spellingDistance('きょうは図書館へ', 'キョウハトショカンヘ')?.distance, 0);
  assert.equal(spellingDistance('今日は本を読みます。', '今日は本を読みます')?.distance, 0);
  assert.equal(spellingDistance('𠮷野の本', '𠮷野の本')?.distance, 0);
  assert.equal(foldedCharacters('２７％').map(c => c.text).join(''), '27%');
  assert.ok((spellingDistance('27%', '27')?.distance ?? 0) > 0);
  assert.equal(compareContent('未知固有名詞𠮷', candidate('違う認識')).evidence.status, 'indeterminate');
  assert.equal(spellingDistance('あ'.repeat(801), 'あ'), undefined);
  assert.equal(spellingDistance('東京', 'とうきょう', [{ start: 0, end: 2, text: 'とうきょう' }])?.distance, 0);
});

test('omission and repetition are tentative source-mapped warnings; empty, low-score and matching ASR never pass quality', () => {
  const normal = compareContent(QA_TEXT, candidate(QA_CANDIDATES.normal)); assert.equal(normal.evidence.status, 'indeterminate'); assert.deepEqual(normal.issues, []);
  const omitted = compareContent(QA_TEXT, candidate(QA_CANDIDATES.omitted), undefined, [], 'test-only');
  const omission = omitted.issues.find(i => i.code === 'possible-omission'); assert.ok(omission?.source); assert.ok(QA_TEXT.slice(omission.source.start, omission.source.end).includes('図書館'));
  const repetition = compareContent(QA_TEXT, candidate(QA_CANDIDATES.repeated), undefined, [], 'test-only').issues.find(i => i.code === 'possible-repetition');
  assert.ok(repetition?.source); assert.equal(QA_TEXT.slice(repetition.source.start, repetition.source.end), '図書館で');
  const weak = compareContent(QA_TEXT, candidate(QA_CANDIDATES.omitted)); assert.deepEqual(weak.issues, []); assert.equal(weak.evidence.status, 'indeterminate'); assert.ok(weak.evidence.differences?.length);
  assert.deepEqual(compareContent(QA_TEXT, candidate(QA_CANDIDATES.omitted, .2)).issues, []);
  assert.equal(compareContent(QA_TEXT, candidate('')).evidence.status, 'indeterminate');
  assert.equal(compareContent(QA_TEXT).evidence.method, 'not-run');
  assert.equal(validCandidate({ ...candidate(QA_TEXT), method: 'forced-alignment' }, 'a'.repeat(64), 'fixture-candidate-v1'), false);
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }, text = QA_TEXT, seconds = 5) {
  const directory = await mkdtemp(join(tmpdir(), 'ripola-audio-qa-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const disk = new LibraryDisk(directory), document = await prepareDocument(importText(text, 'txt', '自作QA'));
  const block = document.blocks[0], key = digest('fixture-speech'), bytes = qaWave(seconds);
  const book: AudioBookManifest = { schemaVersion: 1, id: document.id, revision: document.contentHash, title: document.title, document, updatedAt: '2026-10-12T00:00:00Z',
    options: { provider: 'gemini', voice: 'fixture', transport: 'direct', readings: [] }, warnings: [], precision: 'sentence', completedChunks: 1, totalChunks: 1, durationSeconds: seconds,
    chunks: [{ id: 'stable-chunk', speechKey: key, audioUrl: `/api/local-audio/${key}.wav`, mimeType: 'audio/wav', durationSeconds: seconds, timeline: [{ chunkId: 'stable-chunk', blockId: block.id, start: 0, end: block.text.length, unitIds: document.units.map(u => u.id), startSeconds: 0, endSeconds: seconds, precision: 'sentence' }] }] };
  await disk.write(['books', `${book.id}_${book.revision}.json`], book); await disk.writeBytes(['audio', `${key}.wav`], bytes); await disk.write(['cache', `${key}.json`], { schemaVersion: 1, status: 'ready', provider: 'gemini', hash: digest(bytes), durationSeconds: seconds });
  return { disk, book, bytes, key, input: { bookId: book.id, revision: book.revision }, directory };
}

test('saved QA cache, CLI and refresh use original hashes and never touch speech/provider artifacts', async t => {
  const { disk, book, bytes, key, input, directory } = await fixture(t);
  let calls = 0;
  const asr: AsrAdapter = { version: 'fixture-candidate-v1', qualification: 'test-only', async transcribe(path, mediaHash) { calls++; assert.equal(digest(await readFile(path)), mediaHash); return { ...candidate(QA_CANDIDATES.omitted), mediaHash }; } };
  const service = new AudioInspectionService(disk, asr), savedBefore = await disk.readBytes(['books', `${book.id}_${book.revision}.json`]);
  const report = await service.inspect({ ...input, content: true }); const result = report.chunks[0];
  assert.equal(result.status, 'warning'); assert.equal(result.audioHash, digest(bytes)); assert.equal(result.mediaHash, digest(bytes)); assert.equal(result.inspectionVersion, AUDIO_INSPECTION_VERSION);
  assert.equal(result.source?.blockId, book.document.blocks[0].id); assert.equal((await service.read(book.id, book.revision))?.chunks[0].key, result.key);
  assert.equal((await service.inspect({ ...input, content: true })).reusedChunks, 1); assert.equal(calls, 1);
  await service.inspect({ ...input, content: true, refresh: true }); assert.equal(calls, 2);
  const cli = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/inspect-audio.ts', '--library', directory, '--book', book.id, '--revision', book.revision]);
  assert.equal(JSON.parse(cli.stdout).chunks[0].audioHash, result.audioHash);
  assert.deepEqual(await disk.readBytes(['audio', `${key}.wav`]), bytes); assert.deepEqual(await disk.readBytes(['books', `${book.id}_${book.revision}.json`]), savedBefore);
  assert.deepEqual(await disk.list('jobs'), []); assert.deepEqual(await disk.list('receipts'), []);
  await assert.rejects(service.inspect({ ...input, selectedChunkIds: ['unknown'] }), /chunk/);
  await assert.rejects(service.inspect({ ...input, bookId: '../outside' }), /ID/);
  const changed = qaWave(5, 'silence'); await disk.writeBytes(['audio', `${key}.wav`], changed); await disk.write(['cache', `${key}.json`], { schemaVersion: 1, status: 'ready', provider: 'gemini', hash: digest(changed), durationSeconds: 5 });
  assert.equal((await service.read(book.id, book.revision))?.chunks.length, 0, 'stale audio hash evidence must not be displayed');
  const updated = await service.inspect(input); assert.equal(updated.reusedChunks, 0); assert.equal(updated.chunks[0].audioHash, digest(changed)); assert.ok(updated.chunks[0].issues.some(i => i.code === 'silent-audio'));
});

test('unavailable and failed ASR remain indeterminate and corrupt audio retains a current fatal diagnostic', async t => {
  const { disk, input, key } = await fixture(t);
  const unavailable = await new AudioInspectionService(disk).inspect({ ...input, content: true }); assert.equal(unavailable.chunks[0].content.status, 'indeterminate'); assert.match(unavailable.chunks[0].content.reason, /未設定/);
  let calls = 0;
  const failing: AsrAdapter = { version: 'failing-v1', qualification: 'unvalidated', async transcribe() { calls++; throw new Error('private diagnostic'); } };
  const service = new AudioInspectionService(disk, failing);
  assert.equal((await service.inspect({ ...input, content: true })).chunks[0].status, 'indeterminate');
  assert.equal((await service.inspect({ ...input, content: true })).reusedChunks, 0); assert.equal(calls, 2);
  await disk.writeBytes(['audio', `${key}.wav`], new Uint8Array([1]));
  const fatal = await service.inspect(input); assert.equal(fatal.chunks[0].status, 'fatal'); assert.equal(fatal.chunks[0].issues[0].severity, 'fatal');
  assert.equal((await service.read(input.bookId, input.revision))?.chunks[0].status, 'fatal');
  assert.ok(await disk.read(['audio-inspections', `${input.bookId}_${input.revision}.json`]));
});

test('archived WAV inspects verified MP3 with separate media and original hashes', async t => {
  if (!await audioCompressionAvailable()) { t.skip('ffmpeg/ffprobe are required for the actual MP3 path'); return; }
  const { disk, input, key, bytes } = await fixture(t);
  const cache = await disk.read<AudioCacheRecord>(['cache', `${key}.json`]); assert.ok(cache);
  const media = await encodeVerifiedMp3(disk, key, cache);
  await disk.move(['audio', `${key}.wav`], ['audio-archive', `${key}.wav`]);
  const result = (await new AudioInspectionService(disk).inspect(input)).chunks[0];
  assert.equal(result.audioHash, digest(bytes)); assert.equal(result.mediaHash, media.hash); assert.equal(result.mediaFormat, 'mp3');
  assert.equal(result.lightweight.status, 'no-warning'); assert.equal(result.content.status, 'indeterminate');
  assert.ok(Math.abs(result.lightweight.metrics!.durationSeconds - 5) < .002);
});

test('selected chunks merge atomically and source offsets remain absolute after saved evidence is reopened', async t => {
  const prefix = '前書き。', { disk, book, input, key } = await fixture(t, prefix + QA_TEXT);
  const block = book.document.blocks[0], prefixKey = digest('prefix-audio'), prefixBytes = qaWave(1);
  const second = book.chunks[0]; second.timeline[0].start = prefix.length; second.timeline[0].unitIds = book.document.units.filter(u => u.start >= prefix.length).map(u => u.id);
  book.chunks.unshift({ ...second, id: 'prefix-chunk', speechKey: prefixKey, durationSeconds: 1, timeline: [{ ...second.timeline[0], chunkId: 'prefix-chunk', start: 0, end: prefix.length, endSeconds: 1, unitIds: book.document.units.filter(u => u.end <= prefix.length).map(u => u.id) }] });
  book.completedChunks = 2; book.totalChunks = 2; book.durationSeconds = 6;
  await disk.write(['books', `${book.id}_${book.revision}.json`], book); await disk.writeBytes(['audio', `${prefixKey}.wav`], prefixBytes); await disk.write(['cache', `${prefixKey}.json`], { schemaVersion: 1, status: 'ready', provider: 'gemini', hash: digest(prefixBytes), durationSeconds: 1 });
  const asr: AsrAdapter = { version: 'fixture-candidate-v1', qualification: 'test-only', async transcribe(_path, mediaHash) { return { ...candidate(QA_CANDIDATES.omitted), mediaHash }; } };
  const service = new AudioInspectionService(disk, asr);
  await service.inspect({ ...input, selectedChunkIds: ['prefix-chunk'] });
  const report = await service.inspect({ ...input, content: true, selectedChunkIds: ['stable-chunk'] }); assert.equal(report.chunks.length, 2);
  const source = report.chunks[1].issues.find(i => i.code === 'possible-omission')?.source;
  assert.ok(source); assert.equal(source.blockId, block.id); assert.equal(source.start, prefix.length + 3);
  const read = await service.read(input.bookId, input.revision); assert.deepEqual(read?.chunks[1].issues.find(i => i.code === 'possible-omission')?.source, source);
  assert.equal((await service.inspect({ ...input, content: true, selectedChunkIds: ['stable-chunk'] })).reusedChunks, 1);
  assert.equal(book.chunks[1].speechKey, key);
});
