import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { importPdf, layoutPdfPage, PdfImportError, validatePdfInput } from '../src/reader/pdf-import';

const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
const style = { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'sans-serif' };
function item(str: string, x: number, y: number, width = 60, height = 12): TextItem {
  return { str, dir: 'ltr', transform: [height, 0, 0, height, x, y], width, height, fontName: 'f', hasEOL: false };
}
function content(items: TextItem[]): TextContent { return { items, styles: { f: style }, lang: 'ja' }; }
async function pdfjsForNode(): Promise<typeof import('pdfjs-dist')> {
  // The browser uses the modern build; PDF.js recommends legacy for Node.
  const specifier: string = 'pdfjs-dist/legacy/build/pdf.mjs';
  return import(specifier) as Promise<typeof import('pdfjs-dist')>;
}

test('日本語を座標で行順へ戻し、行/item境界へ不要な空白を加えない', () => {
  const input = content([item('読みます。', 112, 700, 60), item('朝に本を', 40, 716, 60), item('私は', 40, 700, 24), item('資料を', 64, 700, 48)]);
  const { blocks } = layoutPdfPage(input, viewport, 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, '朝に本を私は資料を読みます。');
  assert.deepEqual(blocks[0].runs.map((run) => run.sources[0].kind === 'pdf' ? run.sources[0].item : -1), [1, 2, 3, 0]);
  let cursor = 0;
  for (const run of blocks[0].runs) {
    assert.equal(run.start, cursor);
    const source = run.sources[0];
    assert.equal(source.kind, 'pdf');
    if (source.kind === 'pdf') assert.equal(blocks[0].text.slice(run.start, run.end), (input.items[source.item] as TextItem).str.slice(source.start, source.end));
    assert.equal(run.mapping, 'approximate');
    cursor = run.end;
  }
  assert.equal(cursor, blocks[0].text.length);
});

test('英語itemと折返しだけに補完空白を入れ、変換runを明示する', () => {
  const { blocks } = layoutPdfPage(content([item('Hello', 40, 720, 30), item('world', 74, 720, 30), item('again.', 40, 704, 35)]), viewport, 1);
  assert.equal(blocks[0].text, 'Hello world again.');
  assert.equal(blocks[0].runs.filter((run) => run.mapping === 'transformed').length, 2);
});

test('英語の文末句点と次行の語を接着しない', () => {
  const { blocks } = layoutPdfPage(content([item('First sentence.', 40, 720, 100), item('Next sentence.', 40, 704, 100)]), viewport, 1);
  assert.equal(blocks[0].text, 'First sentence. Next sentence.');
});

test('UTF-16元rangeは結合文字・ZWJ・variation selectorを置換しない', () => {
  const text = '👩‍💻が書いたが。葛󠄀もそのまま。';
  const { blocks } = layoutPdfPage(content([item(text, 40, 720, 240)]), viewport, 4);
  assert.equal(blocks[0].text, text);
  const source = blocks[0].runs[0].sources[0];
  assert.equal(source.kind, 'pdf');
  if (source.kind === 'pdf') { assert.equal(source.end, text.length); assert.equal(source.page, 4); }
});

test('段落間隔をブロックに残し、繰り返し文のitem参照を区別する', () => {
  const { blocks } = layoutPdfPage(content([item('同じ文。', 40, 700), item('同じ文。', 40, 750)]), viewport, 2);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.text), ['同じ文。', '同じ文。']);
  assert.notEqual(blocks[0].id, blocks[1].id);
  const indices = blocks.map((block) => block.runs[0].sources[0]).map((source) => source.kind === 'pdf' ? source.item : -1);
  assert.deepEqual(indices, [1, 0]);
});

test('元rectはviewport scale1の左上座標と幅/高さ', () => {
  const { blocks } = layoutPdfPage(content([item('text', 40, 700, 60, 12)]), viewport, 1);
  const source = blocks[0].runs[0].sources[0];
  assert.equal(source.kind, 'pdf');
  if (source.kind === 'pdf') {
    const [left, top, width, height] = source.rect;
    assert.equal(left, 40);
    assert.ok(Math.abs(top - 90.4) < 0.001);
    assert.equal(width, 60);
    assert.ok(Math.abs(height - 12) < 0.001);
  }
});

test('回転済みviewportで横書きとなる文字も同じ座標へ変換する', () => {
  const input = item('rotated', 100, 40, 60, 12);
  input.transform = [0, 12, -12, 0, 100, 40];
  const { blocks } = layoutPdfPage(content([input]), { width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0] }, 1);
  assert.equal(blocks[0].text, 'rotated');
  const source = blocks[0].runs[0].sources[0];
  assert.equal(source.kind === 'pdf' ? source.rect[0] : -1, 40);
});

test('縦書き・表示上の回転文字は対応範囲として拒否する', () => {
  const vertical = content([item('縦書き', 50, 700)]);
  vertical.styles.f = { ...style, vertical: true };
  assert.throws(() => layoutPdfPage(vertical, viewport, 3), (error: unknown) => error instanceof PdfImportError && error.code === 'layout' && error.message.includes('3ページ'));
  const rotated = item('rotated', 50, 700);
  rotated.transform = [0, 12, -12, 0, 50, 700];
  assert.throws(() => layoutPdfPage(content([rotated]), viewport, 1), PdfImportError);
});

test('複数行で明確に分離した2段組を黙って横につなげない', () => {
  const items = [720, 704, 688, 672].flatMap((y) => [item('Left column line.', 40, y, 120), item('Right column line.', 320, y, 130)]);
  assert.throws(() => layoutPdfPage(content(items), viewport, 2), (error: unknown) => error instanceof PdfImportError && error.code === 'layout');
});

test('小さい文字を捨てずに残し、ルビ・脚注混入の確認を促す', () => {
  const { blocks, warnings } = layoutPdfPage(content([item('Body.', 40, 720, 90), item('Body continues.', 40, 704, 140), item('small note', 40, 684, 70, 6)]), viewport, 1);
  assert.ok(blocks.map((block) => block.text).join('').includes('small note'));
  assert.ok(warnings.some((warning) => warning.includes('小さな文字')));
});

test('空/画像ページと文字化けにはページ番号とテキスト入力の案内を出す', () => {
  for (const items of [[], [item('  ', 40, 720)], [item('取得\uFFFD不能', 40, 720)]]) {
    assert.throws(() => layoutPdfPage(content(items), viewport, 7), (error: unknown) => error instanceof PdfImportError && error.code === 'text' && error.message.includes('7ページ') && error.message.includes('TXT'));
  }
});

test('marked-contentイベントはitem indexを詰めず本文だけ抽出する', () => {
  const input = content([item('Text.', 40, 720)]);
  input.items.unshift({ type: 'beginMarkedContent', id: 'm1' });
  input.items.push({ type: 'endMarkedContent', id: 'm1' });
  const { blocks } = layoutPdfPage(input, viewport, 1);
  const source = blocks[0].runs[0].sources[0];
  assert.equal(source.kind === 'pdf' ? source.item : -1, 1);
  assert.equal(blocks[0].text, 'Text.');
});

test('空・非PDF・容量超過をランタイム/worker起動前に弾く', () => {
  assert.throws(() => validatePdfInput(new ArrayBuffer(0)), (error: unknown) => error instanceof PdfImportError && error.code === 'empty');
  assert.throws(() => validatePdfInput(new TextEncoder().encode('not a PDF').buffer), (error: unknown) => error instanceof PdfImportError && error.code === 'invalid');
  assert.throws(() => validatePdfInput(new ArrayBuffer(20 * 1024 * 1024 + 1)), (error: unknown) => error instanceof PdfImportError && error.code === 'size');
  validatePdfInput(new TextEncoder().encode('%PDF-1.7\nfixture').buffer);
});

test('取り消し済みの取り込みはworker/dataコピー前にAbortErrorとなる', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(importPdf(new TextEncoder().encode('%PDF-1.7\nfixture').buffer, 'cancelled', { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
});

test('自作の実PDFをPDF.jsで抽出し、ページ/item参照から本文を復元する', async () => {
  const pdfjs = await pdfjsForNode();
  const data = await readFile(new URL('./fixtures/text-layer.pdf', import.meta.url));
  const standardFontDataUrl = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));
  const loading = pdfjs.getDocument({ data: new Uint8Array(data), standardFontDataUrl, stopAtErrors: true, verbosity: 0 });
  try {
    const document = await loading.promise;
    assert.equal(document.numPages, 2);
    const output: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const original = await page.getTextContent({ disableNormalization: true });
      const { blocks } = layoutPdfPage(original, page.getViewport({ scale: 1 }), number);
      for (const block of blocks) {
        output.push(block.text);
        for (const run of block.runs.filter((run) => run.mapping !== 'transformed')) {
          const source = run.sources[0];
          assert.equal(source.kind, 'pdf');
          if (source.kind === 'pdf') {
            assert.equal(source.page, number);
            assert.equal(block.text.slice(run.start, run.end), (original.items[source.item] as TextItem).str.slice(source.start, source.end));
          }
        }
      }
      page.cleanup();
    }
    assert.deepEqual(output, [
      'Morning reading begins here. The same sentence is here. The same sentence is here.',
      'This is the second page. A final sentence ends the document.',
    ]);
  } finally {
    await loading.destroy();
  }
});

test('実PDFの画像/空ページ/部分取得/段組/回転fixtureは説明付きで拒否する', async () => {
  const pdfjs = await pdfjsForNode();
  const standardFontDataUrl = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));
  for (const [file, number, code] of [
    ['image-only.pdf', 1, 'text'], ['blank.pdf', 1, 'text'], ['partial-blank.pdf', 2, 'text'],
    ['two-column.pdf', 1, 'layout'], ['rotated-text.pdf', 1, 'layout'],
  ] as const) {
    const data = await readFile(new URL(`./fixtures/${file}`, import.meta.url));
    const loading = pdfjs.getDocument({ data: new Uint8Array(data), standardFontDataUrl, stopAtErrors: true, verbosity: 0 });
    try {
      const document = await loading.promise;
      const page = await document.getPage(number);
      const original = await page.getTextContent({ disableNormalization: true });
      assert.throws(() => layoutPdfPage(original, page.getViewport({ scale: 1 }), number),
        (error: unknown) => error instanceof PdfImportError && error.code === code && error.message.includes(`${number}ページ目`) && error.message.includes('TXT'), file);
      page.cleanup();
    } finally { await loading.destroy(); }
  }
});

test('日本語の実PDFはToUnicodeとローカルCMapから欠落なく抽出する', async () => {
  const pdfjs = await pdfjsForNode();
  const data = await readFile(new URL('./fixtures/japanese-text-layer.pdf', import.meta.url));
  const loading = pdfjs.getDocument({ data: new Uint8Array(data), cMapUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url)), cMapPacked: true, stopAtErrors: true, verbosity: 0 });
  try {
    const document = await loading.promise;
    const page = await document.getPage(1);
    const original = await page.getTextContent({ disableNormalization: true });
    const { blocks } = layoutPdfPage(original, page.getViewport({ scale: 1 }), 1);
    assert.equal(blocks.map(block => block.text).join(''), '私は朝の図書館で本を読む。一度止まり、原文を確かめる。');
    assert.ok(blocks.every(block => block.runs.every(run => run.sources.every(source => source.kind === 'pdf' && source.page === 1))));
  } finally { await loading.destroy(); }
});
