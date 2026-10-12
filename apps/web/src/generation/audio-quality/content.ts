import type { AsrCandidate, ContentEvidence, InspectionIssue, ReadingAlternative } from './contracts';
import { SPELLINGS, SPELLINGS_VERSION } from './spellings.generated';

import { foldedCharacters } from './text';
export { foldedCharacters } from './text';

const fold = (text: string) => foldedCharacters(text).map(part => part.text).join('');
const vocabulary = new Map<string, Array<{ surface: string; alternatives: string[] }>>();
for (const [surface, alternatives] of Object.entries(SPELLINGS)) {
  const normalized = fold(surface);
  const key = normalized[0];
  if (!key) continue;
  const entries = vocabulary.get(key) ?? [];
  entries.push({ surface: normalized, alternatives: [...new Set(alternatives.map(fold).filter(Boolean))] }); vocabulary.set(key, entries);
}
for (const entries of vocabulary.values()) entries.sort((a, b) => b.surface.length - a.surface.length);

interface Edge { from: number; to: number; text: string; start: number; end: number }
interface Edit { kind: 'match' | 'delete' | 'insert' | 'substitute'; text: string; start: number; end: number }

/** Minimum edit path through bounded alternatives, without enumerating sentence combinations. */
export function spellingDistance(text: string, hypothesis: string, alternatives: ReadingAlternative[] = []): { distance: number; matched: number; reference: string; edits: Edit[] } | undefined {
  const chars = foldedCharacters(text), heard = [...fold(hypothesis)];
  if (!chars.length || chars.length > 800 || heard.length > 1600) return;
  const edges: Edge[] = []; let nodes = 1, current = 0;
  for (let offset = 0; offset < chars.length;) {
    const explicit = alternatives.find(a => a.start === chars[offset].start && a.end > a.start);
    const suffix = chars.slice(offset).map(c => c.text).join('');
    const entry = vocabulary.get(chars[offset].text)?.find(e => suffix.startsWith(e.surface));
    let count = entry ? [...entry.surface].length : 1;
    if (explicit) count = chars.slice(offset).filter(c => c.end <= explicit.end).length;
    if (!count) count = 1;
    const start = chars[offset].start, end = chars[offset + count - 1].end;
    const surface = chars.slice(offset, offset + count).map(c => c.text).join('');
    const options = [...new Set([surface, ...(explicit ? [fold(explicit.text)] : entry?.alternatives ?? [])])].filter(Boolean).slice(0, 17);
    const paths = options.map(option => ({ option: [...option], ids: Array.from({ length: [...option].length - 1 }, () => nodes++) }));
    const next = nodes++;
    for (const { option, ids } of paths) {
      const chain = [current, ...ids, next];
      option.forEach((character, i) => edges.push({ from: chain[i], to: chain[i + 1], text: character,
        start: option.join('') === surface ? chars[offset + i].start : start, end: option.join('') === surface ? chars[offset + i].end : end }));
    }
    current = next; offset += count;
  }
  const width = heard.length + 1, cells = nodes * width;
  if (cells > 2_000_000) return;
  const scores = new Uint16Array(cells).fill(65535), previous = new Int32Array(cells).fill(-1), used = new Int32Array(cells).fill(-1), operation = new Uint8Array(cells);
  const substitutions = new Uint16Array(cells).fill(65535), matches = new Uint16Array(cells);
  const incoming: Edge[][] = Array.from({ length: nodes }, () => []);
  const edgeIds = new Map<Edge, number>(); edges.forEach((edge, i) => { incoming[edge.to].push(edge); edgeIds.set(edge, i); });
  scores[0] = 0; substitutions[0] = 0;
  for (let node = 0; node < nodes; node++) {
    for (let j = 0; j < width; j++) {
      const cell = node * width + j;
      const relax = (from: number, cost: number, op: number, edge = -1) => {
        const distance = scores[from] + cost, subs = substitutions[from] + (op === 4 ? 1 : 0), matched = matches[from] + (op === 1 ? 1 : 0);
        if (distance < scores[cell] || (distance === scores[cell] && (subs < substitutions[cell] || (subs === substitutions[cell] && matched > matches[cell])))) {
          scores[cell] = distance; substitutions[cell] = subs; matches[cell] = matched; previous[cell] = from; operation[cell] = op; used[cell] = edge;
        }
      };
      for (const edge of incoming[node]) {
        const id = edgeIds.get(edge)!;
        if (j) relax(edge.from * width + j - 1, edge.text === heard[j - 1] ? 0 : 1, edge.text === heard[j - 1] ? 1 : 4, id);
        relax(edge.from * width + j, 1, 2, id);
      }
      if (j) relax(cell - 1, 1, 3);
    }
  }
  let cell = current * width + heard.length;
  const distance = scores[cell], edits: Edit[] = [];
  while (cell > 0 && previous[cell] >= 0) {
    const op = operation[cell], edge = edges[used[cell]];
    edits.push({ kind: op === 1 ? 'match' : op === 2 ? 'delete' : op === 3 ? 'insert' : 'substitute',
      text: op === 3 ? heard[cell % width - 1] : edge.text, start: edge?.start ?? -1, end: edge?.end ?? -1 });
    cell = previous[cell];
  }
  edits.reverse();
  // Insertions have no exact source character. Present the nearest source anchor explicitly.
  edits.forEach((edit, i) => { if (edit.start < 0) { const anchor = edits.slice(0, i).findLast(e => e.start >= 0) ?? edits.slice(i + 1).find(e => e.start >= 0); edit.start = anchor?.start ?? 0; edit.end = anchor?.end ?? text.length; } });
  return { distance, matched: edits.filter(e => e.kind === 'match').length, reference: edits.filter(e => e.kind !== 'insert').map(e => e.text).join(''), edits };
}

export function compareContent(text: string, candidate?: AsrCandidate, reason = '音声のみの認識を実行していません。', alternatives: ReadingAlternative[] = [], qualification: ContentEvidence['qualification'] = 'unvalidated'): { evidence: ContentEvidence; issues: InspectionIssue[] } {
  const evidence: ContentEvidence = { status: 'indeterminate', method: candidate ? 'audio-only-greedy-ctc' : 'not-run', spellingVersion: SPELLINGS_VERSION, reason };
  const issues: InspectionIssue[] = [];
  if (!candidate) return { evidence, issues };
  Object.assign(evidence, { modelVersion: candidate.version, candidate: candidate.text, tokenScore: candidate.tokenScore, qualification });
  const comparison = spellingDistance(text, candidate.text, alternatives);
  if (!comparison) { evidence.reason = '本文または認識候補が空、または許容表記比較のサイズ上限を超えました。'; return { evidence, issues }; }
  Object.assign(evidence, { editDistance: comparison.distance, matchedCharacters: comparison.matched, referenceCharacters: [...comparison.reference].length });
  evidence.reason = comparison.distance === 0 ? '許容表記の範囲で候補が一致しました。既存ASRの実用精度が未確立のため、内容の正しさは判定不能です。' : '本文と認識候補に差があります。ASR誤りと音声の誤りを区別できないため、内容の正しさは判定不能です。';
  if (qualification === 'unvalidated' && comparison.distance > 0) evidence.reason = 'ASRの実用精度が未確立のため、候補との差を音声異常warningに採用できません。内容は判定不能です。差分は聴き直す参考として表示します。';
  if (candidate.tokenScore < .6 || comparison.matched < 6 || comparison.matched / Math.max(1, comparison.reference.length) < .55) return { evidence, issues };
  const groups: Edit[][] = [];
  for (const edit of comparison.edits) {
    if (edit.kind === 'match') { if (groups.at(-1)?.length) groups.push([]); }
    else { if (!groups.length) groups.push([]); groups.at(-1)!.push(edit); }
  }
  for (const group of groups.filter(g => g.length >= 3).slice(0, 10)) {
    const deleted = group.filter(e => e.kind === 'delete');
    const inserted = group.filter(e => e.kind === 'insert');
    const repetition = inserted.length === group.length && comparison.reference.includes(inserted.map(e => e.text).join(''));
    const omission = deleted.length === group.length;
    if (!repetition && !omission) continue; // Small spelling/ASR substitutions must not masquerade as skipped speech.
    const message = omission ? `認識候補にない部分: ${deleted.map(e => e.text).join('')}` : `認識候補の追加部分: ${inserted.map(e => e.text).join('')}`;
    let start = Math.min(...group.map(e => e.start)), end = Math.max(...group.map(e => e.end));
    if (repetition) {
      const repeated = inserted.map(e => e.text).join(''), index = comparison.reference.indexOf(repeated);
      const referenceEdits = comparison.edits.filter(e => e.kind !== 'insert');
      const begin = [...comparison.reference.slice(0, index)].length;
      const original = referenceEdits.slice(begin, begin + [...repeated].length);
      start = Math.min(...original.map(e => e.start)); end = Math.max(...original.map(e => e.end));
    }
    (evidence.differences ??= []).push({ kind: omission ? 'omission' : 'repetition', message, start, end });
    if (qualification !== 'unvalidated') issues.push({ severity: 'warning', code: omission ? 'possible-omission' : 'possible-repetition',
      message: `${omission ? '読み飛ばし' : '繰り返し'}の疑い（${message}）。ASR誤りの可能性があります。`, source: { blockId: '', start, end } });
  }
  if (issues.length) evidence.status = 'review';
  return { evidence, issues };
}
