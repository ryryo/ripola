import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialReadingDraft, PAGES_DEMO } from '../src/reader/pages-demo';
import { resolveInputFormat } from '../src/reader/input-format';
import { importText } from '../src/reader/text-import';

test('public Pages draft is opt-in and does not prefill local or personal Worker inputs', () => {
  assert.deepEqual(initialReadingDraft('pages'), { title: PAGES_DEMO.title, text: PAGES_DEMO.text, format: 'auto' });
  for (const profile of ['local', 'worker', undefined]) assert.deepEqual(initialReadingDraft(profile), { title: '', text: '', format: 'auto' });
});

test('prefilled Pages excerpt matches bundled Aozora text without ruby notation', async () => {
  const sample = JSON.parse(await readFile(new URL('../public/samples/wagahai.json', import.meta.url), 'utf8'));
  const format = resolveInputFormat(PAGES_DEMO.text, 'auto');
  assert.equal(format, 'txt');
  const imported = importText(PAGES_DEMO.text, format, PAGES_DEMO.title);
  const paragraphs = sample.draft.blocks.filter((block: { kind: string }) => block.kind === 'paragraph');
  assert.equal(imported.blocks[0].text, paragraphs[0].text);
  assert.ok(paragraphs[1].text.startsWith(imported.blocks[1].text));
  for (const block of imported.blocks) assert.deepEqual(block.ruby, []);
});

test('edited Pages history retains empty input and manual format without touching other profiles', () => {
  const state = { ripolaPagesDraft: { title: '任意タイトル', text: '', format: 'txt' } };
  assert.deepEqual(initialReadingDraft('pages', state), state.ripolaPagesDraft);
  assert.deepEqual(initialReadingDraft('worker', state), { title: '', text: '', format: 'auto' });
  assert.deepEqual(initialReadingDraft('local', state), { title: '', text: '', format: 'auto' });
  assert.deepEqual(initialReadingDraft('pages', { ripolaPagesDraft: { title: '誤った状態', text: '本文', format: 'invalid' } }), initialReadingDraft('pages'));
});
