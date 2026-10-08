import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODELS } from '../src/generation/contracts';
import { estimateGeminiOutput, geminiEstimateNote } from '../src/generation/cost-estimate';
import { countSpokenCharacters } from '../src/generation/cost-source';
import { importText } from '../src/reader/text-import';
const current = new Date('2026-10-07T12:00:00Z');

test('400 spoken characters mean 60 original audio seconds; Lite/Flash cost 0.009/0.0135 USD', () => {
  const lite = estimateGeminiOutput(400, GEMINI_MODELS[0], current);
  assert.equal(lite.estimatedSeconds, 60); assert.equal(lite.estimatedAudioTokens, 1500);
  assert.equal(lite.estimatedOutputUsd, 0.009); assert.equal(lite.inputUsdPerMillionTokens, 0.5);
  assert.equal(estimateGeminiOutput(400, GEMINI_MODELS[1], current).estimatedOutputUsd, 0.0135);
  assert.equal(estimateGeminiOutput(0, GEMINI_MODELS[0], current).estimatedOutputUsd, 0);
  assert.match(geminiEstimateNote('direct', lite), /再生速度を変えても生成費用は変わりません/);
  assert.match(geminiEstimateNote('gateway', lite), /5%手数料は含みません/);
  assert.throws(() => estimateGeminiOutput(-1)); assert.throws(() => estimateGeminiOutput(NaN));
});

test('announced 2027 Standard prices change at UTC date boundary', () => {
  assert.equal(estimateGeminiOutput(400, GEMINI_MODELS[0], new Date('2026-12-31T23:59:59Z')).estimatedOutputUsd, 0.009);
  const changed = estimateGeminiOutput(400, GEMINI_MODELS[0], new Date('2027-01-01T00:00:00Z'));
  assert.equal(changed.estimatedOutputUsd, 0.018); assert.equal(changed.inputUsdPerMillionTokens, 1);
  assert.equal(estimateGeminiOutput(400, GEMINI_MODELS[1], new Date('2027-01-01T00:00:00Z')).estimatedOutputUsd, 0.027);
});

test('Markdown ruby and reading overrides count only spoken text, with static blocks excluded', () => {
  const raw = '# 見出し\n\n<ruby>図書館<rt>としょかん</rt></ruby>で**本**を読む。\n\n```js\nconst neverSpeak = 12345;\n```\n\n| 列 | 列 |\n| --- | --- |\n| 除外 | 除外 |';
  const source = { raw, format: 'md' as const, readings: [{text: '本', reading: 'ほん'}] };
  assert.equal(countSpokenCharacters(source), [...'見出しとしょかんでほんを読む。'].length);
  const document = importText(raw, 'md', '検証');
  const paragraph = document.blocks.find(block => block.kind === 'paragraph')!;
  assert.equal(countSpokenCharacters({...source, document, ranges: [{blockId: paragraph.id, start: 0, end: paragraph.text.length}]}), [...'としょかんでほんを読む。'].length);
  assert.equal(countSpokenCharacters({...source, document, ranges: []}), 0);
});

test('prepared PDF/HTML blocks are authoritative, and codepoints/sentence whitespace match TTS', () => {
  const document = importText('  朝。  😀を読む。  ', 'txt', '検証');
  assert.equal(countSpokenCharacters({raw: 'wrong fallback', format: 'md', document, readings: []}), [...'朝。😀を読む。'].length);
  assert.equal(countSpokenCharacters({raw: '', format: 'txt', readings: []}), 0);
  assert.equal(countSpokenCharacters({raw: '```txt\n音声から除く\n```', format: 'md', readings: []}), 0);
});
