import { setTimeout as pause } from 'node:timers/promises';
import type { AlignmentCapabilities, AlignmentJob, AudioBookManifest, GenerationPlan, SavedAlignment, SavedAudioChunk, StartAlignmentInput } from '../contracts';
import { ACOUSTIC_TIMING_VERSION, ALIGNMENT_NORMALIZE_VERSION } from '../contracts';
import type { ReadingDocument } from '../../reader/model';
import { digest, LibraryDisk, processAlive, requireId, requireKey } from './disk';
import type { GenerationServerConfig } from './config';
import { pythonAlignmentAdapter, type AlignmentAdapter, type AlignmentRuntimeRequest, type AlignmentRuntimeResult } from './alignment-adapter';
import { projectAlignment, validateAlignmentResult } from './alignment-projection';
import { normalizeSpeech, prepareSpeech } from './speech-source';
import { VOICEVOX_TIMING_VERSION, voicevoxPhraseTiming, voicevoxTimingAvailable, type CapturedVoicevoxQuery } from './voicevox-timing';
import { requireAudioPresentation } from '../../reader/audio-presentation';
import { audioSegments, validVoicevoxTiming } from '../../reader/audio-clock';

interface AlignmentHost { getBook(bookId: string, revision: string): Promise<AudioBookManifest>; getAudio(speechKey: string, requested?: 'wav' | 'mp3'): Promise<{ bytes: Uint8Array; mimeType?: 'audio/wav' | 'audio/mpeg'; sourceAudioHash?: string }> }
interface CacheEntry { schemaVersion: 1; audioHash: string; spokenTextHash: string; normalizeVersion: string; alignerVersion: string; result: AlignmentRuntimeResult }
function now(): string { return new Date().toISOString(); }

/** Separate local-only job runner: this module has no speech provider or TTS invocation. */
export class AlignmentService {
  private readonly adapter: AlignmentAdapter;
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  readonly ready: Promise<void>;
  constructor(private readonly disk: LibraryDisk, private readonly config: GenerationServerConfig, private readonly host: AlignmentHost, adapter?: AlignmentAdapter) {
    this.adapter = adapter ?? pythonAlignmentAdapter(config);
    this.ready = this.recover();
  }
  private async recover(): Promise<void> {
    for (const filename of await this.disk.list('alignment-jobs')) {
      const job = await this.disk.read<AlignmentJob>(['alignment-jobs', filename]);
      if (!job || !['queued', 'running', 'cancel-requested'].includes(job.status)) continue;
      const owner = await this.disk.read<{ pid: number }>(['alignment-owners', `${job.id}.json`]);
      if (owner && Number.isInteger(owner.pid) && processAlive(owner.pid)) continue;
      const release = await this.disk.lock(`alignrun-${job.id}`);
      if (!release) continue;
      try {
        for (const chunk of job.chunks) if (chunk.status === 'running') chunk.status = 'pending';
        job.status = 'cancelled'; job.updatedAt = now();
        job.error = 'ローカル処理の停止後に復元しました。明示的な再開で対応表だけを作ります。音声は再合成しません。';
        await this.disk.write(['alignment-jobs', filename], job);
      } finally { await release(); }
    }
  }
  async automaticAvailable(): Promise<boolean> { await this.ready; return this.adapter.available(); }
  async capabilities(): Promise<AlignmentCapabilities> {
    await this.ready;
    const ctcAvailable = await this.adapter.available();
    const available = ctcAvailable || await voicevoxTimingAvailable();
    const automatic = this.config.alignmentPython && this.config.alignmentModelDir
      ? this.adapter.readiness ? await this.adapter.readiness() : { status: ctcAvailable ? 'ready' as const : 'failed' as const, message: ctcAvailable ? '保存後にこのPCで自動補正します。' : 'pnpm setup:audioで解析環境を確認してください。' }
      : { status: this.config.alignmentSetupState === 'failed' ? 'failed' as const : 'setup-required' as const, message: 'リポジトリのフォルダーで pnpm setup:audio を実行し、完了後 pnpm dev を起動してください。' };
    return { automatic, configured: available, available, alignerVersion: this.adapter.version, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, method: 'forced-alignment', ...(!available ? { message: 'ローカルPython runtimeとモデルの設定が必要です。自動インストール・ダウンロードは行いません。' } : {}) };
  }
  async start(input: StartAlignmentInput): Promise<AlignmentJob> {
    await this.ready;
    requireId(input.bookId); requireKey(input.revision); requireId(input.operationId);
    const book = await this.host.getBook(input.bookId, input.revision);
    if (input.selectedChunkIds !== undefined && (!Array.isArray(input.selectedChunkIds) || !input.selectedChunkIds.length || !input.selectedChunkIds.every((id) => typeof id === 'string' && book.chunks.some((chunk) => chunk.id === id)))) throw new Error('alignment対象の音声chunkが正しくありません。');
    const selected = input.selectedChunkIds ? new Set(input.selectedChunkIds) : new Set(book.chunks.map((chunk) => chunk.id));
    const chunks = book.chunks.filter((chunk) => selected.has(chunk.id));
    if (!chunks.length) throw new Error('保存済み音声がありません。音声は再合成しません。');
    const reusableCompressed = chunks.every(chunk => chunk.mimeType === 'audio/mpeg' && chunk.alignment);
    if (!reusableCompressed && !await this.adapter.available() && !(book.options.provider === 'voicevox' && await voicevoxTimingAvailable())) throw new Error('ローカルalignment runtimeまたはVOICEVOXが未設定です。');
    const operationKey = digest(input.operationId);
    const requestHash = digest(JSON.stringify({ bookId: book.id, revision: book.revision, chunks: chunks.map((chunk) => chunk.id), alignerVersion: this.adapter.version, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, engineTimingVersion: VOICEVOX_TIMING_VERSION, acousticTimingVersion: ACOUSTIC_TIMING_VERSION }));
    const job = await this.disk.withLock(`alignop-${operationKey}`, async () => {
      const prior = await this.disk.read<{ jobId: string; requestHash: string }>(['alignment-operations', `${operationKey}.json`]);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('同じ操作IDで別のalignment対象は開始できません。');
        return this.get(prior.jobId);
      }
      const jobId = `align-job-${operationKey}`;
      const existing = await this.disk.read<AlignmentJob>(['alignment-jobs', `${jobId}.json`]);
      if (existing) {
        if (existing.bookId !== book.id || existing.revision !== book.revision || existing.alignerVersion !== this.adapter.version || JSON.stringify(existing.selectedChunkIds) !== JSON.stringify(chunks.map((chunk) => chunk.id))) throw new Error('同じ操作IDで別のalignment対象は開始できません。');
        await this.disk.write(['alignment-operations', `${operationKey}.json`], { jobId, requestHash });
        return existing;
      }
      const job: AlignmentJob = { schemaVersion: 1, id: jobId, operationId: input.operationId, bookId: book.id, revision: book.revision, title: book.title, status: 'queued', alignerVersion: this.adapter.version, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION,
        selectedChunkIds: chunks.map((chunk) => chunk.id), createdAt: now(), updatedAt: now(), chunks: chunks.map((chunk) => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'pending', reused: false })), completedChunks: 0, totalChunks: chunks.length, reusedChunks: 0 };
      await this.disk.write(['alignment-owners', `${job.id}.json`], { pid: process.pid });
      await this.disk.write(['alignment-jobs', `${job.id}.json`], job);
      await this.disk.write(['alignment-operations', `${operationKey}.json`], { jobId, requestHash });
      return job;
    });
    if (job.status === 'queued') this.launch(job.id);
    return job;
  }
  private launch(jobId: string): void {
    if (this.running.has(jobId)) return;
    const task = this.run(jobId).catch(async () => {
      await this.update(jobId, (job) => { job.status = 'failed'; job.error = 'alignmentの保存処理に失敗しました。元音声は変更していません。'; }).catch(() => undefined);
    }).finally(async () => {
      this.running.delete(jobId); this.controllers.delete(jobId);
      const job = await this.get(jobId).catch(() => undefined);
      if (job?.status === 'queued') { await pause(50); this.launch(jobId); }
    });
    this.running.set(jobId, task);
  }
  private async sourcePlan(book: AudioBookManifest): Promise<GenerationPlan> {
    for (const filename of await this.disk.list('plans')) {
      const stored = await this.disk.read<{ plan: GenerationPlan; document: ReadingDocument }>(['plans', filename]);
      if (stored?.plan.bookId === book.id && stored.plan.revision === book.revision) return stored.plan;
    }
    throw new Error('保存音声に対応する確定発話原稿がありません。原稿を推測して再合成・置換しません。');
  }
  private async run(jobId: string): Promise<void> {
    const release = await this.disk.lock(`alignrun-${jobId}`);
    if (!release) return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    try {
      const initial = await this.get(jobId);
      if (initial.alignerVersion !== this.adapter.version) throw new Error('alignment runtimeのversionが変わりました。新しい計画で開始してください。');
      const book = await this.host.getBook(initial.bookId, initial.revision);
      const plan = await this.sourcePlan(book);
      await this.update(jobId, (job) => { if (['queued', 'running'].includes(job.status)) job.status = 'running'; delete job.error; });
      for (const state of initial.chunks) {
        const current = await this.get(jobId);
        if (current.status === 'cancelled' || current.status === 'cancel-requested') break;
        if (current.chunks.find((chunk) => chunk.id === state.id)?.status === 'completed') continue;
        const chunk = book.chunks.find((chunk) => chunk.id === state.id && chunk.speechKey === state.speechKey);
        const transcript = plan.chunks.find((chunk) => chunk.id === state.id && chunk.speechKey === state.speechKey);
        if (!chunk || !transcript) throw new Error('音声と確定発話原稿の対応が一致しません。');
        await this.update(jobId, (job) => { job.chunks.find((chunk) => chunk.id === state.id)!.status = 'running'; });
        let speechRelease: (() => Promise<void>) | undefined;
        try {
          speechRelease = await this.disk.lock(`speech-${chunk.speechKey}`);
          if (!speechRelease) throw new Error('音声の保存処理中です。完了後に時刻補正を再開できます。');
          const audio = await this.host.getAudio(chunk.speechKey, 'wav');
          const audioHash = digest(audio.bytes);
          const block = book.document.blocks.find((block) => block.id === transcript.blockId);
          if (!block) throw new Error('原文のblockがありません。');
          const speech = prepareSpeech(block, transcript.start, transcript.end, plan.options.readings);
          if (speech.spokenText !== transcript.spokenText) throw new Error('読みの変換と保存済み発話原稿が一致しません。');
          if (audio.mimeType === 'audio/mpeg') {
            // The MP3 was measured on the unchanged WAV clock before archival.
            // Reuse that correction; do not reconstruct engine timing from lossy PCM.
            const saved = chunk.alignment;
            if (!saved || saved.audioHash !== audio.sourceAudioHash) {
              // A new document may reuse compressed speech. Reproject the saved
              // source-clock CTC result into its new text positions without decoding
              // lossy PCM, reconstructing engine timing, or calling any speech API.
              const normalized = normalizeSpeech(speech.spokenText);
              const key = digest(JSON.stringify({ audioHash: audio.sourceAudioHash, spokenText: speech.spokenText, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: this.adapter.version, acousticTimingVersion: ACOUSTIC_TIMING_VERSION }));
              const cached = await this.disk.read<CacheEntry>(['alignment-cache', `${key}.json`]);
              if (!cached || cached.schemaVersion !== 1 || cached.audioHash !== audio.sourceAudioHash || cached.spokenTextHash !== digest(speech.spokenText)
                || cached.normalizeVersion !== ALIGNMENT_NORMALIZE_VERSION || cached.alignerVersion !== this.adapter.version) throw new Error('再補正には元WAVの復元が必要です。');
              const request: AlignmentRuntimeRequest = { schemaVersion: 1, audioPath: '', audioHash: cached.audioHash, spokenText: speech.spokenText, normalizedText: normalized.text, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: this.adapter.version, offsetUnit: 'utf16' };
              validateAlignmentResult(cached.result, request, chunk.durationSeconds);
              const projected = projectAlignment({ key, audioHash: cached.audioHash, alignerVersion: this.adapter.version, document: book.document, blockId: transcript.blockId, start: transcript.start, end: transcript.end, speech, normalized, result: cached.result });
              await this.attach(book.id, book.revision, chunk, projected);
              await this.update(jobId, job => { const target = job.chunks.find(c => c.id === state.id)!; target.status = 'completed'; target.alignmentKey = key; target.result = projected.status; target.reused = true; delete target.error; });
              continue;
            }
            requireAudioPresentation(book);
            await this.update(jobId, job => { const target = job.chunks.find(c => c.id === state.id)!; target.status = 'completed'; target.alignmentKey = saved.key; target.result = saved.status; target.reused = true; delete target.error; });
            continue;
          }
          const normalized = normalizeSpeech(speech.spokenText);
          const key = digest(JSON.stringify({ audioHash, spokenText: speech.spokenText, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: this.adapter.version, acousticTimingVersion: ACOUSTIC_TIMING_VERSION }));
          const request: AlignmentRuntimeRequest = { schemaVersion: 1, audioPath: await this.disk.existingPath(['audio', `${chunk.speechKey}.wav`]), audioHash, spokenText: speech.spokenText, normalizedText: normalized.text, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: this.adapter.version, offsetUnit: 'utf16' };
          const alignmentRelease = await this.disk.lock(`alignkey-${key}`);
          if (!alignmentRelease) throw new Error('同じ音声のalignmentが処理中です。完了後に再開してください。');
          try {
            const cached = await this.disk.read<CacheEntry>(['alignment-cache', `${key}.json`]);
            let result: AlignmentRuntimeResult;
            let reused = false;
            if (cached) {
              if (cached.schemaVersion !== 1 || cached.audioHash !== audioHash || cached.spokenTextHash !== digest(speech.spokenText) || cached.normalizeVersion !== ALIGNMENT_NORMALIZE_VERSION || cached.alignerVersion !== this.adapter.version) throw new Error('alignment cacheの対応が一致しません。');
              result = cached.result; reused = true;
            } else {
              const canAlign = await this.adapter.available();
              result = normalized.text && canAlign ? await this.adapter.align(request, controller.signal) : { schemaVersion: 1, alignerVersion: this.adapter.version, normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, offsetUnit: 'utf16', normalizedText: normalized.text, durationSeconds: chunk.durationSeconds, segments: [] };
              validateAlignmentResult(result, request, chunk.durationSeconds);
              if (controller.signal.aborted) throw new Error('alignmentを中断しました。');
              if (canAlign) await this.disk.write(['alignment-cache', `${key}.json`], { schemaVersion: 1, audioHash, spokenTextHash: digest(speech.spokenText), normalizeVersion: ALIGNMENT_NORMALIZE_VERSION, alignerVersion: this.adapter.version, result } satisfies CacheEntry);
            }
            validateAlignmentResult(result, request, chunk.durationSeconds);
            // Verify again after the child has read the file. TTS bytes remain immutable.
            if (digest((await this.host.getAudio(chunk.speechKey, 'wav')).bytes) !== audioHash) throw new Error('alignment中に音声が変更されました。');
            let alignment = projectAlignment({ key, audioHash, alignerVersion: this.adapter.version, document: book.document, blockId: transcript.blockId, start: transcript.start, end: transcript.end, speech, normalized, result });
            const acousticTimingFromCtc = alignment.acoustic;
            if (book.options.provider === 'voicevox' && plan.providerVersion === 'voicevox-engine:0.25.2') {
              const timingKey = digest(JSON.stringify({ ctcKey: key, version: VOICEVOX_TIMING_VERSION, document: book.document.contentHash,
                units: book.document.units.filter(unit => unit.blockId === transcript.blockId && unit.start >= transcript.start && unit.end <= transcript.end).map(unit => [unit.id, unit.start, unit.end]) }));
              const cachedTiming = await this.disk.read<{ audioHash: string; alignment: SavedAlignment }>(['voicevox-timing-cache', `${timingKey}.json`]);
              const existing = chunk.alignment;
              const reusableEngine = existing?.method === 'voicevox-mora' && existing.audioHash === audioHash && existing.score === undefined
                && validVoicevoxTiming(existing.engineTiming, chunk.durationSeconds) && Array.isArray(existing.cues) && existing.cues.length > 0
                && audioSegments({ ...book, chunks: [{ ...chunk, alignment: existing }] })[0]?.cues?.length === existing.cues.length;
              if (reusableEngine) {
                // A new CTC processing version must not discard verified engine timestamps.
                alignment = { ...existing, key: timingKey };
                await this.disk.write(['voicevox-timing-cache', `${timingKey}.json`], { audioHash, alignment });
              } else if (cachedTiming) {
                if (cachedTiming.audioHash !== audioHash || cachedTiming.alignment.key !== timingKey || cachedTiming.alignment.audioHash !== audioHash
                  || cachedTiming.alignment.schemaVersion !== 1 || cachedTiming.alignment.status !== 'aligned' || cachedTiming.alignment.score !== undefined
                  || cachedTiming.alignment.method !== 'voicevox-mora' || !validVoicevoxTiming(cachedTiming.alignment.engineTiming, chunk.durationSeconds)
                  || !Array.isArray(cachedTiming.alignment.cues) || !cachedTiming.alignment.cues.length
                  || audioSegments({ ...book, chunks: [{ ...chunk, alignment: cachedTiming.alignment }] })[0]?.cues?.length !== cachedTiming.alignment.cues.length) throw new Error('保存した発音時刻の対応が一致しません。');
                alignment = cachedTiming.alignment;
              } else {
                const captured = await this.disk.read<CapturedVoicevoxQuery>(['voicevox-queries', `${chunk.speechKey}.json`]);
                const timed = await voicevoxPhraseTiming({ key: timingKey, audio: audio.bytes, audioHash, engineVersion: plan.providerVersion, styleId: book.options.voice,
                  document: book.document, blockId: transcript.blockId, start: transcript.start, end: transcript.end, speech, ctc: alignment, captured, signal: controller.signal });
                if (timed) { alignment = timed; reused = false; await this.disk.write(['voicevox-timing-cache', `${timingKey}.json`], { audioHash, alignment }); }
              }
            }
            const acoustic = acousticTimingFromCtc;
            if (acoustic && alignment.method === 'voicevox-mora') alignment = { ...alignment, acoustic };
            await this.attach(book.id, book.revision, chunk, alignment);
            await this.update(jobId, (job) => { const target = job.chunks.find((chunk) => chunk.id === state.id)!; target.status = 'completed'; target.alignmentKey = key; target.result = alignment.status; target.reused = reused; delete target.error; });
          } finally { await alignmentRelease(); }
        } catch {
          const cancelled = controller.signal.aborted || ['cancelled', 'cancel-requested'].includes((await this.get(jobId)).status);
          await this.update(jobId, (job) => {
            const target = job.chunks.find((chunk) => chunk.id === state.id)!;
            target.status = cancelled ? 'pending' : 'failed';
            if (cancelled) job.status = 'cancelled';
            else { target.error = 'alignmentに失敗しました。保存済みWAVと区切り表示を保持しています。未整列の時刻は表示用推定です。'; job.status = 'failed'; job.error = target.error; }
          });
          break;
        } finally { await speechRelease?.(); }
      }
      await this.update(jobId, (job) => { if (job.chunks.every((chunk) => chunk.status === 'completed')) job.status = 'completed'; else if (job.status === 'cancel-requested') job.status = 'cancelled'; else if (job.status === 'running') job.status = 'failed'; });
    } finally { await release(); }
  }
  private async attach(bookId: string, revision: string, chunk: SavedAudioChunk, alignment: SavedAlignment): Promise<void> {
    await this.disk.withLock(`book-${digest(`${bookId}:${revision}`)}`, async () => {
      const filename = `${bookId}_${revision}.json`;
      const book = await this.disk.read<AudioBookManifest>(['books', filename]);
      const target = book?.chunks.find((saved) => saved.id === chunk.id && saved.speechKey === chunk.speechKey);
      if (!book || !target) throw new Error('alignment対象のrevisionが見つかりません。');
      target.alignment = alignment; book.updatedAt = now();
      book.warnings = book.warnings.filter((warning) => warning !== '同期精度は文単位です。フレーズ時刻・Gemini精密alignmentは未検証です。');
      const warning = 'forced alignmentは推定時刻です。低信頼・未一致・無音でも原稿の区切りを表示し、表示用推定を明示します。';
      if (!book.warnings.includes(warning)) book.warnings.push(warning);
      delete book.presentation;
      book.presentation = requireAudioPresentation(book);
      await this.disk.write(['books', filename], book);
    });
  }
  private async update(jobId: string, change: (job: AlignmentJob) => void): Promise<AlignmentJob> {
    return this.disk.withLock(`alignupdate-${jobId}`, async () => {
      const job = await this.get(jobId); change(job); job.updatedAt = now();
      job.completedChunks = job.chunks.filter((chunk) => chunk.status === 'completed').length;
      job.reusedChunks = job.chunks.filter((chunk) => chunk.status === 'completed' && chunk.reused).length;
      await this.disk.write(['alignment-jobs', `${jobId}.json`], job); return job;
    });
  }
  async get(jobId: string): Promise<AlignmentJob> {
    requireId(jobId);
    const job = await this.disk.read<AlignmentJob>(['alignment-jobs', `${jobId}.json`]);
    if (!job) throw new Error('alignmentジョブが見つかりません。'); return job;
  }
  async list(): Promise<AlignmentJob[]> {
    await this.ready;
    const jobs = await Promise.all((await this.disk.list('alignment-jobs')).map((file) => this.disk.read<AlignmentJob>(['alignment-jobs', file])));
    return jobs.filter((job): job is AlignmentJob => Boolean(job)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async cancel(jobId: string): Promise<AlignmentJob> {
    await this.ready;
    const job = await this.update(jobId, (job) => { if (['queued', 'running'].includes(job.status)) job.status = this.running.has(jobId) ? 'cancel-requested' : 'cancelled'; });
    this.controllers.get(jobId)?.abort(); return job;
  }
  async resume(jobId: string): Promise<AlignmentJob> {
    await this.ready;
    if (!await this.adapter.available()) throw new Error('alignment runtimeが未設定です。');
    const current = await this.get(jobId);
    if (current.alignerVersion !== this.adapter.version) throw new Error('aligner versionが変更されています。新しいjobを開始してください。');
    await this.disk.write(['alignment-owners', `${jobId}.json`], { pid: process.pid });
    const job = await this.update(jobId, (job) => {
      if (['completed', 'running', 'cancel-requested', 'queued'].includes(job.status)) return;
      for (const chunk of job.chunks) if (chunk.status === 'failed' || chunk.status === 'running') chunk.status = 'pending';
      job.status = 'queued'; delete job.error;
    });
    if (job.status === 'queued') this.launch(jobId); return job;
  }
  async wait(jobId: string): Promise<AlignmentJob> {
    for (;;) { const task = this.running.get(jobId); if (!task) return this.get(jobId); await task; }
  }
}
