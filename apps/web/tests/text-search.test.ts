import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReadingUnit, TextBlock } from '../src/reader/model.ts';
import { firstMatchAtOrAfter, searchText } from '../src/reader/text-search.ts';

function unit(blockId: string, text: string, start: number, index: number): ReadingUnit {
  return {
    id: `${blockId}:${start}`, blockId, kind: 'text', start, end: start + text.length, text,
    sources: [{ kind: 'text', start, end: start + text.length }], mapping: 'exact', ruby: [],
    characters: text.length, cumulativeCharacters: index, pause: 'none',
  };
}

function block(id: string, text: string, ruby: TextBlock['ruby'] = []): TextBlock {
  return { id, kind: 'paragraph', text, runs: [{ start: 0, end: text.length, sources: [{ kind: 'text', start: 0, end: text.length }], mapping: 'exact' }], ruby };
}

const blocks: TextBlock[] = [
  block('a', '最初の段落です。検索語と検索語。'),
  block('b', '次の段落にも検索語があります。'),
];
const units: ReadingUnit[] = [
  unit('a', '最初の段落です。', 0, 0),
  unit('a', '検索語と', 8, 1),
  unit('a', '検索語。', 12, 2),
  unit('b', '次の段落にも', 0, 3),
  unit('b', '検索語があります。', 6, 4),
];

test('same phrase occurrences are counted separately and keep source offsets', () => {
  const matches = searchText(blocks, units, '検索語');
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(match => [match.blockId, match.start, match.end, match.unitIndex]), [
    ['a', 8, 11, 1], ['a', 12, 15, 2], ['b', 6, 9, 4],
  ]);
  assert.equal(new Set(matches.map(match => match.id)).size, matches.length);
});

test('matches may cross a phrase boundary but never a paragraph boundary', () => {
  const crossing = searchText(blocks, units, '語と検');
  assert.equal(crossing.length, 1);
  assert.equal(crossing[0].unitIndex, 1);
  assert.equal(crossing[0].start, 10);
  assert.deepEqual(searchText([block('a', '終わり'), block('b', '始まり')], [unit('a', '終わり', 0, 0), unit('b', '始まり', 0, 1)], 'り始'), []);
});

test('latin matching ignores case and keeps the original offsets', () => {
  const mixed = [block('c', 'Alpha BETA alpha')];
  const values = [unit('c', 'Alpha BETA alpha', 0, 0)];
  const matches = searchText(mixed, values, 'aLpHa');
  assert.deepEqual(matches.map(match => match.start), [0, 11]);
  assert.deepEqual(matches.map(match => match.end), [5, 16]);
});

test('ruby readings are not searchable; the base text is', () => {
  const base = [block('d', '図書館へ行く', [{ start: 0, end: 3, reading: 'としょかん' }])];
  const values = [unit('d', '図書館へ行く', 0, 0)];
  assert.equal(searchText(base, values, 'としょかん').length, 0);
  assert.equal(searchText(base, values, '図書館').length, 1);
});

test('empty or whitespace-only input is the unsearched state; earlier phrases are found before later ones', () => {
  assert.deepEqual(searchText(blocks, units, ''), []);
  assert.deepEqual(searchText(blocks, units, '   '), []);
  const matches = searchText(blocks, units, '検索語');
  assert.equal(firstMatchAtOrAfter(matches, 4)?.blockId, 'b');
  assert.equal(firstMatchAtOrAfter(matches, 99)?.blockId, 'a');
});
