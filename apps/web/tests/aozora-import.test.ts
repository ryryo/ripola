import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { importAozora } from '../src/reader/aozora-import.ts';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { prepareSpeech } from '../src/generation/core/speech-source.ts';
import { readingSentences, sentenceIndexAt } from '../src/reader/sentences.ts';
import { DEFAULT_SETTINGS, type DraftDocument } from '../src/reader/model.ts';
import { validateSavedReading } from '../src/reader/storage.ts';
import { defaultVoicevoxVoice } from '../src/generation/default-voice.ts';

test('Aozora parses ruby bases and preserves note/gaiji positions without executable HTML or alt speech', () => {
  const raw = '<!DOCTYPE html SYSTEM "https://invalid.example/external.dtd"><h1 class="title">検証</h1><h2 class="author">著者</h2><div class="main_text"><h4><a class="midashi_anchor" id="one">一</a></h4>\r\n　<ruby><rb>猫</rb><rp>（</rp><rt>ねこ</rt><rp>）</rp></ruby>を見る。<br>字<ruby>誤<rt>ママ</rt></ruby>。<span class="notes">［＃注<img class="gaiji" src="https://invalid.example/one.png" alt="説明"></span><img class="gaiji" src="https://invalid.example/two.png" alt="記号の説明"><script>window.bad=1</script><iframe src="https://invalid.example/frame">危険</iframe></div><div class="bibliographical_information">入力：検証者<br>校正：校正者</div>';
  const draft = importAozora(raw);
  assert.deepEqual(draft.blocks.map(block => block.text), ['一', '猫を見る。', '字誤。〓']);
  const first = draft.blocks[1];
  assert.equal(first.ruby[0].reading, 'ねこ'); assert.equal(first.ruby[0].annotationKind, 'reading');
  assert.equal(draft.blocks[2].ruby[0].annotationKind, 'editorial');
  assert.equal(prepareSpeech(first, 0, first.text.length, []).spokenText, 'ねこを見る。');
  assert.equal(prepareSpeech(draft.blocks[2], 0, 3, []).spokenText, '字誤。');
  assert.deepEqual(draft.provenance?.counts, { ruby: 2, gaiji: 2, notes: 1 });
  assert.equal(draft.provenance?.annotations.length, 3);
  assert.match(draft.provenance!.bibliography, /入力：検証者\n校正：校正者/);
  for (const block of draft.blocks) for (const run of block.runs) if (run.mapping === 'exact') {
    const source = run.sources[0]; assert.equal(raw.slice(source.start, source.end), block.text.slice(run.start, run.end));
  }
  assert.match(raw.slice(first.ruby[0].source!.start, first.ruby[0].source!.end), /^<ruby>/);
});

test('the pinned sample contains all eleven chapters, ruby, final text and Aozora attribution', async () => {
  const value = JSON.parse(await readFile(new URL('../public/samples/wagahai.json', import.meta.url), 'utf8')) as { draft: DraftDocument };
  const draft = value.draft; const imported = importAozora(draft.rawText, draft.title, draft.provenance);
  assert.deepEqual(imported.blocks, draft.blocks);
  assert.equal(draft.provenance!.sourceSha256, '6d6f183529b1c4d87941e5d8c44a8d012beeedaba1cbe0fb5e586fcf38bd46df');
  assert.deepEqual(draft.provenance!.chapters.map(chapter => chapter.title), ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一']);
  assert.deepEqual(draft.provenance!.counts, { ruby: 9214, gaiji: 36, notes: 6 });
  assert.equal(draft.provenance!.annotations.filter(note => note.kind === 'gaiji').length, 36);
  assert.match(draft.blocks.filter(block => block.kind === 'paragraph')[0].text, /^吾輩は猫である。名前はまだ無い。/);
  assert.match(draft.blocks.at(-1)!.text, /ありがたいありがたい。$/);
  assert.match(draft.provenance!.bibliography, /柴田卓治/); assert.match(draft.provenance!.bibliography, /2018/);
  const document = await prepareDocument(draft);
  assert.equal(document.units.map(unit => unit.text).join(''), draft.blocks.map(block => block.text).join(''));
  const sentences = readingSentences(document); assert.equal(sentences.length, 9151);
  const target = sentences.at(-1)!.target; assert.equal(sentenceIndexAt(sentences, target), sentences.length - 1);
  validateSavedReading({ schemaVersion: 1, document, anchor: { blockId: sentences.at(-1)!.blockId, offset: sentences.at(-1)!.start }, settings: { ...DEFAULT_SETTINGS, cpm: 800 }, savedAt: new Date().toISOString() });
});

test('new-user CPM is 400 and Zundamon is resolved by metadata regardless of style ID or order', () => {
  assert.equal(DEFAULT_SETTINGS.cpm, 400);
  assert.equal(defaultVoicevoxVoice([{ id: '3', name: '別の声' }, { id: '801', name: 'ずんだもん / ノーマル', speakerName: 'ずんだもん', styleName: 'ノーマル' }]), '801');
});
