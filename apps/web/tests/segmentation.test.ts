import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { DraftDocument } from '../src/reader/model';
import { boundariesFor, countCharacters, prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';

test('all self-authored design cases reconstruct body and preserve grapheme boundaries', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../docs/validation/fixtures/segmentation-cases.json', import.meta.url), 'utf8')) as { cases: Array<{ input: string; displayText: string }> };
  for (const example of fixture.cases) {
    const draft = importText(example.input, 'md', 'example');
    const document = await prepareDocument(draft);
    assert.equal(document.units.map((unit) => unit.text).join(''), example.displayText);
    const cuts = new Set([0, example.displayText.length, ...[...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(example.displayText)].map((part) => part.index)]);
    for (const unit of document.units) {
      assert.ok(unit.text.length);
      assert.ok(cuts.has(unit.start));
      assert.ok(cuts.has(unit.end));
    }
  }
});

test('dates, prices, version, ASCII URL/email and ruby base are indivisible', async () => {
  const text = '今日は2026年10月5日の12:30、料金は1,200円で3.14%です。全角は２０２６年１０月５日と１，２００円。TypeScriptとv2.1を使う。https://example.com/aを開く。連絡はa.b@example.comへ。';
  const document = await prepareDocument(importText(text, 'txt', 'protection'));
  for (const protectedText of ['2026年10月5日', '12:30', '1,200円', '3.14%', '２０２６年１０月５日', '１，２００円', 'TypeScript', 'v2.1', 'https://example.com/a', 'a.b@example.com']) {
    assert.ok(document.units.some((unit) => unit.text.includes(protectedText)), protectedText);
  }
  const ruby = await prepareDocument(importText('<ruby>非常に長い名称<rt>ひじょうにながいめいしょう</rt></ruby>を読む。', 'md', 'ruby'));
  const unit = ruby.units.find((candidate) => candidate.ruby.length)!;
  assert.ok(unit.text.includes('非常に長い名称'));
  assert.equal(unit.text.slice(unit.ruby[0].start, unit.ruby[0].end), '非常に長い名称');
});

test('punctuation and opening brackets never appear as isolated RSVP steps', async () => {
  const raw = '彼は「明日は晴れる」と言いました。はい、そうです！次は（本を読む）予定。';
  const document = await prepareDocument(importText(raw, 'txt', 'punctuation'));
  assert.equal(document.units.map((unit) => unit.text).join(''), raw);
  for (const unit of document.units) {
    assert.ok(!/^[\s\p{Punctuation}]+$/u.test(unit.text));
    assert.ok(!/[「『（【]$/.test(unit.text.trim()));
  }
  assert.equal(document.units.at(-1)?.pause, 'paragraph');
  assert.ok(document.units.some((unit) => unit.pause === 'sentence'));
});

test('source slices are monotone and exact even when the same phrase repeats', async () => {
  const raw = '同じ文を読む。同じ文を読む。\n\n同じ文を読む。';
  const document = await prepareDocument(importText(raw, 'txt', 'same'));
  let previous = 0;
  for (const unit of document.units) {
    assert.equal(unit.mapping, 'exact');
    assert.equal(unit.sources.map((source) => raw.slice(source.start, source.end)).join(''), unit.text);
    for (const source of unit.sources) { assert.ok(source.start >= previous); previous = source.end; }
  }
});

test('transformed Markdown fragments retain original syntax ranges with no false exact mapping', async () => {
  const raw = '私は**同じ語**と[同じ語](https://example.com)と&amp;を見る。';
  const document = await prepareDocument(importText(raw, 'md', 'sources'));
  assert.equal(document.units.map((unit) => unit.text).join(''), '私は同じ語と同じ語と&を見る。');
  let previous = 0;
  for (const unit of document.units) for (const source of unit.sources) { assert.ok(source.start >= previous); previous = source.end; }
  const amp = document.units.find((unit) => unit.text.includes('&'))!;
  assert.equal(amp.mapping, 'transformed');
  assert.ok(amp.sources.some((source) => raw.slice(source.start, source.end) === '&amp;'));
});

test('static code/table contribute no speed characters and cumulative count starts before unit', async () => {
  const document = await prepareDocument(importText('# 見出し\n\n本文を読む。\n\n```txt\n停止するコード\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾。', 'md', 'static'));
  assert.equal(document.units[0].cumulativeCharacters, 0);
  let cumulative = 0;
  for (const unit of document.units) {
    assert.equal(unit.cumulativeCharacters, cumulative);
    if (unit.kind === 'static') assert.equal(unit.characters, 0);
    cumulative += unit.characters;
  }
  assert.equal(document.totalCharacters, cumulative);
  assert.equal(document.units.filter((unit) => unit.kind === 'static').length, 2);
  assert.equal(document.units[0].pause, 'heading');
  assert.equal(countCharacters('👩‍💻 が、。!?'), 2);
});

test('stable hash/unit ids ignore title and change when source or content changes', async () => {
  const first = await prepareDocument(importText('同じ文。', 'txt', 'A'));
  const again = await prepareDocument(importText('同じ文。', 'txt', 'B'));
  const changed = await prepareDocument(importText('違う文。', 'txt', 'A'));
  assert.equal(first.contentHash, again.contentHash);
  assert.deepEqual(first.units.map((unit) => unit.id), again.units.map((unit) => unit.id));
  assert.notEqual(first.contentHash, changed.contentHash);
  assert.equal(first.versions.parser, 'budoux@0.9.3');
  assert.match(first.versions.model, /^ja@budoux-0\.9\.3:sha256-[0-9a-f]{64}$/);
});

test('PDF runs keep approximate item rectangles and multiple item ranges', async () => {
  const draft: DraftDocument = { title: 'PDF', format: 'pdf', rawText: '本文。', warnings: [], blocks: [{ id: 'p1', kind: 'paragraph', text: '本文。', ruby: [], runs: [{ start: 0, end: 1, mapping: 'approximate', sources: [{ kind: 'pdf', page: 1, item: 0, start: 0, end: 1, rect: [10, 10, 10, 10] }] }, { start: 1, end: 3, mapping: 'approximate', sources: [{ kind: 'pdf', page: 1, item: 1, start: 0, end: 2, rect: [20, 10, 20, 10] }] }] }] };
  const document = await prepareDocument(draft);
  assert.equal(document.units.map((unit) => unit.text).join(''), '本文。');
  assert.ok(document.units.every((unit) => unit.mapping === 'approximate'));
  assert.equal(document.units.flatMap((unit) => unit.sources).length, 2);
});

test('100k self-authored input reconstructs without empty units or offset drift', async () => {
  const raw = '私は朝の電車で本を読んでいます。👩‍💻が書いたが、まだ終わっていない。\n\n'.repeat(3_000);
  assert.ok(raw.length >= 100_000);
  const document = await prepareDocument(importText(raw, 'txt', 'long'));
  const reconstructed = new Map<string, string>();
  for (const unit of document.units) reconstructed.set(unit.blockId, (reconstructed.get(unit.blockId) ?? '') + unit.text);
  for (const block of document.blocks) assert.equal(reconstructed.get(block.id), block.text);
  assert.ok(document.units.every((unit) => unit.end > unit.start));
  assert.ok(document.totalCharacters > 0);
});

test('empty block has no bogus cuts', () => {
  assert.deepEqual(boundariesFor({ text: '', ruby: [] }), []);
});
