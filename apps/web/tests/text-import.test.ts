import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_TEXT_LENGTH } from '../src/reader/model';
import { importText } from '../src/reader/text-import';
import { processDraft, processText } from '../src/reader/text-service';
import type { TextWorkerRequest, TextWorkerResponse } from '../src/reader/text-worker';

test('plain text keeps unnormalized source, repeated phrases and UTF-16 ranges', () => {
  const raw = '  がと👩‍💻を見た。\r\n同じ文。\r\n\r\n同じ文。';
  const draft = importText(raw, 'txt', ' 原文 ');
  assert.equal(draft.rawText, raw);
  assert.equal(draft.title, '原文');
  assert.equal(draft.blocks.length, 2);
  for (const block of draft.blocks) {
    const source = block.runs[0].sources[0];
    assert.equal(source.kind, 'text');
    assert.equal(raw.slice(source.start, source.end), block.text);
    assert.equal(block.runs[0].mapping, 'exact');
  }
  assert.equal(draft.blocks[1].runs[0].sources[0].start, raw.lastIndexOf('同じ文。'));
});

test('Markdown fixture selects body structure and never uses metadata/code for repeated body source', async () => {
  const raw = await readFile(new URL('../../../docs/validation/fixtures/import-sample.md', import.meta.url), 'utf8');
  const draft = importText(raw, 'md', 'fixture');
  assert.equal(draft.rawText, raw);
  assert.equal(draft.blocks[0].kind, 'heading');
  assert.equal(draft.blocks[0].text, '試読');
  assert.equal(draft.blocks.filter((block) => block.kind === 'listItem').length, 2);
  assert.equal(draft.blocks.filter((block) => block.kind === 'code').length, 1);
  assert.equal(draft.blocks.filter((block) => block.kind === 'table').length, 1);
  const body = draft.blocks.filter((block) => block.kind !== 'code' && block.kind !== 'table').map((block) => block.text).join('\n');
  assert.ok(!body.includes('本文ではない説明'));
  assert.ok(!body.includes('これは脚注です'));
  assert.ok(!body.includes('https://'));
  assert.ok(body.includes('彼女は資料を読みませんでした。'));
  assert.ok(body.includes('TypeScriptで結果を比べる。'));
  assert.ok(body.includes('記号は & と * を残す。'));
  const ruby = draft.blocks.find((block) => block.ruby.length);
  assert.equal(ruby?.text, '東京へ行った。');
  assert.deepEqual(ruby?.ruby, [{ start: 0, end: 2, reading: 'とうきょう' }]);
  const last = draft.blocks.at(-1)!;
  const source = last.runs[0].sources[0];
  assert.equal(source.start, raw.lastIndexOf('私は朝の電車で本を読んでいます。'));
  assert.ok(draft.warnings.length >= 3);
});

test('entity, escaping, emphasis and links keep precise monotone runs', () => {
  const raw = '**反復**と[反復](https://example.com)と&amp;、\\*、&#x1F600;。';
  const block = importText(raw, 'md', 'mapping').blocks[0];
  assert.equal(block.text, '反復と反復と&、*、😀。');
  let previousSource = -1;
  for (const run of block.runs) {
    const source = run.sources[0];
    assert.ok(source.start >= previousSource);
    previousSource = source.end;
    assert.ok(run.end > run.start);
    if (run.mapping === 'exact') assert.equal(raw.slice(source.start, source.end), block.text.slice(run.start, run.end));
  }
  assert.equal(block.runs.map((run) => block.text.slice(run.start, run.end)).join(''), block.text);
  for (const syntax of ['&amp;', '\\*', '&#x1F600;']) {
    const run = block.runs.find((candidate) => raw.slice(candidate.sources[0].start, candidate.sources[0].end) === syntax);
    assert.equal(run?.mapping, 'transformed');
  }
});

test('ruby is inert, omits rp and supports explicit base/reading pairs', () => {
  const raw = '<ruby><rb>東</rb><rp>（</rp><rt>とう</rt><rp>）</rp><rb>京</rb><rt>きょう</rt></ruby>へ。\n\n<script>alert("秘密")</script>\n\n安全。';
  const draft = importText(raw, 'md', 'ruby');
  assert.equal(draft.blocks[0].text, '東京へ。');
  assert.deepEqual(draft.blocks[0].ruby, [{ start: 0, end: 1, reading: 'とう' }, { start: 1, end: 2, reading: 'きょう' }]);
  assert.ok(!draft.blocks.some((block) => block.text.includes('秘密')));
  assert.equal(draft.blocks.at(-1)?.text, '安全。');
});

test('complex multiline ruby never imports quote/list continuation markers into base text', () => {
  for (const raw of [
    '> <ruby>東京\n> 駅<rt>とうきょうえき</rt></ruby>へ。',
    '- <ruby>東京\n  駅<rt>とうきょうえき</rt></ruby>へ。',
    '> <ruby>東京\r\n> 駅<rt>とうきょうえき</rt></ruby>へ。',
  ]) {
    const draft = importText(raw, 'md', 'unsupported ruby');
    assert.equal(draft.rawText, raw);
    assert.equal(draft.blocks[0].text, 'へ。');
    assert.deepEqual(draft.blocks[0].ruby, []);
    assert.ok(draft.warnings.some((warning) => warning.includes('継続記号') && warning.includes('元の入力')));
    const source = draft.blocks[0].runs[0].sources[0];
    assert.equal(raw.slice(source.start, source.end), 'へ。');
  }
  const regular = importText('<ruby>東京\n駅<rt>とうきょうえき</rt></ruby>へ。', 'md', 'supported ruby');
  assert.equal(regular.blocks[0].text, '東京\n駅へ。');
  assert.deepEqual(regular.blocks[0].ruby, [{ start: 0, end: 4, reading: 'とうきょうえき' }]);
  assert.deepEqual(regular.warnings, []);
  assert.throws(() => importText('> <ruby>東京\n> 駅<rt>とうきょうえき</rt></ruby>', 'md', 'only unsupported'), /継続記号.*元の入力/);
});

test('blockquote and nested list preserve independent readable paragraphs', () => {
  const draft = importText('> 引用。\n>\n> 次の段落。\n\n- 項目。\n  - 内側。\n\n---\n\n末尾。', 'md', 'structure');
  assert.deepEqual(draft.blocks.map((block) => block.kind), ['quote', 'quote', 'listItem', 'listItem', 'paragraph']);
  assert.deepEqual(draft.blocks.map((block) => block.text), ['引用。', '次の段落。', '項目。', '内側。', '末尾。']);
});

test('empty and excluded-only documents and oversized input explain failure', () => {
  assert.throws(() => importText(' \n\t', 'txt', ''), /空/);
  assert.throws(() => importText('---\ntitle: metadata\n---\n\n![alt](image.png)', 'md', ''), /再生できる本文/);
  assert.throws(() => importText('あ'.repeat(MAX_TEXT_LENGTH + 1), 'txt', ''), /100万/);
});

test('processing cancellation terminates its Worker and discards any late response', async () => {
  const originalWorker = globalThis.Worker;
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent<TextWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    request?: TextWorkerRequest;
    constructor() { workers.push(this); }
    postMessage(request: TextWorkerRequest) { this.request = request; }
    terminate() { this.terminated = true; }
    emit(message: TextWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<TextWorkerResponse>); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await assert.rejects(processText('本文。', 'txt', 'cancel', { signal: alreadyCancelled.signal }), { name: 'AbortError' });
    assert.equal(workers.length, 0);
    const controller = new AbortController();
    const progress: number[] = [];
    const pending = processText('本文。', 'txt', 'cancel', { signal: controller.signal, onProgress: (value) => progress.push(value) });
    assert.equal(workers[0].request?.type, 'text');
    workers[0].emit({ type: 'progress', progress: 0.2 });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(workers[0].terminated, true);
    workers[0].emit({ type: 'progress', progress: 0.9 });
    workers[0].emit({ type: 'error', message: '古い応答' });
    assert.deepEqual(progress, [0.2]);
    const next = processDraft(importText('新しい本文。', 'txt', 'next'));
    assert.equal(workers[1].request?.type, 'draft');
    workers[1].emit({ type: 'error', message: '明示的な処理エラー' });
    await assert.rejects(next, /明示的な処理エラー/);
    assert.equal(workers[1].terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
