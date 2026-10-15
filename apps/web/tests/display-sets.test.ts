import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, migrateReaderSettings, validReaderSettings, type TextBlock } from '../src/reader/model.ts';
import { displayFlow, displaySet, flowOffset, sourceSlices } from '../src/reader/display-flow.ts';
import { naturalBoundaries, planTextPage, silentSetSource } from '../src/reader/display-sets.ts';
import { audioDisplayPosition, audioReadingMarker, audioSetSeek, audioSetSource, audioSourceTargets } from '../src/reader/audio-display-session.ts';
import { importText } from '../src/reader/text-import.ts';
import { prepareDocument } from '../src/reader/segmentation.ts';
import { PlaybackController, type PlaybackScheduler } from '../src/reader/playback.ts';
import type { AudioSegment } from '../src/reader/audio-clock.ts';

test('v3 display settings migrate legacy amounts without changing clocks, anchors or full text choice', () => {
  const settings = migrateReaderSettings({ ...DEFAULT_SETTINGS, settingsVersion: 2, focusedDisplay: undefined, groupTarget: 24, groupMinimum: 8, cpm: 900, mode: 'guide', fontSize: 72 });
  assert.deepEqual(settings.focusedDisplay, { kind: 'phrase' });
  assert.equal(settings.mode, 'guide'); assert.equal(settings.cpm, 900); assert.equal(settings.fontSize, 72);
  assert.equal('groupTarget' in settings, false); assert.equal('groupMinimum' in settings, false);
  for (let lines = 2; lines <= 10; lines++) assert.equal(validReaderSettings(migrateReaderSettings({ ...settings, focusedDisplay: { kind: 'multiline', maxLines: lines } })), true);
  for (const maxLines of [1, 11, 2.5, '2', NaN]) assert.deepEqual(migrateReaderSettings({ focusedDisplay: { kind: 'multiline', maxLines } }).focusedDisplay, { kind: 'phrase' });
});

test('measured sets cover a long paragraph exactly once and keep ruby, words and UTF-16 graphemes intact', async () => {
  const document = await prepareDocument(importText('朝に<ruby>図書館<rt>としょかん</rt></ruby>を訪ね、👩‍💻の文章を読む。静かな窓辺で本を開き、次の章をゆっくり確かめる。', 'txt', 'set'));
  const block = document.blocks[0]; let start = 0; let output = ''; let count = 0;
  while (start < block.text.length) {
    const source = silentSetSource(document.blocks, document.units, { blockId: block.id, offset: start })!;
    const set = planTextPage(block, start, source.end, source.boundaries, range => ({ fits: range.end - range.start <= 12, lines: Math.ceil((range.end - range.start) / 6) }));
    assert.ok(set.end > start);
    for (const span of block.ruby) assert.ok(!(span.start < set.end && set.end < span.end));
    output += block.text.slice(start, set.end); start = set.end; count++;
  }
  assert.equal(output, block.text); assert.ok(count > 2);
  const url: TextBlock = { id: 'url', kind: 'paragraph', text: 'https://example.com/long/indivisible', ruby: [], runs: [] };
  assert.deepEqual(naturalBoundaries(url, 0, url.text.length), []);
  const wordPage = planTextPage(url, 0, url.text.length, [], range => ({ fits: range.end - range.start <= 8, lines: 2 }));
  assert.equal(wordPage.fits, true); assert.equal(wordPage.end, 8);
});

test('silent display amount preserves the timeline and source seek preserves playing intent and body/pause budget', async () => {
  const document = await prepareDocument(importText('国際情報通信技術研究開発機構の研究員です。次の段落も読みます。', 'txt', 'clock'));
  let now = 0; const scheduler: PlaybackScheduler = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
  const controller = new PlaybackController(DEFAULT_SETTINGS, scheduler); controller.load(document.units);
  const total = controller.getTimingSummary().totalMs;
  controller.updateSettings({ ...DEFAULT_SETTINGS, focusedDisplay: { kind: 'multiline', maxLines: 10 } });
  assert.equal(controller.getTimingSummary().totalMs, total);
  const unit = document.units[0]; const offset = unit.start + Math.floor((unit.end - unit.start) / 2);
  controller.seekSource({ blockId: unit.blockId, offset });
  assert.equal(controller.getSnapshot().status, 'paused'); assert.equal(controller.getSourcePosition()!.offset, offset);
  controller.play(); now += 10;
  controller.seekSource({ blockId: document.units[1].blockId, offset: document.units[1].start });
  assert.equal(controller.getSnapshot().status, 'playing'); assert.equal(controller.getSourcePosition()!.offset, document.units[1].start);
  assert.equal(controller.getTimingSummary().totalMs, total); controller.dispose();
});

test('audio set boundaries keep accepted shared cues whole, mark estimates distinctly and cannot jump a missing chunk', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number, estimatedReason?: string) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [], estimatedReason });
  const first: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 4, timeline: [] }, startSeconds: 0, endSeconds: 4, text: 'abcdefgh', cues: [cue(0, 4, 0, 2)], displayCues: [cue(0, 2, 0, 1), cue(2, 4, 1, 2), cue(4, 8, 2, 4)] };
  const later: AudioSegment = { chunk: { id: 'c', audioUrl: '/c', durationSeconds: 2, timeline: [] }, startSeconds: 4, endSeconds: 6, text: 'mnop', displayCues: [cue(12, 16, 0, 2)] };
  const targets = audioSourceTargets([first, later]);
  assert.deepEqual(targets.map(target => target.start), [0, 4, 12]);
  assert.equal(audioSetSeek(targets, { blockId: 'p', offset: 2 })?.seconds, 1);
  assert.equal(audioReadingMarker(first, 1.5)?.precision, 'spoken'); assert.equal(audioReadingMarker(first, 2.5)?.precision, 'estimated');
  first.displayCues[2].estimatedReason = 'silence-hold'; assert.equal(audioReadingMarker(first, 2.5), undefined);
  const block: TextBlock = { id: 'p', kind: 'paragraph', text: 'abcdefghijklmnop', ruby: [], runs: [] };
  assert.equal(audioSetSource([block], targets, new Set(['a']), { blockId: 'p', offset: 0 })?.next, undefined);
});

test('multiline audio cursor tolerates native microsecond truncation at cue and internal page boundaries', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefghij', displayCues: [cue(0, 5, 0, 1 / 3), cue(5, 10, 1 / 3, 1)] };
  const targets = audioSourceTargets([segment]);
  for (const offset of [2, 5, 7]) {
    const seconds = audioSetSeek(targets, { blockId: 'p', offset })!.seconds;
    const native = Math.floor(seconds * 1e6) / 1e6;
    assert.ok(audioDisplayPosition(segment, native)!.offset >= offset, `offset ${offset} must not remain on preceding page`);
  }
});

test('unbroken long-word planning measures a bounded source neighbourhood', () => {
  const block: TextBlock = { id: 'long', kind: 'paragraph', text: 'https://example.com/' + 'a'.repeat(100000), ruby: [], runs: [] };
  let maximum = 0;
  const set = planTextPage(block, 0, block.text.length, [], range => { maximum = Math.max(maximum, range.end - range.start); return { fits: range.end - range.start <= 32, lines: 2 }; });
  assert.ok(maximum <= 2048); assert.equal(set.end, 32);
});

test('display source cursor retains the active unit body budget when punctuation settings change', async () => {
  const document = await prepareDocument(importText('本を読む。', 'txt', 'pause'));
  let now = 0; const controller = new PlaybackController(DEFAULT_SETTINGS, { now: () => now, setTimeout: () => 0, clearTimeout: () => {} });
  controller.load(document.units, document.units.length - 1); controller.play(); now = 50;
  const before = controller.getSourcePosition();
  controller.updateSettings({ ...DEFAULT_SETTINGS, punctuationPause: false });
  assert.deepEqual(controller.getSourcePosition(), before); controller.dispose();
});


test('multiline flow joins adjacent paragraphs without losing canonical ranges or crossing static boundaries', async () => {
  const doc = await prepareDocument(importText('短い段落。\n\n次に<ruby>図書館<rt>としょかん</rt></ruby>へ。\n\n```js\nconst x = 1;\n```\n\n後の段落。', 'md', 'flow'));
  const source = (position: { blockId: string; offset: number }) => silentSetSource(doc.blocks, doc.units, position);
  const flow = displayFlow(source, { blockId: doc.blocks[0].id, offset: 0 })!;
  assert.equal(flow.spans.length, 2);
  assert.equal(flow.text, doc.blocks.slice(0, 2).map(block => block.text).join('\n'));
  const page = { start: 0, end: flow.text.length, fits: true, lines: 2 };
  const set = displaySet(flow, page);
  assert.deepEqual(set.ranges, doc.blocks.slice(0, 2).map(block => ({ blockId: block.id, start: 0, end: block.text.length })));
  assert.deepEqual(set.next, { blockId: doc.blocks[2].id, offset: 0 });
  const offset = flowOffset(flow, { blockId: doc.blocks[1].id, offset: 2 })!;
  const sliced = sourceSlices(flow, { start: offset, end: flow.text.length });
  assert.equal(sliced[0].text, doc.blocks[1].text.slice(2)); assert.equal(sliced[0].start, 2);
  assert.deepEqual(displaySet(flow, { ...page, end: flow.spans[0].to }).next, { blockId: doc.blocks[1].id, offset: 0 });
});

test('multiline source flow stays within a PDF page and stops before unavailable audio', async () => {
  const doc = await prepareDocument(importText('最初の段落。\n\n次の段落。', 'txt', 'pages'));
  for (const unit of doc.units) unit.sources = [{ kind: 'pdf', page: unit.blockId === doc.blocks[0].id ? 1 : 2, item: 0, start: 0, end: 1, rect: [0, 0, 1, 1] }];
  const flow = displayFlow(position => silentSetSource(doc.blocks, doc.units, position), { blockId: doc.blocks[0].id, offset: 0 })!;
  assert.equal(flow.spans.length, 1);
  const targets = doc.blocks.map((block, i) => ({ blockId: block.id, start: 0, end: block.text.length, seconds: i, endSeconds: i + 1, segmentId: String(i) }));
  const audio = displayFlow(position => audioSetSource(doc.blocks, targets, new Set(['0']), position), { blockId: doc.blocks[0].id, offset: 0 })!;
  assert.equal(audio.spans.length, 1); assert.equal(audio.next, undefined);
});


test('a restored cursor deep inside a long cue is contained in the bounded display flow', () => {
  const block: TextBlock = { id: 'deep', kind: 'paragraph', text: 'あいうえお'.repeat(20000), ruby: [], runs: [] };
  const flow = displayFlow(() => ({ block, start: 0, end: block.text.length, boundaries: [] }), { blockId: block.id, offset: 80000.5 })!;
  assert.equal(flowOffset(flow, { blockId: block.id, offset: 80000.5 }), .5);
  assert.ok(flow.text.length <= 2048);
});
