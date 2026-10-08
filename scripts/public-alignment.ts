import { MIN_ALIGNMENT_SCORE, type SavedAlignment, type AudioTimelineEntry } from '../apps/web/src/generation/contracts.ts';
import type { MediaTimingMeasurement, PublicAlignment } from '../apps/web/src/distribution/library.ts';
import type { ReadingDocument } from '../apps/web/src/reader/model.ts';
import { validVoicevoxTiming } from '../apps/web/src/reader/audio-clock.ts';

const score = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const version = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9@._:+-]{1,200}$/.test(value) ? value : undefined;
const warning = 'CTCのscoreは採用判定の指標です。校正された時刻精度の確率ではありません。未対応・低scoreの範囲も区切り表示し、時刻は表示用推定です。';

/** Whitelist alignment provenance and display cues; normalize/spoken text, cache keys and paths remain private. */
export function publicAlignment(alignment: SavedAlignment | undefined, document: ReadingDocument, sentence: AudioTimelineEntry[], audioHash: string,
  sourceDuration: number, mediaDuration: number, timing: MediaTimingMeasurement): PublicAlignment {
  const ids = new Set(sentence.flatMap(mark => mark.unitIds));
  const sourceUnits = document.units.filter(unit => ids.has(unit.id));
  const base: PublicAlignment = {
    precision: 'sentence', method: 'sentence-fallback', status: 'fallback', score: score(alignment?.score), cues: [],
    units: sourceUnits.map(unit => ({ unitId: unit.id, blockId: unit.blockId, start: unit.start, end: unit.end, score: 0, status: 'unmatched' })),
    warnings: [warning],
  };
  if (!alignment || alignment.schemaVersion !== 1 || alignment.audioHash !== audioHash || (!['forced-alignment', 'voicevox-mora'].includes(alignment.method) && alignment.acoustic?.version !== 'ctc-energy-v1')) {
    return { ...base, reason: '保存済み音声に対応するforced alignmentがありません。発話境界の時刻がないため、区切り表示には表示用推定を使います。' };
  }
  const engine = alignment.method === 'voicevox-mora';
  if (engine && (!validVoicevoxTiming(alignment.engineTiming, sourceDuration) || alignment.score !== undefined)) return { ...base, reason: 'VOICEVOXの音素時刻の検証情報が一致しません。' };
  const normalizeVersion = version(alignment.normalizeVersion); const alignerVersion = version(alignment.alignerVersion);
  const provenance = { ...(normalizeVersion ? { normalizeVersion } : {}), ...(alignerVersion ? { alignerVersion } : {}) };
  if (timing.verification !== 'pcm-correlated') return { ...base, ...provenance, reason: 'AACのPCM時刻対応を確認できないため、発話境界の時刻がないため、区切り表示には表示用推定を使います。' };
  const estimates = alignment.acoustic;
  const acoustic = estimates?.version === 'ctc-energy-v1' && estimates.minimumTokenScore === MIN_ALIGNMENT_SCORE && Number.isSafeInteger(estimates.anchorCount) && estimates.anchorCount >= 2
    && Array.isArray(estimates.units) && new Set(estimates.units.map(unit => unit.unitId)).size === estimates.units.length
    && estimates.units.every(unit => sourceUnits.some(source => source.id === unit.unitId && source.blockId === unit.blockId && source.start === unit.start && source.end === unit.end)
      && Number.isFinite(unit.startSeconds) && Number.isFinite(unit.endSeconds) && unit.startSeconds >= 0 && unit.endSeconds > unit.startSeconds && unit.endSeconds <= sourceDuration + 1e-6)
    ? { version: estimates.version, minimumTokenScore: estimates.minimumTokenScore, anchorCount: estimates.anchorCount,
      units: estimates.units.map(unit => ({ unitId: unit.unitId, blockId: unit.blockId, start: unit.start, end: unit.end,
        startSeconds: Math.max(0, unit.startSeconds * timing.scale + timing.offsetSeconds), endSeconds: Math.min(mediaDuration, unit.endSeconds * timing.scale + timing.offsetSeconds) })) } : undefined;
  const correctedAcoustic = acoustic?.units.every(unit => unit.endSeconds > unit.startSeconds) ? acoustic : undefined;
  const acousticProvenance = correctedAcoustic ? { acoustic: correctedAcoustic } : {};
  const cues: PublicAlignment['cues'] = [];
  let previousEnd = 0;
  for (const cue of alignment.cues ?? []) {
    const units = sourceUnits.filter(unit => cue.unitIds?.includes(unit.id));
    const inSentence = sentence.some(mark => mark.blockId === cue.blockId && cue.start >= mark.start && cue.end <= mark.end);
    const valid = Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds) && cue.startSeconds >= 0
      && cue.endSeconds > cue.startSeconds && cue.endSeconds <= sourceDuration + .02
      && Array.isArray(cue.unitIds) && cue.unitIds.includes(cue.unitId) && units.length === new Set(cue.unitIds).size && units.length > 0
      && units.every(unit => unit.blockId === cue.blockId && unit.start >= cue.start && unit.end <= cue.end) && inSentence;
    if (!valid) return { ...base, ...provenance, reason: '位置や時刻が一致しないcueがあるため、発話境界の時刻がないため、区切り表示には表示用推定を使います。' };
    const reliableUnits = units.every(unit => alignment.units?.some(result => result.unitId === unit.id && result.blockId === unit.blockId
      && result.start === unit.start && result.end === unit.end && result.status === 'aligned' && (engine ? result.score === undefined : score(result.score) >= MIN_ALIGNMENT_SCORE)));
    if ((engine ? cue.score !== undefined : score(cue.score) < MIN_ALIGNMENT_SCORE) || !reliableUnits) continue;
    const startSeconds = Math.max(0, cue.startSeconds * timing.scale + timing.offsetSeconds);
    const endSeconds = Math.min(mediaDuration, cue.endSeconds * timing.scale + timing.offsetSeconds);
    if (endSeconds <= startSeconds || startSeconds + .001 < previousEnd) return { ...base, ...provenance, reason: '補正後のcueが重なるため、発話境界の時刻がないため、区切り表示には表示用推定を使います。' };
    cues.push({ unitId: cue.unitId, unitIds: [...cue.unitIds], blockId: cue.blockId, start: cue.start, end: cue.end, startSeconds, endSeconds, ...(engine ? {} : { score: score(cue.score) }) });
    previousEnd = endSeconds;
  }
  if (!cues.length) return { ...base, ...provenance, ...acousticProvenance, reason: '採用できるscoreのcueがないため、発話境界の時刻がないため、区切り表示には表示用推定を使います。' };
  const units: PublicAlignment['units'] = sourceUnits.map(unit => {
    const known = alignment.units?.find(value => value.unitId === unit.id && value.blockId === unit.blockId && value.start === unit.start && value.end === unit.end);
    const matched = cues.some(cue => cue.unitIds.includes(unit.id));
    return { unitId: unit.id, blockId: unit.blockId, start: unit.start, end: unit.end, ...(engine ? {} : { score: score(known?.score) }),
      status: matched ? 'aligned' : known?.status === 'low-confidence' ? 'low-confidence' : 'unmatched',
      ...(!matched ? { reason: 'この範囲は発話境界の時刻がないため、区切り表示には表示用推定を使います。' } : {}) };
  });
  const partial = units.some(unit => unit.status !== 'aligned') || alignment.status !== 'aligned';
  const engineTiming = alignment.engineTiming;
  return { precision: 'phrase', method: engine ? 'voicevox-mora' : 'forced-alignment', status: partial ? 'partial' : 'aligned',
    ...(engine && engineTiming ? { engineTiming: { verification: engineTiming.verification, version: engineTiming.version, querySource: engineTiming.querySource,
      engineVersion: engineTiming.engineVersion, styleId: engineTiming.styleId, frameRate: engineTiming.frameRate, frames: engineTiming.frames,
      queryHash: engineTiming.queryHash, phonemeMapping: engineTiming.phonemeMapping, ctcAnchors: engineTiming.ctcAnchors } } : { score: score(alignment.score) }), ...provenance, ...acousticProvenance, cues, units,
    ...(partial ? { reason: '採用した時刻と表示用推定を分け、未対応・低score・無音の範囲は発話境界の時刻がないため、区切り表示には表示用推定を使います。' } : {}),
    warnings: [engine ? 'VOICEVOXの音素フレームに基づく時刻です。CTCの確率や人手で測った境界誤差を示すものではありません。' : warning] };
}
