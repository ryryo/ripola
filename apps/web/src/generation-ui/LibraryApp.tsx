import { AudioSampleReader } from '../reader/ui/AudioSampleReader';
import { Brand } from '../ui/Brand';
import { AUDIO_DEMO_BOOK_ID } from '../reader/audio-demo';
import { Alert, Badge, Button, Loader } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import type { AudioBookManifest, AudioBookSummary } from '../generation/contracts';
import { AudioReader } from '../reader/ui/AudioReader';
import { getBook, listLibrary, renameBook } from './api';
import { AlignmentPanel } from './AlignmentPanel';
import { TitleEditor } from '../reader/ui/TitleEditor';
import { Bookshelf, bookDurationLabel } from '../reader/ui/Bookshelf';
import './generation.css';

export function LibraryApp() {
  const [sampleKey, setSampleKey] = useState<string | null>();
  useEffect(() => { setSampleKey(new URLSearchParams(location.search).get('sample')); }, []);
  if (sampleKey === undefined) return <div className="generation-shell"><main><p role="status">読み込んでいます…</p></main></div>;
  return sampleKey ? <AudioSampleReader sampleKey={sampleKey} /> : <LocalLibraryApp />;
}

function LocalLibraryApp() {
  const [books, setBooks] = useState<AudioBookSummary[]>([]);
  const [book, setBook] = useState<AudioBookManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refreshBook = useCallback(async () => {
    if (!book) return;
    setBook(await getBook({ data: { bookId: book.id, revision: book.revision } }));
  }, [book?.id, book?.revision]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const bookId = params.get('book');
    const revision = params.get('revision') ?? undefined;
    void Promise.all([listLibrary(), bookId ? getBook({ data: { bookId, revision } }) : Promise.resolve(undefined)]).then(([library, selected]) => {
      if (active) { setBooks(library); setBook(selected); }
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : '保存音声を開けませんでした。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function open(value: AudioBookSummary) {
    setLoading(true); setError('');
    try {
      const selected = await getBook({ data: { bookId: value.id, revision: value.revision } });
      setBook(selected);
      const target = new URL(window.location.href);
      target.search = new URLSearchParams({ book: value.id, revision: value.revision }).toString();
      window.history.replaceState(null, '', target);
    } catch (error) { setError(error instanceof Error ? error.message : '保存音声を開けませんでした。'); }
    finally { setLoading(false); }
  }

  async function rename(value: AudioBookSummary | AudioBookManifest, title: string) {
    const renamed = await renameBook({ data: { bookId: value.id, revision: value.revision, title } });
    setBooks(previous => previous.map(entry => entry.id === value.id && entry.revision === value.revision ? { ...entry, title: renamed.title } : entry));
    if (book?.id === value.id && book.revision === value.revision) setBook(renamed);
  }

  if (book) return <AudioReader book={book} onRename={book.id === AUDIO_DEMO_BOOK_ID ? undefined : title => rename(book, title)} demo={book.id === AUDIO_DEMO_BOOK_ID} localTools={<AlignmentPanel key={`${book.id}:${book.revision}`} book={book} onUpdated={refreshBook} />} attribution={book.options.provider === 'voicevox' ? '音声：VOICEVOX' : '音声：Gemini'} onClose={() => { if (book.id === AUDIO_DEMO_BOOK_ID) { window.location.assign(import.meta.env.BASE_URL); return; } setBook(undefined); window.history.replaceState(null, '', '/library'); }} />;

  const listedBooks = books.filter(value => value.id !== AUDIO_DEMO_BOOK_ID);
  return <div className="generation-shell">
    <header className="generation-header"><Brand /><nav><a href="/">黙読</a><a href="/generate">音声を生成</a></nav></header>
    <main>
      <div className="generation-title"><div><span className="eyebrow">LOCAL LIBRARY</span><h1>このPCの本棚</h1><p>保存した音声を選んで、文章と一緒に読みます。</p></div><Badge variant="light" color="ripola">保存音声</Badge></div>
      {error && <Alert color="red" role="alert" mb="md">{error}</Alert>}
      {loading && <Loader aria-label="本棚を読み込み中" />}
      {!loading && !listedBooks.length && <div className="generation-card"><p>まだ音声がありません。短い自作文から試せます。</p><Button component="a" href="/generate">音声を生成する</Button></div>}
      {!loading && listedBooks.length > 0 && <Bookshelf count={listedBooks.length}>{listedBooks.map(value => <li key={`${value.id}:${value.revision}`}><article className="generation-card bookshelf-book" aria-labelledby={`shelf-${value.id}-${value.revision}`}>
        <div className="bookshelf-book-content"><h2 id={`shelf-${value.id}-${value.revision}`}>{value.title}</h2><p className="bookshelf-book-meta"><span>保存音声</span><span>{value.completedChunks} / {value.totalChunks}文</span><span>{bookDurationLabel(value.durationSeconds)}</span></p><p className="bookshelf-book-updated">更新：{new Date(value.updatedAt).toLocaleString()}</p></div>
        <div className="bookshelf-book-actions"><Button onClick={() => void open(value)} disabled={loading || value.completedChunks === 0} aria-describedby={`shelf-${value.id}-${value.revision}`}>保存音声を読む</Button><details className="bookshelf-book-details"><summary>名前を変更</summary><TitleEditor title={value.title} onRename={title => rename(value, title)} /></details></div>
      </article></li>)}</Bookshelf>}
    </main>
  </div>;
}
