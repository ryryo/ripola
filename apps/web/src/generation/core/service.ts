import { resolveDocumentTitle } from '../../reader/document-title';
import { setTimeout as pause } from 'node:timers/promises';
import { inspectAudioPresentation, requireAudioPresentation } from '../../reader/audio-presentation';
import { DEFAULT_SETTINGS, type ReadingDocument } from '../../reader/model';
import { validateSavedReading } from '../../reader/storage';
import { GEMINI_MODELS, type AlignmentJob, type StartAlignmentInput, type AudioBookManifest, type AudioBookSummary, type GenerationChunk, type GenerationChunkSpan, type GenerationChunkPlanningInput, type GenerationChunkPlanningResult, type SpeechProvider, type SpeechProviderCapabilities, type SpeechReceipt, type GenerationConfig, type GenerationJob, type GenerationOptions, type GenerationPlan, type PrepareGenerationInput, type StartGenerationInput } from '../contracts';
import { jobResumeMode } from '../job-resume';
import type { GenerationServerConfig } from './config';
import { prepareSpeech } from './speech-source';
import { estimateGeminiOutput, geminiEstimateNote } from '../cost-estimate';
import { AlignmentService } from './alignment-service';
import type { CapturedVoicevoxQuery } from './voicevox-timing';
import type { AlignmentAdapter } from './alignment-adapter';
import { BOOK_REFERENCES_LOCK, digest, LibraryDisk, processAlive, requireId, requireKey } from './disk';
import { compressedAudioRecord, readReadyAudio, type AudioCacheRecord as CacheRecord } from './audio-cache';
import { audioCompressionAvailable, encodeVerifiedMp3 } from './audio-compression';
import { WavReferences } from './audio-cleanup';
import { BookPublisher } from './book-publisher';
import { GEMINI_ENDPOINT, GEMINI_VOICES, geminiAdapter, gatewayEndpoint, gatewayRouteIdentity, SpeechRequestError, VOICEVOX_CAPABILITIES, GEMINI_CAPABILITIES, IRODORI_CAPABILITIES, VOICEVOX_ENDPOINT, voicevoxAdapter, wavDuration, type SpeechAdapter } from './providers';

class CancelledBeforeSend extends Error {}

interface StoredPlan { plan: GenerationPlan; document: ReadingDocument }
export interface ServiceDependencies {
  voicevox?: SpeechAdapter;
  gemini?: SpeechAdapter;
  /** Optional providers are registered explicitly; constructing the core never installs them. */
  providers?: Partial<Record<SpeechProvider, SpeechAdapter>>;
  planChunks?: (input: GenerationChunkPlanningInput) => GenerationChunkPlanningResult | Promise<GenerationChunkPlanningResult>;
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
  if (!['voicevox', 'gemini', 'irodori'].includes(value.provider) || !text(value.voice, 64) || !value.voice || !['direct', 'gateway'].includes(value.transport)
    || (value.model !== undefined && !(value.provider === 'irodori' ? ['irodori-tts', 'irodori-tts-mf'].includes(value.model) : GEMINI_MODELS.some(model => model === value.model))) || !Array.isArray(value.readings) || value.readings.length > 1000
    || !value.readings.every((reading) => reading && text(reading.text, 256) && reading.text.length > 0 && text(reading.reading, 256) && reading.reading.length > 0)
    || (value.style !== undefined && !text(value.style, 2000))
    || (value.chunking !== undefined && (!value.chunking || !['sentence', 'auto'].includes(value.chunking.mode)))
    || (value.selectedChunkIds !== undefined && (!Array.isArray(value.selectedChunkIds) || value.selectedChunkIds.length > 100_000 || !value.selectedChunkIds.every((id) => text(id, 128))))) inputError();
  if (value.irodori !== undefined && (value.provider !== 'irodori' || !value.irodori
    || (value.irodori.steps !== undefined && (!Number.isSafeInteger(value.irodori.steps) || value.irodori.steps < 1 || value.irodori.steps > 100))
    || (value.irodori.speed !== undefined && (!Number.isFinite(value.irodori.speed) || value.irodori.speed < 0.25 || value.irodori.speed > 4))
    || (value.irodori.seed !== undefined && (!Number.isSafeInteger(value.irodori.seed) || value.irodori.seed < 0))
    || (value.irodori.instructions !== undefined && !text(value.irodori.instructions, 2000)))) inputError();
  if (value.provider === 'voicevox' && (!/^\d{1,8}$/.test(value.voice) || value.style)) throw new Error('VOICEVOXは数値style IDを指定し、style指示は空にしてください。');
  if (value.provider === 'gemini' && value.transport === 'gateway' && value.style) throw new Error('Cloudflare経路は読み上げ方の指示に未対応です。指示を空にするかGemini直結を選んでください。');
  if (value.provider === 'gemini' && !GEMINI_VOICES.some((voice) => voice.id === value.voice)) throw new Error('対応するGemini voiceを選んでください。');
  return {
    provider: value.provider, voice: value.voice, transport: value.transport,
    ...(value.provider === 'gemini' ? { model: value.model ?? GEMINI_MODELS[0], style: value.style ?? '' } : {}),
    ...(value.provider === 'irodori' ? { model: value.model ?? (value.voice === 'ripola' ? 'irodori-tts-mf' as const : 'irodori-tts' as const), style: value.style ?? '' } : {}),
    ...(value.chunking ? { chunking: { mode: value.chunking.mode } } : {}),
    ...(value.irodori ? { irodori: { ...(value.irodori.steps === undefined ? {} : { steps: value.irodori.steps }), ...(value.irodori.speed === undefined ? {} : { speed: value.irodori.speed }), ...(value.irodori.seed === undefined ? {} : { seed: value.irodori.seed }), ...(value.irodori.instructions === undefined ? {} : { instructions: value.irodori.instructions }) } } : {}),
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
function sentenceSpans(document: ReadingDocument): GenerationChunkSpan[] {
  const spans: GenerationChunkSpan[] = [];
  const segmenter = new Intl.Segmenter('ja', { granularity: 'sentence' });
  for (const block of document.blocks) {
    if (block.kind === 'code' || block.kind === 'table') continue;
    for (const sentence of segmenter.segment(block.text)) if (sentence.segment.trim()) {
      spans.push({ blockId: block.id, start: sentence.index, end: sentence.index + sentence.segment.length });
    }
  }
  return spans;
}
/** A planner chooses spans; the core validates coverage and owns IDs, readings and cache identity. */
function chunksFor(document: ReadingDocument, opts: GenerationOptions, providerVersion: string, spans: GenerationChunkSpan[], capabilities: SpeechProviderCapabilities): GenerationChunk[] {
  if (!Array.isArray(spans) || spans.length > 100_000) throw new Error('chunk計画の形式が正しくありません。');
  const blocks = new Map(document.blocks.map((block, index) => [block.id, { block, index }]));
  const unitsByBlock = new Map<string, ReadingDocument['units']>();
  for (const unit of document.units) {
    const units = unitsByBlock.get(unit.blockId) ?? [];
    units.push(unit); unitsByBlock.set(unit.blockId, units);
  }
  const ends = new Map<string, number>();
  const unitCursors = new Map<string, number>();
  let lastBlock = -1;
  const result: GenerationChunk[] = [];
  for (const span of spans) {
    const source = blocks.get(span?.blockId);
    if (!source || source.block.kind === 'code' || source.block.kind === 'table' || source.index < lastBlock
      || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < (ends.get(span.blockId) ?? 0)
      || span.end <= span.start || span.end > source.block.text.length
      || source.block.text.slice(ends.get(span.blockId) ?? 0, span.start).trim()) throw new Error('chunk計画の本文順・元範囲が正しくありません。');
    const { block } = source;
    const splitsSurrogate = (offset: number) => /[\uD800-\uDBFF]/.test(block.text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(block.text.charAt(offset));
    if (splitsSurrogate(span.start) || splitsSurrogate(span.end) || block.ruby.some(ruby => ruby.start < span.start && ruby.end > span.start || ruby.start < span.end && ruby.end > span.end)) throw new Error('chunk計画が文字またはルビの途中を分割しています。');
    lastBlock = source.index; ends.set(span.blockId, span.end);
    const originalText = block.text.slice(span.start, span.end);
    if (originalText.length > 3000) throw new Error('1文が3000文字を超えています。本文で文を区切ってから計画してください。');
    const spokenText = prepareSpeech(block, span.start, span.end, opts.readings).spokenText;
    if (!spokenText) continue;
    if (capabilities.maxCharacters && [...spokenText].length > capabilities.maxCharacters) throw new Error('chunkが生成先の本文上限を超えています。区切りを見直してください。');
    const id = `chunk-${digest(`${block.id}:${span.start}:${span.end}`).slice(0, 24)}`;
    const speechKey = digest(JSON.stringify({ schema: 'speech-v1', text: spokenText, provider: opts.provider, model: opts.model ?? 'voicevox-engine', voice: opts.voice, style: opts.style ?? '', providerVersion, ...(opts.irodori ? { irodori: opts.irodori } : {}) }));
    const blockUnits = unitsByBlock.get(block.id) ?? [];
    let unitCursor = unitCursors.get(block.id) ?? 0;
    while (unitCursor < blockUnits.length && blockUnits[unitCursor].end <= span.start) unitCursor++;
    unitCursors.set(block.id, unitCursor);
    const unitIds: string[] = [];
    for (let cursor = unitCursor; cursor < blockUnits.length && blockUnits[cursor].start < span.end; cursor++) unitIds.push(blockUnits[cursor].id);
    result.push({ id, sourceOrder: result.length, blockId: span.blockId, start: span.start, end: span.end, unitIds, originalText, spokenText, speechKey, cacheHit: false });
  }
  for (const block of document.blocks) if (block.kind !== 'code' && block.kind !== 'table' && block.text.slice(ends.get(block.id) ?? 0).trim()) throw new Error('chunk計画に未収録の本文があります。');
  if (opts.selectedChunkIds) {
    const ids = new Set(result.map(chunk => chunk.id));
    if (opts.selectedChunkIds.some(id => !ids.has(id))) throw new Error('選択された文が現在の本文に存在しません。');
    const selected = new Set(opts.selectedChunkIds);
    return result.filter(chunk => selected.has(chunk.id));
  }
  return result;
}
function executionOrder(chunks: Array<{ id: string }>, priority: unknown): string[] {
  if (!Array.isArray(priority) || priority.length > chunks.length || !priority.every(id => typeof id === 'string')) throw new Error('実行優先順の形式が正しくありません。');
  const selected = new Set(priority as string[]);
  const ids = new Set(chunks.map(chunk => chunk.id));
  if (selected.size !== priority.length || [...selected].some(id => !ids.has(id))) throw new Error('実行優先順に重複または対象外chunkがあります。');
  return [...selected, ...chunks.filter(chunk => !selected.has(chunk.id)).map(chunk => chunk.id)];
}

export class GenerationService {
  private readonly interruptedCompressionJobs: string[] = [];
  private readonly disk: LibraryDisk;
  private readonly adapters: Partial<Record<SpeechProvider, SpeechAdapter>> & Record<'voicevox' | 'gemini', SpeechAdapter>;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly initialized: Promise<void>;
  private readonly alignment: AlignmentService;
  constructor(readonly config: GenerationServerConfig, private readonly dependencies: ServiceDependencies = {}) {
    this.disk = new LibraryDisk(config.libraryDir);
    this.adapters = { voicevox: dependencies.voicevox ?? voicevoxAdapter(), gemini: dependencies.gemini ?? geminiAdapter(config.geminiApiKey, config.gateway), ...dependencies.providers };
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
    try { voices = await this.adapters.voicevox.voices(); } catch { message = '同じPCのVOICEVOXアプリを開き、Engineの起動を確認してください。'; }
    const gatewayStatus = this.adapters.gemini.availability?.() ?? { available: Boolean(this.config.gateway) };
    const optional = this.adapters.irodori;
    let optionalVoices: GenerationConfig['voicevox']['voices'] = [];
    let optionalStatus = optional?.availability?.() ?? { available: Boolean(optional) };
    if (optional) {
      try { optionalVoices = await optional.voices(); } catch { optionalStatus = { available: false, message: 'Irodoriの利用状態を確認できません。' }; }
    }
    return {
      providers: [
        { id: 'voicevox', available: voices.length > 0, endpoint: VOICEVOX_ENDPOINT, voices, capabilities: this.capabilities('voicevox'), ...(message ? { message } : {}) },
        { id: 'gemini', available: Boolean(this.config.paidEnabled && (this.config.geminiApiKey || gatewayStatus.available)), endpoint: GEMINI_ENDPOINT, voices: GEMINI_VOICES, capabilities: this.capabilities('gemini') },
        ...(optional ? [{ id: 'irodori' as const, available: optionalStatus.available, endpoint: optional.endpoint ?? 'ローカル未設定', voices: optionalVoices, capabilities: this.capabilities('irodori'), message: optionalStatus.message }] : []),
      ],
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
  private requireProvider(provider: SpeechProvider): void {
    if (provider === 'irodori' && !this.adapters.irodori) throw new Error('Irodoriは開発用の明示的な有効化が必要です。');
  }
  private capabilities(provider: SpeechProvider): SpeechProviderCapabilities {
    return this.adapters[provider]?.capabilities ?? (provider === 'voicevox' ? VOICEVOX_CAPABILITIES : provider === 'gemini' ? GEMINI_CAPABILITIES : IRODORI_CAPABILITIES);
  }
  private async readyCache(key: string): Promise<CacheRecord | undefined> {
    return (await readReadyAudio(this.disk, key))?.cache;
  }
  async prepareGeneration(input: PrepareGenerationInput): Promise<GenerationPlan> {
    await this.ready();
    const document = validateDocument(input.document);
    const opts = options(input.options);
    this.requireProvider(opts.provider);
    const adapter = this.adapters[opts.provider];
    let providerVersion: string = opts.model ?? 'voicevox-engine:unspecified';
    const providerRecord = opts.provider === 'voicevox' ? 'voicevox-version.json' : `${opts.provider}-${digest(JSON.stringify({ model: opts.model, voice: opts.voice }))}.json`;
    if (opts.provider !== 'gemini' && adapter?.fingerprint) {
      try {
        providerVersion = await adapter.fingerprint(opts);
        if (!text(providerVersion, 512) || !providerVersion) throw new Error('Invalid provider version.');
        await this.disk.write(['providers', providerRecord], { version: providerVersion });
      } catch {
        if (opts.provider === 'irodori' && adapter.availability?.().available !== false) throw new Error('Irodoriのモデル・声の同一性を確認できません。設定を確認してください。');
        const known = await this.disk.read<{ version: string }>(['providers', providerRecord]);
        if (typeof known?.version !== 'string' || !known.version || known.version.length > 512 || (opts.provider === 'voicevox' && !/^voicevox-engine:[a-zA-Z0-9_.-]{1,80}$/.test(known.version))) throw new Error('生成先のversionを確認できません。ローカル音声設定を確認してください。');
        providerVersion = known.version;
      }
    }
    const capabilities = this.capabilities(opts.provider);
    const defaultSpans = sentenceSpans(document);
    let chunkPlan: GenerationPlan['chunkPlan'];
    let spans = defaultSpans;
    if (opts.chunking?.mode === 'auto') {
      if (!this.dependencies.planChunks) throw new Error('自動chunk計画は未導入です。文単位を選んでください。');
      const planned = await this.dependencies.planChunks({ document, options: opts, providerVersion, capabilities, defaultSpans });
      if (!text(planned.version, 200) || !planned.version || !text(planned.settingsFingerprint, 512) || !planned.settingsFingerprint) throw new Error('chunk計画のversionが正しくありません。');
      spans = planned.spans; chunkPlan = { version: planned.version, settingsFingerprint: planned.settingsFingerprint };
    }
    const chunks = chunksFor(document, opts, providerVersion, spans, capabilities);
    if (!chunks.length) throw new Error('読み上げる文を1つ以上選んでください。');
    // Inspect source coverage before any synthesis/charge. Timing here is an explicit visual estimate.
    requireAudioPresentation({ id: 'plan', revision: 'plan', title: document.title, document, warnings: [], completedChunks: chunks.length, totalChunks: chunks.length,
      chunks: chunks.map(chunk => ({ id: chunk.id, audioUrl: '', durationSeconds: 1, timeline: [{ blockId: chunk.blockId, start: chunk.start, end: chunk.end, unitIds: chunk.unitIds }] })) });
    let attribution = await adapter?.attribution?.(opts);
    if (attribution !== undefined && !text(attribution, 2000)) throw new Error('音声の帰属情報が正しくありません。');
    if (!attribution && opts.provider === 'voicevox') {
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
    const revision = digest(JSON.stringify({ document, options: opts, providerVersion, ...(chunkPlan ? { chunkPlan } : {}) }));
    const bookId = `book-${digest(`${document.title}\0${document.rawText}`).slice(0, 24)}`;
    let unavailableReason = !adapter || adapter.availability?.().available === false && opts.provider === 'irodori' ? 'Irodoriのローカル設定が未完了です。明示的に導入してから再確認してください。' : opts.transport === 'gateway' && opts.provider !== 'gemini' ? 'Cloudflare経路はGemini専用です。VOICEVOXはDirectを選んでください。'
      : opts.provider === 'gemini' && !this.config.paidEnabled ? '有料生成は設定で無効です。'
      : opts.provider === 'gemini' && opts.transport === 'direct' && !this.config.geminiApiKey ? 'Gemini直結のGoogle API keyが未設定です。'
      : opts.transport === 'gateway' && !this.config.gateway ? 'Gatewayのサーバー設定が未完了です。' : undefined;
    if (!unavailableReason && opts.transport === 'gateway' && chunks.some(chunk => !chunk.cacheHit)) {
      try { await this.adapters.gemini.preflight?.(opts); }
      catch (error) { unavailableReason = error instanceof SpeechRequestError ? error.message : 'Gatewayの設定確認に失敗しました。'; }
    }
    const chars = chunks.filter((chunk) => !chunk.cacheHit).reduce((sum, chunk) => sum + [...chunk.spokenText].length, 0);
    const estimate = estimateGeminiOutput(chars, opts.model === GEMINI_MODELS[1] ? GEMINI_MODELS[1] : GEMINI_MODELS[0]);
    const estimatedSeconds = estimate.estimatedSeconds;
    const base = { schemaVersion: 1 as const, bookId, revision, providerVersion, ...(chunkPlan ? { chunkPlan } : {}), ...(attribution ? { attribution } : {}), title: document.title, options: opts, chunks, sendingText: chunks.filter((chunk) => !chunk.cacheHit).map((chunk) => chunk.spokenText).join('\n'), endpoint: opts.provider === 'voicevox' ? VOICEVOX_ENDPOINT : opts.provider === 'irodori' ? adapter?.endpoint ?? 'ローカル未設定' : opts.transport === 'gateway' && this.config.gateway ? gatewayEndpoint(this.config.gateway) : opts.transport === 'gateway' ? 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run' : GEMINI_ENDPOINT,
      ...(opts.transport === 'gateway' && this.config.gateway ? { routeIdentity: gatewayRouteIdentity(this.config.gateway) } : {}),
      available: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}), estimatedSeconds,
      estimatedOutputUsd: opts.provider === 'gemini' ? estimate.estimatedOutputUsd : 0,
      estimateNote: opts.provider === 'gemini' ? geminiEstimateNote(opts.transport, estimate) : opts.provider === 'irodori' ? '明示設定したローカルIrodoriを使用します。モデルの自動取得は行いません。' : '同じPCのVOICEVOX Engineを使用します。Googleへの本文送信・API利用料はありません。',
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
    this.requireProvider(plan.options.provider);
    if (!plan.available) throw new Error(plan.unavailableReason ?? '実行できない計画です。');
    if (plan.options.provider === 'gemini' && (input.paidConfirmed !== true || !this.config.paidEnabled || (plan.options.transport === 'direct' ? !this.config.geminiApiKey : !this.config.gateway))) throw new Error('有料開始の確認とサーバー設定が必要です。');
    if (plan.options.transport === 'gateway' && (plan.options.provider !== 'gemini' || !this.config.gateway || plan.endpoint !== gatewayEndpoint(this.config.gateway) || plan.routeIdentity !== gatewayRouteIdentity(this.config.gateway))) throw new Error('Gateway設定が計画から変更されています。計画を再確認してください。');
    const order = input.prioritizedChunkIds === undefined ? undefined : executionOrder(plan.chunks, input.prioritizedChunkIds);
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
        chunks: plan.chunks.map((chunk) => ({ id: chunk.id, speechKey: chunk.speechKey, status: 'pending', attempts: 0, reused: false })), ...(order ? { executionOrder: order } : {}), completedChunks: 0, totalChunks: plan.chunks.length };
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
    let publisher: BookPublisher | undefined;
    try {
      const initial = await this.getJob(jobId);
      const stored = await this.disk.read<StoredPlan>(['plans', `${initial.planId}.json`]);
      if (!stored) throw new Error('missing plan');
      if (initial.chunks.some(chunk => chunk.status !== 'completed' && chunk.status !== 'outcome-unknown') && stored.plan.options.transport === 'gateway'
        && (!this.config.gateway || stored.plan.endpoint !== gatewayEndpoint(this.config.gateway) || stored.plan.routeIdentity !== gatewayRouteIdentity(this.config.gateway))) throw new SpeechRequestError('Gateway設定が変更されています。新しい計画を確認してください。');
      const verifiedCache = new Map<string, CacheRecord>();
      for (const state of initial.chunks) if (state.status === 'completed' && !verifiedCache.has(state.speechKey)) {
        const record = await this.readyCache(state.speechKey); if (record) verifiedCache.set(state.speechKey, record);
      }
      publisher = new BookPublisher(() => this.persistBook(stored, new Map(verifiedCache), jobId));
      await this.updateJob(jobId, (job) => { if (['queued', 'running'].includes(job.status)) job.status = 'running'; delete job.error; });
      const sourceIds = stored.plan.chunks.map(chunk => chunk.id);
      const remaining = new Map(stored.plan.chunks.map(chunk => [chunk.id, chunk]));
      while (remaining.size) {
        publisher.check();
        const current = await this.getJob(jobId);
        const nextId = (current.executionOrder ?? sourceIds).find(id => remaining.has(id));
        if (!nextId) throw new Error('Invalid execution order.');
        const chunk = remaining.get(nextId)!; remaining.delete(nextId);
        if (current.status === 'cancel-requested' || current.status === 'cancelled') break;
        const state = current.chunks.find((state) => state.id === chunk.id)!;
        if (state.status === 'completed' || state.status === 'outcome-unknown') continue;
        const speechRelease = await this.disk.lock(`speech-${chunk.speechKey}`);
        if (!speechRelease) {
          await this.updateJob(jobId, (job) => { job.status = 'failed'; job.error = '同じ音声を別のジョブが処理中です。完了後に再開すると再利用できます。'; }); break;
        }
        let requestCancelled = false;
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
              const adapter = this.adapters[stored.plan.options.provider];
              if (!adapter) throw new SpeechRequestError('生成先が未導入です。ローカル設定を確認してください。');
              await adapter.preflight?.(stored.plan.options);
              const controller = new AbortController();
              if (adapter.capabilities?.cancellation === 'abort') this.activeRequests.set(jobId, controller);
              try {
                audio = await adapter.synthesize({ signal: controller.signal, providerVersion: stored.plan.providerVersion, text: chunk.spokenText, options: stored.plan.options, captureVoicevoxQuery: query => { capturedQuery = query; }, captureReceipt: receipt => { capturedReceipt = receipt; } }, async () => {
                  publisher!.check();
                  const latest = await this.getJob(jobId);
                  if (['cancel-requested', 'cancelled'].includes(latest.status)) throw new CancelledBeforeSend();
                  await this.disk.write(['cache', `${chunk.speechKey}.json`], { schemaVersion: 1, provider: stored.plan.options.provider, status: 'sending' } satisfies CacheRecord);
                  await this.updateJob(jobId, (job) => { const target = job.chunks.find((target) => target.id === chunk.id)!; target.status = 'sending'; target.attempts++; });
                });
              } finally { requestCancelled = controller.signal.aborted; this.activeRequests.delete(jobId); }
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
        } catch (error) {
          if (error instanceof CancelledBeforeSend || requestCancelled && stored.plan.options.provider !== 'gemini') {
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
        await publisher.changed();
      }
      await publisher.finish();
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
    } finally { await publisher?.close(); await release(); }
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
    // Cached speech can still have a WAV from an earlier compression failure.
    // Keep it while any saved book needs correction or refers to another hash.
    const references = new WavReferences(this.disk);
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
          await this.disk.withLock(BOOK_REFERENCES_LOCK, async () => {
            const stillRunning = (await this.getJob(jobId)).status === 'running';
            const cleanupPlanned = Boolean(source && stillRunning && job.automaticAlignment?.status === 'completed'
              && chunk.alignment?.audioHash === media.sourceAudioHash && await references.permitsRemoval(chunk.speechKey, media.sourceAudioHash));
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
          });
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
  private async persistBook(stored: StoredPlan, verifiedCache: Map<string, CacheRecord>, jobId: string): Promise<void> {
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
        chunks.push({ id: chunk.id, ...(chunk.sourceOrder === undefined ? {} : { sourceOrder: chunk.sourceOrder }), speechKey: chunk.speechKey, audioUrl: `/api/local-audio/${chunk.speechKey}.wav`, mimeType: 'audio/wav', durationSeconds: cache.durationSeconds,
          timeline: [{ chunkId: chunk.id, blockId: chunk.blockId, start: chunk.start, end: chunk.end, unitIds: chunk.unitIds, startSeconds: 0, endSeconds: cache.durationSeconds, precision: 'sentence' }],
          ...(previousChunks.get(chunk.id)?.speechKey === chunk.speechKey && previousChunks.get(chunk.id)?.alignment ? { alignment: previousChunks.get(chunk.id)!.alignment } : {}) });
      }
      const manifest: AudioBookManifest = { schemaVersion: 1, id: plan.bookId, revision: plan.revision, title: plan.title, updatedAt: now(), completedChunks: chunks.length, totalChunks: plan.chunks.length, durationSeconds: chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0), precision: 'sentence', document, options: plan.options, providerVersion: plan.providerVersion, ...((plan.attribution ?? previous?.attribution) ? { attribution: plan.attribution ?? previous?.attribution } : {}), chunks, plannedChunkIds: plan.chunks.map(chunk => chunk.id), generation: { jobId, planId: plan.id, planHash: plan.hash, sequence: (previous?.generation?.sequence ?? 0) + 1 }, warnings: chunks.some((chunk) => chunk.alignment) ? [...new Set([...plan.warnings.filter((warning) => warning !== '同期精度は文単位です。フレーズ時刻・Gemini精密alignmentは未検証です。'), ...(previous?.warnings ?? []).filter((warning) => warning !== '同期精度は文単位です。フレーズ時刻・Gemini精密alignmentは未検証です。')])] : plan.warnings };
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
    if (job.status === 'cancel-requested' || job.status === 'cancelled') this.activeRequests.get(jobId)?.abort();
    if (job.automaticAlignment?.status === 'running' && job.automaticAlignment.jobId) await this.alignment.cancel(job.automaticAlignment.jobId);
    return this.getJob(jobId);
  }
  /** Reorders future work under the job lock; it never moves source chunks or saved audio. */
  async prioritizeJobChunks(jobId: string, chunkIds: string[]): Promise<GenerationJob> {
    await this.ready(); requireId(jobId);
    return this.updateJob(jobId, job => {
      const order = executionOrder(job.chunks, chunkIds);
      if (['queued', 'running'].includes(job.status)) job.executionOrder = order;
    });
  }
  async getJobPlan(jobId: string): Promise<GenerationPlan> {
    await this.ready();
    const job = await this.getJob(jobId);
    const stored = await this.disk.read<StoredPlan>(['plans', `${job.planId}.json`]);
    if (!stored) throw new Error('生成計画が見つかりません。');
    // A resume preview uses the frozen source spans and speech keys. Never invoke a new planner here.
    const remaining = new Set(job.chunks.filter(chunk => ['pending', 'failed', 'audio-ready'].includes(chunk.status)).map(chunk => chunk.id));
    const plan = structuredClone(stored.plan);
    plan.chunks = plan.chunks.filter(chunk => remaining.has(chunk.id));
    for (const chunk of plan.chunks) {
      chunk.cacheHit = Boolean(await this.readyCache(chunk.speechKey));
      if (!chunk.cacheHit) {
        const audio = await this.disk.readBytes(['audio', `${chunk.speechKey}.wav`]);
        const record = await this.disk.read<CacheRecord>(['cache', `${chunk.speechKey}.json`]);
        if (audio && record?.hash && digest(audio) !== record.hash) throw new Error('保存音声の整合性検査に失敗しました。');
        chunk.cacheHit = Boolean(audio);
      }
    }
    plan.sendingText = plan.chunks.filter(chunk => !chunk.cacheHit).map(chunk => chunk.spokenText).join('\n');
    const estimate = estimateGeminiOutput(plan.chunks.filter(chunk => !chunk.cacheHit).reduce((sum, chunk) => sum + [...chunk.spokenText].length, 0), plan.options.model === GEMINI_MODELS[1] ? GEMINI_MODELS[1] : GEMINI_MODELS[0]);
    plan.estimatedSeconds = estimate.estimatedSeconds;
    plan.estimatedOutputUsd = plan.options.provider === 'gemini' ? estimate.estimatedOutputUsd : 0;
    if (plan.options.provider === 'gemini') plan.estimateNote = geminiEstimateNote(plan.options.transport, estimate);
    return plan;
  }

  async resumeJob(jobId: string, paidConfirmed = false): Promise<GenerationJob> {
    await this.ready(); requireId(jobId);
    const current = await this.getJob(jobId);
    const stored = await this.disk.read<StoredPlan>(['plans', `${current.planId}.json`]);
    const publicationRetry = jobResumeMode(current) === 'publication';
    if (!publicationRetry) this.requireProvider(current.provider);
    if (!publicationRetry && current.provider === 'gemini' && (paidConfirmed !== true || !this.config.paidEnabled || (stored?.plan.options.transport === 'direct' ? !this.config.geminiApiKey : !this.config.gateway))) throw new Error('有料再開には送信本文・概算の再確認とサーバー設定が必要です。');
    if (!publicationRetry && stored?.plan.options.transport === 'gateway' && (!this.config.gateway || stored.plan.endpoint !== gatewayEndpoint(this.config.gateway) || stored.plan.routeIdentity !== gatewayRouteIdentity(this.config.gateway))) throw new Error('Gateway設定が変更されています。計画を再確認してください。');
    await this.disk.write(['owners', `${jobId}.json`], { pid: process.pid });
    const job = await this.updateJob(jobId, (job) => {
      if (['completed', 'running', 'cancel-requested', 'queued'].includes(job.status)) return;
      if (!jobResumeMode(job)) throw new Error('安全に再開できる未送信分がありません。結果不明の有料音声は自動再送しません。');
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
