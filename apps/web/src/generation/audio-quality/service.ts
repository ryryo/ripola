import { randomUUID } from 'node:crypto';
import type { AudioBookManifest, SavedAudioChunk } from '../contracts';
import { inspectAudioPresentation } from '../../reader/audio-presentation';
import { digest, LibraryDisk, requireId, requireKey } from '../core/disk';
import { readReadyAudio } from '../core/audio-cache';
import { prepareSpeech } from '../speech-source';
import { AUDIO_INSPECTION_VERSION, type AudioInspection, type AudioInspectionReport, type InspectSavedAudioInput, type ReadingAlternative, type SourceSpan, type ContentEvidence } from './contracts';
import { foldedCharacters } from './text';
import { inspectPcm } from './pcm';
import { decodeMp3, decodeWave, InspectionUnavailable, validCandidate, type AsrAdapter } from './runtime';
import { SPELLINGS_VERSION } from './spellings.generated';

function uninspectedContent(reason = '内容検査は実行していません。軽量検査では読み飛ばしや繰り返しを判定できません。'): ContentEvidence {
  return { status: 'indeterminate', method: 'not-run', spellingVersion: SPELLINGS_VERSION, reason };
}

type CachedInspection = Omit<AudioInspection, 'chunkId' | 'source' | 'key' | 'text'>;
interface ChunkText { text: string; source: SourceSpan; alternatives: ReadingAlternative[] }
function validCached(value: CachedInspection | undefined, audioHash: string, mediaHash: string, textHash: string): value is CachedInspection {
  return !!value && value.schemaVersion === 1 && value.inspectionVersion === AUDIO_INSPECTION_VERSION && value.audioHash === audioHash && value.mediaHash === mediaHash && value.textHash === textHash
    && ['warning', 'indeterminate', 'fatal'].includes(value.status) && !!value.lightweight && ['no-warning', 'warning', 'indeterminate', 'fatal'].includes(value.lightweight.status)
    && !!value.content && ['review', 'indeterminate'].includes(value.content.status) && typeof value.content.reason === 'string' && value.content.spellingVersion === SPELLINGS_VERSION
    && Array.isArray(value.issues) && value.issues.length <= 100 && value.issues.every(i => i && ['warning', 'fatal'].includes(i.severity) && typeof i.message === 'string'
      && (!i.source || (Number.isSafeInteger(i.source.start) && Number.isSafeInteger(i.source.end) && i.source.start >= 0 && i.source.end >= i.source.start)));
}

function sourceText(book: AudioBookManifest, chunk: SavedAudioChunk): ChunkText {
  const part = chunk.timeline[0];
  if (!part || chunk.timeline.length !== 1) throw new Error('一つのchunkに対応する元範囲を確定できません。');
  const block = book.document.blocks.find(block => block.id === part.blockId);
  if (!block || !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || part.start < 0 || part.end <= part.start || part.end > block.text.length) throw new Error('音声chunkの元範囲が本文と一致しません。');
  const speech = prepareSpeech(block, part.start, part.end, book.options.readings);
  const alternatives: ReadingAlternative[] = [];
  for (const span of speech.sourceSpans.filter(span => span.kind !== 'identity')) {
    const existing = alternatives.find(a => a.start === span.start - part.start && a.end === span.end - part.start);
    const value = speech.spokenText.slice(span.spokenStart, span.spokenEnd);
    if (existing) existing.text += value;
    else alternatives.push({ start: span.start - part.start, end: span.end - part.start, text: value });
  }
  return { text: block.text.slice(part.start, part.end), source: { blockId: block.id, start: part.start, end: part.end }, alternatives };
}
function project(cached: CachedInspection, key: string, chunk: SavedAudioChunk, input: ChunkText): AudioInspection {
  return { ...cached, key, chunkId: chunk.id, text: input.text, source: input.source,
    issues: cached.issues.map(issue => ({ ...issue, source: issue.source ? { blockId: input.source.blockId, start: input.source.start + issue.source.start, end: input.source.start + issue.source.end } : input.source })) };
}

/** Read-only book/audio access, private QA sidecars only. No generation service, provider or HTTP. */
export class AudioInspectionService {
  constructor(private readonly disk: LibraryDisk, private readonly asr?: AsrAdapter) {}
  async read(bookId: string, revision: string): Promise<AudioInspectionReport | undefined> {
    const book = await this.book(bookId, revision);
    const report = await this.disk.read<AudioInspectionReport>(['audio-inspections', `${bookId}_${revision}.json`]);
    if (!report || report.inspectionVersion !== AUDIO_INSPECTION_VERSION || !Array.isArray(report.chunks)) return;
    const chunks: AudioInspection[] = [];
    // Stale evidence is never shown as current after a file or source replacement.
    for (const result of report.chunks) {
      const chunk = book.chunks.find(c => c.id === result.chunkId);
      if (!chunk) continue;
      try {
        const input = sourceText(book, chunk);
        const audio = await readReadyAudio(this.disk, chunk.speechKey, 'wav');
        if (!audio) throw new Error('保存済み音声がありません。');
        if (validCached(result, audio.sourceAudioHash, digest(audio.bytes), this.textHash(input, chunk.durationSeconds)) && result.text === input.text && JSON.stringify(result.source) === JSON.stringify(input.source)) chunks.push(result);
      } catch {
        // Retain a current fatal diagnostic, but never stale PCM/ASR evidence for corrupt bytes.
        const cache = await this.disk.read<{ hash?: string }>(['cache', `${chunk.speechKey}.json`]);
        const bytes = await this.disk.readBytes(['audio', `${chunk.speechKey}.${result.mediaFormat}`]);
        const hash = typeof cache?.hash === 'string' && /^[a-f0-9]{64}$/.test(cache.hash) ? cache.hash : digest('unavailable');
        if (result.status === 'fatal' && result.audioHash === hash && result.mediaHash === digest(bytes ?? 'unavailable')) chunks.push(result);
      }
    }
    return { ...report, chunks };
  }
  private async book(bookId: string, revision: string): Promise<AudioBookManifest> {
    requireId(bookId); requireKey(revision);
    const book = await this.disk.read<AudioBookManifest>(['books', `${bookId}_${revision}.json`]);
    if (!book || book.id !== bookId || book.revision !== revision) throw new Error('保存済み音声が見つかりません。');
    if (!Array.isArray(book.chunks) || !book.document || !Array.isArray(book.document.blocks) || !book.options || !Array.isArray(book.options.readings)) throw new Error('保存済み本文・音声の構造が不正です。');
    return book;
  }
  private textHash(input: ChunkText, duration: number) { return digest(JSON.stringify({ text: input.text, alternatives: input.alternatives, duration })); }
  async inspect(request: InspectSavedAudioInput): Promise<AudioInspectionReport> {
    if ((request.content !== undefined && typeof request.content !== 'boolean') || (request.refresh !== undefined && typeof request.refresh !== 'boolean')) throw new Error('検査設定が正しくありません。');
    const book = await this.book(request.bookId, request.revision);
    if (request.selectedChunkIds !== undefined && (!Array.isArray(request.selectedChunkIds) || !request.selectedChunkIds.length || request.selectedChunkIds.length > book.chunks.length || new Set(request.selectedChunkIds).size !== request.selectedChunkIds.length || !request.selectedChunkIds.every(id => typeof id === 'string' && book.chunks.some(c => c.id === id)))) throw new Error('検査対象chunkが正しくありません。');
    const selected = request.selectedChunkIds ? new Set(request.selectedChunkIds) : undefined;
    const chunks = book.chunks.filter(c => !selected || selected.has(c.id));
    if (!chunks.length) throw new Error('保存済み音声chunkがありません。');
    const structure = inspectAudioPresentation(book);
    const results: AudioInspection[] = []; let reusedChunks = 0;
    for (const chunk of chunks) {
      requireKey(chunk.speechKey);
      let input: ChunkText, audio: Awaited<ReturnType<typeof readReadyAudio>>;
      try {
        input = sourceText(book, chunk);
        audio = await readReadyAudio(this.disk, chunk.speechKey, 'wav');
        if (!audio) throw new Error('保存済み音声がありません。');
      } catch {
        const cache = await this.disk.read<{ hash?: string }>(['cache', `${chunk.speechKey}.json`]);
        const hash = typeof cache?.hash === 'string' && /^[a-f0-9]{64}$/.test(cache.hash) ? cache.hash : digest('unavailable');
        const wav = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]), mp3 = wav ? undefined : await this.disk.readBytes(['audio', `${chunk.speechKey}.mp3`]);
        results.push({ schemaVersion: 1, inspectionVersion: AUDIO_INSPECTION_VERSION, key: digest(`${hash}:${AUDIO_INSPECTION_VERSION}:invalid`), audioHash: hash, mediaHash: digest(wav ?? mp3 ?? 'unavailable'), mediaFormat: wav ? 'wav' : mp3 ? 'mp3' : chunk.mimeType === 'audio/mpeg' ? 'mp3' : 'wav',
          textHash: digest('unavailable'), inspectedAt: new Date().toISOString(), chunkId: chunk.id, text: '', status: 'fatal', lightweight: { status: 'fatal', reason: '元範囲または保存音声のhash検査に失敗しました。' },
          content: uninspectedContent(), issues: [{ severity: 'fatal', code: 'invalid-audio', message: '元範囲または保存音声の整合性を確認できません。再合成は行いません。' }] });
        continue;
      }
      const audioHash = audio.sourceAudioHash, mediaHash = digest(audio.bytes), textHash = this.textHash(input, chunk.durationSeconds);
      const key = digest(JSON.stringify({ audioHash, mediaHash, textHash, version: AUDIO_INSPECTION_VERSION, spellings: SPELLINGS_VERSION, asr: request.content ? this.asr ? { version: this.asr.version, qualification: this.asr.qualification } : 'unavailable' : 'disabled', structure: structure.status }));
      const parts = ['audio-inspection-cache', `${key}.json`];
      const outcome = await this.disk.withLock(`qa-${key}`, async () => {
        const cached = request.refresh ? undefined : await this.disk.read<CachedInspection>(parts);
        if (validCached(cached, audioHash, mediaHash, textHash)) return { cached, reused: true };
        const value: CachedInspection = { schemaVersion: 1, inspectionVersion: AUDIO_INSPECTION_VERSION, audioHash, mediaHash, mediaFormat: audio.format, textHash, inspectedAt: new Date().toISOString(), status: 'indeterminate', lightweight: { status: 'indeterminate' }, content: uninspectedContent(), issues: [] };
        const temporary = ['audio-inspection-input', `${randomUUID()}.${audio.format}`];
        await this.disk.writeBytes(temporary, audio.bytes);
        try {
          const path = await this.disk.existingPath(temporary);
          try {
            const pcm = audio.format === 'wav' ? decodeWave(audio.bytes) : await decodeMp3(path);
            const light = inspectPcm(pcm.channels, pcm.sampleRate, foldedCharacters(input.text).length, chunk.durationSeconds);
            value.lightweight = { status: light.issues.some(i => i.severity === 'fatal') ? 'fatal' : light.issues.length ? 'warning' : 'no-warning', metrics: light.metrics };
            value.issues.push(...light.issues);
          } catch (error) {
            value.lightweight = error instanceof InspectionUnavailable ? { status: 'indeterminate', reason: error.message } : { status: 'fatal', reason: '保存音声のPCM構造が不正です。' };
            if (!(error instanceof InspectionUnavailable)) value.issues.push({ severity: 'fatal', code: 'invalid-audio', message: '保存音声のPCMを検査できません。' });
          }
          if (structure.status === 'invalid') value.issues.push({ severity: 'fatal', code: 'invalid-source', message: `既存の本文・表示構造検査で不正を検出しました（${structure.issues.slice(0, 8).map(i => i.code).join(', ')}）。音声品質warningとは別の構造不正です。` });
          if (request.content && this.asr && !value.issues.some(i => i.severity === 'fatal') && (value.lightweight.metrics?.durationSeconds ?? Infinity) <= 30) {
            try {
              const candidate = await this.asr.transcribe(path, mediaHash);
              if (!validCandidate(candidate, mediaHash, this.asr.version)) throw new InspectionUnavailable('音声のみASRの応答・hashが正しくありません。');
              const { compareContent } = await import('./content');
              const comparison = compareContent(input.text, candidate, undefined, input.alternatives, this.asr.qualification);
              value.content = comparison.evidence; value.issues.push(...comparison.issues);
            } catch { value.content = uninspectedContent('手元ASRの実行に失敗しました。認識精度や内容の正しさは判定不能です。'); }
          } else if (request.content) value.content = uninspectedContent(!this.asr ? '手元ASRが未設定です。追加モデルの取得は明示opt-inで別途設定してください。' : '構造不正、PCM判定不能、または30秒のASR上限のため内容は判定不能です。');
          value.status = value.issues.some(i => i.severity === 'fatal') ? 'fatal' : value.issues.length ? 'warning' : 'indeterminate';
          // Failed/unavailable ASR is retryable. Do not freeze transient failure into a successful cache hit.
          if (!request.content || value.content.method !== 'not-run' || !this.asr) await this.disk.write(parts, value);
          return { cached: value, reused: false };
        } finally { await this.disk.removeVerified(temporary, mediaHash); }
      });
      if (outcome.reused) reusedChunks++;
      results.push(project(outcome.cached, key, chunk, input));
    }
    const filename = `${book.id}_${book.revision}.json`;
    return this.disk.withLock(`qabook-${digest(filename)}`, async () => {
      const previous = await this.read(book.id, book.revision);
      const map = new Map(previous?.inspectionVersion === AUDIO_INSPECTION_VERSION ? previous.chunks.map(c => [c.chunkId, c]) : []);
      results.forEach(c => map.set(c.chunkId, c));
      const report: AudioInspectionReport = { schemaVersion: 1, inspectionVersion: AUDIO_INSPECTION_VERSION, bookId: book.id, revision: book.revision, inspectedAt: new Date().toISOString(),
        chunks: book.chunks.flatMap(c => map.has(c.id) ? [map.get(c.id)!] : []), reusedChunks };
      await this.disk.write(['audio-inspections', filename], report); return report;
    });
  }
}
