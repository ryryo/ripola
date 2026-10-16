import { Alert, Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import { loadAudioPosition } from '../audio-position';
import { loadHomeReadingBooks, type HomeReadingBook } from '../home-reading-library';
import { readerCapabilities } from '../environment';
import { BookReadingProgress } from './BookReadingProgress';
import './home-continue-reading.css';

type ContinueBook = HomeReadingBook & { savedPosition?: number };

function savedAudioPosition(book: HomeReadingBook): number | undefined {
  const position = loadAudioPosition(book);
  return position.status === 'saved' ? position.seconds : undefined;
}

export default function HomeContinueReading() {
  const [books, setBooks] = useState<ContinueBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true, request = 0;
    let library: HomeReadingBook[] = [];
    const publish = () => {
      const playable = library.map(book => ({ ...book, savedPosition: savedAudioPosition(book) }))
        .filter(book => !book.resumeOnly || book.savedPosition !== undefined && book.savedPosition > 0);
      playable.sort((left, right) => Number(right.savedPosition !== undefined) - Number(left.savedPosition !== undefined) || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
      setBooks(playable.slice(0, 3));
    };
    const refresh = async () => {
      const current = ++request;
      setLoading(true);
      try {
        const loaded = await loadHomeReadingBooks();
        if (!active || current !== request) return;
        library = loaded; publish(); setError(false);
      } catch { if (active && current === request) setError(true); }
      finally { if (active && current === request) setLoading(false); }
    };
    const shown = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith('rsvp-audio-position:') && !event.key.endsWith(':source')) publish(); };
    void refresh();
    window.addEventListener('pageshow', shown);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('storage', changed);
    return () => { active = false; window.removeEventListener('pageshow', shown); document.removeEventListener('visibilitychange', visible); window.removeEventListener('storage', changed); };
  }, [retry]);

  return <section className="home-continue" aria-labelledby="home-continue-title" aria-busy={loading}>
    <div className="home-continue-heading"><h2 id="home-continue-title">続きを読む</h2><a href={`${import.meta.env.BASE_URL}${readerCapabilities(import.meta.env.VITE_RSVP_PROFILE).audioRoute}`}>本棚ですべて見る</a></div>
    {error && <Alert color="gray" role="alert"><p>保存音声を確認できませんでした。文章の入力と黙読は続けられます。</p><Button variant="subtle" onClick={() => setRetry(value => value + 1)} disabled={loading}>保存音声を再確認</Button></Alert>}
    {loading && !books.length && <p className="home-continue-note" role="status">保存音声を確認しています…</p>}
    {!loading && !error && !books.length && <p className="home-continue-note">保存音声はまだありません。下の入力欄から読みはじめられます。</p>}
    {books.length > 0 && <ul className="home-continue-books">{books.map(book => {
      const saved = book.savedPosition !== undefined;
      const heading = `continue-${book.id}-${book.revision}`;
      return <li key={`${book.id}:${book.revision}`}><article aria-labelledby={heading}>
        <h3 id={heading} title={book.title}>{book.title}</h3>
        <BookReadingProgress book={book} incomplete={book.incomplete} catalogStatus={error ? 'failed' : loading ? 'loading' : 'ready'} />
        <Button component="a" variant="subtle" href={book.href} aria-label={saved ? `${book.title}の続きを読む` : `${book.title}を読む`}>{saved ? '続きを読む' : '読む'}</Button>
      </article></li>;
    })}</ul>}
  </section>;
}
