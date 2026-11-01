import { useAppNavigation } from '../navigation/AppNavigation';
import { AudioSampleReader } from '../reader/ui/AudioSampleReader';
import { Brand } from '../ui/Brand';
import { ThemeControl } from '../ui/ThemeControl';
import { AUDIO_DEMO_BOOK_ID } from '../reader/audio-demo';
import { Alert, Badge, Button, Loader, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioBookManifest, AudioBookSummary } from '../generation/contracts';
import type { LocalTextBook, LocalTextBookSummary } from '../kakuyomu/contracts';
import { ProgressiveAudioReader } from '../reader/ui/ProgressiveAudioReader';
import { ReaderApp } from '../reader/ui/ReaderApp';
import { getBook, listLibrary, renameBook } from './api';
import { getKakuyomuBook, listKakuyomuBooks } from '../kakuyomu/api';
import { AlignmentPanel } from './AlignmentPanel';
import { AudioInspectionPanel } from './AudioInspectionPanel';
import { Bookshelf } from '../reader/ui/Bookshelf';
import { BookReadingProgress } from '../reader/ui/BookReadingProgress';
import { DEFAULT_BOOKSHELF_OPTIONS, type BookshelfOptions } from '../reader/bookshelf';
import { buildBookNavigation, loadBookshelfPositions, sameBook, selectBookNavigationSnapshot, type BookNavigation, type BookNavigationBook } from '../reader/book-navigation';
import './generation.css';

type LocalShelfBook = BookNavigationBook & {
  kind: 'audio' | 'text';
  durationSeconds: number;
  totalCharacters?: number;
  completedChunks?: number;
  totalChunks?: number;
};
type OpenedBook = { kind: 'audio'; book: AudioBookManifest } | { kind: 'text'; book: LocalTextBook };

function libraryBookHref(book: { id: string; revision: string }): string {
  return `${import.meta.env.BASE_URL}library?${new URLSearchParams({ book: book.id, revision: book.revision })}`;
}

function canNavigateLocal(book: LocalShelfBook): boolean {
  return book.kind === 'text' || (book.id !== AUDIO_DEMO_BOOK_ID && (book.completedChunks ?? 0) > 0 && book.durationSeconds > 0);
}

export function LibraryApp() {
  const navigation = useAppNavigation();
  const [shelfOptions, setShelfOptions] = useState(DEFAULT_BOOKSHELF_OPTIONS);
  const shelfNavigation = useRef<LocalShelfBook[] | null>(null);
  const sampleKey = navigation.search.get('sample');
  return sampleKey ? <AudioSampleReader sampleKey={sampleKey} /> : <LocalLibraryApp key={navigation.entryKey} shelfOptions={shelfOptions} onShelfOptionsChange={setShelfOptions} navigationSnapshot={shelfNavigation} />;
}

function LocalLibraryApp({ shelfOptions, onShelfOptionsChange, navigationSnapshot }: { shelfOptions: BookshelfOptions; onShelfOptionsChange: (options: BookshelfOptions) => void; navigationSnapshot: { current: LocalShelfBook[] | null } }) {
  const navigation = useAppNavigation();
  const bookId = navigation.search.get('book');
  const revision = navigation.search.get('revision') ?? undefined;
  const [books, setBooks] = useState<AudioBookSummary[]>([]);
  const [textBooks, setTextBooks] = useState<LocalTextBookSummary[]>([]);
  const [opened, setOpened] = useState<OpenedBook>();
  const [loading, setLoading] = useState(true);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const reloadLibrary = useRef<() => void>(() => {});
  const refreshBook = useCallback(async () => {
    if (opened?.kind !== 'audio') return;
    const book = opened.book;
    setOpened({ kind: 'audio', book: await getBook({ data: { bookId: book.id, revision: book.revision } }) });
  }, [opened?.kind === 'audio' ? opened.book.id : undefined, opened?.kind === 'audio' ? opened.book.revision : undefined]);

  useEffect(() => {
    let active = true, request = 0;
    const load = async (initial = false) => {
      const current = ++request;
      if (initial) { setLoading(true); setOpened(undefined); }
      setCatalogStatus('loading');
      try {
        const [library, text] = await Promise.all([listLibrary(), listKakuyomuBooks()]);
        if (!active) return;
        let selected: OpenedBook | undefined;
        if (initial && bookId) {
          const textEntry = text.find(entry => entry.id === bookId && (!revision || entry.revision === revision));
          selected = textEntry
            ? { kind: 'text', book: await getKakuyomuBook({ data: { bookId: textEntry.id, revision: textEntry.revision } }) }
            : { kind: 'audio', book: await getBook({ data: { bookId, revision } }) };
        }
        if (!active) return;
        if (initial) setOpened(selected);
        if (current === request) { setBooks(library); setTextBooks(text); setError(''); setCatalogStatus('ready'); }
      } catch (error) { if (active && current === request) { setError(error instanceof Error ? error.message : '保存した本を開けませんでした。'); setCatalogStatus('failed'); } }
      finally { if (active && initial) setLoading(false); }
    };
    const refresh = () => { void load(); };
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith('rsvp-audio-position:')) refresh(); };
    const shown = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    const visible = () => { if (!document.hidden) refresh(); };
    reloadLibrary.current = refresh;
    void load(true);
    window.addEventListener('storage', changed);
    window.addEventListener('pageshow', shown);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; reloadLibrary.current = () => {}; window.removeEventListener('storage', changed); window.removeEventListener('pageshow', shown); document.removeEventListener('visibilitychange', visible); };
  }, [bookId, revision]);

  const shelfBooks: LocalShelfBook[] = [
    ...books.filter(value => value.id !== AUDIO_DEMO_BOOK_ID).map(value => ({ ...value, kind: 'audio' as const, href: libraryBookHref(value) })),
    ...textBooks.map(value => ({ ...value, kind: 'text' as const, durationSeconds: 0, href: libraryBookHref(value) })),
  ];

  function open(value: LocalShelfBook) {
    navigationSnapshot.current = selectBookNavigationSnapshot(shelfBooks, loadBookshelfPositions(shelfBooks), shelfOptions.sort, shelfOptions.filter, canNavigateLocal);
    void navigation.go(value.href);
  }

  async function rename(value: AudioBookManifest, title: string) {
    const renamed = await renameBook({ data: { bookId: value.id, revision: value.revision, title } });
    setBooks(previous => previous.map(entry => entry.id === value.id && entry.revision === value.revision ? { ...entry, title: renamed.title } : entry));
    if (opened?.kind === 'audio' && opened.book.id === value.id && opened.book.revision === value.revision) setOpened({ kind: 'audio', book: renamed });
    reloadLibrary.current();
  }

  if (opened && opened.book.id === bookId && (!revision || opened.book.revision === revision)) {
    const value = opened.book;
    const current = shelfBooks.find(entry => sameBook(entry, value));
    const ordered = current && canNavigateLocal(current) ? buildBookNavigation({
      books: shelfBooks, positions: loadBookshelfPositions(shelfBooks), sort: shelfOptions.sort, filter: shelfOptions.filter,
      current, canRead: canNavigateLocal, preferred: navigationSnapshot.current,
    }) : undefined;
    const bookNavigation: BookNavigation | undefined = ordered && { previous: ordered.previous, next: ordered.next, shelfHref: `${import.meta.env.BASE_URL}library` };
    if (opened.kind === 'text') return <ReaderApp key={`${value.id}:${value.revision}`} initialDocument={opened.book.document} bookNavigation={bookNavigation} textBook={value} />;
    const audio = opened.book;
    return <ProgressiveAudioReader key={`${audio.id}:${audio.revision}`} book={audio} bookNavigation={bookNavigation} requestedJobId={navigation.search.get('job') ?? undefined} onRename={audio.id === AUDIO_DEMO_BOOK_ID ? undefined : title => rename(audio, title)} demo={audio.id === AUDIO_DEMO_BOOK_ID} renderTools={current => <><AlignmentPanel key={`${current.id}:${current.revision}`} book={current} onUpdated={refreshBook} />{current.id !== AUDIO_DEMO_BOOK_ID && <AudioInspectionPanel key={`qa:${current.id}:${current.revision}`} book={current} />}</>} attribution={audio.options.provider === 'voicevox' ? '音声：VOICEVOX' : audio.options.provider === 'irodori' ? '音声：Irodori' : '音声：Gemini'} onClose={() => navigation.backTo(audio.id === AUDIO_DEMO_BOOK_ID ? import.meta.env.BASE_URL : '/library')} />;
  }

  const total = shelfBooks.length;
  return <div className="generation-shell">
    <header className="generation-header"><Brand /><div className="header-actions"><ThemeControl /><nav><a href="/">黙読</a><a href="/generate">音声を生成</a></nav></div></header>
    <main>
      <div className="generation-title"><div><span className="eyebrow">LOCAL LIBRARY</span><h1>このPCの本棚</h1><p>保存した音声とテキストを選んで読みます。</p></div><Badge variant="light" color="ripola">{total ? `${total}冊` : 'ローカル限定'}</Badge></div>
      {error && <Alert color="red" role="alert" mb="md">{error}</Alert>}
      {loading && <Loader aria-label="本棚を読み込み中" />}
      {!loading && !error && !total && <div className="generation-card"><p>まだ本がありません。リーダーで文章を取り込むか、音声を生成できます。</p><div className="generation-actions"><Button component="a" href="/">リーダーで文章を取り込む</Button><Button component="a" href="/generate" variant="light">音声を生成する</Button></div></div>}
      {!loading && total > 0 && <Bookshelf books={shelfBooks} options={shelfOptions} onChange={onShelfOptionsChange}>{value => <li key={`${value.kind}:${value.id}:${value.revision}`}><article className="generation-card bookshelf-book" aria-labelledby={`shelf-${value.id}-${value.revision}`}>
        <div className="bookshelf-book-content"><h2 id={`shelf-${value.id}-${value.revision}`} title={value.title}><a href={value.href} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (!loading) open(value); }}>{value.title}</a></h2>{value.kind === 'text' ? <Text size="sm" c="dimmed">テキスト · {value.totalCharacters?.toLocaleString('ja-JP')}字</Text> : <BookReadingProgress book={value} incomplete={(value.completedChunks ?? 0) < (value.totalChunks ?? 0)} catalogStatus={catalogStatus} />}</div>
        <div className="bookshelf-book-actions"><Button variant="light" onClick={() => open(value)} disabled={loading || (value.kind === 'audio' && (value.completedChunks ?? 0) === 0)} aria-label={value.kind === 'text' ? 'テキストで読む' : '保存音声を読む'} aria-describedby={`shelf-${value.id}-${value.revision}`}>読む</Button></div>
      </article></li>}</Bookshelf>}
    </main>
  </div>;
}
