import { Alert, Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { AudioBookSummary } from '../../generation/contracts';
import { listLibrary } from '../../generation-ui/api';
import { AUDIO_DEMO_BOOK_ID } from '../audio-demo';
import { bookDurationLabel } from './Bookshelf';
import './home-continue-reading.css';

type ContinueBook = AudioBookSummary & { savedPosition?: number };

function savedAudioPosition(book: AudioBookSummary): number | undefined {
  try {
    const value = localStorage.getItem(`rsvp-audio-position:${book.id}:${book.revision}`);
    if (value === null || !value.trim()) return undefined;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  } catch { return undefined; }
}

export default function HomeContinueReading() {
  const [books, setBooks] = useState<ContinueBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true, request = 0;
    const refresh = async () => {
      const current = ++request;
      setLoading(true);
      try {
        const library = await listLibrary();
        if (!active || current !== request) return;
        const playable = library.filter(book => book.id !== AUDIO_DEMO_BOOK_ID && book.completedChunks > 0)
          .map(book => ({ ...book, savedPosition: savedAudioPosition(book) }));
        playable.sort((left, right) => Number(right.savedPosition !== undefined) - Number(left.savedPosition !== undefined) || right.updatedAt.localeCompare(left.updatedAt));
        setBooks(playable.slice(0, 3)); setError(false);
      } catch { if (active && current === request) setError(true); }
      finally { if (active && current === request) setLoading(false); }
    };
    const shown = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    window.addEventListener('pageshow', shown);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.removeEventListener('pageshow', shown); document.removeEventListener('visibilitychange', visible); };
  }, [retry]);

  return <section className="home-continue" aria-labelledby="home-continue-title" aria-busy={loading}>
    <div className="home-continue-heading"><h2 id="home-continue-title">続きを読む</h2><a href={`${import.meta.env.BASE_URL}library`}>本棚ですべて見る</a></div>
    {error && <Alert color="gray" role="alert"><p>保存音声を確認できませんでした。文章の入力と黙読は続けられます。</p><Button variant="subtle" onClick={() => setRetry(value => value + 1)} disabled={loading}>保存音声を再確認</Button></Alert>}
    {loading && !books.length && <p className="home-continue-note" role="status">保存音声を確認しています…</p>}
    {!loading && !error && !books.length && <p className="home-continue-note">保存音声はまだありません。下の入力欄から読みはじめられます。</p>}
    {books.length > 0 && <ul className="home-continue-books">{books.map(book => {
      const saved = book.savedPosition !== undefined;
      const position = saved ? '保存した位置から再開' : '保存済みの音声から読む';
      const heading = `continue-${book.id}-${book.revision}`;
      return <li key={`${book.id}:${book.revision}`}><article aria-labelledby={heading}>
        <div className="home-continue-copy"><h3 id={heading}>{book.title}</h3><p className="home-continue-position">{position}</p><p className="home-continue-meta"><span>保存音声 {bookDurationLabel(book.durationSeconds)}</span><span>保存済み音声 {book.completedChunks} / {book.totalChunks} 区間</span></p></div>
        <Button component="a" variant="light" href={`${import.meta.env.BASE_URL}library?${new URLSearchParams({ book: book.id, revision: book.revision })}`} aria-label={saved ? `${book.title}の続きを読む` : `${book.title}を読む`}>{saved ? '続きを読む' : '音声から読む'}</Button>
      </article></li>;
    })}</ul>}
  </section>;
}
