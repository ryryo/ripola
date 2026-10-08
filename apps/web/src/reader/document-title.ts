export const MAX_TITLE_LENGTH = 120;

/** Local civil time, not UTC, filenames or an identifier. */
export function automaticDocumentTitle(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function resolveDocumentTitle(value: string, date = new Date()): string {
  if (typeof value !== 'string' || value.length > MAX_TITLE_LENGTH) throw new Error('タイトルは120文字以内にしてください。');
  const trimmed = value.trim();
  if (!trimmed) return automaticDocumentTitle(date);
  if (Array.from(trimmed).some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)) throw new Error('タイトルに改行や制御文字は使えません。');
  return trimmed;
}
