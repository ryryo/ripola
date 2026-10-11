import { createHash } from 'node:crypto';
import type { GenerationChunkPlanningInput, GenerationChunkPlanningResult, GenerationChunkSpan } from '../contracts';
import { prepareSpeech } from './speech-source';
import { CHUNK_PLANNER_VERSION, estimateSpeechSeconds, planSpeechChunks, type ChunkPlannerPolicy, type PlannerRange } from './chunk-planner';

/** Provider ceilings and application planning budgets are separate from quality targets. */
function policyFor(input: GenerationChunkPlanningInput): ChunkPlannerPolicy {
  const { capabilities, options } = input;
  const irodori = options.provider === 'irodori';
  const speed = irodori ? options.irodori?.speed ?? 1 : 1;
  const hardSeconds = Math.min(45, (capabilities.maxAudioSeconds ?? (irodori ? 30 : 45)) * (irodori ? 0.8 * speed : 1));
  const preferred = Math.min(hardSeconds, irodori ? 16 * speed : options.provider === 'gemini' ? 28 : 18,
    capabilities.recommendedMaxCharacters === undefined ? Infinity : capabilities.recommendedMaxCharacters * 0.17);
  return { version: `ripola-${options.provider}-budget-v2`,
    hard: { maxCharacters: Math.min(3000, capabilities.maxCharacters ?? 3000), maxUtf16: 3000, maxEstimatedSeconds: hardSeconds,
      ...(capabilities.maxTextTokens === undefined ? {} : { maxTokenUpperBound: capabilities.maxTextTokens }) },
    soft: { targetSeconds: Math.min(preferred, (irodori ? 12 : options.provider === 'gemini' ? 18 : 12) * speed),
      minimumSeconds: Math.min(4 * speed, preferred), preferredMaxSeconds: preferred },
    requestCost: options.provider === 'gemini' ? 12 : 8, estimatedRequestOverheadSeconds: 0.5 };
}

/** The foundation core owns final IDs, speech keys, selection and source validation. */
export function automaticChunkPlanner(input: GenerationChunkPlanningInput): GenerationChunkPlanningResult {
  const policy = policyFor(input);
  const spans: GenerationChunkSpan[] = [];
  let settingsFingerprint = '';
  for (const block of input.document.blocks) {
    if (block.kind === 'code' || block.kind === 'table' || !block.text.length) continue;
    if (!input.options.readings.length && !block.ruby.length) {
      const plan = planSpeechChunks({ blockId: block.id, text: block.text }, policy);
      settingsFingerprint = plan.settingsHash;
      for (const { start, end } of plan.chunks) spans.push({ blockId: block.id, start, end });
      continue;
    }
    // Without annotations this is simply the usual pasted text. With existing
    // ruby/dictionary use the persisted transcript mapping, preserving whole readings.
    const prepared = prepareSpeech(block, 0, block.text.length, input.options.readings);
    if (!prepared.spokenText) {
      const plan = planSpeechChunks({ blockId: block.id, text: block.text, protectedRanges: block.ruby.map(({ start, end }) => ({ start, end })) }, policy);
      settingsFingerprint = plan.settingsHash;
      for (const { start, end } of plan.chunks) spans.push({ blockId: block.id, start, end });
      continue;
    }
    const protectedRanges: PlannerRange[] = [];
    const sourceProtected: PlannerRange[] = block.ruby.map(({ start, end }) => ({ start, end }));
    const map = prepared.sourceSpans;
    for (let index = 0; index < map.length;) {
      const span = map[index]; let end = index + 1;
      if (span.kind !== 'identity') {
        while (end < map.length && map[end].kind === span.kind && map[end].start === span.start && map[end].end === span.end) end++;
        protectedRanges.push({ start: span.spokenStart, end: map[end - 1].spokenEnd });
        sourceProtected.push({ start: span.start, end: span.end });
      }
      index = end;
    }
    // Also protect editorial/unknown ruby that is displayed but not substituted.
    for (const ruby of block.ruby) {
      let low = 0; let high = map.length;
      while (low < high) { const middle = (low + high) >>> 1; if (map[middle].end <= ruby.start) low = middle + 1; else high = middle; }
      const start = low; high = map.length;
      while (low < high) { const middle = (low + high) >>> 1; if (map[middle].start < ruby.end) low = middle + 1; else high = middle; }
      if (start < low) protectedRanges.push({ start: map[start].spokenStart, end: map[low - 1].spokenEnd });
    }
    const plan = planSpeechChunks({ blockId: block.id, text: prepared.spokenText, protectedRanges }, policy);
    settingsFingerprint = plan.settingsHash;
    let sourceStart = 0; let mapCursor = 0;
    for (const [index, chunk] of plan.chunks.entries()) {
      while (mapCursor < map.length && map[mapCursor].spokenEnd <= chunk.end) mapCursor++;
      const sourceEnd = index === plan.chunks.length - 1 ? block.text.length : map[mapCursor - 1].end;
      if (sourceEnd <= sourceStart) throw new Error('発話本文から元本文の範囲を復元できません。');
      if (sourceEnd - sourceStart > 3000) {
        // Readings can shorten a large source to a tiny utterance. Subdivide that
        // source under the storage ceiling, keeping each complete replacement.
        const text = block.text.slice(sourceStart, sourceEnd);
        const sourceSeconds = Math.max(policy.hard.maxEstimatedSeconds, estimateSpeechSeconds(text));
        const sourcePlan = planSpeechChunks({ blockId: block.id, text,
          protectedRanges: sourceProtected.filter(span => span.start >= sourceStart && span.end <= sourceEnd).map(span => ({ start: span.start - sourceStart, end: span.end - sourceStart })) },
        { ...policy, hard: { maxCharacters: 3000, maxUtf16: 3000, maxEstimatedSeconds: sourceSeconds },
          // Every child is already inside a fitting utterance. Raw-source duration
          // only balances storage spans here; it must not reward tiny utterances.
          soft: { ...policy.soft, targetSeconds: sourceSeconds, preferredMaxSeconds: sourceSeconds } });
        for (const part of sourcePlan.chunks) spans.push({ blockId: block.id, start: sourceStart + part.start, end: sourceStart + part.end });
      } else spans.push({ blockId: block.id, start: sourceStart, end: sourceEnd });
      sourceStart = sourceEnd;
    }
  }
  // Empty/whitespace-only documents still pin the policy; core decides audibility.
  if (!settingsFingerprint) settingsFingerprint = planSpeechChunks({ blockId: 'empty', text: '' }, policy).settingsHash;
  return { spans, version: CHUNK_PLANNER_VERSION,
    settingsFingerprint: createHash('sha256').update(JSON.stringify({ settingsHash: settingsFingerprint, providerVersion: input.providerVersion })).digest('hex') };
}
