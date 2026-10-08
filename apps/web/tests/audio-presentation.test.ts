import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { importText } from '../src/reader/text-import.ts';
import { audioDisplayAt, audioPhraseTargets, audioSegments, type PlayableAudioBook } from '../src/reader/audio-clock.ts';
import { inspectAudioPresentation, requireAudioPresentation } from '../src/reader/audio-presentation.ts';
import type { ReadingDocument } from '../src/reader/model.ts';

function bookFor(document: ReadingDocument): PlayableAudioBook {
  const chunks = document.blocks.filter(block => !['code', 'table'].includes(block.kind)).flatMap(block => [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(block.text)].filter(sentence => sentence.segment.trim()).map(sentence => ({
    id: `${block.id}-${sentence.index}`, audioUrl: '/fixture.wav', durationSeconds: Math.max(3, sentence.segment.length / 3),
    timeline: [{ blockId: block.id, start: sentence.index, end: sentence.index + sentence.segment.length,
      unitIds: document.units.filter(unit => unit.blockId === block.id && unit.start < sentence.index + sentence.segment.length && unit.end > sentence.index).map(unit => unit.id) }],
  })));
  return { id: 'self-authored', revision: 'test', title: document.title, document, chunks, warnings: [], completedChunks: chunks.length, totalChunks: chunks.length };
}
for (const [name, text, format] of [
  ['no alignment', '小鳥が窓辺で朝の光を待っています。', 'txt'],
  ['partial gap', '私は静かな図書館で一冊の本を開きます。', 'txt'],
  ['low confidence', '子どもが庭で小さな花を見つけました。', 'txt'],
  ['ruby', '<ruby>東京<rt>とうきょう</rt></ruby>の図書館でゆっくり本を読みます。', 'md'],
  ['long sentence', 'ゆっくり歩いて景色を眺めながら、'.repeat(80) + '私は家へ帰りました。', 'txt'],
  ['natural single phrase', 'はい。', 'txt'],
] as const) {
  test(`all source phrases are covered independently of demo IDs: ${name}`, async () => {
    const document = await prepareDocument(importText(text, format, name)); const book = bookFor(document);
    if (name === 'partial gap' || name === 'low confidence') {
      const unit = document.units[0];
      book.chunks[0].alignment = { precision: 'phrase', method: 'forced-alignment', status: 'partial', score: .9,
        cues: [{ unitId: unit.id, unitIds: [unit.id], blockId: unit.blockId, start: unit.start, end: unit.end, startSeconds: .3, endSeconds: 1.2, score: name === 'low confidence' ? .2 : .9 }] };
    }
    const snapshot = JSON.stringify(book); const report = requireAudioPresentation(book); const segments = audioSegments(book);
    assert.equal(report.status, 'valid'); assert.equal(report.displayedUnits, report.expectedUnits);
    assert.deepEqual(report.missingUnitIds, []); assert.deepEqual(report.duplicateUnitIds, []);
    assert.ok(report.estimatedUnits > 0); assert.equal(JSON.stringify(book), snapshot);
    if (name === 'low confidence') assert.equal(report.chunks[0].rejectedAcousticCues, 1);
    if (name === 'natural single phrase') assert.equal(report.expectedUnits, 1);
    if (name === 'long sentence') assert.ok(report.expectedUnits > 100);
    for (const segment of segments) {
      assert.equal(segment.displayCues!.map(cue => cue.units[0].text).join(''), segment.text);
      for (const cue of segment.displayCues!) {
        const display = audioDisplayAt(segment, (cue.startSeconds + cue.endSeconds) / 2);
        assert.equal(display.units.length, 1); assert.equal(display.units[0].id, cue.unitId);
        assert.equal(document.blocks.find(block => block.id === display.units[0].blockId)!.text.slice(display.units[0].start, display.units[0].end), display.text);
        if (display.method === 'estimated') assert.equal(display.score, undefined);
      }
      assert.equal(audioDisplayAt(segment, segment.chunk.durationSeconds).text, segment.displayCues!.at(-1)!.units[0].text);
    }
    assert.equal(audioPhraseTargets(segments).length, report.expectedUnits);
  });
}

test('old units crossing audio sentences are split in a source-preserving visual copy', async () => {
  const document = await prepareDocument(importText('日差しの中で本を開いた。次の頁をゆっくり読んだ。\n'.repeat(3), 'txt', '旧保存の境界'));
  const book = bookFor(document); const before = JSON.stringify(book);
  const report = requireAudioPresentation(book);
  assert.ok(report.splitSourceUnits > 0); assert.equal(report.status, 'valid');
  assert.equal(JSON.stringify(book), before);
  assert.ok(audioPhraseTargets(audioSegments(book)).some(target => target.cue.unitId.includes('@')));
  assert.deepEqual(report.missingUnitIds, []);
});

test('missing, corrupt or reordered source data is not a normal sentence player', async () => {
  const book = bookFor(await prepareDocument(importText('私は窓辺で本を読みます。次の頁を開きます。', 'txt', '異常検出')));
  for (const mutate of [
    (b: PlayableAudioBook) => { delete b.document.units; },
    (b: PlayableAudioBook) => { b.document.units!.pop(); },
    (b: PlayableAudioBook) => { const block = b.document.blocks[0]; const first = b.document.units![0]; b.document.units = [{ ...first, start: 0, end: block.text.length, text: block.text, ruby: block.ruby }]; b.chunks = [{ ...b.chunks[0], timeline: [{ blockId: block.id, start: 0, end: block.text.length, unitIds: [first.id] }] }]; b.completedChunks = b.totalChunks = 1; },
    (b: PlayableAudioBook) => { b.document.units!.reverse(); },
    (b: PlayableAudioBook) => { b.document.units![1].id = b.document.units![0].id; },
    (b: PlayableAudioBook) => { b.chunks[0].durationSeconds = NaN; },
    (b: PlayableAudioBook) => { b.chunks[0].timeline[0].end = 99999; },
    (b: PlayableAudioBook) => { b.chunks[0].timeline[0].unitIds = []; },
  ]) {
    const changed = structuredClone(book); mutate(changed);
    assert.notEqual(inspectAudioPresentation(changed).status, 'valid');
    assert.throws(() => requireAudioPresentation(changed), /検査に失敗/);
  }
  const noUnits = structuredClone(book); delete noUnits.document.units;
  assert.equal(inspectAudioPresentation(noUnits).status, 'unverifiable');
  const segment = audioSegments(book)[0]; segment.displayCues = []; segment.cues = [];
  assert.equal(audioDisplayAt(segment, 1).precision, 'unavailable'); assert.equal(audioDisplayAt(segment, 1).text, '');
});

test('coverage inspection detects broken display order, duplicate/missing units and fake timing scores', async () => {
  const book = bookFor(await prepareDocument(importText('私は静かな図書館で本を読みます。', 'txt', '表示計画の異常')));
  for (const mutate of [
    (s: ReturnType<typeof audioSegments>) => { s[0].displayCues!.pop(); },
    (s: ReturnType<typeof audioSegments>) => { s[0].displayCues!.reverse(); },
    (s: ReturnType<typeof audioSegments>) => { s[0].displayCues!.push(s[0].displayCues![0]); },
    (s: ReturnType<typeof audioSegments>) => { s[0].displayCues![0].endSeconds = s[0].displayCues![0].startSeconds; },
    (s: ReturnType<typeof audioSegments>) => { s[0].displayCues![0].score = .99; },
  ]) { const segments = audioSegments(book); mutate(segments); assert.equal(inspectAudioPresentation(book, segments).status, 'invalid'); }
  const report = requireAudioPresentation(book);
  assert.throws(() => requireAudioPresentation(book, true), /検査記録/);
  assert.throws(() => requireAudioPresentation({ ...book, presentation: { ...report, displayedUnits: 0 } }), /検査記録/);
});
