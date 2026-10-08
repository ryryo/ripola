import { Alert, Button } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { ReadingDocument, ReadingUnit } from '../model';
export function PdfSource({ data, document, unit }: { data: ArrayBuffer; document: ReadingDocument; unit?: ReadingUnit }) {
  const sourcePage = unit?.sources.find(source => source.kind === 'pdf')?.page ?? 1;
  const [page, setPage] = useState(sourcePage);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const info = document.pages?.find(value => value.number === page);
  useEffect(() => setPage(sourcePage), [sourcePage]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(1, entries[0].contentRect.width)));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const task = new AbortController();
    setError(''); setRendering(true);
    void import('../pdf-view').then(({ renderPdfPage }) => {
      if (!canvas.current || task.signal.aborted) return;
      return renderPdfPage(data, page, canvas.current, { signal: task.signal, scale: Math.min(2, window.devicePixelRatio || 1) * width / (info?.width ?? 600) });
    }).catch(error => {
      if (!task.signal.aborted) setError(error instanceof Error ? error.message : 'ページを表示できませんでした。');
    }).finally(() => { if (!task.signal.aborted) setRendering(false); });
    return () => task.abort();
  }, [data, page, width, info?.width]);
  return <section className="pdf-source" aria-label="PDFの元ページ"><div className="pdf-pagination"><Button variant="light" size="xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>前のページ</Button><span>{page} / {document.pages?.length ?? 1} ページ</span><Button variant="light" size="xs" disabled={page >= (document.pages?.length ?? 1)} onClick={() => setPage(page + 1)}>次のページ</Button></div>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {rendering && <p role="status" className="muted">元ページを表示しています…</p>}
    <div className="pdf-canvas" ref={container}><canvas ref={canvas} aria-label={`PDF ${page}ページ`} />{unit?.sources.filter(source => source.kind === 'pdf' && source.page === page).map((source, i) => source.kind === 'pdf' && info && <span key={i} className="pdf-highlight" style={{ left: `${source.rect[0] / info.width * 100}%`, top: `${source.rect[1] / info.height * 100}%`, width: `${source.rect[2] / info.width * 100}%`, height: `${source.rect[3] / info.height * 100}%` }} />)}</div><p className="input-note">黄色の範囲は文字要素の近似位置です。文字単位の正確な範囲ではありません。</p>
  </section>;
}
