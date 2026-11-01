import { createServerFn } from '@tanstack/react-start';
import { importSingleUrl } from './service.server';
import { supportedUrlInput } from './urls';

export const importUrlBook = createServerFn({ method: 'POST' }).validator((data: { url: string }) => {
  if (!data || typeof data.url !== 'string' || data.url.length > 2048) throw new Error('記事・作品のURLを入力してください。');
  const source = supportedUrlInput(data.url);
  if (source?.kind !== 'aozora' && source?.kind !== 'note') throw new Error('このURLは取り込みに対応していません。');
  return { url: data.url };
}).handler(async ({ data }) => importSingleUrl(data.url));
