import type { ReadingDocument } from './model';

export type InputFormat = 'auto' | 'md' | 'txt';
export const FORMAT_NAMES: Record<ReadingDocument['format'], string> = { md: 'Markdown', txt: 'テキスト', pdf: 'PDF', aozora: '青空文庫HTML' };

/** Conservative hints, not a grammar validator. A manual choice always wins. */
export function detectTextFormat(text: string): 'md' | 'txt' {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^ {0,3}(?:#{1,6}\s+\S|`{3,}|~{3,}|>\s+\S|[-+*]\s+\S|\d{1,9}[.)]\s+\S)/.test(line)
      || /^\|?(?: *:?-{3,}:? *\|)+ *:?-{3,}:? *\|?$/.test(trimmed)
      || /<ruby(?:\s[^>]*)?>/i.test(line)
      || /!?\[[^\]\n]{1,500}\]\([^\s)]+(?:\s+"[^"\n]{0,500}")?\)/.test(line)
      || /(?:\*\*[^*\n]{1,500}\*\*|__[^_\n]{1,500}__|`[^`\n]{1,500}`)/.test(line)) return 'md';
  }
  return 'txt';
}

export function resolveInputFormat(text: string, choice: InputFormat): 'md' | 'txt' {
  return choice === 'auto' ? detectTextFormat(text) : choice;
}
