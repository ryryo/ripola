import { Alert, Button, Loader, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { UrlImport as KakuyomuImport } from '../kakuyomu-ui/UrlImport';
import { importUrlBook } from '../url-import/functions';
import { getKakuyomuBook } from '../kakuyomu/api';
import type { ImportedUrlBook, UrlImportResult } from '../url-import/contracts';
import { supportedUrlInput } from '../url-import/urls';
import type { ReadingDocument } from '../reader/model';

export function UrlImport({ url, onRead }: { url: string; onRead: (document: ReadingDocument) => void }) {
  return supportedUrlInput(url)?.kind === 'kakuyomu' ? <KakuyomuImport url={url} onRead={onRead} /> : <SingleBookImport url={url} onRead={onRead} />;
}

function SingleBookImport({ url, onRead }: { url: string; onRead: (document: ReadingDocument) => void }) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<UrlImportResult>();
  const [opening, setOpening] = useState('');
  const generation = useRef(0);
  const read = useRef(onRead); read.current = onRead;
  useEffect(() => {
    const current = ++generation.current;
    void importUrlBook({ data: { url } }).then(async result => {
      if (current !== generation.current) return;
      setResult(result);
      if (result.books.length === 1) {
        const book = await getKakuyomuBook({ data: { bookId: result.books[0].id, revision: result.books[0].revision } });
        if (current === generation.current) read.current(book.document);
      }
    }).catch(cause => { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'URLからの読み込みに失敗しました。'); });
    return () => { generation.current++; };
  }, [url, attempt]);
  async function open(book: ImportedUrlBook) {
    const current = generation.current;
    setOpening(book.id); setError('');
    try {
      const saved = await getKakuyomuBook({ data: { bookId: book.id, revision: book.revision } });
      if (current === generation.current) read.current(saved.document);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : '保存した本を開けませんでした。'); }
    finally { if (current === generation.current) setOpening(''); }
  }
  return <>
    {error && <Alert color="red" title="URLを読み込めませんでした" role="alert">{error}<Button variant="subtle" onClick={() => { setError(''); setResult(undefined); setAttempt(value => value + 1); }}>再試行</Button></Alert>}
    {result ? <div className="url-import-books"><Text size="sm">{result.books.length}冊を本棚へ保存しました。</Text><ul>{result.books.map(book => <li key={book.id}><span>{book.title} · {book.totalCharacters.toLocaleString()}字</span><Button variant="light" disabled={Boolean(opening)} loading={opening === book.id} onClick={() => void open(book)}>テキストで読む</Button></li>)}</ul></div>
      : !error && <div role="status" className="url-import-status"><Loader size="sm" /><Text size="sm">本文を読み込んで本棚へ保存しています…</Text></div>}
  </>;
}
