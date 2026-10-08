import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { boundariesFor, prepareDocument, SEGMENTATION_VERSIONS } from '../apps/web/src/reader/segmentation';
import { importText } from '../apps/web/src/reader/text-import';
import type { DraftDocument } from '../apps/web/src/reader/model';

// An observation report, not a grammatical gold set or an exact-match test.
const root = new URL('../', import.meta.url);
const { jaModel, Parser } = createRequire(new URL('apps/web/package.json', root))('budoux');
const fixture = JSON.parse(await readFile(new URL('docs/validation/fixtures/segmentation-cases.json', root), 'utf8')) as {
  cases: Array<{ id: string; input: string; preferredChunks: string[]; acceptedAlternatives?: string[][] }>
};
const sample = (JSON.parse(await readFile(new URL('apps/web/public/samples/wagahai.json', root), 'utf8')) as { draft: DraftDocument }).draft;
const parser = new Parser(jaModel);
const examples = fixture.cases.map(example => ({ ...example, draft: importText(example.input, 'md', example.id) }));
examples.push({ id: 'tomimatsu-1999-example', input: 'けさ朝顔が咲きました。', preferredChunks: ['けさ', '朝顔が', '咲きました。'],
  draft: importText('けさ朝顔が咲きました。', 'txt', '研究の短い例') });
const rubyProbe = '<ruby>非常に長い名称<rt>ひじょうにながいめいしょう</rt></ruby>を読む。';
examples.push({ id: 'long-ruby-protection-probe', input: rubyProbe, preferredChunks: [],
  draft: importText(rubyProbe, 'md', '保護境界の診断用自作例') });
const openingText = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。';
const opening = sample.blocks.find(block => block.text.startsWith('吾輩'))!;
examples.push({ id: 'aozora-opening-three', input: openingText, preferredChunks: [],
  draft: { ...sample, blocks: [{ ...opening, text: openingText, ruby: opening.ruby.filter(span => span.end <= openingText.length),
    runs: opening.runs.filter(run => run.end <= openingText.length) }] } });
const observations = [];
for (const example of examples) {
  const document = await prepareDocument(example.draft);
  const blocks = example.draft.blocks.map(block => {
    const rawCuts = [0, ...(parser.parseBoundaries(block.text) as number[]).filter(cut => cut > 0 && cut < block.text.length), block.text.length];
    const protectedCuts = boundariesFor(block);
    const graphemeCuts = new Set([0, block.text.length, ...[...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(block.text)].map(part => part.index)]);
    return { text: block.text, ruby: block.ruby, rawCuts, protectedCuts,
      rawChunks: rawCuts.slice(0, -1).map((cut, index) => block.text.slice(cut, rawCuts[index + 1])),
      protectedChunks: protectedCuts.slice(0, -1).map((cut, index) => block.text.slice(cut, protectedCuts[index + 1])),
      removedCuts: rawCuts.filter(cut => !protectedCuts.includes(cut)).map(cut => ({ utf16Offset: cut,
        context: `${block.text.slice(Math.max(0, cut - 12), cut)}｜${block.text.slice(cut, cut + 12)}`,
        insideRuby: block.ruby.some(span => span.start < cut && cut < span.end), insideGrapheme: !graphemeCuts.has(cut) })) };
  });
  const actual = document.units.map(unit => unit.text);
  observations.push({ id: example.id, input: example.input, blocks, actualChunks: actual,
    preferredChunks: example.preferredChunks, ...(example.acceptedAlternatives ? { acceptedAlternatives: example.acceptedAlternatives } : {}),
    matchesPreferred: example.preferredChunks.length ? JSON.stringify(actual) === JSON.stringify(example.preferredChunks) : null,
    matchesAcceptedAlternative: example.acceptedAlternatives?.some(chunks => JSON.stringify(actual) === JSON.stringify(chunks)) ?? null,
    bodyReconstruction: actual.join('') === blocks.map(block => block.text).join('') });
}
const output = { observedAt: '2026-10-06', versions: SEGMENTATION_VERSIONS,
  scope: '8 authored fixtures, one cited short research example with sentence punctuation added, Aozora opening three sentences, one authored long-ruby diagnostic',
  policy: 'observed boundaries only; preferredChunks are design examples, not grammatical gold labels or test assertions', observations };
await writeFile(new URL('docs/validation/segmentation-observed.json', root), `${JSON.stringify(output, null, 2)}\n`);
console.log(observations.map(item => ({ id: item.id, raw: item.blocks.flatMap(block => block.rawChunks), protected: item.actualChunks,
  removed: item.blocks.flatMap(block => block.removedCuts), matchesPreferred: item.matchesPreferred, reconstruction: item.bodyReconstruction })));
