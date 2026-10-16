import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, migrateReaderSettings, validReaderSettings, type TextBlock } from '../src/reader/model.ts';
import { displayFlow, displaySet, flowOffset, previousDisplayFlow, sourceSlices } from '../src/reader/display-flow.ts';
import { naturalBoundaries, planPreviousTextPage, planTextPage, previousSetPosition, silentSetSource } from '../src/reader/display-sets.ts';
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
  for (const context of [true, false]) {
    const legacy = { ...settings, context };
    assert.equal(validReaderSettings(legacy), true);
    assert.deepEqual(migrateReaderSettings(legacy), settings);
    assert.equal('context' in migrateReaderSettings(legacy), false);
  }
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
  first.displayCues[2].estimatedReason = 'silence-hold'; assert.equal(audioReadingMarker(first, 2.5)?.precision, 'position');
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


test('audio marker holds the reading position across cue gaps and at boundaries without retiming cues', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  const a = cue(0, 4, .1, .4); const b = cue(4, 8, .5, .9);
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefgh', cues: [a, b], displayCues: [a, b] };
  for (let milliseconds = 0; milliseconds <= 1000; milliseconds++) assert.ok(audioReadingMarker(segment, milliseconds / 1000));
  assert.deepEqual(audioReadingMarker(segment, .45), { blockId: 'p', start: 0, end: 4, precision: 'position' });
  assert.equal(audioReadingMarker(segment, .5)?.start, 4); assert.equal(a.endSeconds, .4); assert.equal(b.startSeconds, .5);
});

test('multiline page cursor stays inside the spoken marker when the visual clock estimates a different interval', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  // Short accepted intervals may be replaced only in the phrase display clock.
  const spoken = [cue(0, 4, 0, .4), cue(4, 8, .4, .48), cue(8, 12, .48, 1)];
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefghijkl', cues: spoken,
    displayCues: [cue(0, 4, 0, .42), cue(4, 8, .42, .54), cue(8, 12, .54, 1)] };
  const before = JSON.stringify(segment);
  for (let milliseconds = 0; milliseconds < 1000; milliseconds++) {
    const time = milliseconds / 1000;
    const position = audioDisplayPosition(segment, time)!; const marker = audioReadingMarker(segment, time)!;
    assert.equal(position.blockId, marker.blockId);
    assert.ok(position.offset >= marker.start && position.offset < marker.end, `cursor ${position.offset} must overlap marker ${marker.start}..${marker.end} at ${time}`);
  }
  assert.equal(JSON.stringify(segment), before);
});

test('multiline source seeks round trip through short and shared spoken cues', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefghijkl',
    cues: [cue(0, 4, 0, .4), cue(4, 8, .4, .48), cue(8, 12, .48, 1)],
    displayCues: [cue(0, 4, 0, .42), cue(4, 8, .42, .54), cue(8, 12, .54, 1)] };
  const shared = { ...segment, cues: [cue(0, 8, 0, .8), cue(8, 12, .8, 1)] };
  for (const clock of [segment, shared]) {
    const targets = audioSourceTargets([clock]);
    for (let offset = 0; offset < 12; offset++) {
      const time = audioSetSeek(targets, { blockId: 'p', offset })!.seconds;
      const position = audioDisplayPosition(clock, Math.floor(time * 1e6) / 1e6)!;
      assert.equal(position.blockId, 'p');
      assert.ok(position.offset >= offset && position.offset - offset < .001, `offset ${offset} returned as ${position.offset}`);
    }
  }
});

test('multiline audio holds the end of a short spoken cue through silence without replaying its page', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefghijklmnopqrstuvwxyz12345',
    cues: [cue(0, 4, .1, .4), cue(4, 27, .4, .48), cue(27, 31, .7, .95)],
    displayCues: [cue(0, 4, 0, .4), cue(4, 27, .4, .7), cue(27, 31, .7, 1)] };
  let previous = 0;
  for (let milliseconds = 0; milliseconds <= 1000; milliseconds++) {
    const time = milliseconds / 1000;
    const position = audioDisplayPosition(segment, time)!; const marker = audioReadingMarker(segment, time)!;
    assert.ok(position.offset >= previous, `cursor went backwards at ${time}: ${previous} -> ${position.offset}`);
    assert.ok(position.offset >= marker.start && position.offset < marker.end);
    previous = position.offset;
  }
  assert.equal(audioReadingMarker(segment, .6)?.precision, 'position');
  assert.ok(audioDisplayPosition(segment, .6)!.offset > 26.99);
});

test('uncovered source estimates fit between speech cues without reordering text or retiming evidence', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  const spoken = [cue(0, 2, .5, .52), cue(5, 8, .9, .98)];
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefgh', cues: spoken,
    displayCues: [cue(0, 2, 0, .433), cue(2, 5, .433, .95), cue(5, 8, .95, 1)] };
  const before = JSON.stringify(segment);
  const targets = audioSourceTargets([segment]);
  assert.deepEqual(targets.map(cue => [cue.start, cue.end]), [[0, 2], [2, 5], [5, 8]]);
  assert.equal(targets[1].seconds, .52); assert.equal(targets[1].endSeconds, .9);
  let previous = 0;
  for (let milliseconds = 0; milliseconds <= 1000; milliseconds++) {
    const position = audioDisplayPosition(segment, milliseconds / 1000)!; const marker = audioReadingMarker(segment, milliseconds / 1000)!;
    assert.ok(position.offset >= previous); previous = position.offset;
    assert.ok(position.offset >= marker.start && position.offset < marker.end);
  }
  for (let offset = 0; offset < 8; offset++) {
    const seconds = audioSetSeek(targets, { blockId: 'p', offset })!.seconds;
    const actual = audioDisplayPosition(segment, Math.floor(seconds * 1e6) / 1e6)!;
    assert.ok(actual.offset >= offset && actual.offset - offset < .001);
  }
  assert.equal(JSON.stringify(segment), before);
});

test('uncovered text with no audio gap uses one estimated source clock instead of zero-duration pages', () => {
  const cue = (start: number, end: number, startSeconds: number, endSeconds: number) => ({ blockId: 'p', start, end, startSeconds, endSeconds, unitId: 'u', unitIds: ['u'], units: [], unitIndices: [] });
  const segment: AudioSegment = { chunk: { id: 'a', audioUrl: '/a', durationSeconds: 1, timeline: [] }, startSeconds: 0, endSeconds: 1, text: 'abcdefgh',
    cues: [cue(0, 2, 0, .4), cue(5, 8, .4, 1)], displayCues: [cue(0, 2, 0, .3), cue(2, 5, .3, .6), cue(5, 8, .6, 1)] };
  const before = JSON.stringify(segment); const targets = audioSourceTargets([segment]);
  assert.ok(targets.every(target => target.endSeconds > target.seconds));
  assert.equal(audioReadingMarker(segment, .5)?.precision, 'estimated');
  for (let offset = 0; offset < 8; offset++) {
    const seconds = audioSetSeek(targets, { blockId: 'p', offset })!.seconds;
    const actual = audioDisplayPosition(segment, Math.floor(seconds * 1e6) / 1e6)!;
    assert.ok(actual.offset >= offset && actual.offset - offset < .001);
  }
  assert.equal(JSON.stringify(segment), before);
});


test('backward sets end at the current start and preserve ruby and UTF-16 boundaries in restored windows', async () => {
  const document = await prepareDocument(importText('朝に図書館で読む。'.repeat(200) + '👩‍💻<ruby>図書館<rt>としょかん</rt></ruby>で読む。', 'txt', 'back'));
  const block = document.blocks[0];
  assert.equal(previousSetPosition(document.blocks, document.units, { blockId: block.id, offset: 0 }, anchor => silentSetSource(document.blocks, document.units, anchor)), undefined);
  const end = block.text.length;
  const anchor = previousSetPosition(document.blocks, document.units, { blockId: block.id, offset: end }, anchor => silentSetSource(document.blocks, document.units, anchor))!;
  assert.ok(anchor.offset > 0 && end - anchor.offset <= 1030);
  assert.ok(!block.ruby.some(span => span.start < anchor.offset && anchor.offset < span.end));
  const page = planPreviousTextPage(block, end, naturalBoundaries(block, Math.max(0, end - 100), end), range => ({ fits: range.end - range.start <= 18, lines: Math.ceil((range.end - range.start) / 9) }), 2);
  assert.equal(page.end, end); assert.ok(page.fits); assert.equal(page.lines, 2);
  assert.ok(!block.ruby.some(span => span.start < page.start && page.start < span.end));
  const unbroken = { text: '👩‍💻'.repeat(10), ruby: [] };
  const fallback = planPreviousTextPage(unbroken, unbroken.text.length, [], range => ({ fits: range.end - range.start <= 10, lines: Math.ceil((range.end - range.start) / 5) }), 2);
  assert.equal(unbroken.text.slice(fallback.start, fallback.end), '👩‍💻👩‍💻');
});

test('backward source windows use the preceding available paragraph and stop at source gaps', () => {
  const blocks: TextBlock[] = ['a', 'b'].map(id => ({ id, kind: 'paragraph', text: 'あ'.repeat(1500), ruby: [], runs: [] }));
  const ranges = [{ blockId: 'a', start: 0, end: 100 }, { blockId: 'a', start: 500, end: 1500 }, { blockId: 'b', start: 0, end: 10 }];
  assert.deepEqual(previousSetPosition(blocks, ranges, { blockId: 'b', offset: 0 }, () => ({ end: 1500 })), { blockId: 'a', offset: 500 });
  assert.deepEqual(previousSetPosition(blocks, ranges, { blockId: 'a', offset: 520 }, () => ({ end: 1500 })), { blockId: 'a', offset: 500 });
});


test('backward windows respect hard PDF boundaries inside an otherwise contiguous source block', () => {
  const block: TextBlock = { id: 'pdf', kind: 'paragraph', text: 'あ'.repeat(200), ruby: [], runs: [] };
  const units = Array.from({ length: 4 }, (_, i) => ({ id: `u${i}`, blockId: block.id, kind: 'text' as const, text: block.text.slice(i * 50, (i + 1) * 50), start: i * 50, end: (i + 1) * 50, ruby: [], mapping: 'exact' as const, characters: 50, cumulativeCharacters: (i + 1) * 50, pause: 'none' as const, sources: [{ kind: 'pdf' as const, page: Math.floor(i / 2) + 1, item: 0, start: 0, end: 50, rect: [0, 0, 50, 10] as [number, number, number, number] }] }));
  const source = (anchor: { blockId: string; offset: number }) => silentSetSource([block], units, anchor);
  assert.deepEqual(previousSetPosition([block], units, { blockId: block.id, offset: 150 }, source), { blockId: block.id, offset: 100 });
  assert.deepEqual(previousSetPosition([block], units, { blockId: block.id, offset: 100 }, source), { blockId: block.id, offset: 0 });
});


test('backward sets can fill the requested rows across adjacent short paragraphs', async () => {
  const document = await prepareDocument(importText('朝の文章。\n\n次の文章。\n\n最後の文章。', 'txt', 'back across paragraphs'));
  const source = (anchor: { blockId: string; offset: number }) => silentSetSource(document.blocks, document.units, anchor);
  const current = { blockId: document.blocks[2].id, offset: 0 };
  const before = previousSetPosition(document.blocks, document.units, current, source)!;
  assert.deepEqual(before, { blockId: document.blocks[0].id, offset: 0 });
  const flow = displayFlow(source, before)!;
  const end = flowOffset(flow, current)!;
  const page = planPreviousTextPage(flow, end, flow.boundaries, range => ({ fits: range.end - range.start <= 20, lines: range.end - range.start > 6 ? 2 : 1 }), 2);
  const slices = sourceSlices(flow, page);
  assert.deepEqual(slices.map(slice => slice.blockId), document.blocks.slice(0, 2).map(block => block.id));
  assert.equal(displaySet(flow, page).next?.blockId, current.blockId);
});


test('many tiny paragraphs keep the backward window within the forward flow limit', async () => {
  const document = await prepareDocument(importText(Array.from({ length: 100 }, () => '文。').join('\n\n'), 'txt', 'bounded back'));
  const source = (anchor: { blockId: string; offset: number }) => silentSetSource(document.blocks, document.units, anchor);
  const current = { blockId: document.blocks.at(-1)!.id, offset: 0 };
  const before = previousSetPosition(document.blocks, document.units, current, source)!;
  const flow = displayFlow(source, before)!;
  assert.equal(flow.spans.length, 64);
  assert.deepEqual(flow.next, current);
});


test('backward flow reaches the immediate preceding text after an oversized atomic ruby', () => {
  const blocks: TextBlock[] = [{ id: 'a', kind: 'paragraph', text: 'あ'.repeat(3100), ruby: [{ start: 0, end: 3000, reading: 'ながいるび' }], runs: [] }, ...['b', 'c'].map(id => ({ id, kind: 'paragraph' as const, text: '文'.repeat(100), ruby: [], runs: [] }))];
  const source = (anchor: { blockId: string; offset: number }) => {
    const index = blocks.findIndex(block => block.id === anchor.blockId); const block = blocks[index];
    return { block, start: 0, end: block.text.length, boundaries: [], joinsNext: true, next: blocks[index + 1] && { blockId: blocks[index + 1].id, offset: 0 } };
  };
  for (const end of [{ blockId: 'c', offset: 0 }, { blockId: 'a', offset: 3090 }]) {
    const flow = previousDisplayFlow(source, { blockId: 'a', offset: 0 }, end)!;
    assert.equal(flow.spans[0].start, 3000);
    const finish = flowOffset(flow, end)!;
    const slices = sourceSlices(flow, { start: 0, end: finish });
    assert.equal(slices[0].start, 3000);
    assert.equal(slices.at(-1)!.end, end.blockId === 'a' ? 3090 : 100);
    if (end.blockId === 'c') assert.equal(slices.at(-1)!.blockId, 'b');
  }
  const rubyOnly = previousDisplayFlow(source, { blockId: 'a', offset: 0 }, { blockId: 'a', offset: 3000 })!;
  assert.deepEqual(rubyOnly.next, { blockId: 'a', offset: 3000 });
});
