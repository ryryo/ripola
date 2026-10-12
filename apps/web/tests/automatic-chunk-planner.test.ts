import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticChunkPlanner } from '../src/generation/core/automatic-chunk-planner.ts';
import { planSpeechChunks, estimateSpeechSeconds } from '../src/generation/core/chunk-planner.ts';
import { prepareSpeech } from '../src/generation/core/speech-source.ts';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';
import type { GenerationChunkPlanningInput, GenerationOptions } from '../src/generation/contracts.ts';
import { plannerFixtures } from './fixtures/speech-chunk-planner.ts';

const options: GenerationOptions = { provider: 'voicevox', voice: '3', transport: 'direct', readings: [], chunking: { mode: 'auto' } };
async function input(text: string, format: 'txt' | 'md' = 'txt'): Promise<GenerationChunkPlanningInput> {
  return { document: await prepareDocument(importText(text, format, '自作planner検査')), options, providerVersion: 'voicevox-engine:mock-v1',
    capabilities: { local: true, supportsStyle: false, cancellation: 'before-send' }, defaultSpans: [] };
}
function verifySource(value: GenerationChunkPlanningInput): ReturnType<typeof automaticChunkPlanner> {
  const result = automaticChunkPlanner(value);
  for (const block of value.document.blocks.filter(block => block.kind !== 'code' && block.kind !== 'table')) {
    const spans = result.spans.filter(span => span.blockId === block.id);
    assert.equal(spans.map(span => block.text.slice(span.start, span.end)).join(''), block.text);
    let cursor = 0;
    const cuts = new Set([0, block.text.length, ...[...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(block.text)].map(part => part.index)]);
    for (const span of spans) {
      assert.equal(span.start, cursor); assert.ok(span.end > span.start);
      assert.ok(cuts.has(span.start) && cuts.has(span.end));
      assert.ok(span.end - span.start <= 3000);
      assert.ok(block.ruby.every(ruby => span.end <= ruby.start || span.end >= ruby.end));
      const spoken = prepareSpeech(block, span.start, span.end, value.options.readings).spokenText;
      assert.ok(value.capabilities.maxCharacters === undefined || [...spoken].length <= value.capabilities.maxCharacters);
      cursor = span.end;
    }
  }
  return result;
}

test('normal pasted text uses the exact foundation span contract and retains static block exclusions', async () => {
  const value = await input('# 自作\n\n' + plannerFixtures[0].text + '\n\n```txt\n音声に混ぜないコード\n```', 'md');
  const result = verifySource(value);
  assert.deepEqual(automaticChunkPlanner(value), result);
  assert.ok(!result.spans.some(span => value.document.blocks.find(block => block.id === span.blockId)?.kind === 'code'));
});

test('a very long punctuation-free block falls back without requiring full-block transcript construction', async () => {
  const value = await input('昨日読んだ本の続きを静かな部屋で思い出す'.repeat(6000));
  const result = verifySource(value);
  assert.ok(result.spans.length > 100);
  value.options = { ...options, readings: [{ text: '辞書にだけある語', reading: 'じしょにだけあるご' }] };
  assert.deepEqual(verifySource(value).spans, result.spans);
});

test('existing ruby and dictionary replacements keep complete original spans under spoken-text limits', async () => {
  const value = await input(('  <ruby>東京<rt>とうきょう</rt></ruby>へ行く。図書館で本を読む。').repeat(20), 'md');
  value.options = { ...options, readings: [{ text: '図書館', reading: 'としょかん' }], chunking: { mode: 'auto' } };
  value.capabilities.maxCharacters = 25;
  const result = verifySource(value);
  assert.ok(result.spans.length > 3);
  for (const span of result.spans) {
    const block = value.document.blocks.find(block => block.id === span.blockId)!;
    const original = block.text.slice(span.start, span.end);
    const spoken = prepareSpeech(block, span.start, span.end, value.options.readings).spokenText;
    if (original.includes('東京')) assert.ok(spoken.includes('とうきょう'));
    if (original.includes('図書館')) assert.ok(spoken.includes('としょかん'));
  }
});

test('whole-block readings handle source and replacement lengths beyond the JavaScript argument limit', async () => {
  const value = await input('甲');
  const block = value.document.blocks[0];
  block.text = '甲'.repeat(140000) + '乙' + '丙'.repeat(140000);
  block.ruby = [{ start: 140000, end: 140001, reading: 'おつ' }];
  const result = automaticChunkPlanner(value);
  assert.equal(result.spans.map(span => block.text.slice(span.start, span.end)).join(''), block.text);
  assert.ok(result.spans.every(span => span.end - span.start <= 3000));
  block.text = '甲'.repeat(140000);
  block.ruby = [{ start: 0, end: block.text.length, reading: 'あ'.repeat(140000) }];
  assert.equal(prepareSpeech(block, 0, block.text.length, []).spokenText.length, 140000);
  block.text = '甲';
  block.ruby = [];
  const dictionary = prepareSpeech(block, 0, block.text.length, [{ text: block.text, reading: 'あ'.repeat(140000) }]);
  assert.equal(dictionary.spokenText.length, 140000);
  assert.deepEqual(dictionary.sourceSpans.at(-1), { spokenStart: 139999, spokenEnd: 140000, start: 0, end: 1, kind: 'dictionary' });
});

test('dictionary matches after ruby, editorial annotations and source whitespace preserve coverage', async () => {
  const value = await input('<ruby>東京<rt>とうきょう</rt></ruby>へ行く。' + '甲乙'.repeat(50), 'md');
  value.options = { ...options, readings: [{ text: 'とうきょうへ', reading: 'みやこへ' }] };
  verifySource(value);
  const editorial = await input('甲乙丙丁'.repeat(30));
  editorial.document.blocks[0].ruby = [{ start: 40, end: 50, reading: '注記', annotationKind: 'editorial' }];
  verifySource(editorial);
});

test('silent source spans still retain complete coverage and the storage ceiling with an unused dictionary', async () => {
  const value = await input('甲');
  value.document.blocks[0].text = ' \t'.repeat(4000);
  value.options = { ...options, readings: [{ text: '未使用', reading: 'みしよう' }] };
  const result = verifySource(value);
  assert.ok(result.spans.length > 1);
});

test('Irodori capability budgets use a token upper bound, duration margin and the configured speed', async () => {
  const value = await input('資料の数字は１．２で、単位は㌖だった。説明を読み直す。'.repeat(25));
  value.options = { ...options, provider: 'irodori', model: 'irodori-tts-mf', voice: 'mock', irodori: { speed: 0.5 } };
  value.providerVersion = 'irodori:mock-model-voice-v1';
  value.capabilities = { local: true, supportsStyle: true, cancellation: 'abort', maxTextTokens: 256, maxAudioSeconds: 30, recommendedMaxCharacters: 90 };
  const result = verifySource(value);
  for (const span of result.spans) {
    const text = value.document.blocks.find(block => block.id === span.blockId)!.text.slice(span.start, span.end);
    assert.ok(estimateSpeechSeconds(text) / 0.5 <= 24);
    const budget = planSpeechChunks({ blockId: 'budget', text }, { version: 'check', hard: { maxCharacters: 3000, maxTokenUpperBound: 256, maxEstimatedSeconds: 30 },
      soft: { minimumSeconds: 1, targetSeconds: 15, preferredMaxSeconds: 30 }, requestCost: 1e6, estimatedRequestOverheadSeconds: 0 });
    assert.equal(budget.chunks.length, 1);
    assert.ok(budget.chunks[0].tokenUpperBound <= 256);
  }
});

test('indivisible readings that exceed a provider cap fail during planning', async () => {
  const value = await input('<ruby>漢字<rt>とてもながいよみかた</rt></ruby>を読む。', 'md');
  value.capabilities.maxCharacters = 4;
  assert.throws(() => automaticChunkPlanner(value), /分割できない/);
});

test('readings that shorten more than 3000 source characters retain all annotations in few storage-safe chunks', async () => {
  const text = Array.from({ length: 80 }, (_, index) => '<ruby>' + '甲'.repeat(60) + '<rt>' + String.fromCodePoint(0x3041 + index) + '</rt></ruby>').join('');
  const value = await input(text, 'md');
  const result = verifySource(value);
  assert.equal(result.spans.length, 2, '4800 source characters need only two chunks for this fitting utterance');
});

test('display units and settings do not change spans or fingerprint; provider and planner budgets do', async () => {
  const value = await input(plannerFixtures[0].text);
  const original = automaticChunkPlanner(value);
  const displayOnly = structuredClone(value); displayOnly.document.units = []; displayOnly.document.versions.rules = 'display-only';
  assert.deepEqual(automaticChunkPlanner(displayOnly), original);
  const providerUpdate = automaticChunkPlanner({ ...value, providerVersion: 'voicevox-engine:mock-v2' });
  assert.deepEqual(providerUpdate.spans, original.spans);
  assert.notEqual(providerUpdate.settingsFingerprint, original.settingsFingerprint);
  const budgetUpdate = automaticChunkPlanner({ ...value, capabilities: { ...value.capabilities, maxCharacters: 30 } });
  assert.notEqual(budgetUpdate.settingsFingerprint, original.settingsFingerprint);
});
