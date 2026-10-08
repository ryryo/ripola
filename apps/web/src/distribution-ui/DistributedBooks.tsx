import { AudioSampleReader } from '../reader/ui/AudioSampleReader';
import { Brand } from '../ui/Brand';
import { Alert, Badge, Button, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { distributionLoadError, loadDistributedBook, loadDistributionLibrary, type PublicAudioBookManifest, type PublicBookEntry } from '../distribution/library';
import { AudioReader } from '../reader/ui/AudioReader';
import { ShareLink } from '../sharing/ShareLink';
import { Bookshelf, bookDurationLabel } from '../reader/ui/Bookshelf';
import '../generation-ui/generation.css';

export function DistributedBooks() {
  const [sampleKey, setSampleKey] = useState<string | null>();
  useEffect(() => { setSampleKey(new URLSearchParams(location.search).get('sample')); }, []);
  if (sampleKey === undefined) return <div className="generation-shell"><main><p role="status">読み込んでいます…</p></main></div>;
  return sampleKey ? <AudioSampleReader sampleKey={sampleKey} /> : <DistributedLibrary />;
}

function DistributedLibrary() {
  const [books, setBooks] = useState<PublicBookEntry[]>([]);
  const [book, setBook] = useState<PublicAudioBookManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const demo = import.meta.env.VITE_RSVP_PROFILE === 'pages' || (books.length > 0 && books.every(entry => entry.publicDemo));
  useEffect(() => {
    let active = true;
    void loadDistributionLibrary(import.meta.env.BASE_URL).then(async library => {
      if (!active) return;
      setBooks(library.books);
      const query = new URLSearchParams(location.search);
      const entry = library.books.find(entry => entry.id === query.get('book') && entry.revision === query.get('revision'));
      if (entry) { const opened = await loadDistributedBook(entry, import.meta.env.BASE_URL); if (active) setBook(opened); }
    }).catch(error => { if (active) setError(distributionLoadError(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function open(entry: PublicBookEntry) {
    setLoading(true); setError('');
    try {
      setBook(await loadDistributedBook(entry, import.meta.env.BASE_URL));
      const url = new URL(location.href); url.search = new URLSearchParams({ book: entry.id, revision: entry.revision }).toString();
      history.replaceState(null, '', url);
    } catch (error) { setError(distributionLoadError(error)); }
    finally { setLoading(false); }
  }
  if (book) {
    const isDemo = books.some(entry => entry.id === book.id && entry.revision === book.revision && entry.publicDemo);
    return <AudioReader book={book} demo={isDemo} onClose={() => { if (isDemo) { location.assign(import.meta.env.BASE_URL); return; } setBook(undefined); history.replaceState(null, '', location.pathname); }} />;
  }
  return <div className="generation-shell"><header className="generation-header"><Brand /><nav><a href={import.meta.env.BASE_URL}>黙読</a></nav></header><main><Stack gap="lg">
    <Button component="a" href={import.meta.env.BASE_URL} variant="subtle" style={{ alignSelf: 'start' }}>黙読リーダーへ</Button>
    <div className="generation-title"><div><Badge variant="light">{demo ? '音声デモ' : '保存音声'}</Badge><Title order={1}>{demo ? '音声に合わせて、読む。' : '本棚'}</Title><Text c="dimmed">保存した音声を選んで、文章と一緒に読みます。</Text></div></div>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {!loading && !error && !books.length && <Text>音声付きの本はまだ配置されていません。</Text>}
    {loading && <Text role="status">読み込んでいます…</Text>}
    {!loading && books.length > 0 && <Bookshelf count={books.length}>{books.map(entry => <li key={`${entry.id}/${entry.revision}`}><article className="generation-card bookshelf-book" aria-labelledby={`shelf-${entry.id}-${entry.revision}`}>
      <div className="bookshelf-book-content"><h2 id={`shelf-${entry.id}-${entry.revision}`}>{entry.title}</h2><p className="bookshelf-book-meta"><span>保存音声</span><span>{bookDurationLabel(entry.durationSeconds)}</span></p><details className="bookshelf-book-details"><summary>著者・音声</summary><p>{entry.attribution}</p></details></div>
      <div className="bookshelf-book-actions"><Button onClick={() => void open(entry)} disabled={loading} aria-describedby={`shelf-${entry.id}-${entry.revision}`}>音声付きで読む</Button></div>
    </article></li>)}</Bookshelf>}
    <ShareLink title={demo ? '音声デモ' : '音声ライブラリー'} />
  </Stack></main></div>;
}
