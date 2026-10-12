export function foldedCharacters(text: string): Array<{ text: string; start: number; end: number }> {
  const result = [];
  for (const part of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)) {
    for (let character of part.segment.normalize('NFKC').toLowerCase()) {
      if (/^[\p{White_Space}\p{Punctuation}\p{Symbol}]$/u.test(character) && !'%‰°¥$€£&'.includes(character)
        && !( /[.:~〜−/-]/u.test(character) && /\d/u.test(text[part.index - 1] ?? '') && /\d/u.test(text[part.index + part.segment.length] ?? '') )) continue;
      if (character >= 'ァ' && character <= 'ヶ') character = String.fromCodePoint(character.codePointAt(0)! - 0x60);
      result.push({ text: character, start: part.index, end: part.index + part.segment.length });
    }
  }
  return result;
}
