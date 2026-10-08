import { audioSegments, type AudioSegment, type PlayableAudioBook } from './audio-clock';
import { boundariesFor, SEGMENTATION_VERSIONS } from './segmentation';
import { audioSourceUnits, unitsInAudioRange } from './audio-units';
import type { ReadingUnit } from './model';

export interface PresentationIssue { code: string; chunkId?: string; unitId?: string }
export interface ChunkPresentationReport {
  chunkId: string;
  expectedUnitIds: string[];
  displayedUnitIds: string[];
  missingUnitIds: string[];
  duplicateUnitIds: string[];
  outOfOrder: boolean;
  forcedAlignmentUnits: number;
  voicevoxUnits: number;
  estimatedUnits: number;
  acousticEstimatedUnits?: number;
  rejectedAcousticCues: number;
  issues: PresentationIssue[];
}
/** Visual coverage, not a claim about measured acoustic boundary accuracy. */
export interface AudioPresentationReport {
  schemaVersion: 1;
  policy: 'all-source-phrases-v1';
  status: 'valid' | 'invalid' | 'unverifiable';
  sourceBoundaryCheck: 'model-recomputed' | 'stored-positions';
  splitSourceUnits: number;
  expectedUnits: number;
  displayedUnits: number;
  forcedAlignmentUnits: number;
  voicevoxUnits: number;
  estimatedUnits: number;
  acousticEstimatedUnits?: number;
  missingUnitIds: string[];
  duplicateUnitIds: string[];
  chunks: ChunkPresentationReport[];
  issues: PresentationIssue[];
}

export function inspectAudioPresentation(book: PlayableAudioBook, suppliedSegments?: AudioSegment[]): AudioPresentationReport {
  const report: AudioPresentationReport = { schemaVersion: 1, policy: 'all-source-phrases-v1', status: 'invalid', sourceBoundaryCheck: 'stored-positions', splitSourceUnits: 0, expectedUnits: 0,
    displayedUnits: 0, forcedAlignmentUnits: 0, voicevoxUnits: 0, estimatedUnits: 0, missingUnitIds: [], duplicateUnitIds: [], chunks: [], issues: [] };
  const issue = (code: string) => report.issues.push({ code });
  if (!book?.document || !Array.isArray(book.document.blocks) || !Array.isArray(book.chunks)) { issue('malformed-book'); return report; }
  if (!Array.isArray(book.document.units) || !book.document.units.length) { report.status = 'unverifiable'; issue('missing-source-units'); return report; }
  const blocks = new Map(book.document.blocks.map(block => [block?.id, block]));
  const blockOrder = new Map(book.document.blocks.map((block, index) => [block?.id, index]));
  if (blocks.size !== book.document.blocks.length || book.document.blocks.some(block => !block || typeof block.id !== 'string' || typeof block.text !== 'string' || !Array.isArray(block.ruby))) issue('invalid-source-blocks');
  const original = book.document.units;
  if (report.issues.length) return report;
  const source = original;
  const ids = new Set<string>();
  const byBlock = new Map<string, ReadingUnit[]>();
  for (const unit of source) {
    if (!unit || typeof unit.id !== 'string' || ids.has(unit.id) || !blocks.has(unit.blockId)
      || !Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end) || unit.start < 0 || unit.end <= unit.start || unit.end > blocks.get(unit.blockId)!.text.length
      || blocks.get(unit.blockId)?.text.slice(unit.start, unit.end) !== unit.text || !Array.isArray(unit.ruby) || !Array.isArray(unit.sources)) { issue('invalid-source-unit'); continue; }
    ids.add(unit.id);
    const values = byBlock.get(unit.blockId) ?? []; values.push(unit); byBlock.set(unit.blockId, values);
  }
  let previousOrder = -1; let previousEnd = -1;
  for (const unit of source) {
    const order = blockOrder.get(unit.blockId)!;
    if (order < previousOrder || order === previousOrder && unit.start < previousEnd) issue('source-unit-order-or-overlap');
    previousOrder = order; previousEnd = unit.end;
  }
  // Sort a separate expected view by original positions; the stored/display order is independently checked.
  for (const values of byBlock.values()) values.sort((a, b) => a.start - b.start);
  if (report.issues.length) return report;
  if (book.chunks.some(chunk => !chunk || !Array.isArray(chunk.timeline) || chunk.timeline.some(mark => !mark || !blocks.has(mark.blockId) || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.end > blocks.get(mark.blockId)!.text.length))) { issue('invalid-timeline'); return report; }
  if (typeof Intl.Segmenter !== 'function') { report.status = 'unverifiable'; issue('grapheme-segmentation-unavailable'); return report; }
  const versions = book.document.versions;
  if (versions?.parser === SEGMENTATION_VERSIONS.parser && versions.rules === SEGMENTATION_VERSIONS.rules && typeof versions.model === 'string' && versions.model.startsWith(SEGMENTATION_VERSIONS.model + ':sha256-')) {
    report.sourceBoundaryCheck = 'model-recomputed';
    for (const blockId of new Set(book.chunks.flatMap(chunk => chunk.timeline.map(mark => mark.blockId)))) {
      const block = blocks.get(blockId)!; const values = byBlock.get(blockId) ?? [];
      if (JSON.stringify(boundariesFor(block)) !== JSON.stringify(values.length ? [values[0].start, ...values.map(unit => unit.end)] : [])) issue('source-segmentation-mismatch');
    }
    if (report.issues.length) return report;
  }
  if (typeof Intl.Segmenter !== 'function') { report.status = 'unverifiable'; issue('grapheme-segmentation-unavailable'); return report; }
  const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  for (const blockId of new Set(book.chunks.flatMap(chunk => chunk.timeline.map(mark => mark.blockId)))) {
    const block = blocks.get(blockId)!; const cuts = new Set([0, block.text.length, ...[...graphemes.segment(block.text)].map(part => part.index)]);
    if ((byBlock.get(blockId) ?? []).some(unit => !cuts.has(unit.start) || !cuts.has(unit.end))
      || book.chunks.some(chunk => chunk.timeline.some(mark => mark.blockId === blockId && (!cuts.has(mark.start) || !cuts.has(mark.end))))) issue('source-or-audio-boundary-splits-grapheme');
  }
  if (report.issues.length) return report;
  const originalByBlock = new Map(byBlock);
  const derived = audioSourceUnits(book);
  report.splitSourceUnits = derived.splitSourceUnits;
  report.issues.push(...derived.issues);
  if (report.issues.length) return report;
  byBlock.clear();
  for (const unit of derived.units) { const values = byBlock.get(unit.blockId) ?? []; values.push(unit); byBlock.set(unit.blockId, values); }
  if (!book.chunks.length || book.completedChunks !== book.chunks.length || !Number.isSafeInteger(book.totalChunks) || book.totalChunks < book.completedChunks) issue('invalid-chunk-count');
  const chunkIds = new Set<string>();
  let lastBlock = -1; let lastEnd = -1;
  const allExpected: string[] = [];
  for (const chunk of book.chunks) {
    const result: ChunkPresentationReport = { chunkId: chunk?.id, expectedUnitIds: [], displayedUnitIds: [], missingUnitIds: [], duplicateUnitIds: [],
      outOfOrder: false, forcedAlignmentUnits: 0, voicevoxUnits: 0, estimatedUnits: 0, rejectedAcousticCues: 0, issues: [] };
    report.chunks.push(result);
    const fail = (code: string, unitId?: string) => result.issues.push({ code, chunkId: chunk?.id, ...(unitId ? { unitId } : {}) });
    if (!chunk || typeof chunk.id !== 'string' || chunkIds.has(chunk.id) || !Number.isFinite(chunk.durationSeconds) || chunk.durationSeconds <= 0 || !Array.isArray(chunk.timeline) || !chunk.timeline.length) { fail('invalid-chunk'); continue; }
    chunkIds.add(chunk.id);
    for (const mark of chunk.timeline) {
      const block = blocks.get(mark?.blockId);
      if (!block || !Number.isSafeInteger(mark.start) || !Number.isSafeInteger(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.end > block.text.length) { fail('invalid-timeline'); continue; }
      const order = blockOrder.get(mark.blockId)!;
      if (order < lastBlock || (order === lastBlock && mark.start < lastEnd)) fail('timeline-order-or-overlap');
      lastBlock = order; lastEnd = mark.end;
      const units = unitsInAudioRange(byBlock.get(mark.blockId) ?? [], mark.start, mark.end).filter(unit => unit.kind === 'text');
      let cursor = mark.start;
      for (const unit of units) {
        if (unit.start !== cursor || unit.end > mark.end) fail('source-gap-or-crossing', unit.id);
        if (block.ruby.some(ruby => ruby.start < unit.start && ruby.end > unit.start || ruby.start < unit.end && ruby.end > unit.end)) fail('ruby-split', unit.id);
        const expectedRuby = block.ruby.filter(ruby => ruby.start >= unit.start && ruby.end <= unit.end).map(ruby => [ruby.start - unit.start, ruby.end - unit.start, ruby.reading]);
        if (JSON.stringify(expectedRuby) !== JSON.stringify(unit.ruby.map(ruby => [ruby.start, ruby.end, ruby.reading]))) fail('ruby-mismatch', unit.id);
        cursor = unit.end; result.expectedUnitIds.push(unit.id);
      }
      if (!units.length || cursor !== mark.end) fail('source-coverage-gap');
      if (mark.unitIds !== undefined && (!Array.isArray(mark.unitIds) || JSON.stringify(mark.unitIds) !== JSON.stringify(unitsInAudioRange(originalByBlock.get(mark.blockId) ?? [], mark.start, mark.end).filter(unit => unit.kind === 'text').map(unit => unit.id)))) fail('timeline-unit-ids-mismatch');
    }
    allExpected.push(...result.expectedUnitIds);
  }
  if (report.issues.length || report.chunks.some(chunk => chunk.issues.length)) {
    report.expectedUnits = allExpected.length; report.issues.push(...report.chunks.flatMap(chunk => chunk.issues)); return report;
  }
  const segments = suppliedSegments ?? audioSegments(book);
  const mapped = new Map(segments.map(segment => [segment.chunk.id, segment]));
  const derivedById = new Map(derived.units.map(unit => [unit.id, unit]));
  if (segments.length !== book.chunks.length || mapped.size !== book.chunks.length) issue('segment-count-or-duplicate');
  let mediaCursor = 0;
  for (const [index, result] of report.chunks.entries()) {
    const segment = mapped.get(result.chunkId);
    const cues = segment?.displayCues ?? [];
    const fail = (code: string, unitId?: string) => result.issues.push({ code, chunkId: result.chunkId, ...(unitId ? { unitId } : {}) });
    if (!segment || segments[index]?.chunk.id !== result.chunkId || segment.chunk.durationSeconds !== book.chunks[index].durationSeconds
      || Math.abs(segment.startSeconds - mediaCursor) > 1e-6 || Math.abs(segment.endSeconds - mediaCursor - book.chunks[index].durationSeconds) > 1e-6) fail('segment-clock-or-order');
    mediaCursor += book.chunks[index].durationSeconds;
    let end = 0;
    for (const cue of cues) {
      const expected = derivedById.get(cue.unitId); const actual = cue.units[0];
      if (!expected || !actual || expected.blockId !== actual.blockId || expected.start !== actual.start || expected.end !== actual.end || expected.text !== actual.text || JSON.stringify(expected.ruby) !== JSON.stringify(actual.ruby)) fail('display-unit-source-mismatch', cue.unitId);
      if (cue.units.length !== 1 || cue.unitIds.length !== 1 || cue.unitIds[0] !== cue.units[0]?.id || cue.unitId !== cue.units[0]?.id) fail('display-is-not-one-source-unit');
      if (!Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds) || cue.startSeconds < end - 1e-6 || cue.endSeconds <= cue.startSeconds || cue.endSeconds > segment!.chunk.durationSeconds + 1e-6) fail('invalid-display-interval', cue.unitId);
      end = cue.endSeconds;
      result.displayedUnitIds.push(...cue.unitIds);
      if (cue.timingMethod === 'estimated' || cue.timingMethod === 'acoustic-estimated') { result.estimatedUnits++; if (cue.timingMethod === 'acoustic-estimated') result.acousticEstimatedUnits = (result.acousticEstimatedUnits ?? 0) + 1; if (cue.score !== undefined) fail('estimated-score', cue.unitId); }
      else if (cue.timingMethod === 'voicevox-mora') result.voicevoxUnits++;
      else if (cue.timingMethod === 'forced-alignment') result.forcedAlignmentUnits++;
      else fail('unknown-display-timing', cue.unitId);
    }
    const seen = new Set<string>();
    result.duplicateUnitIds = result.displayedUnitIds.filter(id => seen.has(id) || !seen.add(id));
    result.missingUnitIds = result.expectedUnitIds.filter(id => !seen.has(id));
    result.outOfOrder = JSON.stringify(result.displayedUnitIds) !== JSON.stringify(result.expectedUnitIds);
    if (result.outOfOrder) fail('display-order-or-coverage');
    if (!segment || cues.map(cue => cue.units.map(unit => unit.text).join('')).join('') !== segment.text) fail('display-text-mismatch');
    result.rejectedAcousticCues = Math.max(0, (Array.isArray(segment?.chunk.alignment?.cues) ? segment.chunk.alignment.cues.length : 0) - (segment?.cues?.length ?? 0));
  }
  report.expectedUnits = allExpected.length;
  report.displayedUnits = report.chunks.reduce((sum, chunk) => sum + chunk.displayedUnitIds.length, 0);
  for (const field of ['forcedAlignmentUnits', 'voicevoxUnits', 'estimatedUnits'] as const) report[field] = report.chunks.reduce((sum, chunk) => sum + chunk[field], 0);
  const acoustic = report.chunks.reduce((sum, chunk) => sum + (chunk.acousticEstimatedUnits ?? 0), 0);
  if (acoustic) report.acousticEstimatedUnits = acoustic;
  report.missingUnitIds = report.chunks.flatMap(chunk => chunk.missingUnitIds);
  const seen = new Set<string>();
  report.duplicateUnitIds = report.chunks.flatMap(chunk => chunk.displayedUnitIds).filter(id => seen.has(id) || !seen.add(id));
  if (report.duplicateUnitIds.length) issue('duplicate-display-unit');
  report.issues.push(...report.chunks.flatMap(chunk => chunk.issues));
  report.status = report.issues.length ? 'invalid' : 'valid';
  return report;
}

/** New artifacts require a report; old artifacts are independently inspected without rewriting them. */
export function requireAudioPresentation(book: PlayableAudioBook & { presentation?: AudioPresentationReport }, requireStored = false): AudioPresentationReport {
  const report = inspectAudioPresentation(book);
  if (report.status !== 'valid') throw new Error(`区切り表示の検査に失敗しました（${[...new Set(report.issues.map(issue => issue.code))].slice(0, 8).join(', ')}）。保存音声は再生成しません。`);
  if ((requireStored && !book.presentation) || (book.presentation && JSON.stringify(book.presentation) !== JSON.stringify(report))) {
    throw new Error('区切り表示の検査記録がないか、現在の原稿・音声・表示計画と一致しません。保存音声から再stageしてください。');
  }
  return report;
}
