import { useAppNavigation } from '../navigation/AppNavigation';
import { AudioSampleReader } from '../reader/ui/AudioSampleReader';
import { Brand } from '../ui/Brand';
import { ThemeControl } from '../ui/ThemeControl';
import { Alert, Badge, Button, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { distributionLoadError, loadDistributedBook, loadDistributionLibrary, type PublicAudioBookManifest, type PublicBookEntry } from '../distribution/library';
import { AudioReader } from '../reader/ui/AudioReader';
import { ShareLink } from '../sharing/ShareLink';
import { Bookshelf } from '../reader/ui/Bookshelf';
import { BookReadingProgress } from '../reader/ui/BookReadingProgress';
import { readerCapabilities } from '../reader/environment';
import { DEFAULT_BOOKSHELF_OPTIONS } from '../reader/bookshelf';
import '../generation-ui/generation.css';

export function DistributedBooks() {
  const sampleKey = useAppNavigation().search.get('sample');
  return sampleKey ? <AudioSampleReader sampleKey={sampleKey} /> : <DistributedLibrary />;
}

function DistributedLibrary() {
  const navigation = useAppNavigation();
  const bookId = navigation.search.get('book');
  const revision = navigation.search.get('revision');
  const [books, setBooks] = useState<PublicBookEntry[]>([]);
  const [book, setBook] = useState<PublicAudioBookManifest>();
  const [shelfOptions, setShelfOptions] = useState(DEFAULT_BOOKSHELF_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const demo = import.meta.env.VITE_RSVP_PROFILE === 'pages' || (books.length > 0 && books.every(entry => entry.publicDemo));
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setBook(undefined);
    void loadDistributionLibrary(import.meta.env.BASE_URL).then(async library => {
      if (!active) return;
      setBooks(library.books);
      const entry = library.books.find(entry => entry.id === bookId && entry.revision === revision);
      if (entry) { const opened = await loadDistributedBook(entry, import.meta.env.BASE_URL); if (active) setBook(opened); }
    }).catch(error => { if (active) setError(distributionLoadError(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bookId, revision]);
  function open(entry: PublicBookEntry) {
    void navigation.go(`${location.pathname}?${new URLSearchParams({ book: entry.id, revision: entry.revision })}`);
  }
  if (book && book.id === bookId && book.revision === revision) {
    const isDemo = books.some(entry => entry.id === book.id && entry.revision === book.revision && entry.publicDemo);
    return <AudioReader book={book} demo={isDemo} onClose={() => navigation.backTo(isDemo ? import.meta.env.BASE_URL : location.pathname)} />;
  }
  return <div className="generation-shell"><header className="generation-header"><Brand /><div className="header-actions"><ThemeControl /><nav><a href={import.meta.env.BASE_URL}>黙読</a></nav></div></header><main><Stack gap="lg">
    <Button component="a" href={import.meta.env.BASE_URL} variant="subtle" style={{ alignSelf: 'start' }}>黙読リーダーへ</Button>
    <div className="generation-title"><div><Badge variant="light">{demo ? '音声デモ' : '保存音声'}</Badge><Title order={1}>{demo ? '音声に合わせて、読む。' : '本棚'}</Title><Text c="dimmed">保存した音声を選んで、文章と一緒に読みます。</Text></div></div>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {!loading && !error && !books.length && <Text>音声付きの本はまだ配置されていません。</Text>}
    {loading && <Text role="status">読み込んでいます…</Text>}
    {!loading && books.length > 0 && <Bookshelf books={books} options={shelfOptions} onChange={setShelfOptions}>{entry => <li key={`${entry.id}/${entry.revision}`}><article className="generation-card bookshelf-book" aria-labelledby={`shelf-${entry.id}-${entry.revision}`}>
      <div className="bookshelf-book-content"><h2 id={`shelf-${entry.id}-${entry.revision}`} title={entry.title}><a href={`${import.meta.env.BASE_URL}${readerCapabilities(import.meta.env.VITE_RSVP_PROFILE).audioRoute}?${new URLSearchParams({ book: entry.id, revision: entry.revision })}`} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (!loading) void open(entry); }}>{entry.title}</a></h2><BookReadingProgress book={entry} /></div>
      <div className="bookshelf-book-actions"><Button variant="light" onClick={() => void open(entry)} disabled={loading} aria-label="音声付きで読む" aria-describedby={`shelf-${entry.id}-${entry.revision}`}>読む</Button></div>
    </article></li>}</Bookshelf>}
    <ShareLink title={demo ? '音声デモ' : '音声ライブラリー'} />
  </Stack></main></div>;
}
