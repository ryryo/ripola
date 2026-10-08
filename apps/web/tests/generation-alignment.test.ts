import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';
import type { ReadingDocument } from '../src/reader/model.ts';
import { ALIGNMENT_NORMALIZE_VERSION, type AlignmentJob, type GenerationPlan, type StartAlignmentInput } from '../src/generation/contracts.ts';
import { GenerationService } from '../src/generation/core/service.ts';
import { digest, LibraryDisk } from '../src/generation/core/disk.ts';
import { requireAudioPresentation } from '../src/reader/audio-presentation.ts';
import { normalizeSpeech, prepareSpeech } from '../src/generation/core/speech-source.ts';
import { projectAlignment, validateAlignmentResult } from '../src/generation/core/alignment-projection.ts';
import type { AlignmentAdapter, AlignmentRuntimeRequest, AlignmentRuntimeResult } from '../src/generation/core/alignment-adapter.ts';

const VERSION = 'reazon-rs35kh-46afc596-ctc-v2';
function wav(): Uint8Array {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
  return bytes;
}
function resultFor(request: AlignmentRuntimeRequest, confidence = 0.98): AlignmentRuntimeResult {
  const characters = [...request.normalizedText];
  let offset = 0;
  return { schemaVersion: 1, alignerVersion: request.alignerVersion, normalizeVersion: request.normalizeVersion, offsetUnit: 'utf16', normalizedText: request.normalizedText, durationSeconds: 1,
    segments: characters.map((character, index) => { const start = offset; offset += character.length; return { start, end: offset, startSeconds: 0.1 + index / characters.length * 0.8, endSeconds: 0.1 + (index + 1) / characters.length * 0.8, confidence, status: confidence >= 0.75 ? 'aligned' : 'low-confidence' }; }) };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, provided?: AlignmentAdapter, engine = false) {
  const libraryDir = await mkdtemp(join(tmpdir(), 'rsvp-alignment-test-')); t.after(() => rm(libraryDir, { recursive: true, force: true }));
  let ttsCalls = 0; let alignmentCalls = 0;
  const adapter: AlignmentAdapter = provided ?? { version: VERSION, async available() { return true; }, async align(request) { alignmentCalls++; return resultFor(request); } };
  const config = { libraryDir, localOrigin: 'http://127.0.0.1:4173', paidEnabled: false };
  const speech = { ...(engine ? { async fingerprint() { return 'voicevox-engine:0.25.2'; } } : {}), async voices() { return [{ id: '3', name: '検証声' }]; }, async synthesize(_request: unknown, beforeSend: () => Promise<void>) { await beforeSend(); ttsCalls++; return wav(); } };
  const service = new GenerationService(config, { voicevox: speech, gemini: speech, alignment: adapter });
  const document = await prepareDocument(importText('朝の光が窓から差し込む。図書館で本をゆっくり読む。', 'txt', '自作の同期検証'));
  const plan = await service.prepareGeneration({ document, options: { provider: 'voicevox', voice: '3', transport: 'direct', readings: [] } });
  const generation = await service.startGeneration({ planId: plan.id, planHash: plan.hash, operationId: 'initial-speech', paidConfirmed: false });
  assert.equal((await service.waitForJob(generation.id)).status, 'completed');
  const input: StartAlignmentInput = { bookId: plan.bookId, revision: plan.revision, operationId: 'initial-alignment' };
  return { service, config, speech, adapter, plan, document, input, disk: new LibraryDisk(libraryDir), ttsCalls: () => ttsCalls, alignmentCalls: () => alignmentCalls };
}

test('ruby, dictionary, NFKC numbers, ligatures and surrogate pairs retain many-to-many UTF-16 source ranges', async () => {
  const document = await prepareDocument(importText('<ruby>東京<rt>とうきょう</rt></ruby>で２０２６年にABとﬃと👩‍💻を読む。', 'md', '自作'));
  const block = document.blocks[0];
  const speech = prepareSpeech(block, 0, block.text.length, [{ text: 'AB', reading: 'エービー' }]);
  assert.equal(speech.spokenText, 'とうきょうで２０２６年にエービーとﬃと👩‍💻を読む。');
  assert.ok(speech.sourceSpans.filter((span) => span.kind === 'ruby').every((span) => span.start === 0 && span.end === 2));
  const ab = block.text.indexOf('AB'); assert.ok(speech.sourceSpans.filter((span) => span.kind === 'dictionary').every((span) => span.start === ab && span.end === ab + 2));
  const normalized = normalizeSpeech(speech.spokenText); assert.match(normalized.text, /2026年/); assert.match(normalized.text, /ffi/); assert.ok(!normalized.text.includes('。'));
  const ligature = speech.spokenText.indexOf('ﬃ'); assert.equal(normalized.spans.filter((span) => span.spokenStart === ligature).length, 3);
  assert.ok(normalized.spans.some((span) => span.end - span.start === 2 && span.spokenEnd - span.spokenStart >= 2));
});

test('existing WAV alignment persists reliable phrase cues and cache reuse with zero TTS requests', async (t) => {
  const { service, input, plan, alignmentCalls, ttsCalls } = await fixture(t);
  const before = await service.getBook(plan.bookId, plan.revision);
  const hashes = await Promise.all(before.chunks.map(async (chunk) => digest((await service.getAudio(chunk.speechKey)).bytes)));
  const job = await service.startAlignment(input); assert.equal((await service.waitForAlignmentJob(job.id)).status, 'completed');
  assert.equal(alignmentCalls(), 2); assert.equal(ttsCalls(), 2);
  const aligned = await service.getBook(plan.bookId, plan.revision);
  assert.ok(aligned.chunks.every((chunk) => chunk.alignment?.precision === 'phrase' && chunk.alignment.status === 'aligned' && chunk.alignment.cues.length > 1));
  assert.deepEqual(aligned.chunks.map((chunk) => chunk.timeline), before.chunks.map((chunk) => chunk.timeline));
  const after = await Promise.all(aligned.chunks.map(async (chunk) => digest((await service.getAudio(chunk.speechKey)).bytes))); assert.deepEqual(after, hashes);
  const repeated = await service.startAlignment({ ...input, operationId: 'reuse-alignment' });
  const reused = await service.waitForAlignmentJob(repeated.id); assert.equal(reused.reusedChunks, 2); assert.equal(alignmentCalls(), 2); assert.equal(ttsCalls(), 2);
  const twice = await service.startAlignment(input); assert.equal(twice.id, job.id);
  const regeneratedPlan = await service.prepareGeneration({ document: aligned.document, options: aligned.options });
  const generation = await service.startGeneration({ planId: regeneratedPlan.id, planHash: regeneratedPlan.hash, operationId: 'reuse-speech-after-alignment', paidConfirmed: false }); await service.waitForJob(generation.id);
  assert.equal(ttsCalls(), 2); assert.ok((await service.getBook(plan.bookId, plan.revision)).chunks.every((chunk) => chunk.alignment?.cues.length));
});

test('low confidence and unmatched characters are persisted as sentence fallback without interpolating times', async (t) => {
  const adapter: AlignmentAdapter = { version: VERSION, async available() { return true; }, async align(request) {
    const result = resultFor(request, 0.2);
    result.segments[0] = { start: result.segments[0].start, end: result.segments[0].end, confidence: 0, status: 'unmatched' };
    result.warnings = ['unknown-vocabulary-character']; return result;
  } };
  const { service, input, ttsCalls } = await fixture(t, adapter);
  const job = await service.startAlignment(input); const completed = await service.waitForAlignmentJob(job.id); assert.equal(completed.status, 'completed');
  const book = await service.getBook(input.bookId, input.revision);
  assert.ok(book.chunks.every((chunk) => chunk.alignment?.precision === 'sentence' && chunk.alignment.cues.length === 0));
  assert.ok(book.chunks[0].alignment!.units.some((unit) => unit.status === 'unmatched' && unit.startSeconds === undefined));
  assert.ok(book.chunks[0].alignment!.units.some((unit) => unit.status === 'low-confidence')); assert.equal(ttsCalls(), 2);
});

test('alignment rejects changed transcript, invalid timing, invalid hash and arbitrary IDs without TTS', async (t) => {
  const { service, input, plan, disk, ttsCalls } = await fixture(t);
  const stored = await disk.read<{ plan: GenerationPlan; document: ReadingDocument }>(['plans', `${plan.id}.json`]); assert.ok(stored);
  stored.plan.chunks[0].spokenText = '音声と違う原稿'; await disk.write(['plans', `${plan.id}.json`], stored);
  const job = await service.startAlignment(input); assert.equal((await service.waitForAlignmentJob(job.id)).status, 'failed'); assert.equal(ttsCalls(), 2);
  await assert.rejects(service.startAlignment({ ...input, bookId: '../other' }), /ID/);
  await assert.rejects(service.startAlignment({ ...input, selectedChunkIds: ['unknown'] }), /対象/);
  const request: AlignmentRuntimeRequest = { schemaVersion: 1, audioPath: '/tmp/server-owned.wav', audioHash: 'a'.repeat(64), spokenText: '朝', normalizedText: '朝', normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: VERSION, offsetUnit: 'utf16' };
  assert.throws(() => validateAlignmentResult({ ...resultFor(request), normalizedText: '夜' }, request, 1), /本文/);
  const invalid = resultFor(request); invalid.segments[0].endSeconds = 2; assert.throws(() => validateAlignmentResult(invalid, request, 1), /時刻/);
});

test('many-to-many readings sharing one runtime token produce one cue instead of overlapping invented phrase times', async () => {
  const document = await prepareDocument(importText('AB', 'txt', '対応検証'));
  const first = document.units[0];
  document.units = [{ ...first, id: 'unit-a', start: 0, end: 1, text: 'A' }, { ...first, id: 'unit-b', start: 1, end: 2, text: 'B' }];
  const speech = prepareSpeech(document.blocks[0], 0, 2, [{ text: 'AB', reading: 'エービー' }]); const normalized = normalizeSpeech(speech.spokenText);
  const request: AlignmentRuntimeRequest = { schemaVersion: 1, audioPath: '/tmp/server-owned.wav', audioHash: 'a'.repeat(64), spokenText: speech.spokenText, normalizedText: normalized.text, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: VERSION, offsetUnit: 'utf16' };
  const projected = projectAlignment({ key: 'b'.repeat(64), audioHash: request.audioHash, alignerVersion: VERSION, document, blockId: first.blockId, start: 0, end: 2, speech, normalized, result: resultFor(request) });
  assert.equal(projected.cues.length, 1); assert.deepEqual(projected.cues[0].unitIds, ['unit-a', 'unit-b']); assert.equal(projected.cues[0].start, 0); assert.equal(projected.cues[0].end, 2);
});


test('multi-character CTC tokens spanning a BudouX boundary remain one reliable cue', async () => {
  const document = await prepareDocument(importText('AB', 'txt', 'CTC token対応検証'));
  const first = document.units[0];
  document.units = [{ ...first, id: 'unit-a', start: 0, end: 1, text: 'A' }, { ...first, id: 'unit-b', start: 1, end: 2, text: 'B' }];
  const speech = prepareSpeech(document.blocks[0], 0, 2, []); const normalized = normalizeSpeech(speech.spokenText);
  const result: AlignmentRuntimeResult = { schemaVersion: 1, alignerVersion: VERSION, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, offsetUnit: 'utf16', normalizedText: 'AB', durationSeconds: 1, segments: [{ start: 0, end: 2, startSeconds: 0.1, endSeconds: 0.9, confidence: 0.99, status: 'aligned' }] };
  const projected = projectAlignment({ key: 'c'.repeat(64), audioHash: 'a'.repeat(64), alignerVersion: VERSION, document, blockId: first.blockId, start: 0, end: 2, speech, normalized, result });
  assert.equal(projected.cues.length, 1); assert.deepEqual(projected.cues[0].unitIds, ['unit-a', 'unit-b']); assert.equal(projected.cues[0].startSeconds, 0.1); assert.equal(projected.cues[0].endSeconds, 0.9);
});

test('alignment cancellation and restart resume only unfinished local processing while preserving audio hashes', async (t) => {
  let calls = 0; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const adapter: AlignmentAdapter = { version: VERSION, async available() { return true; }, async align(request, signal) {
    calls++; if (calls === 2) { entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
    return resultFor(request);
  } };
  const { service, input, config, speech, ttsCalls } = await fixture(t, adapter);
  const job = await service.startAlignment(input); await started; await service.cancelAlignmentJob(job.id);
  const cancelled = await service.waitForAlignmentJob(job.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.completedChunks, 1); assert.equal(ttsCalls(), 2);
  const restarted = new GenerationService(config, { voicevox: speech, alignment: adapter }); await restarted.ready();
  await restarted.resumeAlignmentJob(job.id); assert.equal((await restarted.waitForAlignmentJob(job.id)).status, 'completed'); assert.equal(calls, 3); assert.equal(ttsCalls(), 2);
});

test('completed raw alignment cache survives manifest-write failure and resumes without model or TTS reruns', async (t) => {
  const { service, input, alignmentCalls, ttsCalls } = await fixture(t);
  const original = LibraryDisk.prototype.write;
  let fail = true;
  t.mock.method(LibraryDisk.prototype, 'write', async function (this: LibraryDisk, parts: string[], value: unknown) {
    if (parts[0] === 'books' && fail) { fail = false; throw new Error('private path in simulated error'); }
    return original.call(this, parts, value);
  });
  const job = await service.startAlignment(input); assert.equal((await service.waitForAlignmentJob(job.id)).status, 'failed'); assert.equal(alignmentCalls(), 1);
  await service.resumeAlignmentJob(job.id); const result = await service.waitForAlignmentJob(job.id);
  assert.equal(result.status, 'completed'); assert.equal(result.reusedChunks, 1); assert.equal(alignmentCalls(), 2); assert.equal(ttsCalls(), 2);
});

test('orphaned alignment jobs recover to explicit-resume state, independently of speech jobs', async (t) => {
  const { input, plan, config, speech, adapter, disk, ttsCalls } = await fixture(t);
  const job: AlignmentJob = { schemaVersion: 1, id: 'align-job-orphaned', operationId: 'orphaned', bookId: input.bookId, revision: input.revision, title: plan.title, status: 'running', alignerVersion: VERSION, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, selectedChunkIds: plan.chunks.map((chunk) => chunk.id), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), chunks: plan.chunks.map((chunk) => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'running', reused: false })), completedChunks: 0, totalChunks: plan.chunks.length, reusedChunks: 0 };
  await disk.write(['alignment-jobs', `${job.id}.json`], job);
  const restored = new GenerationService(config, { voicevox: speech, alignment: adapter }); await restored.ready();
  const saved = await restored.getAlignmentJob(job.id); assert.equal(saved.status, 'cancelled'); assert.ok(saved.chunks.every((chunk) => chunk.status === 'pending'));
  await restored.resumeAlignmentJob(job.id); assert.equal((await restored.waitForAlignmentJob(job.id)).status, 'completed'); assert.equal(ttsCalls(), 2);
});


test('new CTC processing preserves verified existing VOICEVOX cues without engine reconstruction or TTS', async t => {
  const { service, input, plan, disk, ttsCalls } = await fixture(t, undefined, true);
  const before = await service.getBook(plan.bookId, plan.revision);
  for (const chunk of before.chunks) {
    const mark = chunk.timeline[0];
    const units = before.document.units.filter(unit => unit.blockId === mark.blockId && unit.start >= mark.start && unit.end <= mark.end);
    const audioHash = digest((await service.getAudio(chunk.speechKey)).bytes);
    chunk.alignment = { schemaVersion: 1, key: 'b'.repeat(64), audioHash, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: VERSION,
      precision: 'phrase', method: 'voicevox-mora', status: 'aligned', warnings: [],
      engineTiming: { verification: 'voicevox-mora-frames', version: 'voicevox-mora-v1', querySource: 'captured', engineVersion: 'voicevox-engine:0.25.2', styleId: '3', frameRate: 93.75, frames: 94, queryHash: 'c'.repeat(64), phonemeMapping: 'exact', ctcAnchors: 0 },
      cues: units.map((unit, index) => ({ unitId: unit.id, unitIds: [unit.id], blockId: unit.blockId, start: unit.start, end: unit.end, startSeconds: index / units.length * .9, endSeconds: (index + 1) / units.length * .9 })),
      units: units.map(unit => ({ unitId: unit.id, blockId: unit.blockId, start: unit.start, end: unit.end, spokenRanges: [], normalizedRanges: [], status: 'aligned' })) };
  }
  before.presentation = requireAudioPresentation({ ...before, presentation: undefined });
  await disk.write(['books', `${before.id}_${before.revision}.json`], before);
  const original = before.chunks.map(chunk => chunk.alignment!.cues);
  const job = await service.startAlignment(input); assert.equal((await service.waitForAlignmentJob(job.id)).status, 'completed');
  const after = await service.getBook(plan.bookId, plan.revision);
  assert.deepEqual(after.chunks.map(chunk => chunk.alignment!.cues), original);
  assert.ok(after.chunks.every(chunk => chunk.alignment!.method === 'voicevox-mora'));
  assert.equal(ttsCalls(), 2);
});
