export const READING_FONTS = {
  system: { label: '端末標準', family: "'Yu Mincho', 'Hiragino Mincho ProN', serif", face: '' },
  'noto-sans-jp': { label: 'Noto Sans JP', family: "'Noto Sans JP', sans-serif", face: 'Noto Sans JP' },
  'noto-serif-jp': { label: 'Noto Serif JP', family: "'Noto Serif JP', serif", face: 'Noto Serif JP' },
  'biz-udpgothic': { label: 'BIZ UDPGothic', family: "'BIZ UDPGothic', sans-serif", face: 'BIZ UDPGothic' },
} as const;
export type ReadingFontId = keyof typeof READING_FONTS;
export function isReadingFont(value: unknown): value is ReadingFontId { return typeof value === 'string' && Object.hasOwn(READING_FONTS, value); }
const css = {
  'noto-sans-jp': () => import('@fontsource/noto-sans-jp/400.css'),
  'noto-serif-jp': () => import('@fontsource/noto-serif-jp/400.css'),
  'biz-udpgothic': () => import('@fontsource/biz-udpgothic/400.css'),
};

/** No manuscript enters a URL: FontFaceSet chooses same-origin bundled unicode ranges. */
export async function loadReadingFont(id: ReadingFontId, text: string): Promise<void> {
  if (id === 'system') return;
  await css[id]();
  const face = READING_FONTS[id].face;
  // Deduplicate by grapheme to bound loading work without dropping manuscript/ruby glyphs.
  const characters = [...new Set(Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text), value => value.segment))].join('');
  const loaded = await document.fonts.load(`400 24px "${face}"`, characters || 'あ');
  if (!loaded.length || loaded.some(font => font.status !== 'loaded' || font.family.replace(/["']/g, '') !== face)) throw new Error('font-load');
}
