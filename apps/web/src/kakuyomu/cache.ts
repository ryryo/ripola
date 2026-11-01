import { setTimeout as pause } from 'node:timers/promises';
import { LibraryDisk } from '../generation/core/disk';
import {
  hash, kakuyomuEpisodeUrl, kakuyomuWorkUrl,
  requireEpisodeCanonical, requireWorkCanonical, type NovelEpisode, type SourceAccess,
} from './parser';
import type { PageFetch, FetchedPage } from './fetch';

export interface SourceRecord {
  schemaVersion: 1;
  kind: 'index' | 'episode';
  workId: string;
  workUrl: string;
  episodeId?: string;
  url: string;
  file: string;
  bytes: number;
  sha256: string;
  fetchedAt: string;
  canonicalUrl: string;
  contentType?: string;
  /** Existing cache adopted at its current hash; not proof it was never modified earlier. */
  adopted?: true;
}

export interface CacheLedger {
  schemaVersion: 1;
  workId: string;
  workUrl: string;
  index?: SourceRecord;
  episodes: Record<string, SourceRecord>;
}

export interface CachedPage { html: string; record: SourceRecord; cached: boolean; adopted: boolean }

export interface CacheOptions {
  disk: LibraryDisk;
  workId: string;
  workUrl: string;
  /** Adopt legacy numeric (001.html) and un-ledgered files at their current hash. */
  allowLegacyAdoption?: boolean;
  maxBytes?: number;
  now?: () => string;
}

function emptyLedger(workId: string, workUrl: string): CacheLedger {
  return { schemaVersion: 1, workId, workUrl, episodes: {} };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`取得記録が正しくありません: ${label}`);
  return value as Record<string, unknown>;
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('取得したHTMLの文字コードを確認できません。'); }
}
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/**
 * One cache directory per work. The ledger is written only after raw bytes are
 * committed; every read re-checks the URL/work/episode relation, byte count,
 * SHA-256 and DOM canonical before the HTML is used.
 */
export class KakuyomuCache {
  private readonly disk: LibraryDisk;
  private readonly workId: string;
  private readonly workUrl: string;
  private readonly allowLegacy: boolean;
  private readonly maximum: number;
  private readonly now: () => string;
  readonly access: SourceAccess;
  constructor(options: CacheOptions) {
    this.disk = options.disk;
    this.workUrl = kakuyomuWorkUrl(options.workUrl);
    this.workId = this.workUrl.split('/').at(-1)!;
    if (options.workId !== this.workId) throw new Error('作品IDとURLが一致しません。');
    this.allowLegacy = options.allowLegacyAdoption === true;
    this.maximum = options.maxBytes ?? 3_000_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.access = { workId: this.workId, workUrl: this.workUrl, allowedEpisodeUrl: id => kakuyomuEpisodeUrl(this.workUrl, id) };
  }

  private async ledger(): Promise<CacheLedger> {
    const value = await this.disk.read<unknown>(['ledger.json']);
    if (value === undefined) return emptyLedger(this.workId, this.workUrl);
    const data = record(value, 'ledger');
    if (data.schemaVersion !== 1 || data.workId !== this.workId || data.workUrl !== this.workUrl || !data.episodes || typeof data.episodes !== 'object' || Array.isArray(data.episodes)) {
      throw new Error('取得済みデータの台帳がこの作品と一致しません。');
    }
    return data as unknown as CacheLedger;
  }
  private async updateLedger(action: (ledger: CacheLedger) => void): Promise<void> {
    await this.disk.withLock('kakuyomu-ledger', async () => {
      const ledger = await this.ledger();
      action(ledger);
      await this.disk.write(['ledger.json'], ledger);
    });
  }
  private files(record: SourceRecord): string[] {
    const parts = record.file.split('/');
    if (parts.some(part => part === '.' || part === '..' || !part)) throw new Error('取得済みデータの保存先が正しくありません。');
    return parts;
  }
  private expectedFile(kind: 'index' | 'episode', episodeId?: string): string {
    return kind === 'index' ? 'index.html' : `episodes/${episodeId}.html`;
  }
  private async verified(record: SourceRecord, expectedUrl: string, canonical: (html: string) => string): Promise<string> {
    if (record.schemaVersion !== 1 || record.kind !== (record.episodeId ? 'episode' : 'index') || record.workId !== this.workId || record.workUrl !== this.workUrl
      || record.url !== expectedUrl || record.canonicalUrl !== expectedUrl || record.file !== this.expectedFile(record.episodeId ? 'episode' : 'index', record.episodeId)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || record.bytes > this.maximum || !/^[a-f0-9]{64}$/.test(record.sha256)
      || !validTimestamp(record.fetchedAt) || (record.episodeId !== undefined && !/^\d{19,20}$/.test(record.episodeId))) {
      throw new Error('取得済みデータの台帳が取得元または保存先と一致しません。');
    }
    const bytes = await this.disk.readBytes(this.files(record));
    if (!bytes) throw new Error('取得済み原本ファイルがありません。再取得せずに停止しました。');
    if (bytes.byteLength !== record.bytes || hash(bytes) !== record.sha256) throw new Error('取得済み原本が取得時のhash・容量と一致しません。改変された可能性があるため再利用しません。');
    const html = decode(bytes);
    let canonicalUrl: string;
    try { canonicalUrl = canonical(html); } catch { throw new Error('取得済み原本に正しいcanonicalがありません。'); }
    if (canonicalUrl !== expectedUrl) throw new Error('取得済み原本canonicalが出典URLと一致しません。');
    return html;
  }
  private async commit(record: SourceRecord, bytes: Uint8Array): Promise<void> {
    await this.disk.writeBytes(this.files(record), bytes);
    await this.updateLedger(ledger => {
      if (record.kind === 'index') ledger.index = record;
      else ledger.episodes[record.episodeId!] = record;
    });
  }
  private fetchedRecord(fetch: FetchedPage, kind: 'index' | 'episode', url: string, episodeId?: string): SourceRecord {
    return {
      schemaVersion: 1, kind, workId: this.workId, workUrl: this.workUrl, ...(episodeId ? { episodeId } : {}),
      url, file: this.expectedFile(kind, episodeId), bytes: fetch.bytes.byteLength, sha256: hash(fetch.bytes),
      fetchedAt: fetch.fetchedAt, canonicalUrl: url, ...(fetch.contentType ? { contentType: fetch.contentType } : {}),
    };
  }

  private async withFetchLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 30_000;
    let release: (() => Promise<void>) | undefined;
    while (!(release = await this.disk.lock(id))) {
      if (Date.now() >= deadline) throw new Error('同じ作品の取得処理が別のタブまたは処理で進行中です。完了を待ってください。');
      await pause(25);
    }
    try { return await action(); } finally { await release(); }
  }

  async getIndex(fetch: PageFetch | undefined, offline: boolean): Promise<CachedPage> {
    return this.withFetchLock('kakuyomu-fetch-index', () => this.getIndexUnlocked(fetch, offline));
  }
  private async getIndexUnlocked(fetch: PageFetch | undefined, offline: boolean): Promise<CachedPage> {
    const ledger = await this.ledger();
    if (ledger.index) return { html: await this.verified(ledger.index, this.workUrl, html => requireWorkCanonical(html, this.workUrl)), record: ledger.index, cached: true, adopted: ledger.index.adopted === true };
    const existing = this.allowLegacy ? await this.disk.readBytes(['index.html']) : undefined;
    if (existing) {
      if (existing.byteLength > this.maximum) throw new Error('取得済み原本の容量が上限を超えています。');
      const html = decode(existing);
      requireWorkCanonical(html, this.workUrl);
      const record: SourceRecord = { schemaVersion: 1, kind: 'index', workId: this.workId, workUrl: this.workUrl, url: this.workUrl,
        file: 'index.html', bytes: existing.byteLength, sha256: hash(existing), fetchedAt: this.now(), canonicalUrl: this.workUrl, adopted: true };
      await this.commit(record, existing);
      return { html, record, cached: true, adopted: true };
    }
    if (offline) throw new Error('取得済みデータがありません: 作品目次');
    if (!fetch) throw new Error('取得処理が設定されていません。');
    const page = await fetch(this.workUrl, this.access);
    if (page.url !== this.workUrl) throw new Error('取得した作品ページのURLが一致しません。');
    if (page.bytes.byteLength > this.maximum) throw new Error('公開ページの容量が上限を超えています。');
    const html = decode(page.bytes);
    requireWorkCanonical(html, this.workUrl);
    const record = this.fetchedRecord(page, 'index', this.workUrl);
    await this.commit(record, page.bytes);
    return { html, record, cached: false, adopted: false };
  }

  async getEpisode(episode: NovelEpisode, fetch: PageFetch | undefined, offline: boolean): Promise<CachedPage> {
    return this.withFetchLock(`kakuyomu-fetch-${episode.id}`, () => this.getEpisodeUnlocked(episode, fetch, offline));
  }
  private async getEpisodeUnlocked(episode: NovelEpisode, fetch: PageFetch | undefined, offline: boolean): Promise<CachedPage> {
    const expected = kakuyomuEpisodeUrl(this.workUrl, episode.id);
    const ledger = await this.ledger();
    const known = ledger.episodes[episode.id];
    if (known) return { html: await this.verified(known, expected, html => requireEpisodeCanonical(html, expected)), record: known, cached: true, adopted: known.adopted === true };
    if (this.allowLegacy) {
      const legacyFile = `${String(episode.order).padStart(3, '0')}.html`;
      const existing = await this.disk.readBytes([legacyFile]);
      if (existing) {
        if (existing.byteLength > this.maximum) throw new Error('取得済み原本の容量が上限を超えています。');
        const html = decode(existing);
        requireEpisodeCanonical(html, expected);
        const record: SourceRecord = { schemaVersion: 1, kind: 'episode', workId: this.workId, workUrl: this.workUrl, episodeId: episode.id,
          url: expected, file: this.expectedFile('episode', episode.id), bytes: existing.byteLength, sha256: hash(existing), fetchedAt: this.now(), canonicalUrl: expected, adopted: true };
        await this.commit(record, existing);
        return { html, record, cached: true, adopted: true };
      }
    }
    if (offline) throw new Error(`取得済みデータがありません: 第${episode.order}話`);
    if (!fetch) throw new Error('取得処理が設定されていません。');
    const page = await fetch(expected, this.access);
    if (page.url !== expected) throw new Error('取得した話ページのURLが一致しません。');
    if (page.bytes.byteLength > this.maximum) throw new Error('公開ページの容量が上限を超えています。');
    const html = decode(page.bytes);
    requireEpisodeCanonical(html, expected);
    const record = this.fetchedRecord(page, 'episode', expected, episode.id);
    await this.commit(record, page.bytes);
    return { html, record, cached: false, adopted: false };
  }
}

export function openKakuyomuCache(root: string, workUrl: string, options: Omit<CacheOptions, 'disk' | 'workUrl' | 'workId'> = {}): KakuyomuCache {
  const url = kakuyomuWorkUrl(workUrl), workId = url.split('/').at(-1)!;
  return new KakuyomuCache({ ...options, disk: new LibraryDisk(root), workId, workUrl: url });
}
