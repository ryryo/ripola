import { createHash } from 'node:crypto';

/** These are planning budgets. Measured audio duration is owned by the provider/cache. */
export interface ChunkPlannerPolicy {
  version: string;
  hard: { maxCharacters: number; maxUtf16?: number; maxUtf8Bytes?: number; maxTokenUpperBound?: number; maxEstimatedSeconds: number };
  soft: { targetSeconds: number; minimumSeconds: number; preferredMaxSeconds: number };
  /** Relative objective cost per request, not a price or a measured latency. */
  requestCost: number;
  /** A scenario for comparison only; never copied from an upstream machine's benchmark. */
  estimatedRequestOverheadSeconds: number;
}
export interface PlannerRange { start: number; end: number }
export interface ChunkPlannerInput {
  blockId: string;
  text: string;
  /** Optional indivisible source spans (e.g. existing ruby); no readings are required. */
  protectedRanges?: readonly PlannerRange[];
}
export type PlannerBoundary = 'end' | 'paragraph' | 'sentence' | 'clause' | 'bracket' | 'space' | 'fallback';
export interface PlannedSpeechChunk extends PlannerRange {
  id: string;
  blockId: string;
  text: string;
  estimatedSeconds: number;
  characters: number;
  utf8Bytes: number;
  tokenUpperBound: number;
  boundary: PlannerBoundary;
}
export interface SpeechChunkPlan {
  version: string;
  settingsHash: string;
  hash: string;
  chunks: PlannedSpeechChunk[];
  estimatedSeconds: number;
  estimatedRequestOverheadSeconds: number;
  objectiveCost: number;
}

export const CHUNK_PLANNER_VERSION = 'speech-chunk-dp-v1';
// Changes to duration heuristics, candidates, costs or tie breaking must bump the version.
const FALLBACK_STRIDE = 8;
const EPSILON = 1e-9;
const opening = new Set([...'「『（([【〈《〔｛{“‘']);
const closing = new Set([...'」』）)]】〉》〕｝}”’']);
const sentence = /^[。！？!?]$/u;
const clause = /^[、,，;；:：]$/u;
const whitespace = /^\s+$/u;
const latin = /^[\p{Script=Latin}\p{Mark}]+$/u;
const digit = /^[0-9０-９]$/u;
const punctuation = /^[\p{Punctuation}\p{Symbol}]+$/u;
const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function validatePolicy(policy: ChunkPlannerPolicy): void {
  if (!policy.version || !Number.isSafeInteger(policy.hard.maxCharacters) || policy.hard.maxCharacters < 1
    || (policy.hard.maxUtf8Bytes !== undefined && (!Number.isSafeInteger(policy.hard.maxUtf8Bytes) || policy.hard.maxUtf8Bytes < 1))
    || (policy.hard.maxUtf16 !== undefined && (!Number.isSafeInteger(policy.hard.maxUtf16) || policy.hard.maxUtf16 < 1))
    || (policy.hard.maxTokenUpperBound !== undefined && (!Number.isSafeInteger(policy.hard.maxTokenUpperBound) || policy.hard.maxTokenUpperBound < 2))
    || !positive(policy.hard.maxEstimatedSeconds) || !positive(policy.soft.targetSeconds) || !positive(policy.soft.minimumSeconds)
    || !positive(policy.soft.preferredMaxSeconds) || policy.soft.minimumSeconds > policy.soft.targetSeconds
    || policy.soft.targetSeconds > policy.soft.preferredMaxSeconds || policy.soft.preferredMaxSeconds > policy.hard.maxEstimatedSeconds
    || !Number.isFinite(policy.requestCost) || policy.requestCost < 0
    || !Number.isFinite(policy.estimatedRequestOverheadSeconds) || policy.estimatedRequestOverheadSeconds < 0) {
    throw new Error('音声分割の長さ・要求コスト設定が正しくありません。');
  }
}

/** Additive, integer-ms surface estimate: no ruby, dictionary, tokenizer or TTS call. */
function durationMs(character: string): number {
  if (/\r|\n/u.test(character)) return 350;
  if (whitespace.test(character)) return 20;
  if (sentence.test(character) || character === '.') return 350;
  if (clause.test(character)) return 180;
  if (opening.has(character) || closing.has(character)) return 0;
  if (digit.test(character)) return 250;
  if (latin.test(character)) return 80;
  if (punctuation.test(character)) return 100;
  return 170;
}

/** The comparison script uses exactly the same estimator for legacy and planned spans. */
export function estimateSpeechSeconds(text: string): number {
  let ms = 0;
  for (const part of graphemes.segment(text)) ms += durationMs(part.segment);
  return ms / 1000;
}

interface Point {
  offset: number;
  characters: number;
  bytes: number;
  tokenBytes: number;
  ms: number;
  boundary: PlannerBoundary;
  penalty: number;
  beforeClosing: boolean;
}
function metric(start: Point, end: Point) {
  return { characters: end.characters - start.characters, utf8Bytes: end.bytes - start.bytes, tokenUpperBound: end.tokenBytes - start.tokenBytes + 1, estimatedSeconds: (end.ms - start.ms) / 1000 };
}
function fits(start: Point, end: Point, policy: ChunkPlannerPolicy): boolean {
  return end.characters - start.characters <= policy.hard.maxCharacters
    && (policy.hard.maxUtf16 === undefined || end.offset - start.offset <= policy.hard.maxUtf16)
    && (policy.hard.maxUtf8Bytes === undefined || end.bytes - start.bytes <= policy.hard.maxUtf8Bytes)
    && (policy.hard.maxTokenUpperBound === undefined || end.tokenBytes - start.tokenBytes + 1 <= policy.hard.maxTokenUpperBound)
    && end.ms - start.ms <= policy.hard.maxEstimatedSeconds * 1000 + EPSILON;
}

function boundary(left: string, right: string, previous: PlannerBoundary, depth: number, quoteOpen: boolean): Pick<Point, 'boundary' | 'penalty' | 'beforeClosing'> {
  const beforeClosing = closing.has(right) || right === '"' && quoteOpen;
  const afterOpening = opening.has(left) || left === '"' && quoteOpen;
  let kind: PlannerBoundary = 'fallback';
  if (/\r|\n/u.test(left)) kind = 'paragraph';
  else if (sentence.test(left) || left === '.' && (whitespace.test(right) || !right)) kind = 'sentence';
  else if (clause.test(left)) kind = 'clause';
  else if (closing.has(left) || left === '"' && !quoteOpen) kind = previous === 'sentence' || previous === 'clause' ? previous : 'bracket';
  else if (whitespace.test(left) && !whitespace.test(right)) kind = previous === 'sentence' || previous === 'clause' || previous === 'paragraph' ? previous : 'space';
  const costs: Record<PlannerBoundary, number> = { end: 0, paragraph: 0.25, sentence: 0, clause: 2, bracket: 3, space: 5, fallback: 18 };
  // Prefer the end of a quotation and keep punctuation with the preceding source.
  return { boundary: kind, beforeClosing, penalty: costs[kind] + Math.min(depth, 4) * 3 + (beforeClosing || afterOpening ? 24 : 0) };
}

function softProtectedRanges(text: string): PlannerRange[] {
  const patterns = [
    /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gu,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
    /[0-9０-９]{4}年[0-9０-９]{1,2}月[0-9０-９]{1,2}日/gu,
    /[0-9０-９]{4}[-/／][0-9０-９]{1,2}[-/／][0-9０-９]{1,2}/gu,
    /[0-9０-９]{1,2}[:：][0-9０-９]{2}(?:[:：][0-9０-９]{2})?/gu,
    /[+−$€£￥¥-]?[vV]?[0-9０-９]+(?:[.,，．][0-9０-９]+)*(?:[%％円]|[A-Za-z]+)?/gu,
    /[A-Za-z_][A-Za-z0-9_]*(?:[.'’-][A-Za-z0-9_]+)*/gu,
  ];
  return patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => {
    let end = match.index + match[0].length;
    if (pattern === patterns[0]) while (end > match.index && /[.,;!?)]/u.test(text[end - 1])) end--;
    return { start: match.index, end };
  }));
}

function canonicalPolicy(policy: ChunkPlannerPolicy): ChunkPlannerPolicy {
  // Field order and irrelevant caller properties cannot change identity.
  return { version: policy.version,
    hard: { maxCharacters: policy.hard.maxCharacters, ...(policy.hard.maxUtf16 === undefined ? {} : { maxUtf16: policy.hard.maxUtf16 }), ...(policy.hard.maxUtf8Bytes === undefined ? {} : { maxUtf8Bytes: policy.hard.maxUtf8Bytes }),
      ...(policy.hard.maxTokenUpperBound === undefined ? {} : { maxTokenUpperBound: policy.hard.maxTokenUpperBound }), maxEstimatedSeconds: policy.hard.maxEstimatedSeconds },
    soft: { targetSeconds: policy.soft.targetSeconds, minimumSeconds: policy.soft.minimumSeconds, preferredMaxSeconds: policy.soft.preferredMaxSeconds },
    requestCost: policy.requestCost, estimatedRequestOverheadSeconds: policy.estimatedRequestOverheadSeconds };
}

function mergeRanges(ranges: readonly PlannerRange[]): PlannerRange[] {
  const merged: PlannerRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Pure source-span planning. Every source character belongs to exactly one ordered chunk. */
export function planSpeechChunks(input: ChunkPlannerInput, requestedPolicy: ChunkPlannerPolicy): SpeechChunkPlan {
  validatePolicy(requestedPolicy);
  if (!input.blockId || typeof input.text !== 'string') throw new Error('音声分割の本文・block IDが正しくありません。');
  const policy = canonicalPolicy(requestedPolicy);
  const settingsHash = hash({ version: CHUNK_PLANNER_VERSION, policy: { version: policy.version, hard: policy.hard, soft: policy.soft, requestCost: policy.requestCost } });
  const parts = [...graphemes.segment(input.text)];
  const points: Point[] = [{ offset: 0, characters: 0, bytes: 0, tokenBytes: 0, ms: 0, boundary: 'fallback', penalty: 0, beforeClosing: false }];
  let depth = 0; let quoteOpen = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]; const previous = points[index]; const right = parts[index + 1]?.segment ?? '';
    if (opening.has(part.segment)) depth++;
    if (closing.has(part.segment)) depth = Math.max(0, depth - 1);
    if (part.segment === '"') { quoteOpen = !quoteOpen; depth = Math.max(0, depth + (quoteOpen ? 1 : -1)); }
    const bytes = encoder.encode(part.segment).length;
    // Irodori's Unigram tokenizer can fall back to bytes and prepends one BOS.
    // Bound both raw and NFKC-expanded bytes; spaces become U+2581 and dots may
    // become an ellipsis. This deliberately needs no downloaded vocabulary.
    const tokenBytes = Math.max(bytes, encoder.encode(part.segment.normalize('NFKC').replaceAll(' ', '▁').replaceAll('.', '…')).length);
    points.push({ offset: part.index + part.segment.length, characters: previous.characters + [...part.segment].length,
      bytes: previous.bytes + bytes, tokenBytes: previous.tokenBytes + tokenBytes, ms: previous.ms + durationMs(part.segment),
      ...boundary(part.segment, right, previous.boundary, depth, quoteOpen) });
  }
  points[points.length - 1].boundary = 'end'; points[points.length - 1].penalty = 0;
  const pointByOffset = new Map(points.map((point, index) => [point.offset, index]));
  const forbidden = new Uint8Array(points.length);
  function protect(range: PlannerRange, required: boolean): void {
    const begin = pointByOffset.get(range.start); const finish = pointByOffset.get(range.end);
    if (begin === undefined || finish === undefined || finish <= begin) {
      if (required) throw new Error('音声分割の保護範囲は書記素境界上の非空範囲にしてください。');
      return;
    }
    if (!fits(points[begin], points[finish], policy)) {
      if (required) throw new Error('分割できないルビ等の範囲が音声providerの上限を超えています。本文か読みを短くしてください。');
      return; // A huge word/number/URL must still have a grapheme fallback.
    }
    forbidden.fill(1, begin + 1, finish);
  }
  for (const range of input.protectedRanges ?? []) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > input.text.length) {
      throw new Error('音声分割の保護範囲が正しくありません。');
    }
  }
  const requiredRanges = mergeRanges(input.protectedRanges ?? []);
  for (const range of requiredRanges) protect(range, true);
  // A lexical span can overlap ruby. Protect their union only if that union fits;
  // otherwise retain just the required spans so a long lexical chain has a path.
  for (const range of mergeRanges([...requiredRanges, ...softProtectedRanges(input.text)])) protect(range, false);
  // Sparse grapheme candidates keep a punctuation-free chapter bounded. Insert extra
  // candidates before a hard budget would be crossed, even when it is smaller than stride.
  const candidates: Point[] = [points[0]];
  let previousAllowed = 0; let lastAdded = 0;
  for (let index = 1; index < points.length; index++) {
    if (forbidden[index]) continue;
    if (!fits(points[previousAllowed], points[index], policy)) throw new Error('1書記素または保護範囲が音声providerの上限を超えています。');
    if (!fits(points[lastAdded], points[index], policy)) {
      if (lastAdded !== previousAllowed) candidates.push(points[previousAllowed]);
      lastAdded = previousAllowed;
    }
    const right = parts[index]?.segment ?? '';
    const natural = points[index].boundary !== 'fallback' && (!right || !points[index].beforeClosing && !sentence.test(right) && !clause.test(right) && !whitespace.test(right));
    if (natural || index === points.length - 1 || index - lastAdded >= FALLBACK_STRIDE) { candidates.push(points[index]); lastAdded = index; }
    previousAllowed = index;
  }
  const costs = new Float64Array(candidates.length); costs.fill(Infinity); costs[0] = 0;
  const counts = new Uint32Array(candidates.length);
  const parents = new Int32Array(candidates.length); parents.fill(-1);
  for (let end = 1; end < candidates.length; end++) {
    for (let start = end - 1; start >= 0; start--) {
      if (!fits(candidates[start], candidates[end], policy)) break; // Prefix budgets are monotone.
      const seconds = (candidates[end].ms - candidates[start].ms) / 1000;
      const short = Math.max(0, (policy.soft.minimumSeconds - seconds) / policy.soft.minimumSeconds);
      const long = Math.max(0, (seconds - policy.soft.preferredMaxSeconds) / policy.soft.preferredMaxSeconds);
      const target = (seconds - policy.soft.targetSeconds) / policy.soft.targetSeconds;
      const cost = costs[start] + policy.requestCost + candidates[end].penalty + 4 * short ** 2 + 30 * long ** 2 + 1.5 * target ** 2;
      const count = counts[start] + 1;
      if (cost < costs[end] - EPSILON || Math.abs(cost - costs[end]) <= EPSILON && (parents[end] < 0 || count < counts[end] || count === counts[end] && start < parents[end])) {
        costs[end] = cost; counts[end] = count; parents[end] = start;
      }
    }
    if (parents[end] < 0) throw new Error('音声providerの上限内で全文を分割できません。');
  }
  const chunks: PlannedSpeechChunk[] = [];
  for (let end = candidates.length - 1; end > 0;) {
    const start = parents[end]; const begin = candidates[start]; const finish = candidates[end];
    chunks.push({ id: `chunk-${hash([input.blockId, begin.offset, finish.offset]).slice(0, 24)}`, blockId: input.blockId,
      start: begin.offset, end: finish.offset, text: input.text.slice(begin.offset, finish.offset), ...metric(begin, finish), boundary: finish.boundary });
    end = start;
  }
  chunks.reverse();
  return { version: CHUNK_PLANNER_VERSION, settingsHash, hash: hash({ settingsHash, blockId: input.blockId, text: input.text, ranges: chunks.map(({ start, end }) => [start, end]) }), chunks,
    estimatedSeconds: points[points.length - 1].ms / 1000,
    estimatedRequestOverheadSeconds: chunks.length * policy.estimatedRequestOverheadSeconds,
    objectiveCost: costs[costs.length - 1] };
}
