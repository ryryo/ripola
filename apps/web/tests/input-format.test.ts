import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectTextFormat, resolveInputFormat } from '../src/reader/input-format.ts';
import { readerCapabilities } from '../src/reader/environment.ts';
test('auto detects strong Markdown hints while keeping literal prose and ambiguous punctuation', () => {
  for (const value of ['# 朝の図書館\n\n本文。', '[図書館](https://example.com)へ。', '```js\nconst a=1;\n```', '| 項目 | 値 |\n| --- | --- |', '<ruby>朝<rt>あさ</rt></ruby>です。', '**静かな朝**です。', '- 本を読む', '> 引用する文']) assert.equal(detectTextFormat(value), 'md', value);
  for (const value of ['', '朝の図書館は静かです。', 'C# と #記号、a*b、snake_case をそのまま読む。', '---', '100円 - 20円', '👩‍💻が書いたが。', ' '.repeat(100_000) + '朝']) assert.equal(detectTextFormat(value), 'txt', value.slice(0,80));
});
test('manual override wins without changing raw input, and auto may be selected again', () => {
  const source='# 見出し\n\n[本](https://example.com)を読む。';
  assert.equal(resolveInputFormat(source,'txt'),'txt');assert.equal(resolveInputFormat(source,'auto'),'md');assert.equal(resolveInputFormat('記号はない。','md'),'md');assert.equal(source,'# 見出し\n\n[本](https://example.com)を読む。');
});
test('capabilities distinguish local generation and public audio routes', () => {
  assert.deepEqual(readerCapabilities('local'), { localGeneration:true,audioRename:true,environmentLabel:'ローカルPC版',audioRoute:'library' });
  for (const profile of ['worker','pages',undefined]) { const c=readerCapabilities(profile);assert.equal(c.localGeneration,false);assert.equal(c.audioRename,false);assert.equal(c.environmentLabel,'配布閲覧版'); }
  assert.equal(readerCapabilities('pages').audioRoute,'demo/');assert.equal(readerCapabilities('worker').audioRoute,'books/');
});
