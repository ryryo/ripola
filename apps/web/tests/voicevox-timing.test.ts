import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roundFrames, voicevoxMoraClock, voicevoxPhraseTiming } from '../src/generation/core/voicevox-timing.ts';
import { validVoicevoxTiming } from '../src/reader/audio-clock.ts';
import type { SavedAlignment, VoicevoxTimingEvidence } from '../src/generation/contracts.ts';
import { digest } from '../src/generation/core/disk.ts';
import { prepareSpeech } from '../src/generation/core/speech-source.ts';
import type { ReadingDocument } from '../src/reader/model.ts';

test('VOICEVOX timing quantizes individual phonemes with ties-to-even and keeps pauses separate', () => {
  assert.equal(roundFrames(2.5), 2); assert.equal(roundFrames(3.5), 4);
  const query = { accent_phrases: [{ moras: [{ text: 'カ', consonant: 'k', consonant_length: 2.5 / 93.75, vowel: 'a', vowel_length: 3.5 / 93.75, pitch: 1 }], pause_mora: { text: '、', vowel: 'pau', vowel_length: 4 / 93.75, pitch: 0 } }], speedScale: 1, prePhonemeLength: 2 / 93.75, postPhonemeLength: 3 / 93.75, outputSamplingRate: 24000, outputStereo: false };
  const result = voicevoxMoraClock(query); assert.equal(result.frames, 15);
  assert.deepEqual(result.moras, [{ phoneme: 'k/a', startSeconds: 2 / 93.75, endSeconds: 8 / 93.75 }]);
  assert.throws(() => voicevoxMoraClock({ ...query, accent_phrases: [{ ...query.accent_phrases[0], is_interrogative: true }] }));
  assert.throws(() => voicevoxMoraClock({ ...query, outputSamplingRate: 48000 }));
});

// Authored tones/queries test acceptance and rejection; they are not model accuracy measurements.
function timingFixture() {
  const moras = [{ text: 'ア', vowel: 'a', vowel_length: .2, pitch: 1 }, { text: 'イ', vowel: 'i', vowel_length: .2, pitch: 1 }];
  const query = { accent_phrases: [{ moras }], speedScale: 1, prePhonemeLength: .1, postPhonemeLength: .1, outputSamplingRate: 24000, outputStereo: false };
  const clock = voicevoxMoraClock(query); const samples = clock.frames * 256; const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) audio.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 200 / 24000) * 1000), 44 + index * 2);
  const block = { id: 'b', kind: 'paragraph' as const, text: 'あ。い。', ruby: [], runs: [] };
  const document: ReadingDocument = { id: 'd', title: '検証', format: 'txt', rawText: block.text, blocks: [block], contentHash: 'a'.repeat(64), warnings: [], totalCharacters: 2,
    versions: { parser: 'fixture', model: 'fixture', rules: 'fixture' }, units: ['あ。', 'い。'].map((text, index) => ({ id: `u${index}`, blockId: 'b', kind: 'text', text, start: index * 2, end: index * 2 + 2,
      sources: [], mapping: 'exact', ruby: [], characters: 1, cumulativeCharacters: index, pause: 'sentence' })) };
  const audioHash = digest(audio); const speech = prepareSpeech(block, 0, 4, []);
  const ctc: SavedAlignment = { schemaVersion: 1, key: 'fixture', audioHash, normalizeVersion: 'fixture', alignerVersion: 'fixture', precision: 'phrase', method: 'forced-alignment', status: 'aligned', score: .9, units: [], warnings: [],
    cues: document.units.map((unit, index) => ({ unitId: unit.id, unitIds: [unit.id], blockId: 'b', start: unit.start, end: unit.end, startSeconds: clock.moras[index].startSeconds, endSeconds: clock.moras[index].endSeconds, score: .9 })) };
  return { query, moras, input: { key: 'timing', audio, audioHash, engineVersion: 'voicevox-engine:0.25.2', styleId: '2', document, blockId: 'b', start: 0, end: 4, speech, ctc, signal: new AbortController().signal } };
}

test('a matching WAV duration alone cannot pass reconstructed query verification', async t => {
  const fixture = timingFixture(); const input = fixture.input;
  let engine = '0.25.2'; let full = fixture.query; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (value: string | URL | Request, init?: RequestInit) => {
    calls++; const url = new URL(String(value)); assert.equal(url.origin, 'http://127.0.0.1:50021');
    assert.notEqual(url.pathname, '/synthesis');
    if (url.pathname === '/version') return new Response(JSON.stringify(engine));
    assert.equal(init?.method, 'POST'); assert.equal(url.pathname, '/audio_query');
    const text = url.searchParams.get('text');
    return new Response(JSON.stringify(text === input.speech.spokenText ? full : { ...fixture.query, accent_phrases: [{ moras: [fixture.moras[text === 'あ。' ? 0 : 1]] }] }));
  });
  const result = await voicevoxPhraseTiming(input);
  assert.equal(result?.method, 'voicevox-mora'); assert.equal(result?.engineTiming?.ctcAnchors, 2); assert.equal(result?.score, undefined);
  assert.ok(result?.cues.every(cue => cue.score === undefined));
  assert.equal(await voicevoxPhraseTiming({ ...input, ctc: { ...input.ctc, cues: [] } }), undefined);
  assert.equal(await voicevoxPhraseTiming({ ...input, ctc: { ...input.ctc, cues: [{ ...input.ctc.cues[0], startSeconds: .5, endSeconds: .55 }, input.ctc.cues[1]] } }), undefined);
  assert.equal(await voicevoxPhraseTiming({ ...input, ctc: { ...input.ctc, cues: input.ctc.cues.map(cue => ({ ...cue, score: .3 })) } }), undefined);
  // Same duration, different phoneme identity: reject rather than add times by character proportions.
  full = { ...fixture.query, accent_phrases: [{ moras: [{ ...fixture.moras[0], vowel: 'o' }, fixture.moras[1]] }] };
  assert.equal(voicevoxMoraClock(full).frames, voicevoxMoraClock(fixture.query).frames);
  assert.equal(await voicevoxPhraseTiming(input), undefined);
  full = fixture.query; engine = 'other'; assert.equal(await voicevoxPhraseTiming(input), undefined);
  engine = '0.25.2';
  const captured = { schemaVersion: 1 as const, audioHash: input.audioHash, spokenTextHash: digest(input.speech.spokenText), providerVersion: input.engineVersion, styleId: input.styleId, query: fixture.query };
  assert.equal((await voicevoxPhraseTiming({ ...input, captured, ctc: { ...input.ctc, cues: [] } }))?.engineTiming?.querySource, 'captured');
  assert.equal(await voicevoxPhraseTiming({ ...input, captured: { ...captured, spokenTextHash: 'b'.repeat(64) } }), undefined);
  const silent = Buffer.from(input.audio); silent.fill(0, 44); const silentHash = digest(silent);
  assert.equal(await voicevoxPhraseTiming({ ...input, audio: silent, audioHash: silentHash, ctc: { ...input.ctc, audioHash: silentHash }, captured: { ...captured, audioHash: silentHash } }), undefined);
  assert.ok(calls > 0);
});
test('reconstructed Engine timing requires exact version, a matching duration and acoustic anchors', () => {
  const proof: VoicevoxTimingEvidence = { verification: 'voicevox-mora-frames', version: 'voicevox-mora-v1', querySource: 'reconstructed', engineVersion: 'voicevox-engine:0.25.2', styleId: '2', frameRate: 93.75, frames: 206, queryHash: 'a'.repeat(64), phonemeMapping: 'exact', ctcAnchors: 3 };
  assert.equal(validVoicevoxTiming(proof, 206 / 93.75), true);
  assert.equal(validVoicevoxTiming({ ...proof, ctcAnchors: 1 }, 206 / 93.75), false);
  assert.equal(validVoicevoxTiming({ ...proof, engineVersion: 'voicevox-engine:other' }, 206 / 93.75), false);
  assert.equal(validVoicevoxTiming(proof, 3), false);
  assert.equal(validVoicevoxTiming({ ...proof, querySource: 'captured', ctcAnchors: 0 }, 206 / 93.75), true);
});
