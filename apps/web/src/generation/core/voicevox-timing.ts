import type { ReadingDocument, ReadingUnit } from '../../reader/model';
import { MIN_ALIGNMENT_SCORE, type SavedAlignment } from '../contracts';
import { digest } from './disk';
import { VOICEVOX_ENDPOINT, wavDuration } from './providers';
import { mergedRanges, type PreparedSpeech } from './speech-source';

export const VOICEVOX_TIMING_VERSION = 'voicevox-mora-v1';
interface Mora { text: string; consonant?: string | null; consonant_length?: number | null; vowel: string; vowel_length: number; pitch: number }
interface Query {
  accent_phrases: Array<{ moras: Mora[]; pause_mora?: Mora | null; is_interrogative?: boolean }>;
  speedScale: number; prePhonemeLength: number; postPhonemeLength: number;
  pauseLength?: number | null; pauseLengthScale?: number; outputSamplingRate: number; outputStereo: boolean;
}
export interface CapturedVoicevoxQuery { schemaVersion: 1; audioHash: string; spokenTextHash: string; providerVersion: string; styleId: string; query: unknown }
interface TimedMora { phoneme: string; startSeconds: number; endSeconds: number }
interface SpeechGroup { units: ReadingUnit[]; spokenStart: number; spokenEnd: number }
const rate = 93.75;
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
/** Engine 0.25.2 uses NumPy ties-to-even rounding, not Math.round at .5. */
export function roundFrames(value: number): number {
  const integer = Math.floor(value); const fraction = value - integer;
  return fraction === .5 ? integer + integer % 2 : Math.round(value);
}
function queryData(value: unknown): Query {
  const query = value as Query;
  if (!query || !Array.isArray(query.accent_phrases) || query.accent_phrases.length > 512
    || !finite(query.speedScale) || query.speedScale <= 0 || query.speedScale > 10
    || !finite(query.prePhonemeLength) || !finite(query.postPhonemeLength)
    || query.outputSamplingRate !== 24000 || query.outputStereo !== false
    || (query.pauseLength != null && !finite(query.pauseLength)) || (query.pauseLengthScale != null && !finite(query.pauseLengthScale))) throw new Error('unsupported-query');
  for (const phrase of query.accent_phrases) {
    // Synthesis can append an interrogative mora; this version does not guess that extra mapping.
    if (!Array.isArray(phrase.moras) || phrase.moras.length > 1024 || phrase.is_interrogative) throw new Error('unsupported-query');
    for (const mora of [...phrase.moras, ...(phrase.pause_mora ? [phrase.pause_mora] : [])]) {
      if (!mora || typeof mora.text !== 'string' || !/^[a-zA-Z]+$/.test(mora.vowel) || !finite(mora.vowel_length)
        || (mora.consonant != null && !/^[a-zA-Z]+$/.test(mora.consonant)) || (mora.consonant_length != null && !finite(mora.consonant_length))) throw new Error('invalid-mora');
    }
  }
  return query;
}
function phoneme(mora: Mora): string { return `${mora.consonant ?? ''}/${mora.vowel.toLowerCase()}`; }
function sounds(query: Query): string[] { return query.accent_phrases.flatMap(phrase => phrase.moras.map(phoneme)); }
function audibleVoicevoxPcm(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes); let energy = 0; let samples = 0; let compatible = false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4); const begin = offset + 8; if (begin + size > buffer.length) return false;
    const type = buffer.toString('ascii', offset, offset + 4);
    if (type === 'fmt ' && size >= 16) compatible = buffer.readUInt16LE(begin) === 1 && buffer.readUInt16LE(begin + 2) === 1 && buffer.readUInt32LE(begin + 4) === 24000 && buffer.readUInt16LE(begin + 14) === 16;
    if (type === 'data') for (let index = begin; index + 1 < begin + size; index += 2) { const value = buffer.readInt16LE(index) / 32768; energy += value * value; samples++; }
    offset = begin + size + size % 2;
  }
  return compatible && samples > 0 && Math.sqrt(energy / samples) >= .0001;
}
export function voicevoxMoraClock(value: unknown): { moras: TimedMora[]; frames: number } {
  const query = queryData(value); const moras: TimedMora[] = [];
  const framesFor = (seconds: number) => roundFrames(seconds * rate / query.speedScale);
  let frames = framesFor(query.prePhonemeLength);
  for (const phrase of query.accent_phrases) {
    for (const mora of phrase.moras) {
      const begin = frames;
      frames += framesFor(mora.consonant_length ?? 0) + framesFor(mora.vowel_length);
      moras.push({ phoneme: phoneme(mora), startSeconds: begin / rate, endSeconds: frames / rate });
    }
    if (phrase.pause_mora) frames += framesFor((query.pauseLength ?? phrase.pause_mora.vowel_length) * (query.pauseLengthScale ?? 1));
  }
  frames += framesFor(query.postPhonemeLength);
  return { moras, frames };
}
async function localJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${VOICEVOX_ENDPOINT}${path}`, { method: path.startsWith('/audio_query?') ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
  if (!response.ok || !response.body) throw new Error('query-unavailable');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('query-too-large'); } parts.push(value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function voicevoxTimingAvailable(): Promise<boolean> {
  try { return await localJson('/version') === '0.25.2'; } catch { return false; }
}
function speechGroups(document: ReadingDocument, blockId: string, start: number, end: number, speech: PreparedSpeech): SpeechGroup[] {
  const groups: SpeechGroup[] = [];
  for (const unit of document.units.filter(unit => unit.kind === 'text' && unit.blockId === blockId && unit.start >= start && unit.end <= end)) {
    const ranges = mergedRanges(speech.sourceSpans.filter(span => span.start < unit.end && span.end > unit.start).map(span => ({ start: span.spokenStart, end: span.spokenEnd })));
    if (ranges.length !== 1) throw new Error('unmapped-reading');
    const previous = groups.at(-1);
    if (previous && previous.spokenEnd > ranges[0].start) { previous.units.push(unit); previous.spokenEnd = Math.max(previous.spokenEnd, ranges[0].end); }
    else groups.push({ units: [unit], spokenStart: ranges[0].start, spokenEnd: ranges[0].end });
  }
  if (!groups.length || groups.length > 128 || groups[0].spokenStart !== 0 || groups.at(-1)!.spokenEnd !== speech.spokenText.length
    || groups.some((group, index) => index > 0 && group.spokenStart !== groups[index - 1].spokenEnd)) throw new Error('incomplete-reading-map');
  return groups;
}

/** Use engine phoneme durations, not character-length interpolation or relaxed CTC scores.
 * Old audio requires the same Engine, exact frame count and at least two acoustic anchors.
 * New audio can use the exact query captured in its synthesis call, bound to the immutable WAV.
 */
export async function voicevoxPhraseTiming(input: {
  key: string; audio: Uint8Array; audioHash: string; engineVersion: string; styleId: string;
  document: ReadingDocument; blockId: string; start: number; end: number; speech: PreparedSpeech;
  ctc: SavedAlignment; captured?: CapturedVoicevoxQuery; signal: AbortSignal;
}): Promise<SavedAlignment | undefined> {
  try {
    if (input.engineVersion !== 'voicevox-engine:0.25.2' || !/^\d{1,8}$/.test(input.styleId) || input.speech.spokenText.length > 512
      || digest(input.audio) !== input.audioHash || !audibleVoicevoxPcm(input.audio)
      || input.ctc.audioHash !== input.audioHash || !Array.isArray(input.ctc.cues)) return undefined;
    const captured = input.captured;
    if (captured && (captured.schemaVersion !== 1 || captured.audioHash !== input.audioHash || captured.spokenTextHash !== digest(input.speech.spokenText)
      || captured.providerVersion !== input.engineVersion || captured.styleId !== input.styleId)) return undefined;
    if (!captured && await localJson('/version', input.signal) !== '0.25.2') return undefined;
    const query = queryData(captured?.query ?? await localJson('/audio_query?' + new URLSearchParams({ text: input.speech.spokenText, speaker: input.styleId }), input.signal));
    const clock = voicevoxMoraClock(query); const duration = wavDuration(input.audio);
    if (Math.abs(clock.frames / rate - duration) > 1 / 24000) return undefined;
    const groups = speechGroups(input.document, input.blockId, input.start, input.end, input.speech);
    const cues: SavedAlignment['cues'] = []; let cursor = 0;
    for (const group of groups) {
      const piece = queryData(await localJson('/audio_query?' + new URLSearchParams({ text: input.speech.spokenText.slice(group.spokenStart, group.spokenEnd), speaker: input.styleId }), input.signal));
      const expected = sounds(piece); const actual = clock.moras.slice(cursor, cursor + expected.length);
      if (!expected.length || expected.some((sound, index) => sound !== actual[index]?.phoneme)) return undefined;
      const startSeconds = actual[0].startSeconds; const endSeconds = actual.at(-1)!.endSeconds;
      if (endSeconds <= startSeconds) return undefined;
      cues.push({ unitId: group.units[0].id, unitIds: group.units.map(unit => unit.id), blockId: input.blockId,
        start: group.units[0].start, end: group.units.at(-1)!.end, startSeconds, endSeconds });
      cursor += expected.length;
    }
    if (cursor !== clock.moras.length) return undefined;
    let anchors = 0;
    for (const anchor of input.ctc.cues) {
      if (!Array.isArray(anchor.unitIds) || !anchor.unitIds.length || new Set(anchor.unitIds).size !== anchor.unitIds.length
        || typeof anchor.score !== 'number' || !Number.isFinite(anchor.score) || anchor.score < MIN_ALIGNMENT_SCORE || anchor.score > 1
        || !Number.isFinite(anchor.startSeconds) || !Number.isFinite(anchor.endSeconds) || anchor.endSeconds <= anchor.startSeconds
        || anchor.blockId !== input.blockId) return undefined;
      const cue = cues.find(cue => anchor.unitIds.every(id => cue.unitIds.includes(id)));
      if (!cue || anchor.start < cue.start || anchor.end > cue.end || anchor.startSeconds < cue.startSeconds - .08 || anchor.endSeconds > cue.endSeconds + .08) return undefined;
      anchors++;
    }
    if (!captured && anchors < 2) return undefined;
    const querySource = captured ? 'captured' : 'reconstructed';
    return { schemaVersion: 1, key: input.key, audioHash: input.audioHash, normalizeVersion: input.ctc.normalizeVersion,
      alignerVersion: VOICEVOX_TIMING_VERSION, precision: 'phrase', method: 'voicevox-mora', status: 'aligned', cues,
      ...(input.ctc.score === undefined ? {} : { ctcScore: input.ctc.score }),
      units: groups.flatMap((group, index) => group.units.map(unit => ({ unitId: unit.id, blockId: unit.blockId, start: unit.start, end: unit.end,
        spokenRanges: [{ start: group.spokenStart, end: group.spokenEnd }], normalizedRanges: [], status: 'aligned' as const, startSeconds: cues[index].startSeconds, endSeconds: cues[index].endSeconds }))),
      engineTiming: { verification: 'voicevox-mora-frames', version: VOICEVOX_TIMING_VERSION, querySource, engineVersion: input.engineVersion,
        styleId: input.styleId, frameRate: rate, frames: clock.frames, queryHash: digest(JSON.stringify(query)), phonemeMapping: 'exact', ctcAnchors: anchors },
      warnings: [querySource === 'captured' ? '合成時に保存したVOICEVOX queryの音素時刻を使います。人手の発話境界誤差は未測定です。' : '同じEngineでVOICEVOX queryを再構成し、音素列・WAVのフレーム数・CTCの採用時刻を照合しました。人手の発話境界誤差は未測定です。'],
    };
  } catch { if (input.signal.aborted) throw new Error('alignment-cancelled'); return undefined; }
}
