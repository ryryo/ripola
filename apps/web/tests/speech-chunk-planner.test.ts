import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateSpeechSeconds, planSpeechChunks, type ChunkPlannerPolicy, type SpeechChunkPlan } from '../src/generation/core/chunk-planner.ts';
import { fixturePolicy, plannerFixtures } from './fixtures/speech-chunk-planner.ts';

function verify(text: string, policy: ChunkPlannerPolicy, plan: SpeechChunkPlan): void {
  assert.equal(plan.chunks.map(chunk => chunk.text).join(''), text);
  const cuts = new Set([0, text.length, ...[...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].map(part => part.index)]);
  let cursor = 0;
  for (const chunk of plan.chunks) {
    assert.equal(chunk.start, cursor); assert.ok(chunk.end > cursor);
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(cuts.has(chunk.start) && cuts.has(chunk.end));
    assert.equal(chunk.characters, [...chunk.text].length);
    assert.equal(chunk.utf8Bytes, new TextEncoder().encode(chunk.text).length);
    assert.ok(chunk.characters <= policy.hard.maxCharacters);
    assert.ok(policy.hard.maxUtf8Bytes === undefined || chunk.utf8Bytes <= policy.hard.maxUtf8Bytes);
    assert.ok(policy.hard.maxTokenUpperBound === undefined || chunk.tokenUpperBound <= policy.hard.maxTokenUpperBound);
    assert.ok(chunk.estimatedSeconds <= policy.hard.maxEstimatedSeconds + 1e-9);
    assert.equal(chunk.estimatedSeconds, estimateSpeechSeconds(chunk.text));
    cursor = chunk.end;
  }
  assert.equal(cursor, text.length);
  assert.equal(plan.estimatedSeconds, estimateSpeechSeconds(text));
  assert.equal(new Set(plan.chunks.map(chunk => chunk.id)).size, plan.chunks.length);
}

for (const fixture of plannerFixtures) {
  test(`planner covers ordered source and satisfies hard budgets: ${fixture.id}`, () => {
    const input = { blockId: fixture.id, text: fixture.text };
    const plan = planSpeechChunks(input, fixturePolicy);
    verify(fixture.text, fixturePolicy, plan);
    assert.deepEqual(planSpeechChunks(input, fixturePolicy), plan, 'a restart yields the same plan and IDs');
  });
}

test('short sentences batch independently of display phrases, while long clauses use punctuation', () => {
  const text = plannerFixtures.find(fixture => fixture.id === 'many-short-sentences')!.text;
  const legacy = [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(text)];
  const plan = planSpeechChunks({ blockId: 'short', text }, fixturePolicy);
  assert.ok(plan.chunks.length < legacy.length / 2);
  const clauses = plannerFixtures.find(fixture => fixture.id === 'long-clause')!.text.repeat(3);
  const long = planSpeechChunks({ blockId: 'long', text: clauses }, fixturePolicy);
  assert.ok(long.chunks.length > 1);
  assert.ok(long.chunks.every(chunk => chunk.boundary === 'clause' || chunk.boundary === 'sentence' || chunk.boundary === 'end'));
});

test('numbers, dates, version identifiers, URLs and English words stay together when they fit', () => {
  const fixture = plannerFixtures.find(fixture => fixture.id === 'numbers-and-english')!;
  const policy = { ...fixturePolicy, hard: { maxCharacters: 80, maxEstimatedSeconds: 18 }, soft: { targetSeconds: 6, minimumSeconds: 2, preferredMaxSeconds: 10 } };
  const plan = planSpeechChunks({ blockId: fixture.id, text: fixture.text }, policy);
  for (const word of ['2026年10月12日', '10:30', '1,200円', 'v2.1', 'report_2026.json', '１２．５％', 'reader@example.test', 'https://example.test/path?q=12.5']) {
    const start = fixture.text.indexOf(word); const end = start + word.length;
    assert.ok(plan.chunks.every(chunk => chunk.end <= start || chunk.end >= end), word);
  }
  verify(fixture.text, policy, plan);
  const signed = '残高は -1,200円で、変化は+12.5%、費用は$3.14だった。'.repeat(4);
  const signs = planSpeechChunks({ blockId: 'signed', text: signed }, policy);
  for (const token of ['-1,200円', '+12.5%', '$3.14']) for (const match of signed.matchAll(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
    assert.ok(signs.chunks.every(chunk => chunk.end <= match.index || chunk.end >= match.index + token.length));
  }
});

test('one oversized candidate, including overlapping lexical protections, can always fall back', () => {
  const text = 'a'.repeat(100) + '12345' + 'b'.repeat(100);
  const policy = { ...fixturePolicy, hard: { maxCharacters: 12, maxUtf8Bytes: 32, maxEstimatedSeconds: 4 }, soft: { minimumSeconds: 0.5, targetSeconds: 1, preferredMaxSeconds: 2 } };
  const plan = planSpeechChunks({ blockId: 'oversized', text }, policy);
  assert.ok(plan.chunks.length > 10);
  verify(text, policy, plan);
});

test('a closing quotation stays with its sentence when the quoted utterance fits the hard budget', () => {
  for (const [open, close] of [['「', '」'], ['“', '”'], ['"', '"']]) {
    const text = (`彼は${open}確認は大切です。${close}と言った。続いて${open}小さく始めよう。${close}と話した。`).repeat(3);
    const policy = { ...fixturePolicy, hard: { maxCharacters: 14, maxEstimatedSeconds: 45 } };
    const plan = planSpeechChunks({ blockId: 'quotes', text }, policy);
    for (const match of text.matchAll(new RegExp(`。${close}`, 'gu'))) assert.ok(plan.chunks.every(chunk => chunk.end !== match.index + 1));
    verify(text, policy, plan);
  }
});

test('UTF-8 and code-point caps never split surrogate pairs, combining marks, flags or ZWJ sequences', () => {
  const text = '👨‍👩‍👧‍👦か\u3099𠮷🇯🇵葛\u{E0100}Cafe\u0301'.repeat(30);
  const policy = { ...fixturePolicy, hard: { maxCharacters: 18, maxUtf8Bytes: 40, maxEstimatedSeconds: 4 }, soft: { minimumSeconds: 0.5, targetSeconds: 1, preferredMaxSeconds: 2 } };
  verify(text, policy, planSpeechChunks({ blockId: 'grapheme', text }, policy));
  assert.throws(() => planSpeechChunks({ blockId: 'too-small', text: '👨‍👩‍👧‍👦' }, { ...policy, hard: { ...policy.hard, maxUtf8Bytes: 2 } }), /1書記素/);
});

test('token byte-fallback upper bounds account for BOS, spaces, dots and NFKC expansion', () => {
  const text = '㌖ ㍿ .. １．２ '.repeat(80);
  const policy = { ...fixturePolicy, hard: { maxCharacters: 3000, maxEstimatedSeconds: 30, maxTokenUpperBound: 256 } };
  const plan = planSpeechChunks({ blockId: 'tokens', text }, policy);
  verify(text, policy, plan);
  assert.ok(plan.chunks.every(chunk => chunk.tokenUpperBound >= new TextEncoder().encode(chunk.text.normalize('NFKC').replaceAll(' ', '▁')).length + 1));
  assert.ok(plan.chunks.length > 1);
});

test('source whitespace and line breaks are covered without normalization or trimming', () => {
  for (const text of ['', ' \t\r\n\n ', '  一行目。\r\n\r\n二行目。  ']) verify(text, fixturePolicy, planSpeechChunks({ blockId: 'space', text }, fixturePolicy));
});

test('existing indivisible ruby spans remain intact and impossible or invalid spans fail before sending', () => {
  const text = '甲'.repeat(70) + '東京都市図書館' + '乙'.repeat(70);
  const protectedRanges = [{ start: 70, end: 77 }];
  const plan = planSpeechChunks({ blockId: 'ruby', text, protectedRanges }, fixturePolicy);
  assert.ok(plan.chunks.every(chunk => chunk.end <= 70 || chunk.end >= 77));
  assert.throws(() => planSpeechChunks({ blockId: 'ruby', text, protectedRanges: [{ start: 0, end: text.length }] }, { ...fixturePolicy, hard: { ...fixturePolicy.hard, maxCharacters: 10 } }), /分割できない/);
  for (const range of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 1000 }, { start: NaN, end: 1 }]) {
    assert.throws(() => planSpeechChunks({ blockId: 'ruby', text, protectedRanges: [range] }, fixturePolicy), /保護範囲/);
  }
  assert.throws(() => planSpeechChunks({ blockId: 'ruby', text: 'か\u3099', protectedRanges: [{ start: 0, end: 1 }] }, fixturePolicy), /書記素境界/);
  const overlapping = 'abcdefghij'.repeat(3);
  const policy = { ...fixturePolicy, hard: { maxCharacters: 12, maxEstimatedSeconds: 45 } };
  verify(overlapping, policy, planSpeechChunks({ blockId: 'overlapping', text: overlapping, protectedRanges: [{ start: 8, end: 20 }] }, policy));
});

test('soft preferred length is not a shared 100-character hard cap', () => {
  const text = 'あ'.repeat(145);
  const policy = { ...fixturePolicy, requestCost: 80 };
  const plan = planSpeechChunks({ blockId: 'soft', text }, policy);
  assert.equal(plan.chunks.length, 1);
  assert.ok(plan.chunks[0].characters > 100 && plan.chunks[0].estimatedSeconds > policy.soft.preferredMaxSeconds);
  verify(text, policy, plan);
});

test('the objective trades request cost for natural boundaries and pins settings independently of source IDs', () => {
  const text = 'あ'.repeat(30) + '。' + 'い'.repeat(30) + '。' + 'う'.repeat(30) + '。';
  const policy = { ...fixturePolicy, soft: { targetSeconds: 5, minimumSeconds: 2, preferredMaxSeconds: 6 } };
  const inexpensive = planSpeechChunks({ blockId: 'tradeoff', text }, { ...policy, requestCost: 0 });
  const expensive = planSpeechChunks({ blockId: 'tradeoff', text }, { ...policy, requestCost: 60 });
  assert.ok(inexpensive.chunks.length > expensive.chunks.length);
  const changedVersion = planSpeechChunks({ blockId: 'tradeoff', text }, { ...policy, version: 'fixture-v2', requestCost: 60 });
  assert.deepEqual(expensive.chunks, changedVersion.chunks);
  assert.notEqual(expensive.settingsHash, changedVersion.settingsHash);
  assert.notEqual(expensive.hash, changedVersion.hash);
  const reordered = { ...policy, hard: { maxEstimatedSeconds: 45, maxCharacters: 3000 }, requestCost: 60 };
  assert.deepEqual(planSpeechChunks({ blockId: 'tradeoff', text }, reordered), expensive);
  assert.notEqual(planSpeechChunks({ blockId: 'other', text }, reordered).chunks[0].id, expensive.chunks[0].id);
  const scenarioOnly = planSpeechChunks({ blockId: 'tradeoff', text }, { ...reordered, estimatedRequestOverheadSeconds: 2 });
  assert.equal(scenarioOnly.settingsHash, expensive.settingsHash);
  assert.equal(scenarioOnly.hash, expensive.hash);
});

test('invalid duration, budget and cost policies fail explicitly', () => {
  for (const change of [
    { requestCost: NaN }, { estimatedRequestOverheadSeconds: -1 },
    { hard: { ...fixturePolicy.hard, maxCharacters: 0 } }, { hard: { ...fixturePolicy.hard, maxEstimatedSeconds: Infinity } },
    { soft: { ...fixturePolicy.soft, targetSeconds: 50 } }, { soft: { ...fixturePolicy.soft, minimumSeconds: 13 } },
  ]) assert.throws(() => planSpeechChunks({ blockId: 'bad', text: '自作。' }, { ...fixturePolicy, ...change }), /設定/);
});

test('seeded mixed-text cases cover the entire source under small hard budgets', () => {
  let seed = 19;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const words = ['甲', '乙', '。', '、', ' ', '\r\n', '「', '」', '(', ')', '3.14', '12:30', 'word', 'か\u3099', '👩🏽‍💻', '🇯🇵'];
  for (let trial = 0; trial < 50; trial++) {
    const text = Array.from({ length: 100 }, () => words[next() % words.length]).join('');
    const policy = { ...fixturePolicy, hard: { maxCharacters: 24, maxUtf8Bytes: 80, maxEstimatedSeconds: 5 }, soft: { targetSeconds: 2, minimumSeconds: 0.5, preferredMaxSeconds: 3 } };
    verify(text, policy, planSpeechChunks({ blockId: `seed-${trial}`, text }, policy));
  }
});
