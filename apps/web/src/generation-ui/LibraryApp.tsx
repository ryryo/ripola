import { useAppNavigation } from '../navigation/AppNavigation';
import { AudioSampleReader } from '../reader/ui/AudioSampleReader';
import { Brand } from '../ui/Brand';
import { ThemeControl } from '../ui/ThemeControl';
import { AUDIO_DEMO_BOOK_ID } from '../reader/audio-demo';
import { Alert, Badge, Button, Loader } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioBookManifest, AudioBookSummary } from '../generation/contracts';
import { ProgressiveAudioReader } from '../reader/ui/ProgressiveAudioReader';
import { getBook, listLibrary, renameBook } from './api';
import { AlignmentPanel } from './AlignmentPanel';
import { AudioInspectionPanel } from './AudioInspectionPanel';
import { Bookshelf } from '../reader/ui/Bookshelf';
import { BookReadingProgress } from '../reader/ui/BookReadingProgress';
import { DEFAULT_BOOKSHELF_OPTIONS, type BookshelfOptions } from '../reader/bookshelf';
import './generation.css';

export function LibraryApp() {
  const navigation = useAppNavigation();
  const [shelfOptions, setShelfOptions] = useState(DEFAULT_BOOKSHELF_OPTIONS);
  const sampleKey = navigation.search.get('sample');
  return sampleKey ? <AudioSampleReader sampleKey={sampleKey} /> : <LocalLibraryApp key={navigation.entryKey} shelfOptions={shelfOptions} onShelfOptionsChange={setShelfOptions} />;
}

function LocalLibraryApp({ shelfOptions, onShelfOptionsChange }: { shelfOptions: BookshelfOptions; onShelfOptionsChange: (options: BookshelfOptions) => void }) {
  const navigation = useAppNavigation();
  const bookId = navigation.search.get('book');
  const revision = navigation.search.get('revision') ?? undefined;
  const [books, setBooks] = useState<AudioBookSummary[]>([]);
  const [book, setBook] = useState<AudioBookManifest>();
  const [loading, setLoading] = useState(true);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const listedBooks = useMemo(() => books.filter(value => value.id !== AUDIO_DEMO_BOOK_ID), [books]);
  const reloadLibrary = useRef<() => void>(() => {});
  const refreshBook = useCallback(async () => {
    if (!book) return;
    setBook(await getBook({ data: { bookId: book.id, revision: book.revision } }));
  }, [book?.id, book?.revision]);

  useEffect(() => {
    let active = true, request = 0;
    const load = async (initial = false) => {
      const current = ++request;
      if (initial) { setLoading(true); setBook(undefined); }
      setCatalogStatus('loading');
      try {
        const [library, selected] = await Promise.all([bookId ? Promise.resolve([]) : listLibrary(), initial && bookId ? getBook({ data: { bookId, revision } }) : Promise.resolve(undefined)]);
        if (!active) return;
        if (initial) setBook(selected);
        if (current === request) { setBooks(library); setError(''); setCatalogStatus('ready'); }
      } catch (error) { if (active && current === request) { setError(error instanceof Error ? error.message : '保存音声を開けませんでした。'); setCatalogStatus('failed'); } }
      finally { if (active && initial) setLoading(false); }
    };
    const refresh = () => { void load(); };
    const shown = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    const visible = () => { if (!document.hidden) refresh(); };
    reloadLibrary.current = refresh;
    void load(true);
    if (bookId) return () => { active = false; reloadLibrary.current = () => {}; };
    window.addEventListener('pageshow', shown);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; reloadLibrary.current = () => {}; window.removeEventListener('pageshow', shown); document.removeEventListener('visibilitychange', visible); };
  }, [bookId, revision]);

  function open(value: AudioBookSummary) {
    void navigation.go(`/library?${new URLSearchParams({ book: value.id, revision: value.revision })}`);
  }

  async function rename(value: AudioBookSummary | AudioBookManifest, title: string) {
    const renamed = await renameBook({ data: { bookId: value.id, revision: value.revision, title } });
    setBooks(previous => previous.map(entry => entry.id === value.id && entry.revision === value.revision ? { ...entry, title: renamed.title } : entry));
    if (book?.id === value.id && book.revision === value.revision) setBook(renamed);
    if (!bookId) reloadLibrary.current();
  }

  if (book && book.id === bookId && (!revision || book.revision === revision)) return <ProgressiveAudioReader key={`${book.id}:${book.revision}`} book={book} requestedJobId={navigation.search.get('job') ?? undefined} onRename={book.id === AUDIO_DEMO_BOOK_ID ? undefined : title => rename(book, title)} demo={book.id === AUDIO_DEMO_BOOK_ID} renderTools={current => <><AlignmentPanel key={`${current.id}:${current.revision}`} book={current} onUpdated={refreshBook} />{current.id !== AUDIO_DEMO_BOOK_ID && <AudioInspectionPanel key={`qa:${current.id}:${current.revision}`} book={current} />}</>} attribution={book.options.provider === 'voicevox' ? '音声：VOICEVOX' : book.options.provider === 'irodori' ? '音声：Irodori' : '音声：Gemini'} onClose={() => navigation.backTo(book.id === AUDIO_DEMO_BOOK_ID ? import.meta.env.BASE_URL : '/library')} />;

  return <div className="generation-shell">
    <header className="generation-header"><Brand /><div className="header-actions"><ThemeControl /><nav><a href="/">黙読</a><a href="/generate">音声を生成</a></nav></div></header>
    <main>
      <div className="generation-title"><div><span className="eyebrow">LOCAL LIBRARY</span><h1>このPCの本棚</h1><p>保存した音声を選んで、文章と一緒に読みます。</p></div><Badge variant="light" color="ripola">保存音声</Badge></div>
      {error && <Alert color="red" role="alert" mb="md">{error}</Alert>}
      {loading && <Loader aria-label="本棚を読み込み中" />}
      {!loading && !error && !listedBooks.length && <div className="generation-card"><p>まだ音声がありません。短い自作文から試せます。</p><Button component="a" href="/generate">音声を生成する</Button></div>}
      {!loading && listedBooks.length > 0 && <Bookshelf books={listedBooks} options={shelfOptions} onChange={onShelfOptionsChange}>{(value, position) => <li key={`${value.id}:${value.revision}`}><article className="generation-card bookshelf-book" aria-labelledby={`shelf-${value.id}-${value.revision}`}>
        <div className="bookshelf-book-content"><h2 id={`shelf-${value.id}-${value.revision}`} title={value.title}>{value.completedChunks > 0 ? <a href={`/library?${new URLSearchParams({ book: value.id, revision: value.revision })}`} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (!loading) void open(value); }}>{value.title}</a> : value.title}</h2><BookReadingProgress position={position} book={value} incomplete={value.completedChunks < value.totalChunks} catalogStatus={catalogStatus} /></div>
        <div className="bookshelf-book-actions"><Button variant="light" onClick={() => void open(value)} disabled={loading || value.completedChunks === 0} aria-label="保存音声を読む" aria-describedby={`shelf-${value.id}-${value.revision}`}>読む</Button></div>
      </article></li>}</Bookshelf>}
    </main>
  </div>;
}
