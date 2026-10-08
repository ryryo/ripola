import { ALIGNMENT_NORMALIZE_VERSION, MIN_ALIGNMENT_SCORE, type AlignmentUnitResult, type SavedAlignment } from '../contracts';
import type { ReadingDocument } from '../../reader/model';
import type { AlignmentRuntimeRequest, AlignmentRuntimeResult, AlignmentRuntimeSegment } from './alignment-adapter';
import { acousticTiming, validSpeechActivity } from './alignment-acoustic';
import { mergedRanges, type NormalizedSpeech, type PreparedSpeech } from './speech-source';

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function boundary(text: string, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= text.length && !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
}
export function validateAlignmentResult(result: AlignmentRuntimeResult, request: AlignmentRuntimeRequest, durationSeconds: number): void {
  if (!result || result.schemaVersion !== 1 || result.offsetUnit !== 'utf16' || result.alignerVersion !== request.alignerVersion || result.normalizeVersion !== request.normalizeVersion
    || result.normalizedText !== request.normalizedText || !finite(result.durationSeconds) || Math.abs(result.durationSeconds - durationSeconds) > 0.05
    || !Array.isArray(result.segments) || result.segments.length > 20_000) throw new Error('alignment応答の本文・version・音声長が一致しません。');
  if (result.speechActivity && !validSpeechActivity(result.speechActivity, durationSeconds)) throw new Error('音声活動区間が正しくありません。');
  let previousTextEnd = 0;
  let previousTimeEnd = 0;
  for (const segment of result.segments) {
    if (!segment || !boundary(result.normalizedText, segment.start) || !boundary(result.normalizedText, segment.end) || segment.start >= segment.end || segment.start < previousTextEnd
      || !finite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1 || !['aligned', 'low-confidence', 'unmatched'].includes(segment.status)) throw new Error('alignmentの文字位置またはscoreが正しくありません。');
    previousTextEnd = segment.end;
    if (segment.startSeconds !== undefined || segment.endSeconds !== undefined || segment.status === 'aligned') {
      if (!finite(segment.startSeconds) || !finite(segment.endSeconds) || segment.startSeconds < 0 || segment.endSeconds <= segment.startSeconds || segment.endSeconds > durationSeconds + 0.001) throw new Error('alignmentの時刻が音声の範囲外です。');
      if (segment.status === 'aligned') {
        if (segment.startSeconds + 0.001 < previousTimeEnd) throw new Error('alignmentの時刻順序が正しくありません。');
        previousTimeEnd = segment.endSeconds;
      }
    }
  }
}

interface ProjectedUnit { value: AlignmentUnitResult; indices: number[] }
function rangeOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean { return a.start < b.end && a.end > b.start; }
function scoreFor(segments: AlignmentRuntimeSegment[]): number {
  const weight = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  return weight ? segments.reduce((sum, segment) => sum + segment.confidence * (segment.end - segment.start), 0) / weight : 0;
}

export function projectAlignment(input: {
  key: string;
  audioHash: string;
  alignerVersion: string;
  document: ReadingDocument;
  blockId: string;
  start: number;
  end: number;
  speech: PreparedSpeech;
  normalized: NormalizedSpeech;
  result: AlignmentRuntimeResult;
}): SavedAlignment {
  const { result, normalized, speech } = input;
  const units: ProjectedUnit[] = input.document.units.filter((unit) => unit.blockId === input.blockId && unit.start < input.end && unit.end > input.start && unit.kind === 'text').map((unit) => {
    const spokenRanges = mergedRanges(speech.sourceSpans.filter((span) => rangeOverlap(span, unit)).map((span) => ({ start: span.spokenStart, end: span.spokenEnd })));
    const normalizedRanges = mergedRanges(normalized.spans.filter((span) => spokenRanges.some((range) => rangeOverlap({ start: span.spokenStart, end: span.spokenEnd }, range))).map(({ start, end }) => ({ start, end })));
    const indices = result.segments.flatMap((segment, index) => normalizedRanges.some((range) => rangeOverlap(range, segment)) ? [index] : []);
    const segments = indices.map((index) => result.segments[index]);
    const expected = normalizedRanges.reduce((sum, range) => sum + range.end - range.start, 0);
    const covered = mergedRanges(normalizedRanges.flatMap((range) => segments.map((segment) => ({ start: Math.max(range.start, segment.start), end: Math.min(range.end, segment.end) })))).reduce((sum, range) => sum + range.end - range.start, 0);
    const score = scoreFor(segments);
    const unmatched = !expected || covered < expected || segments.some((segment) => segment.status === 'unmatched');
    const low = segments.some((segment) => segment.status !== 'aligned' || segment.confidence < MIN_ALIGNMENT_SCORE) || score < MIN_ALIGNMENT_SCORE;
    const status = unmatched ? 'unmatched' : low ? 'low-confidence' : 'aligned';
    const timed = segments.filter((segment) => segment.startSeconds !== undefined && segment.endSeconds !== undefined);
    const value: AlignmentUnitResult = {
      unitId: unit.id, blockId: unit.blockId, start: Math.max(unit.start, input.start), end: Math.min(unit.end, input.end), spokenRanges, normalizedRanges, score, status,
      ...(status !== 'unmatched' && timed.length ? { startSeconds: Math.min(...timed.map((segment) => segment.startSeconds!)), endSeconds: Math.max(...timed.map((segment) => segment.endSeconds!)) } : {}),
      ...(status !== 'aligned' ? { reason: !expected ? 'punctuation-or-silence' : unmatched ? 'unmatched-transcript' : 'low-ctc-score' } : {}),
    };
    return { value, indices };
  });
  const groups: ProjectedUnit[][] = [];
  for (const unit of units) {
    const shared = groups.findIndex((group) => unit.indices.some((index) => group.some((previous) => previous.indices.includes(index))));
    if (shared >= 0) groups.push([...groups.splice(shared).flat(), unit]);
    else groups.push([unit]);
  }
  const cues: SavedAlignment['cues'] = [];
  for (const group of groups) {
    if (group.some(({ value }) => value.status !== 'aligned' || value.startSeconds === undefined || value.endSeconds === undefined)) {
      for (const unit of group) if (unit.value.status === 'aligned') { unit.value.status = 'low-confidence'; unit.value.reason = 'shared-reading-unreliable'; }
      continue;
    }
    const first = group[0].value;
    const startSeconds = Math.min(...group.map(({ value }) => value.startSeconds!));
    const endSeconds = Math.max(...group.map(({ value }) => value.endSeconds!));
    const previous = cues[cues.length - 1];
    if (previous && startSeconds + 0.001 < previous.endSeconds) {
      for (const unit of group) { unit.value.status = 'low-confidence'; unit.value.reason = 'overlapping-unit-times'; }
      continue;
    }
    cues.push({ unitId: first.unitId, unitIds: group.map(({ value }) => value.unitId), blockId: first.blockId, start: Math.min(...group.map(({ value }) => value.start)), end: Math.max(...group.map(({ value }) => value.end)), startSeconds, endSeconds, score: Math.min(...group.map(({ value }) => value.score ?? 0)) });
  }
  const runtimeWarningMessages: Record<string, string> = {
    'runtime-size-limit': 'ローカルruntimeの上限（60秒／512文字）を超えるためフレーズの発話時刻は付けません。表示時刻は推定で補います。',
    'unknown-vocabulary-character': 'モデル語彙にない文字を含むため推測時刻を作りません。',
    'silence-or-too-quiet': '無音または非常に小さい音声のためフレーズ時刻を作りません。',
    'no-valid-ctc-path': '既知原稿と対応するCTC経路を確認できません。',
  };
  const runtimeWarnings = Array.isArray(result.warnings) ? result.warnings.flatMap((warning) => typeof warning === 'string' && runtimeWarningMessages[warning] ? [runtimeWarningMessages[warning]] : []) : [];
  const acoustic = acousticTiming(units.map(unit => unit.value), result);
  const aligned = units.filter(({ value }) => value.status === 'aligned').length;
  const status = cues.length === 0 ? 'fallback' : aligned === units.length ? 'aligned' : 'partial';
  return {
    schemaVersion: 1, key: input.key, audioHash: input.audioHash, alignerVersion: input.alignerVersion, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION,
    precision: cues.length ? 'phrase' : 'sentence', method: cues.length ? 'forced-alignment' : 'sentence-fallback', status, score: scoreFor(result.segments), ...(acoustic ? { acoustic } : {}), cues, units: units.map(({ value }) => value),
    ...(status !== 'aligned' ? { reason: cues.length ? 'some-units-unreliable' : 'no-reliable-phrase-cues' } : {}),
    warnings: [...runtimeWarnings, 'CTC scoreは時刻精度の確率ではありません。低信頼・未一致・無音部分の発話時刻は採用せず、表示用推定を使います。'],
  };
}
