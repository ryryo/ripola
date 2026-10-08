import { resolveDocumentTitle } from '../../reader/document-title';
import { setTimeout as pause } from 'node:timers/promises';
import { inspectAudioPresentation, requireAudioPresentation } from '../../reader/audio-presentation';
import { DEFAULT_SETTINGS, type ReadingDocument } from '../../reader/model';
import { validateSavedReading } from '../../reader/storage';
import { GEMINI_MODELS, type AlignmentJob, type StartAlignmentInput, type AudioBookManifest, type AudioBookSummary, type GenerationChunk, type SpeechReceipt, type GenerationConfig, type GenerationJob, type GenerationOptions, type GenerationPlan, type PrepareGenerationInput, type StartGenerationInput } from '../contracts';
import type { GenerationServerConfig } from './config';
import { prepareSpeech } from './speech-source';
import { estimateGeminiOutput, geminiEstimateNote } from '../cost-estimate';
import { AlignmentService } from './alignment-service';
import type { CapturedVoicevoxQuery } from './voicevox-timing';
import type { AlignmentAdapter } from './alignment-adapter';
import { digest, LibraryDisk, processAlive, requireId, requireKey } from './disk';
import { compressedAudioRecord, readReadyAudio, type AudioCacheRecord as CacheRecord } from './audio-cache';
import { audioCompressionAvailable, encodeVerifiedMp3 } from './audio-compression';
import { GEMINI_ENDPOINT, GEMINI_VOICES, geminiAdapter, gatewayEndpoint, gatewayRouteIdentity, SpeechRequestError, VOICEVOX_ENDPOINT, voicevoxAdapter, wavDuration, type SpeechAdapter } from './providers';

class CancelledBeforeSend extends Error {}

interface StoredPlan { plan: GenerationPlan; document: ReadingDocument }
export interface ServiceDependencies {
  voicevox?: SpeechAdapter;
  gemini?: SpeechAdapter;
  finalizeAudio?: (bytes: Uint8Array) => Promise<number>;
  alignment?: AlignmentAdapter;
  compression?: { available: typeof audioCompressionAvailable; encode: typeof encodeVerifiedMp3 };
}
function now(): string { return new Date().toISOString(); }
function inputError(): never { throw new Error('生成入力の形式が正しくありません。'); }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length <= maximum; }
function options(input: unknown): GenerationOptions {
  if (!input || typeof input !== 'object') inputError();
  const value = input as GenerationOptions;
  if (!['voicevox', 'gemini'].includes(value.provider) || !text(value.voice, 64) || !value.voice || !['direct', 'gateway'].includes(value.transport)
    || (value.model !== undefined && !GEMINI_MODELS.includes(value.model)) || !Array.isArray(value.readings) || value.readings.length > 1000
    || !value.readings.every((reading) => reading && text(reading.text, 256) && reading.text.length > 0 && text(reading.reading, 256) && reading.reading.length > 0)
    || (value.style !== undefined && !text(value.style, 2000))
    || (value.selectedChunkIds !== undefined && (!Array.isArray(value.selectedChunkIds) || value.selectedChunkIds.length > 100_000 || !value.selectedChunkIds.every((id) => text(id, 128))))) inputError();
  if (value.provider === 'voicevox' && (!/^\d{1,8}$/.test(value.voice) || value.style)) throw new Error('VOICEVOXは数値style IDを指定し、style指示は空にしてください。');
  if (value.provider === 'gemini' && value.transport === 'gateway' && value.style) throw new Error('Cloudflare経路は読み上げ方の指示に未対応です。指示を空にするかGemini直結を選んでください。');
  if (value.provider === 'gemini' && !GEMINI_VOICES.some((voice) => voice.id === value.voice)) throw new Error('対応するGemini voiceを選んでください。');
  return {
    provider: value.provider, voice: value.voice, transport: value.transport,
    ...(value.provider === 'gemini' ? { model: value.model ?? GEMINI_MODELS[0], style: value.style ?? '' } : {}),
    readings: value.readings.map(({ text, reading }) => ({ text, reading })),
    ...(value.selectedChunkIds ? { selectedChunkIds: [...new Set(value.selectedChunkIds)] } : {}),
  };
}
function validateDocument(input: unknown): ReadingDocument {
  if (JSON.stringify(input).length > 20 * 1024 * 1024) throw new Error('抽出本文は20MiB以内にしてください。');
  const document = structuredClone(input) as ReadingDocument;
  if (document && typeof document === 'object') document.title = resolveDocumentTitle(document.title);
  if (!document?.units?.length) throw new Error('本文を取り込んでから計画してください。');
  validateSavedReading({ schemaVersion: 1, document, anchor: { blockId: document.units[0].blockId, offset: 0 }, settings: DEFAULT_SETTINGS, savedAt: now() });
  return document;
}
function chunksFor(document: ReadingDocument, opts: GenerationOptions, providerVersion: string): GenerationChunk[] {
  const result: GenerationChunk[] = [];
  const unitsByBlock = new Map<string, ReadingDocument['units']>();
  for (const unit of document.units) {
    let units = unitsByBlock.get(unit.blockId);
    if (!units) { units = []; unitsByBlock.set(unit.blockId, units); }
    units.push(unit);
  }
  const sentenceSegmenter = new Intl.Segmenter('ja', { granularity: 'sentence' });
  for (const block of document.blocks) {
    if (block.kind === 'code' || block.kind === 'table') continue;
    const blockUnits = unitsByBlock.get(block.id) ?? [];
    let unitCursor = 0;
    for (const sentence of sentenceSegmenter.segment(block.text)) {
      const start = sentence.index;
      const end = start + sentence.segment.length;
      if (!sentence.segment.trim()) continue;
      if (sentence.segment.length > 3000) throw new Error('1文が3000文字を超えています。本文で文を区切ってから計画してください。');
      const spokenText = prepareSpeech(block, start, end, opts.readings).spokenText;
      if (!spokenText) continue;
      const id = `chunk-${digest(`${block.id}:${start}:${end}`).slice(0, 24)}`;
      const speechKey = digest(JSON.stringify({ schema: 'speech-v1', text: spokenText, provider: opts.provider, model: opts.model ?? 'voicevox-engine', voice: opts.voice, style: opts.style ?? '', providerVersion }));
      while (unitCursor < blockUnits.length && blockUnits[unitCursor].end <= start) unitCursor++;
      const unitIds: string[] = [];
      for (let cursor = unitCursor; cursor < blockUnits.length && blockUnits[cursor].start < end; cursor++) unitIds.push(blockUnits[cursor].id);
      result.push({ id, blockId: block.id, start, end, unitIds, originalText: sentence.segment, spokenText, speechKey, cacheHit: false });
    }
  }
  if (opts.selectedChunkIds) {
    const ids = new Set(result.map((chunk) => chunk.id));
    if (opts.selectedChunkIds.some((id) => !ids.has(id))) throw new Error('選択された文が現在の本文に存在しません。');
    const selected = new Set(opts.selectedChunkIds);
    return result.filter((chunk) => selected.has(chunk.id));
  }
  return result;
}

export class GenerationService {
  private readonly interruptedCompressionJobs: string[] = [];
  private readonly disk: LibraryDisk;
  private readonly adapters: Record<'voicevox' | 'gemini', SpeechAdapter>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly initialized: Promise<void>;
  private readonly alignment: AlignmentService;
  constructor(readonly config: GenerationServerConfig, private readonly dependencies: ServiceDependencies = {}) {
    this.disk = new LibraryDisk(config.libraryDir);
    this.adapters = { voicevox: dependencies.voicevox ?? voicevoxAdapter(), gemini: dependencies.gemini ?? geminiAdapter(config.geminiApiKey, config.gateway) };
    this.alignment = new AlignmentService(this.disk, config, { getBook: (bookId, revision) => this.getBook(bookId, revision), getAudio: (key, requested) => this.getAudio(key, requested) }, dependencies.alignment);
    this.initialized = Promise.all([this.recoverInterruptedJobs(), this.alignment.ready]).then(() => {
      for (const jobId of this.interruptedCompressionJobs) this.launch(jobId);
    });
  }
  async ready(): Promise<void> { await this.initialized; }
  private async recoverInterruptedJobs(): Promise<void> {
    for (const file of await this.disk.list('jobs')) {
      const job = await this.disk.read<GenerationJob>(['jobs', file]);
      if (!job || !['queued', 'running', 'cancel-requested'].includes(job.status)) continue;
      const owner = await this.disk.read<{ pid: number }>(['owners', `${job.id}.json`]);
      if (owner && Number.isInteger(owner.pid) && processAlive(owner.pid)) continue;
      const release = await this.disk.lock(`run-${job.id}`);
      if (!release) continue; // A different live process still owns it.
      try {
        if (job.status === 'running' && job.automaticCompression?.status === 'running' && job.chunks.every(chunk => chunk.status === 'completed')) {
          // Only local finalization remains. Restart it automatically; every
          // completed speech cache is checked before the normal runner proceeds.
          job.status = 'queued'; job.updatedAt = now(); delete job.error;
          await this.disk.write(['owners', `${job.id}.json`], { pid: process.pid });
          await this.disk.write(['jobs', file], job);
          this.interruptedCompressionJobs.push(job.id);
          continue;
        }
        for (const chunk of job.chunks) if (chunk.status === 'sending') {
          const audio = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
          chunk.status = audio ? 'audio-ready' : job.provider === 'gemini' ? 'outcome-unknown' : 'pending';
          if (!audio) await this.disk.write(['cache', `${chunk.speechKey}.json`], { schemaVersion: 1, status: chunk.status === 'outcome-unknown' ? 'outcome-unknown' : 'failed', provider: job.provider });
        }
        job.status = job.chunks.some((chunk) => chunk.status === 'outcome-unknown') ? 'outcome-unknown' : 'cancelled';
        job.error = 'サーバー停止後に復元しました。未送信分は明示的な再開で進められます。結果不明の有料送信は再送しません。';
        job.updatedAt = now();
        await this.disk.write(['jobs', file], job);
      } finally { await release(); }
    }
  }
  async getGenerationConfig(): Promise<GenerationConfig> {
    await this.ready();
    let voices: Awaited<ReturnType<SpeechAdapter['voices']>> = [];
    let message: string | undefined;
    try { voices = await this.adapters.voicevox.voices(); } catch { message = '同じMacのVOICEVOXアプリを開き、Engineの起動を確認してください。'; }
    const gatewayStatus = this.adapters.gemini.availability?.() ?? { available: Boolean(this.config.gateway) };
    return {
      voicevox: { available: voices.length > 0, endpoint: VOICEVOX_ENDPOINT, voices, ...(message ? { message } : {}) },
      gemini: { available: Boolean(this.config.paidEnabled && (this.config.geminiApiKey || gatewayStatus.available)), credentialConfigured: Boolean(this.config.geminiApiKey || gatewayStatus.available), models: GEMINI_MODELS, voices: GEMINI_VOICES, endpoint: GEMINI_ENDPOINT,
        ...(!this.config.paidEnabled ? { message: '既存設定で有料生成を停止しています。設定管理者に確認してください。' } : !this.config.geminiApiKey && !this.config.gateway ? { message: '選択経路のサーバー認証設定が必要です。' } : {}) },
      transports: [
        { id: 'direct', available: Boolean(this.config.paidEnabled && this.config.geminiApiKey), message: this.config.geminiApiKey ? 'Googleキー設定あり。Gemini直結はGoogleのアカウントへ課金されます。' : 'Gemini直結にはGoogle API keyが必要です。' },
        { id: 'gateway', available: Boolean(this.config.paidEnabled && gatewayStatus.available), message: gatewayStatus.message ?? (this.config.gateway ? 'Cloudflare REST設定あり。実接続・残高は未確認です。' : 'Cloudflare経路の設定が未完了です。通常はWranglerの既存ログインを使います。') },
      ],
      precision: 'sentence',
      alignment: await this.alignment.capabilities(),
    };
  }
  private async readyCache(key: string): Promise<CacheRecord | undefined> {
    return (await readReadyAudio(this.disk, key))?.cache;
  }
  async prepareGeneration(input: PrepareGenerationInput): Promise<GenerationPlan> {
    await this.ready();
    const document = validateDocument(input.document);
    const opts = options(input.options);
    let providerVersion = opts.model ?? 'voicevox-engine:unspecified';
    if (opts.provider === 'voicevox' && this.adapters.voicevox.fingerprint) {
      try {
        providerVersion = await this.adapters.voicevox.fingerprint();
        await this.disk.write(['providers', 'voicevox-version.json'], { version: providerVersion });
      } catch {
        const known = await this.disk.read<{ version: string }>(['providers', 'voicevox-version.json']);
        if (typeof known?.version !== 'string' || !/^voicevox-engine:[a-zA-Z0-9_.-]{1,80}$/.test(known.version)) throw new Error('VOICEVOX Engineのversionを確認できません。アプリを開いて再試行してください。');
        providerVersion = known.version;
      }
    }
    const chunks = chunksFor(document, opts, providerVersion);
    if (!chunks.length) throw new Error('読み上げる文を1つ以上選んでください。');
    // Inspect source coverage before any synthesis/charge. Timing here is an explicit visual estimate.
    requireAudioPresentation({ id: 'plan', revision: 'plan', title: document.title, document, warnings: [], completedChunks: chunks.length, totalChunks: chunks.length,
      chunks: chunks.map(chunk => ({ id: chunk.id, audioUrl: '', durationSeconds: 1, timeline: [{ blockId: chunk.blockId, start: chunk.start, end: chunk.end, unitIds: chunk.unitIds }] })) });
    let attribution: string | undefined;
    if (opts.provider === 'voicevox') {
      try {
        const voice = (await this.adapters.voicevox.voices()).find(voice => voice.id === opts.voice);
        const name = voice?.speakerName ?? voice?.name.split(' / ')[0];
        if (name) attribution = `VOICEVOX:${name}`;
      } catch { /* Cached/offline plans remain usable without new voice metadata. */ }
    }
    const cacheAvailability = new Map<string, boolean>();
    for (const chunk of chunks) {
      if (cacheAvailability.has(chunk.speechKey)) { chunk.cacheHit = cacheAvailability.get(chunk.speechKey)!; continue; }
      chunk.cacheHit = Boolean(await this.readyCache(chunk.speechKey));
      if (!chunk.cacheHit) {
        const record = await this.disk.read<CacheRecord>(['cache', `${chunk.speechKey}.json`]);
        const bytes = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
        if (bytes && record?.hash && digest(bytes) !== record.hash) throw new Error('保存音声の整合性検査に失敗しました。');
        chunk.cacheHit = Boolean(bytes);
      }
      cacheAvailability.set(chunk.speechKey, chunk.cacheHit);
    }
    const revision = digest(JSON.stringify({ document, options: opts, providerVersion }));
    const bookId = `book-${digest(`${document.title}\0${document.rawText}`).slice(0, 24)}`;
    let unavailableReason = opts.transport === 'gateway' && opts.provider !== 'gemini' ? 'Cloudflare経路はGemini専用です。VOICEVOXはDirectを選んでください。'
      : opts.provider === 'gemini' && !this.config.paidEnabled ? '有料生成は設定で無効です。'
      : opts.provider === 'gemini' && opts.transport === 'direct' && !this.config.geminiApiKey ? 'Gemini直結のGoogle API keyが未設定です。'
      : opts.transport === 'gateway' && !this.config.gateway ? 'Gatewayのサーバー設定が未完了です。' : undefined;
    if (!unavailableReason && opts.transport === 'gateway' && chunks.some(chunk => !chunk.cacheHit)) {
      try { await this.adapters.gemini.preflight?.(opts); }
      catch (error) { unavailableReason = error instanceof SpeechRequestError ? error.message : 'Gatewayの設定確認に失敗しました。'; }
    }
    const chars = chunks.filter((chunk) => !chunk.cacheHit).reduce((sum, chunk) => sum + [...chunk.spokenText].length, 0);
    const estimate = estimateGeminiOutput(chars, opts.model);
    const estimatedSeconds = estimate.estimatedSeconds;
    const base = { schemaVersion: 1 as const, bookId, revision, providerVersion, ...(attribution ? { attribution } : {}), title: document.title, options: opts, chunks, sendingText: chunks.filter((chunk) => !chunk.cacheHit).map((chunk) => chunk.spokenText).join('\n'), endpoint: opts.provider === 'voicevox' ? VOICEVOX_ENDPOINT : opts.transport === 'gateway' && this.config.gateway ? gatewayEndpoint(this.config.gateway) : opts.transport === 'gateway' ? 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run' : GEMINI_ENDPOINT,
      ...(opts.transport === 'gateway' && this.config.gateway ? { routeIdentity: gatewayRouteIdentity(this.config.gateway) } : {}),
      available: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}), estimatedSeconds,
      estimatedOutputUsd: opts.provider === 'gemini' ? estimate.estimatedOutputUsd : 0,
      estimateNote: opts.provider === 'gemini' ? geminiEstimateNote(opts.transport, estimate) : '同じMacのVOICEVOX Engineを使用します。Googleへの本文送信・API利用料はありません。',
      warnings: ['原稿の区切りを一つずつ表示します。発話境界の時刻がない部分は表示用推定です。人手で測った時刻精度は未検証です。', '声・キャラクターごとの利用規約とクレジットを確認してください。'],
    };
    const hash = digest(JSON.stringify(base));
    const plan: GenerationPlan = { ...base, id: `plan-${hash}`, hash, createdAt: now() };
    await this.disk.write(['sources', `${revision}.json`], document);
    await this.disk.write(['plans', `${plan.id}.json`], { plan, document } satisfies StoredPlan);
    return plan;
  }
  async startGeneration(input: StartGenerationInput): Promise<GenerationJob> {
    await this.ready(); requireId(input.planId); requireId(input.operationId);
    const stored = await this.disk.read<StoredPlan>(['plans', `${input.planId}.json`]);
    if (!stored || stored.plan.hash !== input.planHash) throw new Error('計画が変更されています。再確認してください。');
    const { plan } = stored;
    if (!plan.available) throw new Error(plan.unavailableReason ?? '実行できない計画です。');
    if (plan.options.provider === 'gemini' && (input.paidConfirmed !== true || !this.config.paidEnabled || (plan.options.transport === 'direct' ? !this.config.geminiApiKey : !this.config.gateway))) throw new Error('有料開始の確認とサーバー設定が必要です。');
    if (plan.options.transport === 'gateway' && (plan.options.provider !== 'gemini' || !this.config.gateway || plan.endpoint !== gatewayEndpoint(this.config.gateway) || plan.routeIdentity !== gatewayRouteIdentity(this.config.gateway))) throw new Error('Gateway設定が計画から変更されています。計画を再確認してください。');
    const operationKey = digest(input.operationId);
    const job = await this.disk.withLock(`operation-${operationKey}`, async () => {
      const prior = await this.disk.read<{ jobId: string; planHash: string }>(['operations', `${operationKey}.json`]);
      if (prior) {
        if (prior.planHash !== plan.hash) throw new Error('同じ操作IDで別の計画は開始できません。');
        return this.getJob(prior.jobId);
      }
      const recovered = await this.disk.read<GenerationJob>(['jobs', `job-${operationKey}.json`]);
      if (recovered) {
        if (recovered.planId !== plan.id) throw new Error('同じ操作IDで別の計画は開始できません。');
        await this.disk.write(['operations', `${operationKey}.json`], { jobId: recovered.id, planHash: plan.hash });
        return recovered;
      }
      const job: GenerationJob = { schemaVersion: 1, id: `job-${operationKey}`, operationId: input.operationId, planId: plan.id, bookId: plan.bookId, revision: plan.revision, title: plan.title, provider: plan.options.provider, status: 'queued', createdAt: now(), updatedAt: now(),
        chunks: plan.chunks.map((chunk) => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'pending', attempts: 0, reused: false })), completedChunks: 0, totalChunks: plan.chunks.length };
      await this.disk.write(['owners', `${job.id}.json`], { pid: process.pid });
      await this.disk.write(['jobs', `${job.id}.json`], job);
      await this.disk.write(['operations', `${operationKey}.json`], { jobId: job.id, planHash: plan.hash });
      return job;
    });
    if (job.status === 'queued') this.launch(job.id);
    return job;
  }
  private launch(jobId: string): void {
    if (this.running.has(jobId)) return;
    const task = this.run(jobId).catch(async () => {
      await this.updateJob(jobId, (job) => { job.status = 'failed'; job.error = '保存処理に失敗しました。保存済み音声を保持して停止しました。'; }).catch(() => undefined);
    }).finally(async () => {
      this.running.delete(jobId);
      const job = await this.getJob(jobId).catch(() => undefined);
      if (job?.status === 'queued') { await pause(50); this.launch(jobId); }
    });
    this.running.set(jobId, task);
  }
  async waitForJob(jobId: string): Promise<GenerationJob> {
    for (;;) {
      const task = this.running.get(jobId);
      if (!task) return this.getJob(jobId);
      await task;
    }
  }
  private async updateJob(jobId: string, change: (job: GenerationJob) => void): Promise<GenerationJob> {
    return this.disk.withLock(`update-${jobId}`, async () => {
      const job = await this.getJob(jobId); change(job); job.updatedAt = now(); job.completedChunks = job.chunks.filter((chunk) => chunk.status === 'completed').length;
      await this.disk.write(['jobs', `${jobId}.json`], job); return job;
    });
  }
  private async run(jobId: string): Promise<void> {
    const release = await this.disk.lock(`run-${jobId}`);
    if (!release) return;
    try {
      const initial = await this.getJob(jobId);
      const stored = await this.disk.read<StoredPlan>(['plans', `${initial.planId}.json`]);
      if (!stored) throw new Error('missing plan');
      if (initial.chunks.some(chunk => chunk.status !== 'completed') && stored.plan.options.transport === 'gateway'
        && (!this.config.gateway || stored.plan.endpoint !== gatewayEndpoint(this.config.gateway) || stored.plan.routeIdentity !== gatewayRouteIdentity(this.config.gateway))) throw new SpeechRequestError('Gateway設定が変更されています。新しい計画を確認してください。');
      const verifiedCache = new Map<string, CacheRecord>();
      for (const state of initial.chunks) if (state.status === 'completed' && !verifiedCache.has(state.speechKey)) {
        const record = await this.readyCache(state.speechKey); if (record) verifiedCache.set(state.speechKey, record);
      }
      let lastPublishedAt = 0;
      await this.updateJob(jobId, (job) => { if (['queued', 'running'].includes(job.status)) job.status = 'running'; delete job.error; });
      for (const chunk of stored.plan.chunks) {
        const current = await this.getJob(jobId);
        if (current.status === 'cancel-requested' || current.status === 'cancelled') break;
        const state = current.chunks.find((state) => state.id === chunk.id)!;
        if (state.status === 'completed' || state.status === 'outcome-unknown') continue;
        const speechRelease = await this.disk.lock(`speech-${chunk.speechKey}`);
        if (!speechRelease) {
          await this.updateJob(jobId, (job) => { job.status = 'failed'; job.error = '同じ音声を別のジョブが処理中です。完了後に再開すると再利用できます。'; }); break;
        }
        try {
          let cache = verifiedCache.get(chunk.speechKey) ?? await this.readyCache(chunk.speechKey);
          if (cache) {
            await this.updateJob(jobId, (job) => { const target = job.chunks.find((target) => target.id === chunk.id)!; target.status = 'completed'; target.reused = true; delete target.error; });
          } else {
            const record = await this.disk.read<CacheRecord>(['cache', `${chunk.speechKey}.json`]);
            let audio = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
            if (audio && record?.hash && digest(audio) !== record.hash) throw new Error('保存音声の整合性が失われています。');
            if (!audio && stored.plan.options.provider === 'gemini' && (record?.status === 'sending' || record?.status === 'outcome-unknown')) {
              await this.updateJob(jobId, (job) => { const target = job.chunks.find((target) => target.id === chunk.id)!; target.status = 'outcome-unknown'; target.error = '送信済み音声の結果を確認できません。追加課金を避けるため再送しません。'; });
              continue;
            }
            if (!audio) {
              let capturedQuery: unknown;
              let capturedReceipt: SpeechReceipt | undefined;
              audio = await this.adapters[stored.plan.options.provider].synthesize({ text: chunk.spokenText, options: stored.plan.options, captureVoicevoxQuery: query => { capturedQuery = query; }, captureReceipt: receipt => { capturedReceipt = receipt; } }, async () => {
                const latest = await this.getJob(jobId);
                if (['cancel-requested', 'cancelled'].includes(latest.status)) throw new CancelledBeforeSend();
                await this.disk.write(['cache', `${chunk.speechKey}.json`], { schemaVersion: 1, provider: stored.plan.options.provider, status: 'sending' } satisfies CacheRecord);
                await this.updateJob(jobId, (job) => { const target = job.chunks.find((target) => target.id === chunk.id)!; target.status = 'sending'; target.attempts++; });
              });
              await this.disk.writeBytes(['audio', `${chunk.speechKey}.wav`], audio);
              if (capturedReceipt) await this.disk.write(['receipts', `${chunk.speechKey}.json`], capturedReceipt);
              await this.disk.write(['cache', `${chunk.speechKey}.json`], { schemaVersion: 1, provider: stored.plan.options.provider, status: 'audio-ready', hash: digest(audio) } satisfies CacheRecord);
              if (stored.plan.options.provider === 'voicevox' && capturedQuery && stored.plan.providerVersion) {
                await this.disk.write(['voicevox-queries', `${chunk.speechKey}.json`], { schemaVersion: 1, audioHash: digest(audio), spokenTextHash: digest(chunk.spokenText),
                  providerVersion: stored.plan.providerVersion, styleId: stored.plan.options.voice, query: capturedQuery } satisfies CapturedVoicevoxQuery);
              }
            }
            await this.updateJob(jobId, (job) => { job.chunks.find((target) => target.id === chunk.id)!.status = 'audio-ready'; });
            const durationSeconds = this.dependencies.finalizeAudio ? await this.dependencies.finalizeAudio(audio) : wavDuration(audio);
            cache = { schemaVersion: 1, provider: stored.plan.options.provider, status: 'ready', hash: digest(audio), durationSeconds };
            await this.disk.write(['cache', `${chunk.speechKey}.json`], cache);
            await this.updateJob(jobId, (job) => { const target = job.chunks.find((target) => target.id === chunk.id)!; target.status = 'completed'; target.reused = Boolean(record?.status === 'audio-ready'); delete target.error; });
          }
          verifiedCache.set(chunk.speechKey, cache);
          if (Date.now() - lastPublishedAt >= 5000) { await this.persistBook(stored, verifiedCache); lastPublishedAt = Date.now(); }
        } catch (error) {
          if (error instanceof CancelledBeforeSend) {
            await this.updateJob(jobId, job => { const target = job.chunks.find(target => target.id === chunk.id)!; target.status = 'pending'; delete target.error; job.status = 'cancelled'; delete job.error; });
            break;
          }
          const audio = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
          const ledger = await this.disk.read<CacheRecord>(['cache', `${chunk.speechKey}.json`]);
          const durable = Boolean(audio || await this.disk.readBytes(['audio-media', `${chunk.speechKey}.json`]));
          const uncertain = !durable && stored.plan.options.provider === 'gemini' && (error instanceof SpeechRequestError ? error.outcomeUnknown : ledger?.status === 'sending');
          const message = durable ? '保存済み音声の検証または対応表作成に失敗しました。再開では音声を再利用します。' : error instanceof SpeechRequestError ? error.message : '生成または保存に失敗しました。';
          if (!durable) await this.disk.write(['cache', `${chunk.speechKey}.json`], { schemaVersion: 1, provider: stored.plan.options.provider, status: uncertain ? 'outcome-unknown' : 'failed', error: message } satisfies CacheRecord);
          await this.updateJob(jobId, (job) => { const target = job.chunks.find((target) => target.id === chunk.id)!; target.status = durable ? 'audio-ready' : uncertain ? 'outcome-unknown' : 'failed'; target.error = message; job.status = uncertain ? 'outcome-unknown' : 'failed'; job.error = message; });
          break;
        } finally { await speechRelease(); }
      }
      await this.persistBook(stored, verifiedCache);
      const savedJob = await this.getJob(jobId);
      if (savedJob.status === 'running' && savedJob.chunks.every(chunk => chunk.status === 'completed')) await this.correctSavedAudio(jobId, stored);
      const correctedJob = await this.getJob(jobId);
      if (correctedJob.status === 'running' && correctedJob.chunks.every(chunk => chunk.status === 'completed')) await this.compressSavedAudio(jobId);
      await this.updateJob(jobId, (job) => {
        if (job.chunks.every((chunk) => chunk.status === 'completed')) job.status = 'completed';
        else if (job.chunks.some((chunk) => chunk.status === 'outcome-unknown')) job.status = 'outcome-unknown';
        else if (job.status === 'cancel-requested') job.status = 'cancelled';
        else if (job.status === 'running') job.status = 'failed';
      });
    } finally { await release(); }
  }
  /** Both providers use one default, local-only compression path after correction. */
  private async compressSavedAudio(jobId: string): Promise<void> {
    if (this.config.automaticCompression === false) return;
    const job = await this.getJob(jobId);
    const book = await this.getBook(job.bookId, job.revision);
    const chunks = [...new Map(book.chunks.map(chunk => [chunk.speechKey, chunk])).values()];
    const summary: NonNullable<GenerationJob['automaticCompression']> = { status: 'running', completedFiles: 0, totalFiles: chunks.length, sourceBytes: 0, compressedBytes: 0, removedWavBytes: 0, retainedWavFiles: 0 };
    const compression = this.dependencies.compression ?? { available: audioCompressionAvailable, encode: encodeVerifiedMp3 };
    if (!await compression.available().catch(() => false)) {
      summary.status = 'unavailable'; summary.retainedWavFiles = chunks.length;
      await this.updateJob(jobId, value => { value.automaticCompression = summary; }); return;
    }
    // Completed books can share speech. Keep the original if another reference
    // still needs correction; only intermediates newly synthesized by this job
    // are eligible for automatic deletion.
    const needsWav = new Set<string>();
    const referencedHashes = new Map<string, Set<string>>();
    for (const file of await this.disk.list('books')) {
      const other = await this.disk.read<AudioBookManifest>(['books', file]);
      for (const chunk of other?.chunks ?? []) {
        if (!chunk.alignment) needsWav.add(chunk.speechKey);
        else {
          const hashes = referencedHashes.get(chunk.speechKey) ?? new Set<string>();
          hashes.add(chunk.alignment.audioHash); referencedHashes.set(chunk.speechKey, hashes);
        }
      }
    }
    const newlyGenerated = new Set(job.chunks.filter(chunk => !chunk.reused && chunk.attempts > 0).map(chunk => chunk.speechKey));
    const previousProgress = await this.disk.read<{ files: Array<{ speechKey: string; cleanupPlanned?: boolean; sourceAudioHash?: string }> }>(['audio-compression-jobs', `${jobId}.json`]);
    const previousCleanup = new Map(previousProgress?.files.filter(file => file.cleanupPlanned).map(file => [file.speechKey, file.sourceAudioHash]));
    const files: Array<{ speechKey: string; status: 'verified' | 'source-removed' | 'source-retained' | 'failed' | 'in-use'; sourceAudioHash?: string; mp3Hash?: string; cleanupPlanned?: boolean; reason?: string }> = [];
    const recordProgress = () => this.disk.write(['audio-compression-jobs', `${jobId}.json`], { schemaVersion: 1, jobId, bookId: job.bookId, revision: job.revision, updatedAt: now(), ...summary, files });
    await this.updateJob(jobId, value => { value.automaticCompression = { ...summary }; });
    try {
      for (const chunk of chunks) {
        if (['cancel-requested', 'cancelled'].includes((await this.getJob(jobId)).status)) { summary.status = 'cancelled'; break; }
        const release = await this.disk.lock(`speech-${chunk.speechKey}`);
        if (!release) { summary.retainedWavFiles++; files.push({ speechKey: chunk.speechKey, status: 'in-use' }); await recordProgress(); continue; }
        try {
          const audio = await readReadyAudio(this.disk, chunk.speechKey);
          if (!audio) throw new Error('Saved source is unavailable.');
          const media = await compression.encode(this.disk, chunk.speechKey, audio.cache);
          // Always read back the persisted bytes/proof before using or removing input.
          await readReadyAudio(this.disk, chunk.speechKey, 'mp3');
          summary.completedFiles++; summary.sourceBytes += media.sourceBytes; summary.compressedBytes += media.bytes;
          const source = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
          const stillRunning = (await this.getJob(jobId)).status === 'running';
          const cleanupPlanned = Boolean(source && stillRunning && newlyGenerated.has(chunk.speechKey) && job.automaticAlignment?.status === 'completed'
            && chunk.alignment?.audioHash === media.sourceAudioHash && !needsWav.has(chunk.speechKey)
            && [...(referencedHashes.get(chunk.speechKey) ?? [])].every(hash => hash === media.sourceAudioHash));
          const alreadyRemoved = !source && previousCleanup.get(chunk.speechKey) === media.sourceAudioHash;
          const row = { speechKey: chunk.speechKey, status: 'verified' as 'verified' | 'source-removed' | 'source-retained', sourceAudioHash: media.sourceAudioHash, mp3Hash: media.hash, cleanupPlanned: cleanupPlanned || alreadyRemoved };
          files.push(row);
          // Persist the exact proof and intent before removing an intermediate.
          await recordProgress();
          if (source && cleanupPlanned) {
            await this.disk.removeVerified(['audio', `${chunk.speechKey}.wav`], media.sourceAudioHash);
            summary.removedWavBytes += source.length; row.status = 'source-removed';
          } else if (source) { summary.retainedWavFiles++; row.status = 'source-retained'; }
          else if (alreadyRemoved) { summary.removedWavBytes += media.sourceBytes; row.status = 'source-removed'; }
        } catch (error) {
          // Speech is already durable. Codec/verification failures never retry TTS.
          summary.retainedWavFiles++;
          files.push({ speechKey: chunk.speechKey, status: 'failed', reason: error instanceof Error ? error.message : 'Compression failed.' });
        } finally { await release(); }
        await recordProgress();
        await this.updateJob(jobId, value => { value.automaticCompression = { ...summary }; });
      }
      if (summary.status !== 'cancelled') summary.status = summary.completedFiles === summary.totalFiles ? 'completed' : 'partial';
    } catch { summary.status = 'failed'; }
    await recordProgress().catch(() => undefined);
    await this.updateJob(jobId, value => { value.automaticCompression = { ...summary }; });
  }
  /** Shared CLI/browser path: save speech first, then perform optional local correction. */
  private async correctSavedAudio(jobId: string, stored: StoredPlan): Promise<void> {
    if (!this.config.alignmentPython || !this.config.alignmentModelDir) {
      await this.updateJob(jobId, job => { job.automaticAlignment = { status: 'unavailable' }; }); return;
    }
    try {
      if (!await this.alignment.automaticAvailable()) {
        await this.updateJob(jobId, job => { job.automaticAlignment = { status: 'unavailable' }; }); return;
      }
      if ((await this.getJob(jobId)).status !== 'running') return;
      const alignment = await this.alignment.start({ bookId: stored.plan.bookId, revision: stored.plan.revision, operationId: `automatic-${jobId}` });
      const current = await this.updateJob(jobId, job => { job.automaticAlignment = { status: 'running', jobId: alignment.id }; });
      if (current.status === 'cancel-requested' || current.status === 'cancelled') await this.alignment.cancel(alignment.id);
      const result = await this.alignment.wait(alignment.id);
      await this.updateJob(jobId, job => { job.automaticAlignment = { status: result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed', jobId: result.id }; });
    } catch {
      // Correction failure does not invalidate durable speech or trigger another paid request.
      await this.updateJob(jobId, job => { job.automaticAlignment = { status: 'failed' }; });
    }
  }
  private async persistBook(stored: StoredPlan, verifiedCache: Map<string, CacheRecord>): Promise<void> {
    const { plan, document } = stored;
    await this.disk.withLock(`book-${digest(`${plan.bookId}:${plan.revision}`)}`, async () => {
      const filename = `${plan.bookId}_${plan.revision}.json`;
      const previous = await this.disk.read<AudioBookManifest>(['books', filename]);
      const previousChunks = new Map(previous?.chunks.map((chunk) => [chunk.id, chunk]) ?? []);
      const chunks: AudioBookManifest['chunks'] = [];
      for (const chunk of plan.chunks) {
        const cache = verifiedCache.get(chunk.speechKey);
        if (!cache?.durationSeconds) {
          const saved = previousChunks.get(chunk.id);
          if (saved?.speechKey === chunk.speechKey) chunks.push(saved);
          continue;
        }
        chunks.push({ id: chunk.id, speechKey: chunk.speechKey, audioUrl: `/api/local-audio/${chunk.speechKey}.wav`, mimeType: 'audio/wav', durationSeconds: cache.durationSeconds,
          timeline: [{ chunkId: chunk.id, blockId: chunk.blockId, start: chunk.start, end: chunk.end, unitIds: chunk.unitIds, startSeconds: 0, endSeconds: cache.durationSeconds, precision: 'sentence' }],
          ...(previousChunks.get(chunk.id)?.speechKey === chunk.speechKey && previousChunks.get(chunk.id)?.alignment ? { alignment: previousChunks.get(chunk.id)!.alignment } : {}) });
      }
      const manifest: AudioBookManifest = { schemaVersion: 1, id: plan.bookId, revision: plan.revision, title: plan.title, updatedAt: now(), completedChunks: chunks.length, totalChunks: plan.chunks.length, durationSeconds: chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0), precision: 'sentence', document, options: plan.options, providerVersion: plan.providerVersion, ...((plan.attribution ?? previous?.attribution) ? { attribution: plan.attribution ?? previous?.attribution } : {}), chunks, warnings: chunks.some((chunk) => chunk.alignment) ? [...new Set([...plan.warnings.filter((warning) => warning !== '同期精度は文単位です。フレーズ時刻・Gemini精密alignmentは未検証です。'), ...(previous?.warnings ?? []).filter((warning) => warning !== '同期精度は文単位です。フレーズ時刻・Gemini精密alignmentは未検証です。')])] : plan.warnings };
      manifest.presentation = chunks.length ? requireAudioPresentation(manifest) : inspectAudioPresentation(manifest);
      await this.disk.write(['books', filename], manifest);
    });
  }
  async getJob(jobId: string): Promise<GenerationJob> {
    requireId(jobId);
    const job = await this.disk.read<GenerationJob>(['jobs', `${jobId}.json`]);
    if (!job) throw new Error('ジョブが見つかりません。'); return job;
  }
  async listJobs(): Promise<GenerationJob[]> {
    await this.ready();
    const jobs = await Promise.all((await this.disk.list('jobs')).map((file) => this.disk.read<GenerationJob>(['jobs', file])));
    return jobs.filter((job): job is GenerationJob => Boolean(job)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async cancelJob(jobId: string): Promise<GenerationJob> {
    await this.ready(); requireId(jobId);
    const job = await this.updateJob(jobId, (job) => { if (['queued', 'running'].includes(job.status)) job.status = this.running.has(jobId) ? 'cancel-requested' : 'cancelled'; });
    if (job.automaticAlignment?.status === 'running' && job.automaticAlignment.jobId) await this.alignment.cancel(job.automaticAlignment.jobId);
    return this.getJob(jobId);
  }
  async getJobPlan(jobId: string): Promise<GenerationPlan> {
    await this.ready();
    const job = await this.getJob(jobId);
    const stored = await this.disk.read<StoredPlan>(['plans', `${job.planId}.json`]);
    if (!stored) throw new Error('生成計画が見つかりません。');
    const selectedChunkIds = job.chunks.filter((chunk) => ['pending', 'failed', 'audio-ready'].includes(chunk.status)).map((chunk) => chunk.id);
    return this.prepareGeneration({ document: stored.document, options: { ...stored.plan.options, selectedChunkIds } });
  }
  async resumeJob(jobId: string, paidConfirmed = false): Promise<GenerationJob> {
    await this.ready(); requireId(jobId);
    const current = await this.getJob(jobId);
    const stored = await this.disk.read<StoredPlan>(['plans', `${current.planId}.json`]);
    if (current.provider === 'gemini' && (paidConfirmed !== true || !this.config.paidEnabled || (stored?.plan.options.transport === 'direct' ? !this.config.geminiApiKey : !this.config.gateway))) throw new Error('有料再開には送信本文・概算の再確認とサーバー設定が必要です。');
    if (stored?.plan.options.transport === 'gateway' && (!this.config.gateway || stored.plan.endpoint !== gatewayEndpoint(this.config.gateway) || stored.plan.routeIdentity !== gatewayRouteIdentity(this.config.gateway))) throw new Error('Gateway設定が変更されています。計画を再確認してください。');
    await this.disk.write(['owners', `${jobId}.json`], { pid: process.pid });
    const job = await this.updateJob(jobId, (job) => {
      if (['completed', 'running', 'cancel-requested', 'queued'].includes(job.status)) return;
      if (!job.chunks.some((chunk) => ['pending', 'failed', 'audio-ready'].includes(chunk.status))) throw new Error('安全に再開できる未送信分がありません。結果不明の有料音声は自動再送しません。');
      for (const chunk of job.chunks) if (chunk.status === 'failed') chunk.status = 'pending';
      job.status = 'queued'; delete job.error;
    });
    if (job.status === 'queued') this.launch(jobId); return job;
  }
  async renameBook(bookId: string, revision: string, title: string): Promise<AudioBookManifest> {
    await this.ready(); requireId(bookId); requireKey(revision);
    const name = resolveDocumentTitle(title);
    await this.getBook(bookId, revision);
    // Display-name metadata is independent of immutable manuscript/audio and jobs.
    await this.disk.withLock(`name-${digest(`${bookId}:${revision}`)}`, async () => {
      await this.disk.write(['book-names', `${bookId}_${revision}.json`], { schemaVersion: 1, title: name, updatedAt: now() });
    });
    return this.getBook(bookId, revision);
  }
  private async displayName(book: AudioBookManifest): Promise<string> {
    const value = await this.disk.read<{ schemaVersion: number; title: string }>(['book-names', `${book.id}_${book.revision}.json`]);
    return value?.schemaVersion === 1 && typeof value.title === 'string' ? resolveDocumentTitle(value.title) : book.title;
  }
  async listLibrary(): Promise<AudioBookSummary[]> {
    await this.ready();
    const books = await Promise.all((await this.disk.list('books')).map((file) => this.disk.read<AudioBookManifest>(['books', file])));
    const summaries = await Promise.all(books.filter((book): book is AudioBookManifest => Boolean(book)).map(async book => ({ id: book.id, revision: book.revision, title: await this.displayName(book), updatedAt: book.updatedAt, completedChunks: book.completedChunks, totalChunks: book.totalChunks, durationSeconds: book.durationSeconds, precision: book.precision })));
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getBook(bookId: string, revision?: string): Promise<AudioBookManifest> {
    await this.ready(); requireId(bookId);
    const selected = revision ?? (await this.listLibrary()).find((book) => book.id === bookId)?.revision;
    requireKey(selected);
    const book = await this.disk.read<AudioBookManifest>(['books', `${bookId}_${selected}.json`]);
    if (!book) throw new Error('保存済み音声が見つかりません。');
    // Old valid records get a fresh in-memory report; reading never rewrites the saved manuscript/audio.
    const title = await this.displayName(book);
    const chunks = await Promise.all(book.chunks.map(async chunk => {
      const media = await compressedAudioRecord(this.disk, chunk.speechKey);
      if (!media) return chunk;
      if (Math.abs(media.durationSeconds - chunk.durationSeconds) > 1e-6) throw new Error('MP3と保存済み文の時計が一致しません。');
      return { ...chunk, audioUrl: `/api/local-audio/${chunk.speechKey}.mp3`, mimeType: 'audio/mpeg' as const };
    }));
    const view = { ...book, chunks, title, document: { ...book.document, title } };
    return { ...view, presentation: requireAudioPresentation(view) };
  }
  async getAudio(speechKey: string, requested?: 'wav' | 'mp3') {
    await this.ready(); requireKey(speechKey);
    const audio = await readReadyAudio(this.disk, speechKey, requested);
    if (!audio) throw new Error('検証済み音声がありません。');
    return audio;
  }
  async getAlignmentCapabilities() { await this.ready(); return this.alignment.capabilities(); }
  async startAlignment(input: StartAlignmentInput): Promise<AlignmentJob> { await this.ready(); return this.alignment.start(input); }
  async listAlignmentJobs(): Promise<AlignmentJob[]> { await this.ready(); return this.alignment.list(); }
  async getAlignmentJob(jobId: string): Promise<AlignmentJob> { await this.ready(); return this.alignment.get(jobId); }
  async cancelAlignmentJob(jobId: string): Promise<AlignmentJob> { await this.ready(); return this.alignment.cancel(jobId); }
  async resumeAlignmentJob(jobId: string): Promise<AlignmentJob> { await this.ready(); return this.alignment.resume(jobId); }
  async waitForAlignmentJob(jobId: string): Promise<AlignmentJob> { await this.ready(); return this.alignment.wait(jobId); }

}
