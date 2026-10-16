import { loadDistributionLibrary } from '../distribution/library';
import { AUDIO_DEMO_BOOK_ID, HOME_AUDIO_DEMOS, audioDemoHref, loadAudioDemos } from './audio-demo';
import { readerCapabilities } from './environment';

export type HomeReadingBook = {
  id: string;
  revision: string;
  title: string;
  durationSeconds: number;
  updatedAt?: string;
  incomplete: boolean;
  resumeOnly: boolean;
  href: string;
};

export async function loadHomeReadingBooks(): Promise<HomeReadingBook[]> {
  const base = import.meta.env.BASE_URL;
  const profile = import.meta.env.VITE_RSVP_PROFILE;
  const route = `${base}${readerCapabilities(profile).audioRoute}`;
  const href = (book: { id: string; revision: string }) => `${route}?${new URLSearchParams({ book: book.id, revision: book.revision })}`;
  if (import.meta.env.VITE_RSVP_PROFILE === 'local') {
    const { listLibrary } = await import('../generation-ui/api');
    return (await listLibrary()).filter(book => book.id !== AUDIO_DEMO_BOOK_ID && book.completedChunks > 0)
      .map(book => ({ ...book, incomplete: book.completedChunks < book.totalChunks, resumeOnly: false, href: href(book) }));
  }
  // AudioDemo reports sample failures separately; they must not hide the user's bookshelf.
  const [library, samples] = await Promise.all([loadDistributionLibrary(base), loadAudioDemos(base).catch(() => [])]);
  const books: HomeReadingBook[] = library.books.map(book => ({ ...book, incomplete: false, resumeOnly: false, href: href(book) }));
  for (const sample of HOME_AUDIO_DEMOS) {
    const entry = samples.find(book => book.id === sample.id && book.revision === sample.revision);
    if (!entry || books.some(book => book.id === entry.id && book.revision === entry.revision)) continue;
    books.push({ ...entry, incomplete: false, resumeOnly: true, href: audioDemoHref(sample.key, profile, base) });
  }
  return books;
}
