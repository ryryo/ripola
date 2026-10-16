import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phrasePageAt, planPhrasePages, type PhraseSlice } from '../src/reader/phrase-layout';
import { prepareDocument } from '../src/reader/segmentation';
import { importText } from '../src/reader/text-import';

const fits = (unit: PhraseSlice, size: number, wrap: boolean) => wrap || Array.from(unit.text).length * size <= 240;

test('one line shrinks before natural subdivision and keeps exact source coverage', async () => {
  const doc = await prepareDocument(importText('国際情報通信技術研究開発機構の研究員です。', 'txt', '確認'));
  const original = JSON.stringify(doc);
  const unit = doc.units[0];
  const pages = planPhrasePages(unit, [unit], 56, fits);
  assert.ok(pages.length > 1);
  assert.equal(pages.map(page => page.unit.text).join(''), unit.text);
  assert.ok(pages.every(page => !page.wrapped && fits(page.unit, page.fontSize, false)));
  assert.equal(pages[0].unit.start, unit.start);
  assert.equal(pages.at(-1)!.unit.end, unit.end);
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i - 1].unit.end, pages[i].unit.start);
  for (const page of pages) assert.equal(doc.blocks.find(block => block.id === page.unit.blockId)!.text.slice(page.unit.start, page.unit.end), page.unit.text);
  assert.equal(phrasePageAt(pages, unit, 0), 0);
  assert.equal(phrasePageAt(pages, unit, 1), pages.length - 1);
  assert.equal(JSON.stringify(doc), original);
});

test('ruby, dates, URLs, English words and graphemes remain indivisible fallback runs', async () => {
  for (const text of ['https://example.com/abcdefghijklmnopqrstuvwxyz123456789', 'InternationalizationInternationalization', '2026年10月15日', '<ruby>国際情報通信技術研究開発機構<rt>こくさいじょうほうつうしんぎじゅつけんきゅうかいはつきこう</rt></ruby>', '👩‍💻が𠮷']) {
    const doc = await prepareDocument(importText(text, 'md', '確認'));
    for (const unit of doc.units) {
      const pages = planPhrasePages(unit, [unit], 56, fits);
      assert.equal(pages.length, 1);
      assert.equal(pages[0].unit.text, unit.text);
      assert.deepEqual(pages[0].unit.ruby, unit.ruby);
    }
  }
});

test('a very long source unit measures nearby cuts instead of every remaining suffix', async () => {
  const measured: number[] = [];
  for (const length of [1000, 2000]) {
    const doc = await prepareDocument(importText('漢'.repeat(length), 'txt', '確認'));
    assert.equal(doc.units.length, 1);
    let characters = 0;
    const pages = planPhrasePages(doc.units[0], doc.units, 56, (unit, size, wrap) => { characters += unit.text.length; return fits(unit, size, wrap); });
    assert.equal(pages.map(page => page.unit.text).join(''), doc.units[0].text);
    measured.push(characters);
  }
  assert.ok(measured[0] < 20000);
  assert.ok(measured[1] < measured[0] * 2.2);
});
