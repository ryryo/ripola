import type { ReadingDocument } from '../reader/model';

/** Kakuyomu acquisition DTOs shared by the local server functions and the shelf UI. */
export interface NovelEpisode { id: string; title: string; url: string; order: number }
export interface NovelPart { title: string; chapter: string; section?: string; order: number; episodes: NovelEpisode[] }
export interface NovelIndex { id: string; title: string; author: string; url: string; parts: NovelPart[] }

export interface KakuyomuPartSummary {
  order: number;
  title: string;
  chapter: string;
  section?: string;
  episodeCount: number;
  firstEpisode?: string;
  lastEpisode?: string;
}

export interface KakuyomuPreview {
  id: string;
  title: string;
  author: string;
  url: string;
  parts: KakuyomuPartSummary[];
  /** True when the work index came from a hash-verified local cache. */
  cached: boolean;
  fetchedAt?: string;
}

export interface KakuyomuSourceEpisode {
  order: number;
  id: string;
  title: string;
  url: string;
  sha256: string;
  bytes: number;
  fetchedAt: string;
}

/** Local, explicit text book. It is not an audio manifest with empty chunks. */
export interface LocalTextBook {
  schemaVersion: 1;
  kind: 'text';
  id: string;
  revision: string;
  title: string;
  updatedAt: string;
  document: ReadingDocument;
  chunks: [];
  completedChunks: 0;
  totalChunks: 0;
  durationSeconds: 0;
  precision: 'sentence';
  attribution: string;
  warnings: string[];
  source: {
    kind: 'kakuyomu';
    workId: string;
    workUrl: string;
    indexSha256: string;
    partOrder: number;
    chapter: string;
    section?: string;
    episodes: KakuyomuSourceEpisode[];
  } | {
    kind: 'aozora';
    workId: string;
    workUrl: string;
    partOrder: number;
    chapter?: string;
    htmlUrl: string;
    htmlSha256: string;
    cardSha256: string;
    bytes: number;
    fetchedAt: string;
  } | {
    kind: 'note';
    workId: string;
    workUrl: string;
    partOrder: 1;
    access: 'free-public';
    htmlSha256: string;
    bodySha256: string;
    responseSha256: string;
    bytes: number;
    fetchedAt: string;
  };
}

export interface LocalTextBookSummary {
  kind: 'text';
  id: string;
  revision: string;
  title: string;
  updatedAt: string;
  totalCharacters: number;
  attribution: string;
  workUrl: string;
  partOrder: number;
  episodeCount: number;
}

/**
 * Browser-safe validation for the URL input. Only an explicit https work URL
 * counts; bare numbers and surrounding prose are not URLs. The CLI keeps
 * accepting bare ids through kakuyomuWorkUrl().
 */
export function kakuyomuWorkUrlInput(input: string): string | undefined {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.host !== 'kakuyomu.jp' || url.username || url.password || url.search || url.hash
    || !/^\/works\/\d{19,20}\/?$/.test(url.pathname)) return undefined;
  return url.href.replace(/\/$/, '');
}

export type KakuyomuJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface KakuyomuJobBook {
  id: string;
  revision: string;
  title: string;
  partOrder: number;
  episodeCount: number;
  totalCharacters: number;
}

export interface KakuyomuJobView {
  id: string;
  status: KakuyomuJobStatus;
  workId: string;
  workUrl: string;
  selectedParts: number[];
  totalParts: number;
  totalEpisodes: number;
  completedEpisodes: number;
  completedParts: number;
  current?: { partOrder: number; partTitle: string; episodeOrder: number; episodeTitle: string };
  books: KakuyomuJobBook[];
  error?: string;
  startedAt: string;
  updatedAt: string;
}
