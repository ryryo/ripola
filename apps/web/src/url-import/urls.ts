import { kakuyomuWorkUrlInput } from '../kakuyomu/contracts';

export const SUPPORTED_URLS = '対応URL：カクヨムの作品トップ、青空文庫の図書カード・本文HTML、noteの無料記事';
export const UNSUPPORTED_URL = 'カクヨムの作品トップ、青空文庫の図書カード・本文HTML、noteの記事のURLを入力してください。';
export interface AozoraUrl { kind: 'aozora'; url: string; cardUrl: string; authorId: string; workId: string }
export interface NoteUrl { kind: 'note'; url: string; author: string; key: string }

export function noteUrlInput(input: string): NoteUrl | undefined {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return undefined; }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'note.com' || url.port || url.username || url.password) return undefined;
  const match = /^\/([A-Za-z0-9_]{1,64})\/n\/(n[a-f0-9]{12})\/?$/.exec(url.pathname);
  if (!match) return undefined;
  return { kind: 'note', url: `https://note.com/${match[1]}/n/${match[2]}`, author: match[1], key: match[2] };
}

/** Normalize only official work paths. No arbitrary URL, query, port or credentials reaches the server. */
export function aozoraUrlInput(input: string): AozoraUrl | undefined {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || !['www.aozora.gr.jp', 'aozora.gr.jp'].includes(url.hostname)
    || url.port || url.username || url.password || url.search) return undefined;
  const card = /^\/cards\/(\d{6})\/card(\d{1,9})\.html$/.exec(url.pathname);
  const file = /^\/cards\/(\d{6})\/files\/(\d{1,9})(?:_\d+)*\.html$/.exec(url.pathname);
  const match = card ?? file;
  if (!match) return undefined;
  url.protocol = 'https:'; url.hostname = 'www.aozora.gr.jp'; url.hash = '';
  const [, authorId, workId] = match;
  return { kind: 'aozora', url: url.href, cardUrl: `https://www.aozora.gr.jp/cards/${authorId}/card${workId}.html`, authorId, workId };
}

export function supportedUrlInput(input: string): { kind: 'kakuyomu'; url: string } | AozoraUrl | NoteUrl | undefined {
  const kakuyomu = kakuyomuWorkUrlInput(input);
  return kakuyomu ? { kind: 'kakuyomu', url: kakuyomu } : aozoraUrlInput(input) ?? noteUrlInput(input);
}
