import { loadDistributionLibrary, type PublicBookEntry } from '../distribution/library';
import { readerCapabilities } from './environment';

// Explicit, rights-cleared revisions; never infer samples from a user's book titles.
export const AUDIO_DEMOS = [
  { key: 'voicevox', label: 'VOICEVOX', voice: 'ずんだもん', id: 'book-6487aedc3f6da54d169317f3', revision: '742654591d3b1f08f6a6b42eb93b69f67a69415058c1dd567919179cb06199b9' },
  { key: 'gemini-male', label: 'Gemini（男）', voice: 'Puck', id: 'book-edc889c2c4bed6b4c94ce9ab', revision: '49fcdf803d0d20b96b048ee25f3f013a5e5c7f316c6a1c30b594d9dfe96c0ddd' },
  { key: 'gemini-female', label: 'Gemini（女）', voice: 'Kore', id: 'book-46e680913b8fbb69271ea04c', revision: 'a1f947a8834612b5f214e2b93e0bad65672f1f1885268be8070b22e8bcf3d393' },
] as const;
export const AUDIO_DEMO_BOOK_ID = AUDIO_DEMOS[0].id;
export type AudioDemoKey = typeof AUDIO_DEMOS[number]['key'];
export function audioDemo(key: string | null) { return AUDIO_DEMOS.find(sample => sample.key === key); }
export function audioDemoBaseUrl(baseUrl: string) { return `${baseUrl}samples/audio/`; }
export async function loadAudioDemos(baseUrl: string, fetcher: typeof fetch = fetch): Promise<PublicBookEntry[]> {
  const library = await loadDistributionLibrary(audioDemoBaseUrl(baseUrl), fetcher);
  return library.books.filter(entry => entry.publicDemo && AUDIO_DEMOS.some(sample => sample.id === entry.id && sample.revision === entry.revision));
}
export function audioDemoHref(key: AudioDemoKey, profile: string | undefined, baseUrl: string) {
  const sample = audioDemo(key)!;
  return `${baseUrl}${readerCapabilities(profile).audioRoute}?${new URLSearchParams({ sample: sample.key, book: sample.id, revision: sample.revision })}`;
}
