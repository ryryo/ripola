import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';
import { audioDisplayAt, audioSegments } from '../src/reader/audio-clock';
import { continuation, contiguousChunks, playbackAnchor, restoreAnchor, savedPlaybackAnchor, serializePlaybackAnchor, acceptsManifest, mergeManifest } from '../src/reader/audio-progressive';
import type { AudioBookManifest } from '../src/generation/contracts';

async function fixture(): Promise<AudioBookManifest> {
  const document = await prepareDocument(importText('朝の窓を開きます。次の頁を読みます。最後に本を閉じます。', 'txt', '自作の途中本'));
  const block = document.blocks[0];
  const chunks = [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(block.text)].map((value, i) => ({ id: `c${i}`, speechKey: `s${i}`, audioUrl: `/c${i}.wav`, mimeType: 'audio/wav' as const, durationSeconds: 3, sourceOrder: i,
    timeline: [{ blockId: block.id, chunkId: `c${i}`, start: value.index, end: value.index + value.segment.length, unitIds: document.units.filter(unit => unit.start >= value.index && unit.end <= value.index + value.segment.length).map(unit => unit.id), startSeconds: 0, endSeconds: 3, precision: 'sentence' as const }] }));
  return { schemaVersion: 1, id: document.id, revision: 'r1', title: document.title, updatedAt: '2026-10-12', durationSeconds: 9, precision: 'sentence', document, chunks, plannedChunkIds: chunks.map(chunk => chunk.id), completedChunks: 3, totalChunks: 3, options: { provider: 'voicevox', voice: '3', readings: [], transport: 'direct' }, warnings: [], generation: { jobId: 'j1', planId: 'p1', planHash: 'h1', sequence: 3 } };
}

test('partial books wait at a generation hole and resume only the immediate source successor', async () => {
  const full = await fixture();
  const partial = { ...full, chunks: [full.chunks[0], full.chunks[2]], completedChunks: 2 };
  assert.deepEqual(continuation(partial, 'c0'), { kind: 'waiting', chunkId: 'c1' });
  assert.deepEqual(contiguousChunks(partial, 'c0').map(chunk => chunk.id), ['c0']);
  assert.deepEqual(continuation(full, 'c0'), { kind: 'next', index: 1 });
  assert.deepEqual(continuation(full, 'c2'), { kind: 'end' });
  const legacy = { ...full, plannedChunkIds: undefined };
  assert.deepEqual(continuation({ ...legacy, chunks: [full.chunks[0]], completedChunks: 1 }, 'c0'), { kind: 'waiting' });
  assert.deepEqual(continuation(legacy, 'c0'), { kind: 'next', index: 1 });
});

test('completion inserted earlier changes the absolute offset without moving current chunk/local time', async () => {
  const full = await fixture();
  const partial = audioSegments({ ...full, chunks: [full.chunks[0], full.chunks[2]], completedChunks: 2 });
  const anchor = playbackAnchor(partial[1], 1.3);
  const restored = restoreAnchor(audioSegments(full), anchor)!;
  assert.equal(restored.index, 2); assert.equal(restored.localSeconds, 1.3); assert.equal(restored.assetChanged, false);
});

test('a saved source bookmark survives chunks completed while closed; legacy/corrupt values fall back', async () => {
  const full = await fixture();
  const partial = audioSegments({ ...full, chunks: [full.chunks[0], full.chunks[2]], completedChunks: 2 });
  const original = playbackAnchor(partial[1], 1.3);
  const saved = savedPlaybackAnchor(serializePlaybackAnchor(original))!;
  assert.deepEqual(restoreAnchor(audioSegments(full), saved), { index: 2, localSeconds: 1.3, assetChanged: false });
  for (const value of [null, '4.3', '{bad', JSON.stringify({ version: 0, ...original }), JSON.stringify({ version: 1, ...original, localSeconds: -1 }), JSON.stringify({ version: 1, ...original, fraction: 9 })]) assert.equal(savedPlaybackAnchor(value), undefined);
});

test('MP3 replacement remaps the same source phrase; cue-only updates preserve the native clock', async () => {
  const full = await fixture(); const original = audioSegments(full);
  const anchor = playbackAnchor(original[0], 1.3);
  const changed = { ...full, chunks: [{ ...full.chunks[0], audioUrl: '/new.mp3', mimeType: 'audio/mpeg' as const, durationSeconds: 6 }, ...full.chunks.slice(1)] };
  const restored = restoreAnchor(audioSegments(changed), anchor)!;
  assert.equal(restored.assetChanged, true); assert.equal(audioDisplayAt(audioSegments(changed)[0], restored.localSeconds).units[0].id, anchor.unitId);
  assert.equal(restoreAnchor(original, anchor)!.localSeconds, 1.3);
  assert.equal(restoreAnchor(audioSegments(changed), playbackAnchor(original[0], 3, true))!.localSeconds, 6);
});

test('old jobs, plan hashes, revisions and monotonic sequence regressions cannot update the reader', async () => {
  const book = await fixture();
  assert.equal(acceptsManifest(book, { ...book, generation: { ...book.generation!, sequence: 4 } }), true);
  for (const changed of [{ jobId: 'old' }, { planId: 'old' }, { planHash: 'old' }, { sequence: 2 }]) assert.equal(acceptsManifest(book, { ...book, generation: { ...book.generation!, ...changed } }), false);
  assert.equal(acceptsManifest(book, { ...book, revision: 'old' }), false);
  assert.equal(acceptsManifest(book, { ...book, completedChunks: 99 }), false);
});

test('equal-sequence alignment views preserve immutable source refs and reject source/plan corruption', async () => {
  const book = await fixture();
  const incoming = structuredClone(book); incoming.title = '表示名の更新';
  assert.equal(acceptsManifest(book, incoming), true);
  const merged = mergeManifest(book, incoming);
  assert.equal(merged.document.blocks, book.document.blocks);
  assert.equal(merged.document.units, book.document.units);
  assert.equal(merged.title, incoming.title);
  assert.equal(acceptsManifest(book, { ...incoming, plannedChunkIds: ['c0', 'c2', 'c1'] }), false);
  assert.equal(acceptsManifest(book, { ...incoming, chunks: [book.chunks[0]], completedChunks: 1 }), false);
  assert.equal(acceptsManifest(book, { ...incoming, document: { ...book.document, contentHash: 'other' } }), false);
});

test('manifest validation checks all saved IDs with bounded linear work on long partial books', async () => {
  const book = await fixture(), count = 256;
  const chunks = Array.from({ length: count }, (_, i) => ({ ...book.chunks[0], id: `long-${i}`, sourceOrder: i }));
  const current = { ...book, chunks, totalChunks: count + 1, completedChunks: count, plannedChunkIds: [...chunks.map(chunk => chunk.id), 'pending'] };
  let idReads = 0;
  const incoming = { ...current, chunks: chunks.map(chunk => ({ ...chunk, get id() { idReads++; return chunk.id; } })) };
  assert.equal(acceptsManifest(current, incoming), true);
  assert.ok(idReads <= count * 4, `unchanged manifest required ${idReads} saved-ID reads for ${count} chunks`);
  for (const changed of [
    { ...incoming, chunks: incoming.chunks.slice(1), completedChunks: count - 1 },
    { ...incoming, chunks: [...incoming.chunks].reverse() },
    { ...incoming, chunks: [incoming.chunks[0], incoming.chunks[0], ...incoming.chunks.slice(2)] },
    { ...incoming, chunks: [{ ...incoming.chunks[0], id: 'not-in-plan' }, ...incoming.chunks.slice(1)] },
  ]) assert.equal(acceptsManifest(current, changed), false);
});
