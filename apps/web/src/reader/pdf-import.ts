import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextContent, TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import { MAX_INPUT_BYTES, MAX_TEXT_LENGTH, type DraftDocument, type SourceRange, type TextBlock } from './model';

export const MAX_PDF_PAGES = 300;
const TEXT_ALTERNATIVE = 'Markdown・TXTファイル、または本文の貼り付けをお使いください。';
export type PdfErrorCode = 'empty' | 'size' | 'invalid' | 'password' | 'pages' | 'text' | 'layout' | 'limit' | 'read';

export class PdfImportError extends Error {
  constructor(public readonly code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfImportError';
  }
}

export interface PdfImportOptions {
  signal?: AbortSignal;
  onProgress?: (completedPages: number, totalPages: number) => void;
}

/** Coordinates are the displayed page's viewport at scale=1, including its rotation.
 * SourceRange.rect is [left, top, width, height], not PDF bottom-left coordinates.
 * A text item's whole rectangle is an approximation for a substring highlight.
 */
export interface PdfViewport {
  width: number;
  height: number;
  transform: number[];
}
interface PositionedItem {
  item: number;
  text: string;
  baseline: number;
  height: number;
  rect: [number, number, number, number];
}
interface PdfLine { items: PositionedItem[]; baseline: number; height: number }

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('PDFの読み込みを取り消しました。', 'AbortError');
}

export function validatePdfInput(data: ArrayBuffer): void {
  if (data.byteLength === 0) throw new PdfImportError('empty', 'PDFファイルが空です。別のファイルを選んでください。');
  if (data.byteLength > MAX_INPUT_BYTES) {
    throw new PdfImportError('size', 'PDFは20 MiBまで読み込めます。小さなPDFに分けるか、' + TEXT_ALTERNATIVE);
  }
  const header = new TextDecoder('ascii').decode(new Uint8Array(data, 0, Math.min(data.byteLength, 1024)));
  if (!header.includes('%PDF-')) throw new PdfImportError('invalid', 'PDFとして読み込めません。ファイル形式を確認するか、' + TEXT_ALTERNATIVE);
}

function safePdfError(error: unknown): Error {
  if (error instanceof PdfImportError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return error as Error;
  if (name === 'PasswordException') {
    return new PdfImportError('password', 'パスワードで保護されたPDFには対応していません。保護を解除したファイル、または' + TEXT_ALTERNATIVE);
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
    return new PdfImportError('invalid', 'PDFが破損しているか、読み込めない形式です。別のファイル、または' + TEXT_ALTERNATIVE);
  }
  return new PdfImportError('read', 'PDFを読み込めませんでした。再試行するか、' + TEXT_ALTERNATIVE);
}

/** Browser-only entry. The runtime import prevents PDF.js DOM APIs from running in SSR.
 * Destroying the loading task also destroys its document and worker transport.
 */
export async function withPdfDocument<T>(
  data: ArrayBuffer,
  signal: AbortSignal | undefined,
  read: (document: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  abortIfNeeded(signal);
  validatePdfInput(data);
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.mjs?url'),
  ]).catch((error: unknown) => {
    abortIfNeeded(signal);
    throw safePdfError(error);
  });
  abortIfNeeded(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const assets = `${import.meta.env.BASE_URL}pdfjs/`;
  const task = pdfjs.getDocument({
    // PDF.js transfers the buffer to its worker. Preserve the caller's original.
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    useWorkerFetch: true,
    stopAtErrors: true,
    enableXfa: false,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 64_000_000,
    verbosity: 0,
  });
  let destroyPromise: Promise<void> | undefined;
  const destroy = () => (destroyPromise ??= task.destroy().catch(() => undefined));
  const onAbort = () => { void destroy(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    abortIfNeeded(signal);
    const document = await task.promise;
    abortIfNeeded(signal);
    const result = await read(document);
    abortIfNeeded(signal);
    return result;
  } catch (error) {
    abortIfNeeded(signal);
    throw safePdfError(error);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await destroy();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

function positionItem(item: TextItem, index: number, style: TextStyle | undefined, viewport: PdfViewport, page: number): PositionedItem {
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const [a, b, c, d, e, f] = item.transform.map(Number);
  const ax = va * a + vc * b;
  const ay = vb * a + vd * b;
  const length = Math.hypot(ax, ay);
  if (![a, b, c, d, e, f, item.width, item.height, ...viewport.transform].every(Number.isFinite) || length < 0.001) {
    throw new PdfImportError('layout', `${page}ページ目の文字位置を復元できません。${TEXT_ALTERNATIVE}`);
  }
  if (style?.vertical || item.dir === 'ttb' || item.dir === 'rtl' || ax <= 0 || Math.abs(ay) > length * 0.12) {
    throw new PdfImportError('layout', `${page}ページ目に縦書き・回転文字など、横書き1段として読めない配置があります。${TEXT_ALTERNATIVE}`);
  }
  const baselineX = va * e + vc * f + ve;
  const baselineY = vb * e + vd * f + vf;
  const hx = va * c + vc * d;
  const hy = vb * c + vd * d;
  const height = Math.max(Math.hypot(hx, hy), Math.abs(item.height) * Math.hypot(va, vb), 0.1);
  const normalLength = Math.hypot(hx, hy);
  const nx = normalLength ? hx / normalLength : 0;
  const ny = normalLength ? hy / normalLength : -1;
  const width = Math.max(0, item.width) * Math.hypot(va, vb);
  const ascent = style && Number.isFinite(style.ascent) ? Math.min(2, Math.max(0, style.ascent)) : 0.8;
  const descent = style && Number.isFinite(style.descent) ? Math.min(0, Math.max(-1, style.descent)) : -0.2;
  const points = [ascent, descent].flatMap((vertical) => [0, width].map((horizontal) => [
    baselineX + (ax / length) * horizontal + nx * height * vertical,
    baselineY + (ay / length) * horizontal + ny * height * vertical,
  ]));
  const left = Math.min(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const right = Math.max(...points.map(([x]) => x));
  const bottom = Math.max(...points.map(([, y]) => y));
  return { item: index, text: item.str, baseline: baselineY, height, rect: [left, top, right - left, bottom - top] };
}

function hasClearColumns(lines: PdfLine[], pageWidth: number): boolean {
  const candidates: Array<{ left: number; right: number }> = [];
  for (const line of lines) {
    const textItems = line.items.filter((item) => item.text.trim());
    for (let i = 1; i < textItems.length; i++) {
      const previous = textItems[i - 1];
      const current = textItems[i];
      const left = previous.rect[0] + previous.rect[2];
      const right = current.rect[0];
      if (right - left > Math.max(3 * line.height, 0.07 * pageWidth)
        && left - textItems[0].rect[0] > 0.08 * pageWidth
        && textItems.at(-1)!.rect[0] + textItems.at(-1)!.rect[2] - right > 0.08 * pageWidth) {
        candidates.push({ left, right });
        break;
      }
    }
  }
  return candidates.some((gap) => candidates.filter((other) =>
    Math.abs(gap.right - other.right) < pageWidth * 0.05
    && Math.min(gap.right, other.right) - Math.max(gap.left, other.left) > pageWidth * 0.04,
  ).length >= Math.max(3, Math.ceil(lines.length * 0.35)));
}

function sourceFor(item: PositionedItem, page: number): SourceRange {
  return { kind: 'pdf', page, item: item.item, start: 0, end: item.text.length, rect: item.rect };
}

const latinEnd = /[\p{Script=Latin}\p{N}][,.;:!?'"”’)\]]*$/u;
const latinStart = /^[\p{Script=Latin}\p{N}]/u;
function hasBrokenText(text: string): boolean {
  for (const character of text) {
    const value = character.codePointAt(0)!;
    if (value === 0xfffd || value < 32 && value !== 9 && value !== 10 && value !== 13) return true;
  }
  return false;
}

/** Pure layout step, separately testable without importing the browser PDF runtime.
 * It does not claim to detect every multi-column, table, ruby or invisible-text PDF.
 */
export function layoutPdfPage(content: TextContent, viewport: PdfViewport, page: number): { blocks: TextBlock[]; warnings: string[] } {
  const positioned = content.items.flatMap((item, index) => 'str' in item && item.str.length
    ? [positionItem(item, index, content.styles[item.fontName], viewport, page)] : []);
  if (!positioned.some((item) => item.text.trim())) {
    throw new PdfImportError('text', `${page}ページ目から本文の文字を取得できませんでした。画像だけのPDFや空ページは読み込めません。OCRには対応していません。${TEXT_ALTERNATIVE}`);
  }
  if (positioned.some((item) => hasBrokenText(item.text))) {
    throw new PdfImportError('text', `${page}ページ目の文字を正しく取得できませんでした。文字化けを含むPDFは読み込めません。${TEXT_ALTERNATIVE}`);
  }
  positioned.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0] || a.item - b.item);
  const lines: PdfLine[] = [];
  for (const item of positioned) {
    const line = lines.at(-1);
    if (line && Math.abs(item.baseline - line.baseline) <= Math.min(item.height, line.height) * 0.35) {
      line.items.push(item);
      line.height = Math.max(line.height, item.height);
    } else {
      lines.push({ items: [item], baseline: item.baseline, height: item.height });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.rect[0] - b.rect[0] || a.item - b.item);
  if (hasClearColumns(lines, viewport.width)) {
    throw new PdfImportError('layout', `${page}ページ目は段組や表のように離れた文字列が並んでいます。初期版は横書き1段のPDFに対応しています。${TEXT_ALTERNATIVE}`);
  }
  const normalHeight = median(lines.map((line) => line.height));
  const warnings: string[] = [];
  if (positioned.some((item) => item.text.trim() && item.height < normalHeight * 0.65)) {
    warnings.push(`${page}ページ目に小さな文字があります。ルビや脚注が本文に混ざる場合があるため、原ページと抽出本文を確認してください。`);
  }
  const blocks: TextBlock[] = [];
  let block: TextBlock | undefined;
  let previousLine: PdfLine | undefined;
  let lastItem: PositionedItem | undefined;
  const append = (text: string, source: SourceRange[], mapping: 'transformed' | 'approximate') => {
    if (!block) return;
    const start = block.text.length;
    block.text += text;
    block.runs.push({ start, end: block.text.length, sources: source, mapping });
  };
  for (const line of lines) {
    const previousEnd = previousLine?.items.at(-1)?.text ?? '';
    const indent = previousLine ? Math.abs(line.items[0].rect[0] - previousLine.items[0].rect[0]) : 0;
    const paragraphBreak = !previousLine || line.baseline - previousLine.baseline > normalHeight * 1.85
      || (indent > normalHeight * 1.5 && /[。！？.!?][」』）)\]]?$/u.test(previousEnd));
    if (paragraphBreak) {
      block = { id: `pdf-${page}-${blocks.length}`, kind: 'paragraph', text: '', runs: [], ruby: [] };
      blocks.push(block);
      lastItem = undefined;
    }
    for (const item of line.items) {
      if (lastItem && latinEnd.test(lastItem.text) && latinStart.test(item.text)) {
        const gap = item.rect[0] - lastItem.rect[0] - lastItem.rect[2];
        if (previousLine !== line || gap > line.height * 0.18) {
          append(' ', [sourceFor(lastItem, page), sourceFor(item, page)], 'transformed');
        }
      }
      append(item.text, [sourceFor(item, page)], 'approximate');
      lastItem = item;
      // Once inside this line, only the actual horizontal gap calls for a space.
      previousLine = line;
    }
  }
  return { blocks, warnings };
}

export async function importPdf(data: ArrayBuffer, title: string, options: PdfImportOptions = {}): Promise<DraftDocument> {
  return withPdfDocument(data, options.signal, async (document) => {
    if (document.numPages > MAX_PDF_PAGES) {
      throw new PdfImportError('pages', `PDFは${MAX_PDF_PAGES}ページまで読み込めます。文書を分けるか、${TEXT_ALTERNATIVE}`);
    }
    const blocks: TextBlock[] = [];
    const pages: NonNullable<DraftDocument['pages']> = [];
    const warnings = ['PDFの読順は完全には保証できません。抽出本文と原ページを確認してください。縦書き・段組・PDFルビの自動復元には対応していません。'];
    let textLength = 0;
    options.onProgress?.(0, document.numPages);
    for (let number = 1; number <= document.numPages; number++) {
      abortIfNeeded(options.signal);
      try {
        const page = await document.getPage(number);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent({ disableNormalization: true });
          abortIfNeeded(options.signal);
          const result = layoutPdfPage(content, viewport, number);
          textLength += result.blocks.reduce((sum, block) => sum + block.text.length, 0);
          if (textLength > MAX_TEXT_LENGTH) {
            throw new PdfImportError('limit', `PDFの抽出本文が${MAX_TEXT_LENGTH.toLocaleString('ja-JP')}文字の上限を超えています。文書を分けるか、${TEXT_ALTERNATIVE}`);
          }
          blocks.push(...result.blocks);
          warnings.push(...result.warnings);
          pages.push({ number, width: viewport.width, height: viewport.height });
        } finally {
          page.cleanup();
        }
      } catch (error) {
        abortIfNeeded(options.signal);
        if (error instanceof PdfImportError) {
          const acquired = number > 1 ? ` 1〜${number - 1}ページ目の文字は取得できましたが、一部だけの本文は読み込みません。` : '';
          throw new PdfImportError(error.code, error.message + acquired);
        }
        throw new PdfImportError('read', `${number}ページ目を取得できませんでした。途中までの本文を完全な文書として読み込むことはできません。別のファイル、または${TEXT_ALTERNATIVE}`);
      }
      options.onProgress?.(number, document.numPages);
      // Let a queued cancel action run even when each page is in worker cache.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return { title, format: 'pdf', rawText: blocks.map((block) => block.text).join('\n\n'), blocks, pages, warnings };
  });
}
