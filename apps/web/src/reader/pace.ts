import { DEFAULT_SETTINGS, type ReaderSettings, type ReadingUnit } from './model.ts';

export type ReadingPace = NonNullable<ReaderSettings['readingPace']>;
type PaceSettings = Pick<ReaderSettings, 'cpm' | 'punctuationPause' | 'readingPace'>;
export const MIN_DISPLAY_MS = 100;
const pauses: Record<ReadingUnit['pause'], number> = {
  none: 0, comma: 100, sentence: 250, paragraph: 400, heading: 600,
};
let graphemes: Intl.Segmenter | undefined;
const content = /[^\s\p{Punctuation}]/u;

function segmenter(): Intl.Segmenter {
  if (typeof Intl.Segmenter !== 'function') throw new Error('このブラウザは文字境界解析に対応していません。原文を静的表示して確認してください。');
  return graphemes ??= new Intl.Segmenter('ja', { granularity: 'grapheme' });
}

function boundedCpm(cpm: number): number {
  return Number.isFinite(cpm) ? Math.min(3000, Math.max(100, cpm)) : DEFAULT_SETTINGS.cpm;
}

/** The existing per-unit contract; also safe for callers outside silent playback. */
export function durationMs(unit: ReadingUnit, settings: PaceSettings): number {
  if (unit.kind === 'static') return 0;
  return Math.max(MIN_DISPLAY_MS, 60_000 * unit.characters / boundedCpm(settings.cpm))
    + (settings.punctuationPause ? pauses[unit.pause] : 0);
}

/** Provisional, explainable text features, not a measured comprehension model. */
export function textLoad(text: string): {
  characters: number; digits: number; latin: number; brackets: number; multiplier: number;
} {
  let characters = 0, digits = 0, latin = 0, brackets = 0;
  for (const { segment } of segmenter().segment(text)) {
    if (/[\p{Ps}\p{Pe}]/u.test(segment)) brackets++;
    if (!content.test(segment)) continue;
    characters++;
    if (/\p{Nd}/u.test(segment)) digits++;
    if (/\p{Script=Latin}/u.test(segment)) latin++;
  }
  const divisor = Math.max(1, characters);
  const multiplier = 1 + .3 * digits / divisor + .2 * latin / divisor
    + .15 * Math.min(2, brackets) + .3 * Math.min(1, Math.max(0, characters - 12) / 12);
  return { characters, digits, latin, brackets, multiplier };
}

export interface PaceTimeline {
  durations: number[];
  totalMs: number;
  /** CPM budget plus the selected punctuation pauses, before display floors. */
  requestedMs: number;
  /** Overhead retained from legacy's per-unit display floors. */
  minimumOverheadMs: number;
  minimumRequiredMs: number;
  infeasibleCpm: boolean;
  minimumUnits: number;
  effectiveCpm: number;
}

/** Allocate one document budget with d_i = max(100, scale * weight_i).
 * Low weights are fixed at the floor before normalizing the remaining weights.
 * Pauses stay outside that budget; static units never receive timed duration.
 */
export function buildPaceTimeline(units: readonly ReadingUnit[], settings: PaceSettings): PaceTimeline {
  const durations = units.map(unit => durationMs(unit, settings));
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  const cpm = boundedCpm(settings.cpm);
  let displayBudget = 0, pauseBudget = 0, characters = 0, textUnits = 0;
  const weighted: Array<{ index: number; weight: number }> = [];
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit.kind === 'static') continue;
    textUnits++;
    const pause = settings.punctuationPause ? pauses[unit.pause] : 0;
    pauseBudget += pause;
    displayBudget += durations[index] - pause;
    characters += unit.characters;
    if (settings.readingPace === 'text-load') weighted.push({ index, weight: unit.characters * textLoad(unit.text).multiplier });
  }
  if (weighted.length > 0) {
    weighted.sort((left, right) => left.weight - right.weight);
    let budget = displayBudget;
    let weight = weighted.reduce((sum, item) => sum + item.weight, 0);
    let firstFree = 0;
    // No spread/argument expansion: a long document may contain many units.
    for (; firstFree < weighted.length; firstFree++) {
      const item = weighted[firstFree];
      if (item.weight > 0 && budget * item.weight / weight >= MIN_DISPLAY_MS) break;
      durations[item.index] = MIN_DISPLAY_MS;
      budget -= MIN_DISPLAY_MS;
      weight -= item.weight;
    }
    for (let i = firstFree; i < weighted.length; i++) durations[weighted[i].index] = Math.max(MIN_DISPLAY_MS, budget * weighted[i].weight / weight);
    // Correct only floating-point residue, using the largest free allocation.
    const allocated = weighted.reduce((sum, item) => sum + durations[item.index], 0);
    const largest = weighted.at(-1)!;
    durations[largest.index] = Math.max(MIN_DISPLAY_MS, durations[largest.index] + displayBudget - allocated);
    for (const { index } of weighted) if (settings.punctuationPause) durations[index] += pauses[units[index].pause];
  }
  const requestedDisplay = 60_000 * characters / cpm;
  let minimumUnits = 0;
  for (let i = 0; i < units.length; i++) if (units[i].kind !== 'static'
    && durations[i] - (settings.punctuationPause ? pauses[units[i].pause] : 0) <= MIN_DISPLAY_MS + 1e-7) minimumUnits++;
  return {
    durations, totalMs, requestedMs: requestedDisplay + pauseBudget,
    minimumOverheadMs: Math.max(0, displayBudget - requestedDisplay), minimumUnits,
    minimumRequiredMs: MIN_DISPLAY_MS * textUnits + pauseBudget,
    infeasibleCpm: 60_000 * characters < MIN_DISPLAY_MS * textUnits * cpm,
    effectiveCpm: totalMs > 0 ? 60_000 * characters / totalMs : 0,
  };
}
