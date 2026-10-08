import { MAX_TEXT_LENGTH } from './model';
import { MAX_TITLE_LENGTH } from './document-title';
import type { InputFormat } from './input-format';

/** Public-domain excerpt already present in the bundled Aozora sample. Never saved automatically. */
export const PAGES_DEMO = {
  title: '吾輩は猫である・冒頭',
  text: '<ruby>吾輩<rt>わがはい</rt></ruby>は猫である。名前はまだ無い。\n\nどこで生れたかとんと<ruby>見当<rt>けんとう</rt></ruby>がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。',
  sourceUrl: 'https://www.aozora.gr.jp/cards/000148/files/789_14547.html',
} as const;

export interface ReadingDraft { title: string; text: string; format: InputFormat }

/** Only the current Pages history entry can restore an edited form, including a deliberately empty one. */
export function initialReadingDraft(profile: string | undefined, historyState?: unknown): ReadingDraft {
  if (profile !== 'pages') return { title: '', text: '', format: 'auto' };
  const draft = typeof historyState === 'object' && historyState !== null
    ? (historyState as { ripolaPagesDraft?: unknown }).ripolaPagesDraft : undefined;
  if (typeof draft === 'object' && draft !== null) {
    const value = draft as Partial<ReadingDraft>;
    if (typeof value.title === 'string' && value.title.length <= MAX_TITLE_LENGTH
      && typeof value.text === 'string' && value.text.length <= MAX_TEXT_LENGTH
      && ['auto', 'md', 'txt'].includes(value.format ?? '')) {
      return { title: value.title, text: value.text, format: value.format! };
    }
  }
  return { title: PAGES_DEMO.title, text: PAGES_DEMO.text, format: 'auto' };
}
