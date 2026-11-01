import assert from 'node:assert/strict';
import test from 'node:test';
import { importArticle } from '../src/reader/article-import';
import { NoteImporter, noteArticleHtml, parseFreeNote } from '../src/url-import/note.server';
import { noteUrlInput, supportedUrlInput } from '../src/url-import/urls';
import { requireLocalTextBook } from '../src/kakuyomu/text-books';
import { digest } from '../src/generation/core/disk';
import type { LocalTextBook } from '../src/kakuyomu/contracts';
import { IDBFactory } from 'fake-indexeddb';
import { saveReading, loadReading, deleteReading } from '../src/reader/storage';
import { DEFAULT_SETTINGS } from '../src/reader/model';
import { prepareDocument } from '../src/reader/segmentation';

const url = 'https://note.com/example/n/n0123456789ab';
const source = noteUrlInput(url)!;
const body = '<h2>見出し</h2><p>  朝に <strong>文章</strong> と<ruby>本<rt>ほん</rt></ruby>を読む。&amp; 次へ。</p><ul><li>第一項</li><li>第二項</li></ul><blockquote><p>引用の文章。</p></blockquote><pre><code>const a = 1;\n  a++;</code></pre><figure><img src="https://evil.test/image"><figcaption>画像の説明。</figcaption></figure><iframe src="http://127.0.0.1/"></iframe><script>secret()</script>';
function article(overrides: Record<string, unknown> = {}) {
  return { data: { key: source.key, status: 'published', type: 'TextNote', is_published: true, is_draft: false, price: 0, can_read: true,
    is_limited: false, separator: null, is_r18: false, is_r18_confirmation_needed: false,
    remained_char_num: 0, remained_figure_num: 0, remained_image_num: 0, remained_file_num: 0, remained_sound_num: 0,
    name: '記事タイトル', body, note_url: url, user: { urlname: 'example', nickname: '著者' }, publish_at: '2026-11-01T00:00:00Z',
    paywall: { is_simple_paid_note: true, context: { is_show_limited_pay_note_paywall: false } }, ...overrides } };
}

test('note URL dispatch accepts one article, drops share tracking and rejects other origins, credentials and feeds', () => {
  assert.equal(supportedUrlInput(url)?.kind, 'note');
  assert.equal(noteUrlInput(`${url}?sub_rt=share_b&utm_source=share#section`)?.url, url);
  assert.equal(noteUrlInput(url.replace('https:', 'http:'))?.url, url);
  for (const input of ['https://note.com/example', 'https://note.com/example/m/m0123456789ab', 'https://note.com/api/v3/notes/n0123456789ab',
    url.replace('note.com', 'note.com.evil.test'), url.replace('note.com', 'user@note.com'), url.replace('note.com', 'note.com:8443'),
    'http://127.0.0.1/n/n0123456789ab', 'https://note.com/example/n/invalid']) assert.equal(noteUrlInput(input), undefined, input);
});

test('note validates free public access and full body before parsing any HTML', () => {
  assert.equal(parseFreeNote(article(), source).title, '記事タイトル');
  for (const overrides of [{ price: 100 }, { can_read: false }, { is_limited: true }, { is_published: false }, { is_draft: true },
    { status: 'draft' }, { separator: 'paid' }, { remained_char_num: 100 }, { remained_image_num: 2 }, { is_r18_confirmation_needed: true },
    { is_published_preview_note: true }, { is_temporary_frozen: true }]) {
    assert.throws(() => parseFreeNote(article({ ...overrides, body: '<unknown>unreadable</unknown>' }), source), /無料で全文公開/);
  }
  assert.throws(() => parseFreeNote(article({ paywall: { context: { is_show_limited_pay_note_paywall: true } } }), source), /閲覧制限/);
  assert.throws(() => parseFreeNote(article({ type: 'ImageNote' }), source), /テキスト記事/);
  assert.throws(() => parseFreeNote(article({ key: 'nffffffffffff' }), source), /一致/);
  assert.throws(() => parseFreeNote(article({ user: { urlname: 'other', nickname: '著者' } }), source), /一致/);
  assert.throws(() => parseFreeNote(article({ note_url: 'https://evil.test/' }), source), /一致/);
});

test('article HTML keeps paragraphs, headings, ruby, quotes, list items, captions and code without activating media', () => {
  const raw = noteArticleHtml(parseFreeNote(article(), source), url);
  const draft = importArticle(raw, { title: '記事タイトル', author: '著者', sourceUrl: url, sourceSha256: digest(raw) });
  assert.equal(draft.format, 'html');
  assert.equal(draft.blocks.find(block => block.ruby.length)?.ruby[0].reading, 'ほん');
  assert.match(draft.blocks.find(block => block.ruby.length)?.text ?? '', /^朝に 文章 と本を読む。& 次へ。$/);
  assert.deepEqual(draft.blocks.filter(block => block.kind === 'listItem').map(block => block.text), ['第一項', '第二項']);
  assert.equal(draft.blocks.find(block => block.kind === 'quote')?.text, '引用の文章。');
  assert.equal(draft.blocks.find(block => block.kind === 'code')?.text, 'const a = 1;\n  a++;');
  assert.ok(draft.blocks.some(block => block.text === '画像の説明。'));
  assert.ok(!draft.blocks.some(block => /secret|127\.0\.0|evil\.test/.test(block.text)));
  assert.equal(draft.provenance?.sourceUrl, url);
  assert.deepEqual(draft.provenance?.chapters.map(value => value.title), ['見出し']);
  for (const block of draft.blocks) for (const run of block.runs) for (const origin of run.sources) {
    if (run.mapping === 'exact' && origin.kind === 'text') assert.equal(block.text.slice(run.start, run.end), raw.slice(origin.start, origin.end));
  }
});

test('article parser handles tables and hidden text, and fails without readable text or with unsupported ruby', () => {
  const metadata = { title: '表', author: '著者', sourceUrl: url, sourceSha256: digest('table') };
  const draft = importArticle('<p>本文。</p><table><tr><td>項目</td><td>値</td></tr></table><p hidden>隠れた本文</p><p style="display:none">hidden</p>', metadata);
  assert.ok(draft.blocks.some(block => block.kind === 'table' && block.text.includes('項目\t値')));
  assert.ok(!draft.blocks.some(block => /hidden|隠れ/.test(block.text)));
  assert.throws(() => importArticle('<img src="https://example.test/image">', metadata), /読むテキスト/);
  assert.throws(() => importArticle('<p><ruby>本<rt>ほん</rt>追加</ruby></p>', metadata), /ルビ構造/);
});

test('note importer uses the bounded anonymous JSON endpoint, coalesces calls, saves a text book and versions metadata changes', async () => {
  let calls = 0, saved: LocalTextBook | undefined, title = '記事タイトル';
  const importer = new NoteImporter('unused-memory-store', { minIntervalMs: 0, fetch: async (input, init) => {
    calls++;
    assert.equal(input, 'https://note.com/api/v3/notes/n0123456789ab');
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify(article({ name: title })), { headers: { 'content-type': 'application/json' } });
  }, save: async book => { requireLocalTextBook(book); saved = book; return book; } });
  const [result, coalesced] = await Promise.all([importer.import(url), importer.import(url)]);
  assert.equal(calls, 1); assert.deepEqual(result, coalesced);
  assert.equal(saved?.source.kind, 'note'); assert.equal(saved?.chunks.length, 0);
  assert.equal(saved?.document.format, 'html');
  assert.match(saved?.attribution ?? '', /著者/);
  const previous = result.books[0]; title = '変更されたタイトル';
  const updated = (await importer.import(url)).books[0];
  assert.equal(updated.id, previous.id); assert.notEqual(updated.revision, previous.revision);
  assert.throws(() => requireLocalTextBook({ ...saved, source: { ...saved?.source, workUrl: 'https://evil.test/' } }), /取得元/);
});

test('note importer never saves paid previews, incomplete or mismatched data, failures, redirects or oversized responses', async () => {
  let writes = 0;
  for (const value of [article({ price: 300 }), article({ remained_char_num: 50 }), article({ note_url: url.replace('example', 'other') }), article({ body: '<unsupported></unsupported>' })]) {
    const importer = new NoteImporter('unused-memory-store', { minIntervalMs: 0, fetch: async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), save: async book => { writes++; return book; } });
    await assert.rejects(importer.import(url));
  }
  for (const response of [new Response('no', { status: 403 }), new Response('', { status: 302 }), new Response('x'.repeat(100), { headers: { 'content-type': 'application/json' } }), new Response('bad', { headers: { 'content-type': 'text/html' } })]) {
    const importer = new NoteImporter('unused-memory-store', { maxBytes: 50, fetch: async () => response, save: async book => { writes++; return book; } });
    await assert.rejects(importer.import(url));
  }
  assert.equal(writes, 0);
});

test('HTML articles round-trip through browser reading storage with source, ruby and reading position intact', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  const raw = noteArticleHtml(parseFreeNote(article(), source), url);
  const document = await prepareDocument(importArticle(raw, { title: '記事タイトル', author: '著者', sourceUrl: url, sourceSha256: digest(raw) }));
  const anchor = { blockId: document.blocks[1].id, offset: 1 };
  await saveReading({ document, anchor, settings: DEFAULT_SETTINGS });
  const restored = await loadReading();
  assert.equal(restored?.document.format, 'html');
  assert.deepEqual(restored?.document.provenance, document.provenance);
  assert.deepEqual(restored?.document.blocks, document.blocks);
  assert.deepEqual(restored?.anchor, anchor);
  await deleteReading();
});
