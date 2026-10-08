import { MIN_ALIGNMENT_SCORE, type AudioAlignmentCue, type AcousticTimingEstimate, type VoicevoxTimingEvidence } from '../generation/contracts';
import { applyAcousticTiming } from './audio-acoustic';
import { audioSourceUnits, unitsInAudioRange } from './audio-units';
import type { AozoraProvenance, ReadingUnit, TextBlock } from './model';

export interface PlayableAlignment {
  precision: 'phrase' | 'sentence';
  method: 'forced-alignment' | 'voicevox-mora' | 'sentence-fallback';
  status: 'aligned' | 'partial' | 'fallback';
  score?: number;
  engineTiming?: VoicevoxTimingEvidence;
  acoustic?: AcousticTimingEstimate;
  reason?: string;
  alignerVersion?: string;
  cues: AudioAlignmentCue[];
  warnings?: string[];
}

export interface PlayableAudioChunk {
  id: string;
  audioUrl: string;
  durationSeconds: number;
  mimeType?: string;
  timeline: Array<{ blockId: string; start: number; end: number; unitIds?: string[] }>;
  alignment?: PlayableAlignment;
}
/** Shared playback contract: private generation metadata is unnecessary for playback. */
export interface PlayableAudioBook {
  id: string;
  revision: string;
  title: string;
  document: { blocks: TextBlock[]; units?: ReadingUnit[]; provenance?: AozoraProvenance; versions?: { parser: string; model: string; rules: string } };
  chunks: PlayableAudioChunk[];
  warnings: string[];
  completedChunks: number;
  totalChunks: number;
  attribution?: string;
}

export interface AudioSegment {
  chunk: PlayableAudioChunk;
  startSeconds: number;
  endSeconds: number;
  text: string;
  cues?: PlayablePhraseCue[];
  displayCues: PlayablePhraseCue[];
}

export interface PlayablePhraseCue extends AudioAlignmentCue {
  timingMethod?: 'forced-alignment' | 'voicevox-mora' | 'acoustic-estimated' | 'estimated';
  estimatedReason?: string;
  units: ReadingUnit[];
  unitIndices: number[];
}
export interface AudioDisplay {
  precision: 'phrase' | 'unavailable';
  method: 'forced-alignment' | 'voicevox-mora' | 'acoustic-estimated' | 'estimated' | 'unavailable';
  text: string;
  units: ReadingUnit[];
  unitIndices: number[];
  cue?: PlayablePhraseCue;
  score?: number;
  reason?: string;
  querySource?: 'captured' | 'reconstructed';
}
export function validVoicevoxTiming(value: VoicevoxTimingEvidence | undefined, duration: number): boolean {
  return Boolean(value && value.verification === 'voicevox-mora-frames' && value.version === 'voicevox-mora-v1'
    && value.engineVersion === 'voicevox-engine:0.25.2' && /^\d{1,8}$/.test(value.styleId)
    && ['captured', 'reconstructed'].includes(value.querySource) && value.frameRate === 93.75 && Number.isSafeInteger(value.frames) && value.frames > 0
    && /^[a-f0-9]{64}$/.test(value.queryHash) && value.phonemeMapping === 'exact' && Number.isSafeInteger(value.ctcAnchors) && value.ctcAnchors >= 0
    && (value.querySource === 'captured' || value.ctcAnchors >= 2) && Math.abs(value.frames / value.frameRate - duration) <= .1);
}

function phraseCues(chunk: PlayableAudioChunk, units: Map<string, ReadingUnit>, indices: Map<string, number>, blocks: Map<string, TextBlock>): PlayablePhraseCue[] {
  const alignment = chunk.alignment;
  if (!alignment || alignment.precision !== 'phrase' || !['forced-alignment', 'voicevox-mora'].includes(alignment.method) || alignment.status === 'fallback' || !Array.isArray(alignment.cues)) return [];
  const engine = alignment.method === 'voicevox-mora';
  if (engine && (!validVoicevoxTiming(alignment.engineTiming, chunk.durationSeconds) || alignment.score !== undefined)) return [];
  const result: PlayablePhraseCue[] = [];
  let previousEnd = 0;
  for (const cue of alignment.cues) {
    if (!cue || !Array.isArray(cue.unitIds) || (engine ? cue.score !== undefined : typeof cue.score !== 'number' || !Number.isFinite(cue.score) || cue.score < MIN_ALIGNMENT_SCORE || cue.score > 1)
      || !Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds)
      || cue.startSeconds < 0 || cue.startSeconds < previousEnd - 0.0001 || cue.endSeconds <= cue.startSeconds
      || cue.endSeconds > chunk.durationSeconds + 0.0001 || !cue.unitIds?.length
      || !cue.unitIds.includes(cue.unitId) || new Set(cue.unitIds).size !== cue.unitIds.length) continue;
    const mapped = cue.unitIds.map(id => units.get(id));
    if (mapped.some(unit => !unit || unit.kind !== 'text' || unit.blockId !== cue.blockId
      || !Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end) || unit.start < 0 || unit.end <= unit.start
      || blocks.get(unit.blockId)?.text.slice(unit.start, unit.end) !== unit.text || !Array.isArray(unit.ruby)
      || unit.start < cue.start || unit.end > cue.end
      || !chunk.timeline.some(mark => mark.blockId === unit.blockId && unit.start >= mark.start && unit.end <= mark.end))) continue;
    const original = mapped as ReadingUnit[];
    const positions = original.map(unit => indices.get(unit.id)!);
    if (original[0].start !== cue.start || original.at(-1)!.end !== cue.end
      || positions.some((position, i) => i > 0 && position !== positions[i - 1] + 1)) continue;
    result.push({ ...cue, units: original, unitIndices: positions });
    previousEnd = cue.endSeconds;
  }
  return result;
}


/** Build a separate visual clock. Accepted acoustic cues and their scores stay untouched. */
function displayCues(chunk: PlayableAudioChunk, source: ReadingUnit[], indices: Map<string, number>, accepted: PlayablePhraseCue[], blocks: Map<string, TextBlock>): PlayablePhraseCue[] {
  const selected = source.filter(unit => unit.kind === 'text' && Array.isArray(unit.ruby) && unit.end > unit.start
    && blocks.get(unit.blockId)?.text.slice(unit.start, unit.end) === unit.text
    && chunk.timeline.some(mark => mark.blockId === unit.blockId && unit.start >= mark.start && unit.end <= mark.end));
  const expected = chunk.timeline.map(mark => blocks.get(mark.blockId)?.text.slice(mark.start, mark.end) ?? '').join('');
  if (!selected.length || selected.map(unit => unit.text).join('') !== expected) return [];
  const method = chunk.alignment?.method === 'voicevox-mora' ? 'voicevox-mora' : 'forced-alignment';
  const positions = new Map(selected.map((unit, index) => [unit.id, index]));
  const minimum = .12; // Visual dwell, not an acoustic accuracy threshold.
  const estimates = (from: number, to: number, start: number, end: number, reason: string): PlayablePhraseCue[] => {
    const values = selected.slice(from, to);
    const weights = values.map(unit => Math.max(1, Array.from(unit.text).length));
    const weight = weights.reduce((sum, value) => sum + value, 0);
    const floor = Math.min(minimum, (end - start) / Math.max(1, values.length) / 2);
    const available = Math.max(0, end - start - floor * values.length);
    let cursor = start;
    return values.map((unit, index) => {
      const next = index === values.length - 1 ? end : cursor + floor + available * weights[index] / weight;
      const cue: PlayablePhraseCue = { unitId: unit.id, unitIds: [unit.id], blockId: unit.blockId, start: unit.start, end: unit.end,
        startSeconds: cursor, endSeconds: next, units: [unit], unitIndices: [indices.get(unit.id)!], timingMethod: 'estimated', estimatedReason: reason };
      cursor = next; return cue;
    });
  };
  const anchors = accepted.flatMap((cue): PlayablePhraseCue[] => {
    const from = positions.get(cue.units[0].id);
    if (from === undefined) return [];
    if (cue.units.length > 1) return estimates(from, from + cue.units.length, cue.startSeconds, cue.endSeconds, 'shared-cue');
    return [{ ...cue, timingMethod: method }];
  });
  const result: PlayablePhraseCue[] = [];
  let nextUnit = 0;
  let previousEnd = 0;
  for (const anchor of anchors) {
    const at = positions.get(anchor.unitId)!;
    // A very short cue can be skipped between browser frames at high speed.
    // Discard it only from the visual anchors and estimate that unit instead.
    if (at < nextUnit || anchor.endSeconds - anchor.startSeconds < minimum
      || anchor.startSeconds < previousEnd + (at - nextUnit) * minimum
      || chunk.durationSeconds - anchor.endSeconds < (selected.length - at - 1) * minimum) continue;
    result.push(...estimates(nextUnit, at, previousEnd, anchor.startSeconds, 'missing-cue'), anchor);
    previousEnd = anchor.endSeconds; nextUnit = at + 1;
  }
  result.push(...estimates(nextUnit, selected.length, previousEnd, chunk.durationSeconds, 'missing-cue'));
  return applyAcousticTiming(result, chunk.alignment?.acoustic, chunk.durationSeconds);
}


/** Keep audio-file segments separate from the original document's display units. */
export function audioSegments(book: PlayableAudioBook): AudioSegment[] {
  const segments: AudioSegment[] = [];
  const blocks = new Map(book.document.blocks.map(block => [block.id, block]));
  const source = audioSourceUnits(book).units;
  const units = new Map(source.map(unit => [unit.id, unit]));
  const indices = new Map(source.map((unit, index) => [unit.id, index]));
  const byBlock = new Map<string, ReadingUnit[]>();
  for (const unit of source) { const values = byBlock.get(unit.blockId) ?? []; values.push(unit); byBlock.set(unit.blockId, values); }
  let cursor = 0;
  for (const chunk of book.chunks) {
    if (!Number.isFinite(chunk.durationSeconds) || chunk.durationSeconds <= 0) continue;
    const text = chunk.timeline.map(mark => {
      const block = blocks.get(mark.blockId);
      return block?.text.slice(mark.start, mark.end) ?? '';
    }).join('');
    const cues = phraseCues(chunk, units, indices, blocks);
    segments.push({ chunk, startSeconds: cursor, endSeconds: cursor + chunk.durationSeconds, text, cues,
      displayCues: displayCues(chunk, chunk.timeline.flatMap(mark => unitsInAudioRange(byBlock.get(mark.blockId) ?? [], mark.start, mark.end)), indices, cues, blocks) });
    cursor += chunk.durationSeconds;
  }
  return segments;
}

/** Read one original phrase from the visual clock, distinguishing estimated timing. */
export function audioDisplayAt(segment: AudioSegment | undefined, localSeconds: number): AudioDisplay {
  const alignment = segment?.chunk.alignment;
  const fallback: AudioDisplay = {
    precision: 'unavailable', method: 'unavailable', text: '', units: [], unitIndices: [],
    ...(typeof alignment?.score === 'number' && Number.isFinite(alignment.score) && alignment.score >= 0 && alignment.score <= 1 ? { score: alignment.score } : {}),
    reason: '区切り表示の計画を検査できません。原文の区切り情報を確認してください。',
  };
  if (!segment || !Number.isFinite(localSeconds)) return fallback;
  // State updates/seek callbacks can briefly straddle a chunk boundary. Hold its first phrase.
  localSeconds = Math.max(0, Math.min(segment.chunk.durationSeconds, localSeconds));
  const cues = segment.displayCues ?? [];
  // Chromium media seeks can truncate to microseconds; adding/subtracting chunk
  // offsets adds float noise too. 2 μs is below a 24 kHz PCM sample (41.7 μs)
  // and changes clock comparisons only, never an alignment cue or its confidence.
  const clockTolerance = 2e-6;
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].startSeconds <= localSeconds + clockTolerance) low = mid + 1;
    else high = mid;
  }
  const cue = cues[Math.max(0, low - 1)];
  if (!cue) return fallback;
  const held = localSeconds + clockTolerance < cue.startSeconds || localSeconds + clockTolerance >= cue.endSeconds;
  const acoustic = !held && cue.timingMethod === 'acoustic-estimated';
  const estimated = held || cue.timingMethod === 'estimated' || acoustic;
  return { precision: 'phrase', method: acoustic ? 'acoustic-estimated' : estimated ? 'estimated' : alignment?.method === 'voicevox-mora' ? 'voicevox-mora' : 'forced-alignment', text: cue.units.map(unit => unit.text).join(''),
    units: cue.units, unitIndices: cue.unitIndices, cue, score: estimated ? undefined : cue.score,
    ...(estimated ? { reason: held ? 'silence-hold' : cue.estimatedReason ?? alignment?.reason } : {}),
    ...(alignment?.engineTiming ? { querySource: alignment.engineTiming.querySource } : {}) };
}

export interface AudioPhraseTarget { seconds: number; endSeconds?: number; segmentIndex: number; cue: PlayablePhraseCue }
export function audioPhraseTargets(segments: AudioSegment[]): AudioPhraseTarget[] {
  return segments.flatMap((segment, segmentIndex) => (segment.displayCues ?? []).map((cue, index) => ({ seconds: segment.startSeconds + (index === 0 ? 0 : cue.startSeconds), endSeconds: segment.startSeconds + cue.endSeconds, segmentIndex, cue })));
}

/** Previous/next uses every visual phrase, including explicitly estimated intervals. */
export function adjacentAudioPhrase(targets: AudioPhraseTarget[], seconds: number, direction: -1 | 1): AudioPhraseTarget | undefined {
  let low = 0;
  let high = targets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (targets[mid].seconds <= seconds + 0.0001) low = mid + 1;
    else high = mid;
  }
  if (direction === 1) return targets[low];
  const current = targets[low - 1];
  const inside = current && seconds < (current.endSeconds ?? current.seconds + current.cue.endSeconds - current.cue.startSeconds);
  return targets[low - (inside ? 2 : 1)];
}

export function locateAudioTime(segments: AudioSegment[], seconds: number): { index: number; localSeconds: number } {
  if (!segments.length) return { index: 0, localSeconds: 0 };
  const total = segments[segments.length - 1].endSeconds;
  const position = Math.max(0, Math.min(total, Number.isFinite(seconds) ? seconds : 0));
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (position >= segments[mid].endSeconds) low = mid + 1;
    else high = mid;
  }
  return { index: low, localSeconds: position - segments[low].startSeconds };
}

export function mediaPosition(segment: AudioSegment | undefined, currentTime: number, ended = false): number {
  if (!segment) return 0;
  // A decoder can round its duration below the saved PCM clock. Once it ends,
  // use the exact segment boundary so a later timeupdate cannot undo completion.
  if (ended) return segment.endSeconds;
  const elapsed = Number.isFinite(currentTime) ? currentTime : 0;
  return segment.startSeconds + Math.max(0, Math.min(segment.chunk.durationSeconds, elapsed));
}

export function audioTimeLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}
