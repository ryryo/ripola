import { PdfImportError, withPdfDocument } from './pdf-import';

export interface PdfRenderOptions { signal?: AbortSignal; scale?: number }

/** Render only the original PDF canvas; no scripts, links or form controls are added.
 * Multiply a SourceRange.rect by the returned scale used here to position overlays.
 */
export async function renderPdfPage(
  data: ArrayBuffer,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  { signal, scale = 1 }: PdfRenderOptions = {},
): Promise<{ width: number; height: number }> {
  return withPdfDocument(data, signal, async (document) => {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new PdfImportError('pages', '表示するPDFページが見つかりません。');
    }
    if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
      throw new PdfImportError('limit', 'PDFページの表示倍率は0より大きく4以下にしてください。');
    }
    const page = await document.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale });
      if (viewport.width * viewport.height > 16_000_000) {
        throw new PdfImportError('limit', 'PDFページが大きすぎるため、この倍率では表示できません。表示を小さくしてください。');
      }
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const render = page.render({ canvas, viewport, annotationMode: 0, background: '#ffffff' });
      const onAbort = () => render.cancel();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal?.aborted) render.cancel();
        await render.promise;
        return { width: viewport.width, height: viewport.height };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      page.cleanup();
    }
  });
}
