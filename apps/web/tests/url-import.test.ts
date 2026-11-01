import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aozoraUrlInput, supportedUrlInput } from '../src/url-import/urls';
import { aozoraHtmlLink, AozoraImporter, splitAozoraDraft } from '../src/url-import/aozora.server';
import { importAozora } from '../src/reader/aozora-import';
import { prepareDocument } from '../src/reader/segmentation';
import { MAX_TEXT_BOOK_BYTES } from '../src/kakuyomu/text-books';
import type { DraftDocument } from '../src/reader/model';
import { SequentialHtmlFetcher } from '../src/url-import/fetch-html.server';
import { LocalTextBookStore } from '../src/kakuyomu/text-books';

const cardUrl = 'https://www.aozora.gr.jp/cards/000148/card789.html';
const htmlUrl = 'https://www.aozora.gr.jp/cards/000148/files/789_14547.html';
const card = '<html><h1>図書カード：No.789</h1><a href="files/789_14547.html">いますぐ読む</a><a href="files/789_14547.html">HTML</a></html>';
const html = '<html><meta charset="utf-8"><h1 class="title">試験の作品</h1><h2 class="author">著者</h2><div class="main_text"><h3>一章</h3>朝に<ruby>本<rt>ほん</rt></ruby>を読む。<br>次の段落。</div><div class="bibliographical_information">底本：試験本\n入力：入力者\n校正：校正者</div></html>';
const response = (value: string) => new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } });

test('URL dispatch accepts only explicit supported work URLs and normalizes official Aozora links', () => {
  assert.equal(supportedUrlInput('https://kakuyomu.jp/works/16816927863114551346')?.kind, 'kakuyomu');
  assert.equal(aozoraUrlInput('http://aozora.gr.jp/cards/000148/card789.html#main')?.url, cardUrl);
  assert.equal(aozoraUrlInput(htmlUrl)?.cardUrl, cardUrl);
  for (const url of ['https://ncode.syosetu.com/n9265ig/', 'https://www.alphapolis.co.jp/novel/1/2', 'https://note.com/user/n/n123',
    'https://127.0.0.1/cards/000148/card789.html', 'https://www.aozora.gr.jp.evil.test/cards/000148/card789.html',
    'https://user@www.aozora.gr.jp/cards/000148/card789.html', `${cardUrl}?url=http://localhost/`,
    'https://www.aozora.gr.jp:8080/cards/000148/card789.html', 'https://www.aozora.gr.jp/index.html']) assert.equal(supportedUrlInput(url), undefined, url);
});

test('Aozora card resolves only this work’s linked HTML, rejects unrelated and ambiguous downloads', () => {
  const source = aozoraUrlInput(cardUrl)!;
  assert.equal(aozoraHtmlLink(card, source), htmlUrl);
  assert.equal(aozoraHtmlLink(card, aozoraUrlInput(htmlUrl)!), htmlUrl);
  assert.throws(() => aozoraHtmlLink(card.replace('No.789', 'No.7890'), source), /作品番号/);
  assert.throws(() => aozoraHtmlLink(card.replaceAll('files/789_14547.html', 'https://evil.test/body.html'), source), /特定/);
  assert.throws(() => aozoraHtmlLink(card.replaceAll('files/789_14547.html', '../000081/files/45630_23908.html'), source), /特定/);
  const ambiguous = card + '<a href="files/789_20000.html">another</a>';
  assert.throws(() => aozoraHtmlLink(ambiguous, source), /特定/);
  assert.equal(aozoraHtmlLink(ambiguous, aozoraUrlInput(htmlUrl)!), htmlUrl);
  assert.throws(() => aozoraHtmlLink(card, aozoraUrlInput(htmlUrl.replace('14547', '99999'))!), /含まれていません/);
});

test('HTML transport blocks unsupported URLs, redirects, non-HTML, streaming overflow and concurrent requests', async () => {
  let calls = 0, active = 0, peak = 0;
  const transport = new SequentialHtmlFetcher(url => aozoraUrlInput(url)?.url === url, { minIntervalMs: 0, fetch: async (_url, init) => {
    calls++; active++; peak = Math.max(peak, active);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return response(html);
  } });
  await assert.rejects(transport.fetch('http://127.0.0.1:4173/'), /取得対象/);
  assert.equal(calls, 0);
  await Promise.all([transport.fetch(cardUrl), transport.fetch(htmlUrl)]);
  assert.equal(peak, 1);
  for (const res of [new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(new SequentialHtmlFetcher(() => true, { minIntervalMs: 0, fetch: async () => res }).fetch(cardUrl));
  }
  await assert.rejects(new SequentialHtmlFetcher(() => true, { maxBytes: 10, fetch: async () => response(html) }).fetch(cardUrl), /容量/);
  const wrong = response(html); Object.defineProperty(wrong, 'url', { value: 'https://evil.test/' });
  await assert.rejects(new SequentialHtmlFetcher(() => true, { fetch: async () => wrong }).fetch(cardUrl), /一致/);
});

test('Aozora import preserves ruby, headings, source and bibliography, reuses immutable books and appears on shelf', async t => {
  const root = await mkdtemp(join(process.env.WORKSPACE_SCRATCH ?? tmpdir(), 'ripola-aozora-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const importer = new AozoraImporter(root, { minIntervalMs: 0, fetch: async url => {
    calls++;
    assert.ok(url === cardUrl || url === htmlUrl);
    return response(url === cardUrl ? card : html);
  } });
  const [result, same] = await Promise.all([importer.import(cardUrl), importer.import(cardUrl)]);
  assert.equal(calls, 2); assert.deepEqual(same, result);
  const book = await new LocalTextBookStore(root).get(result.books[0].id, result.books[0].revision);
  assert.equal(book.source.kind, 'aozora');
  assert.equal(book.document.format, 'aozora');
  assert.equal(book.document.provenance?.sourceUrl, htmlUrl);
  assert.equal(book.document.provenance?.cardUrl, cardUrl);
  assert.equal(book.document.provenance?.counts.ruby, 1);
  assert.match(book.document.provenance?.bibliography ?? '', /校正者/);
  assert.deepEqual(book.document.provenance?.chapters.map(item => item.title), ['一章']);
  assert.equal(book.document.blocks.find(block => block.ruby.length)?.ruby[0].reading, 'ほん');
  const filename = (await readdir(join(root, 'text-books')))[0];
  const bytes = await readFile(join(root, 'text-books', filename));
  const retry = await importer.import(htmlUrl);
  assert.deepEqual(retry, result);
  assert.deepEqual(await readFile(join(root, 'text-books', filename)), bytes);
  const shelf = await new LocalTextBookStore(root).list();
  assert.equal(shelf.length, 1); assert.equal(shelf[0].workUrl, cardUrl);
  await assert.rejects(new LocalTextBookStore(root).save({ ...book, source: { ...book.source, workUrl: htmlUrl } }), /取得元/);
});

test('Aozora failure never leaves a partial book and a later attempt can succeed', async t => {
  const root = await mkdtemp(join(process.env.WORKSPACE_SCRATCH ?? tmpdir(), 'ripola-aozora-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fail = true;
  const importer = new AozoraImporter(root, { minIntervalMs: 0, fetch: async url => response(url === cardUrl ? card : fail ? '<html>本文を取得できません</html>' : html) });
  await assert.rejects(importer.import(cardUrl), /main_text/);
  assert.deepEqual(await new LocalTextBookStore(root).list(), []);
  fail = false;
  assert.equal((await importer.import(cardUrl)).books.length, 1);
});

test('Aozora chapters preserve all blocks, nested headings, ruby and annotation source ranges', async t => {
  const root = await mkdtemp(join(process.env.WORKSPACE_SCRATCH ?? tmpdir(), 'ripola-aozora-parts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = html.replace('<h3>一章</h3>', '序文。<br><h3>一章</h3><h4>小見出し</h4>')
    .replace('</div><div class="bibliographical_information">', '<h3>二章</h3>第二章の本文。<br><span class="notes">入力者注</span>終わり。</div><div class="bibliographical_information">');
  const draft = importAozora(raw), parts = splitAozoraDraft(draft);
  assert.deepEqual(parts.map(part => part.chapter), ['はじめに', '一章', '二章']);
  assert.deepEqual(parts.flatMap(part => part.draft.blocks), draft.blocks);
  assert.equal(parts.flatMap(part => part.draft.blocks).flatMap(block => block.ruby).length, 1);
  assert.equal(parts.flatMap(part => part.draft.provenance?.annotations ?? []).filter(note => note.blockId).length, 1);
  assert.ok(parts[1].draft.provenance?.chapters.some(chapter => chapter.title === '小見出し'));
  const importer = new AozoraImporter(root, { minIntervalMs: 0, fetch: async url => response(url === cardUrl ? card : raw) });
  const result = await importer.import(cardUrl);
  assert.equal(result.books.length, 3);
  assert.equal((await new LocalTextBookStore(root).list()).length, 3);
  assert.ok(result.books.every((book, index) => book.id.endsWith(`-0${index + 1}`)));
});

test('the existing full-length Aozora sample fits the book limit when split at its eleven chapters', async () => {
  const { draft }: { draft: DraftDocument } = JSON.parse(await readFile(new URL('../public/samples/wagahai.json', import.meta.url), 'utf8'));
  const parts = splitAozoraDraft(draft);
  assert.equal(parts.length, 11);
  assert.deepEqual(parts.flatMap(part => part.draft.blocks).map(block => block.id), draft.blocks.map(block => block.id));
  let total = 0;
  for (const part of parts) {
    const document = await prepareDocument(part.draft);
    assert.ok(Buffer.byteLength(JSON.stringify(document)) + 4096 < MAX_TEXT_BOOK_BYTES);
    total += document.totalCharacters;
  }
  assert.ok(total > 290_000);
});
