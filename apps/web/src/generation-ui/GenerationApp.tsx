import { MAX_TITLE_LENGTH, resolveDocumentTitle } from '../reader/document-title';
import { Brand } from '../ui/Brand';
import { ThemeControl } from '../ui/ThemeControl';
import { Alert, Badge, Button, Checkbox, Progress, Select, Switch, Textarea, TextInput } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GEMINI_MODELS, type GenerationConfig, type GenerationJob, type GenerationOptions, type GenerationPlan, type ReadingOverride } from '../generation/contracts';
import { MAX_INPUT_BYTES, MAX_TEXT_LENGTH, type ReadingDocument } from '../reader/model';
import { processDraft, processText } from '../reader/text-service';
import { cancelJob, getGenerationConfig, getJobPlan, listJobs, prepareGeneration, resumeJob, startGeneration } from './api';
import { jobResumeMode } from '../generation/job-resume';
import { mergeJobSnapshots } from './job-state';
import { defaultVoicevoxVoice } from '../generation/default-voice';
import { decodeAozoraHtml } from '../reader/aozora-import';
import { InputFormatControl } from '../reader/ui/InputFormatControl';
import { resolveInputFormat, type InputFormat } from '../reader/input-format';
import { GeminiCostPreview } from './GeminiCostPreview';
import { IrodoriPanel } from './IrodoriPanel';
import type { IrodoriSettings } from '../generation/irodori-contracts';
import './generation.css';

const SAMPLE = '朝の図書館は静かです。窓辺で本を開きました。今日はゆっくり読んでみましょう。';
const STATUS: Record<GenerationJob['status'], string> = { queued: '待機中', running: '生成中', 'cancel-requested': '停止を受け付けました', cancelled: '停止済み', failed: '失敗', 'outcome-unknown': '結果を確認できません', completed: '完了' };
const CHUNK_STATUS: Record<GenerationJob['chunks'][number]['status'], string> = { pending: '未送信', sending: '送信中', 'audio-ready': '音声保存済み', completed: '完了', failed: '失敗', 'outcome-unknown': '結果不明' };

export function parseReadings(value: string): ReadingOverride[] {
  return value.split('\n').filter(line => line.trim()).map((line, index) => {
    const separator = line.indexOf('=');
    if (separator <= 0 || !line.slice(separator + 1).trim()) throw new Error(`読み辞書の${index + 1}行目を「表記=読み」の形にしてください。`);
    return { text: line.slice(0, separator).trim(), reading: line.slice(separator + 1).trim() };
  });
}

function message(error: unknown): string { return error instanceof Error ? error.message : '処理を完了できませんでした。'; }
function voicesFor(config: GenerationConfig | undefined, provider: GenerationOptions['provider']) {
  return provider === 'voicevox' ? config?.voicevox.voices : provider === 'gemini' ? config?.gemini.voices : config?.providers?.find(value => value.id === 'irodori')?.voices;
}

export interface HomeGenerationProps {
  input: ReactNode;
  rawText: string;
  inputFormat: InputFormat;
  document?: ReadingDocument;
  revision: number;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  prepareDocument: () => Promise<ReadingDocument | undefined>;
  onRead: () => void;
  textBusy: boolean;
  onBusyChange: (busy: boolean) => void;
}

export function GenerationApp({ home }: { home?: HomeGenerationProps }) {
  const [config, setConfig] = useState<GenerationConfig>();
  const [configState, setConfigState] = useState<'checking' | 'ready' | 'error'>('checking');
  const [configCheckedAt, setConfigCheckedAt] = useState<Date>();
  const [configError, setConfigError] = useState('');
  const configRequest = useRef(0);
  const [loadedDocument, setDocument] = useState<ReadingDocument>();
  const document = home?.document ?? loadedDocument;
  const audioEnabled = home ? home.enabled : true;
  const [raw, setRaw] = useState('');
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<InputFormat>('auto');
  const [provider, setProvider] = useState<GenerationOptions['provider']>('voicevox');
  const [irodori, setIrodori] = useState<IrodoriSettings>();
  const [irodoriBusy, setIrodoriBusy] = useState(false);
  const irodoriEnabled = Boolean(config?.providers?.some(value => value.id === 'irodori'));
  const [automaticChunking, setAutomaticChunking] = useState(false);
  const [voice, setVoice] = useState('');
  const [model, setModel] = useState<typeof GEMINI_MODELS[number]>(GEMINI_MODELS[0]);
  const [transport, setTransport] = useState<GenerationOptions['transport']>('direct');
  const [readings, setReadings] = useState('');
  const [style, setStyle] = useState('');
  const selectedProviderAvailable = provider === 'voicevox' ? config?.voicevox.available : provider === 'irodori' ? Boolean(irodori && !irodoriBusy && config?.providers?.find(value => value.id === 'irodori')?.available) : Boolean(config?.gemini.available && config.transports.find(value => value.id === transport)?.available);
  const selectedTransportMessage = config?.transports.find(value => value.id === transport)?.message;
  const [selected, setSelected] = useState<string[]>();
  const [plan, setPlan] = useState<GenerationPlan>();
  const [preview, setPreview] = useState<GenerationPlan>();
  const [chunkPage, setChunkPage] = useState(0);
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  const [resumePlan, setResumePlan] = useState<GenerationPlan>();
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const operationId = useRef('');
  const mounted = useRef(true);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const job = selectedJob ? jobs.find(value => value.id === selectedJob) : jobs[0];

  const refreshConfig = useCallback(async () => {
    const id = ++configRequest.current;
    setConfigState('checking'); setConfigError('');
    try {
      const value = await getGenerationConfig();
      if (!mounted.current || id !== configRequest.current) return;
      setConfig(value); setConfigState('ready'); setConfigCheckedAt(new Date());
      const activeProvider = providerRef.current === 'irodori' && !value.providers?.some(provider => provider.id === 'irodori') ? 'voicevox' : providerRef.current;
      if (activeProvider !== providerRef.current) {
        setProvider(activeProvider); setIrodori(undefined); setPlan(undefined); setPreview(undefined); setSelected(undefined); setPaidConfirmed(false); operationId.current = '';
      }
      setVoice(previous => { const voices = voicesFor(value, activeProvider) ?? []; return voices.some(voice => voice.id === previous) ? previous : activeProvider === 'voicevox' ? defaultVoicevoxVoice(voices) : voices[0]?.id ?? ''; });
    } catch (error) {
      if (!mounted.current || id !== configRequest.current) return;
      setConfigState('error'); setConfigError(message(error)); setConfigCheckedAt(new Date());
    }
  }, []);
  const irodoriSettingsChanged = useCallback((settings: IrodoriSettings) => { setIrodori(settings); setPlan(undefined); setPreview(undefined); setSelected(undefined); setPaidConfirmed(false); operationId.current = ''; }, []);

  useEffect(() => {
    mounted.current = true;
    if (!audioEnabled) return;
    let active = true;
    void refreshConfig();
    const refresh = () => { void listJobs().then(value => {
      if (!active) return;
      setJobs(previous => mergeJobSnapshots(previous, value));
    }).catch(error => { if (active) setNotice(`進捗を取得できませんでした。${message(error)}`); }); };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; mounted.current = false; configRequest.current++; request.current++; abort.current?.abort(); window.clearInterval(timer); };
  }, [audioEnabled, refreshConfig]);

  const revision = home?.revision;
  const onBusyChange = home?.onBusyChange;
  useEffect(() => { onBusyChange?.(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => { if (revision !== undefined) { request.current++; invalidate(true); } }, [revision, audioEnabled]);

  function invalidate(resetTargets = false) {
    setPlan(undefined); setPaidConfirmed(false); operationId.current = '';
    if (resetTargets) { setPreview(undefined); setSelected(undefined); setChunkPage(0); }
  }
  function changeProvider(value: string | null) {
    if (value !== 'voicevox' && value !== 'gemini' && value !== 'irodori') return;
    if (value === 'irodori' && !irodoriEnabled) return;
    setProvider(value);
    if (value === 'irodori') setIrodori(undefined);
    if (value !== 'gemini') setTransport('direct');
    setVoice(value === 'voicevox' ? defaultVoicevoxVoice(config?.voicevox.voices ?? []) : voicesFor(config, value)?.[0]?.id ?? '');
    invalidate(true);
  }
  function draftChanged() { setDocument(undefined); setPreview(undefined); setSelected(undefined); setChunkPage(0); invalidate(); }

  async function loadDocument(file?: File, sample?: string) {
    const id = ++request.current;
    abort.current?.abort();
    const task = new AbortController(); abort.current = task;
    setBusy('本文を準備しています'); setProgress(0); setError(''); setNotice(''); invalidate();
    try {
      let result: ReadingDocument;
      if (file) {
        if (file.size > MAX_INPUT_BYTES) throw new Error('ファイルは20 MB以下にしてください。');
        const extension = file.name.split('.').pop()?.toLowerCase();
        if (!['md', 'markdown', 'txt', 'pdf', 'html', 'htm'].includes(extension ?? '')) throw new Error('MD・TXT・PDF・青空文庫HTMLを選んでください。');
        if (extension === 'pdf') {
          const { importPdf } = await import('../reader/pdf-import');
          const draft = await importPdf(await file.arrayBuffer(), file.name.slice(0, MAX_TITLE_LENGTH), { signal: task.signal, onProgress: (done, total) => { if (id === request.current) setProgress(total ? done / total * 60 : 0); } });
          result = await processDraft(draft, { signal: task.signal, onProgress: value => { if (id === request.current) setProgress(60 + value * 40); } });
        } else {
          const html = extension === 'html' || extension === 'htm';
          result = await processText(html ? decodeAozoraHtml(await file.arrayBuffer()) : await file.text(), html ? 'aozora' : extension === 'txt' ? 'txt' : 'md', file.name.slice(0, MAX_TITLE_LENGTH), { signal: task.signal, onProgress: value => { if (id === request.current) setProgress(value * 100); } });
        }
      } else {
        const text = sample ?? raw;
        if (!text.trim()) throw new Error('文章を入力してください。');
        if (text.length > MAX_TEXT_LENGTH) throw new Error('本文は100万文字以下にしてください。');
        result = await processText(text, sample ? 'txt' : resolveInputFormat(text, format), sample ? '朝の図書館' : resolveDocumentTitle(title), { signal: task.signal, onProgress: value => { if (id === request.current) setProgress(value * 100); } });
      }
      if (id !== request.current || task.signal.aborted) return;
      if (!result.units.some(unit => unit.kind === 'text')) throw new Error('読み上げる本文がありません。');
      if (file) { setRaw(result.format === 'md' || result.format === 'txt' ? result.rawText : result.blocks.map(block => block.text).join('\n\n')); setFormat('auto'); setTitle(result.title); }
      setDocument(result); setPreview(undefined); setSelected(undefined); setChunkPage(0);
      setNotice('抽出した本文を確認してから、声と生成対象を選んでください。');
    } catch (error) { if (id === request.current && !task.signal.aborted) setError(message(error)); }
    finally { if (id === request.current) { setBusy(''); abort.current = null; } }
  }

  async function prepare() {
    if (configState !== 'ready' || !selectedProviderAvailable) return;
    const id = ++request.current;
    setBusy('生成計画を確認しています'); setError(''); setNotice(''); invalidate();
    try {
      const source = home ? await home.prepareDocument() : document;
      const prepared = source ? { ...source, title: resolveDocumentTitle(source.title) } : undefined;
      if (!home && prepared) setDocument(prepared);
      if (!prepared || id !== request.current) return;
      const options: GenerationOptions = { provider, voice, transport, readings: parseReadings(readings), chunking: { mode: provider === 'irodori' || automaticChunking ? 'auto' : 'sentence' }, ...(provider === 'gemini' ? { model, style: transport === 'direct' ? style : '' } : provider === 'irodori' ? { model: 'irodori-tts' as const, irodori } : {}), ...(selected ? { selectedChunkIds: selected } : {}) };
      const result = await prepareGeneration({ data: { document: prepared, options } });
      if (!mounted.current || id !== request.current) return;
      setPlan(result); if (!selected) setPreview(result);
      operationId.current = crypto.randomUUID();
    } catch (error) { if (mounted.current) setError(message(error)); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function start() {
    if (configState !== 'ready' || !selectedProviderAvailable || !plan || busy || !plan.available || provider === 'gemini' && !paidConfirmed) return;
    setBusy('生成を開始しています'); setError('');
    try {
      const result = await startGeneration({ data: { planId: plan.id, planHash: plan.hash, operationId: operationId.current, paidConfirmed } });
      if (!mounted.current) return;
      setJobs(previous => [result, ...previous.filter(value => value.id !== result.id)]); setSelectedJob(result.id);
      setNotice('ジョブを保存しました。タブを閉じても、ローカルサーバーが動いていれば処理は続きます。');
    } catch (error) { if (mounted.current) setError(message(error)); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function controlJob(action: 'cancel' | 'resume') {
    if (!job) return;
    if (action === 'resume' && jobResumeMode(job) !== 'publication' && job.provider === 'gemini' && (!resumePlan || !resumeConfirmed || !resumePlan.available)) return;
    setBusy(action === 'cancel' ? '停止を要求しています' : jobResumeMode(job) === 'publication' ? '保存済み音声を公開しています' : '未完了分を再開しています'); setError('');
    try {
      const result = action === 'cancel' ? await cancelJob({ data: { jobId: job.id } }) : await resumeJob({ data: { jobId: job.id, paidConfirmed: resumeConfirmed } });
      setJobs(previous => [result, ...previous.filter(value => value.id !== result.id)]); setSelectedJob(result.id);
      setResumePlan(undefined); setResumeConfirmed(false);
    } catch (error) { setError(message(error)); }
    finally { setBusy(''); }
  }

  async function prepareResume() {
    if (!job) return;
    setBusy('再開する対象と費用を確認しています'); setError(''); setResumeConfirmed(false);
    try { setResumePlan(await getJobPlan({ data: { jobId: job.id } })); }
    catch (error) { setError(message(error)); }
    finally { setBusy(''); }
  }

  const voices = voicesFor(config, provider);
  const chosenIds = selected ?? preview?.chunks.map(chunk => chunk.id) ?? [];
  const chunkPageCount = Math.ceil((preview?.chunks.length ?? 0) / 20);
  const resumeMode = job && jobResumeMode(job);

  const costReadings = useMemo(() => {
    try { return { values: parseReadings(readings), error: undefined }; }
    catch (error) { return { values: [], error: message(error) }; }
  }, [readings]);
  const costRanges = useMemo(() => preview && selected ? preview.chunks.filter(chunk => selected.includes(chunk.id)).map(({ blockId, start, end }) => ({ blockId, start, end })) : undefined, [preview, selected]);
  const costRaw = home?.rawText ?? raw;
  const costPreview = provider === 'gemini' && <GeminiCostPreview raw={costRaw} format={resolveInputFormat(costRaw, home?.inputFormat ?? format)} document={document} readings={costReadings.values} readingsError={costReadings.error} ranges={costRanges} model={model ?? GEMINI_MODELS[0]} transport={transport} />;

  const JobsContainer = home ? 'details' : 'section';
  const selection = preview && <section className="generation-card"><h2>3. 生成対象</h2><p>{chosenIds.length} / {preview.chunks.length}{preview.chunkPlan ? '区間' : '文'}を選択。本文・読み・声の変更後は計画をもう一度確認してください。</p><div className="generation-actions"><Button variant="light" disabled={Boolean(busy)} onClick={() => { setSelected(undefined); invalidate(); }}>すべて選択</Button><Button variant="light" disabled={Boolean(busy)} onClick={() => { setSelected(preview.chunks.filter(chunk => !chunk.cacheHit).map(chunk => chunk.id)); invalidate(); }}>{preview.chunkPlan ? '未保存の区間だけ' : '未保存の文だけ'}</Button></div>
        <div className="chunk-selection">{preview.chunks.slice(chunkPage * 20, (chunkPage + 1) * 20).map((chunk, i) => <Checkbox key={chunk.id} checked={chosenIds.includes(chunk.id)} disabled={Boolean(busy)} label={<span>{chunkPage * 20 + i + 1}. {chunk.originalText} {chunk.cacheHit && <Badge color="ripola" size="xs">再利用</Badge>}</span>} onChange={event => { setSelected(event.currentTarget.checked ? [...chosenIds, chunk.id] : chosenIds.filter(id => id !== chunk.id)); invalidate(); }} />)}</div>
        {chunkPageCount > 1 && <div className="generation-actions"><Button variant="subtle" disabled={chunkPage === 0} onClick={() => setChunkPage(value => value - 1)}>前の20{preview.chunkPlan ? '区間' : '文'}</Button><span>{chunkPage + 1} / {chunkPageCount}</span><Button variant="subtle" disabled={chunkPage >= chunkPageCount - 1} onClick={() => setChunkPage(value => value + 1)}>次の20{preview.chunkPlan ? '区間' : '文'}</Button></div>}
        {!plan && <Button mt="md" onClick={() => void prepare()} disabled={Boolean(busy) || chosenIds.length === 0}>選択した対象で計画を確認</Button>}
      </section>;

  const view = <div className={home ? "generation-shell home-generation" : "generation-shell"}>
    {!home && <header className="generation-header"><Brand /><div className="header-actions"><ThemeControl /><nav><a href="/">黙読</a><a href="/library">音声の本棚</a></nav></div></header>}
    <div className={home ? "home-generation-content" : "generation-main"}>
      {!home && <><div className="generation-title"><div><span className="eyebrow">LOCAL GENERATION</span><h1>文章を、音声に。</h1><p>このPCに保存して、音声と一緒に読みます。</p></div><Badge variant="light" color="ripola">ローカル生成</Badge></div>
      <p className="muted">無料VOICEVOXは起動中のデスクトップアプリへ接続します。有料Geminiは、送信内容と概算費用を確認してから開始します。</p></>}
      {error && <Alert color="red" role="alert" mb="md">{error}</Alert>}
      {notice && <Alert color="ripola" role="status" mb="md">{notice}</Alert>}
      {busy && <div className="generation-busy" role="status"><strong>{busy}</strong>{abort.current && <><Progress value={progress} mt="sm" /><Button variant="subtle" onClick={() => { request.current++; abort.current?.abort(); abort.current = null; setBusy(''); }}>読み込みを取り消す</Button></>}</div>}
      <div className={home ? "home-composer" : "generation-grid"}>
      {home ? home.input : <section className="generation-card"><h2>1. 原稿</h2>
        <Button component="label" htmlFor="generation-file" variant="light" fullWidth disabled={Boolean(busy)}>MD・TXT・PDFを選ぶ</Button>
        <input id="generation-file" type="file" aria-label="音声生成用の原稿ファイル" accept=".md,.markdown,.txt,.pdf,.html,.htm" className="visually-hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void loadDocument(file); event.target.value = ''; }} />
        <p className="muted">20 MBまで。画像・縦書き・段組PDFは対応していません。</p>
        <TextInput label="タイトル" description="任意。未入力ならこの端末の日付と時刻を使います。保存後も名前を変えられます。" placeholder="未入力なら作成日時" maxLength={MAX_TITLE_LENGTH} value={title} onChange={event => { setTitle(event.target.value); if (document) setDocument({ ...document, title: event.target.value }); invalidate(); }} disabled={Boolean(busy)} />
        <InputFormatControl text={raw} value={format} sourceFormat={document?.format} disabled={Boolean(busy)} onChange={value => { setFormat(value); draftChanged(); }} />
        <Textarea label="原稿を貼り付け" rows={6} value={raw} onChange={event => { setRaw(event.target.value); draftChanged(); }} maxLength={MAX_TEXT_LENGTH + 1} disabled={Boolean(busy)} />
        <div className="generation-actions"><Button onClick={() => void loadDocument()} disabled={Boolean(busy)}>本文を確認する</Button><Button variant="subtle" onClick={() => { setRaw(SAMPLE); setTitle('朝の図書館'); setFormat('txt'); void loadDocument(undefined, SAMPLE); }} disabled={Boolean(busy)}>自作文で試す</Button></div>
        {document && <div className="manuscript-preview"><h3>{document.title}</h3><p>{document.totalCharacters.toLocaleString()}文字 · {document.blocks.length}ブロック</p><details><summary>抽出本文を確認</summary><pre>{document.blocks.filter(block => !['code', 'table'].includes(block.kind)).map(block => block.text).join('\n\n')}</pre></details>{document.warnings.map((warning, i) => <p className="muted" key={i}>{warning}</p>)}</div>}
      </section>}
      {home && <div className={`audio-disclosure ${audioEnabled ? 'is-open' : ''}`}>
        <div className="audio-disclosure-heading"><div><strong>音声も生成する</strong><span className="advanced-label">アドバンスド設定</span><p>声や読みを選んで、同じ文章に音声を付けます。</p></div><Switch role="switch" aria-label="音声も生成する" aria-controls="home-audio-settings" checked={audioEnabled} disabled={Boolean(busy) || home.textBusy} onChange={event => home.onToggle(event.currentTarget.checked)} size="md" /></div>
      </div>}
      {audioEnabled && <section id={home ? 'home-audio-settings' : undefined} className={home ? 'home-audio-settings' : 'generation-card'}>{!home && <h2>2. 読みと声</h2>}
        <Select label={home ? "生成方法" : "生成手段"} value={provider} onChange={changeProvider} data={[{ value: 'voicevox', label: '無料 · VOICEVOX' }, { value: 'gemini', label: '有料 · Gemini' }, ...(irodoriEnabled ? [{ value: 'irodori', label: '任意追加 · Irodori（このPC）' }] : [])]} allowDeselect={false} disabled={Boolean(busy) || irodoriBusy} />
        <div className="generation-connection" role="region" aria-label="音声生成の利用状態"><div className="environment-heading"><Badge color="gray" variant="light">ローカルPC版</Badge><span role="status">{configState === 'checking' ? '確認中…' : configState === 'error' ? '状態を確認できませんでした' : provider === 'voicevox' ? config?.voicevox.available ? '最終確認：VOICEVOXに接続あり' : '最終確認：VOICEVOX未接続' : selectedProviderAvailable ? '選択経路のサーバー設定あり' : 'サーバー設定が必要'}</span></div>
          {configCheckedAt && <p className="connection-time">最終確認：<time dateTime={configCheckedAt.toISOString()}>{configCheckedAt.toLocaleTimeString()}</time> · {provider === 'voicevox' ? '確認時点の結果です。' : '設定の確認です。合成接続の成功を意味しません。'}</p>}
          {configState === 'error' ? <p className="muted">{configError} 原稿を保ったまま再確認できます。</p> : provider === 'voicevox' ? <p className="muted">{configState === 'checking' ? 'このPCのVOICEVOX Engineを確認しています。' : config?.voicevox.available ? 'このPCのEngineを利用できます。音声合成はまだ開始していません。' : 'このPCでVOICEVOX Engineを起動してから再確認してください。'} 黙読と準備済み音声は、接続なしでも使えます。</p> : provider === 'irodori' ? <p className="muted">{config?.providers?.find(value => value.id === 'irodori')?.message ?? 'このPCの任意追加Irodoriを使います。'} 本文をクラウドへ送信しません。</p> : <p className="muted">{config?.gemini.message} {selectedTransportMessage} {home ? transport === 'direct' ? '本文をGoogleに送信します。内容と費用を確認してから生成します。' : '本文をCloudflareに送信し、Googleモデルで合成します。課金元はGatewayの設定に従います。' : '認証情報の値はブラウザへ渡しません。'}</p>}
          <Button variant="subtle" disabled={Boolean(busy) || configState === 'checking'} loading={configState === 'checking'} onClick={() => void refreshConfig()}>接続を再確認</Button>
        </div>
        <div className="generation-connection" data-testid="alignment-setup-status" role="region" aria-label="音声補正の準備状態">
          <Badge color={config?.alignment?.automatic?.status === 'ready' ? 'ripola' : config?.alignment?.automatic?.status === 'failed' || configState === 'error' ? 'red' : 'gray'} variant="light">音声補正：{configState === 'checking' && !config ? '確認中' : configState === 'error' ? '確認失敗' : config?.alignment?.automatic?.status === 'ready' ? '利用可能' : config?.alignment?.automatic?.status === 'failed' ? '準備の確認に失敗' : 'セットアップが必要'}</Badge>
          <p className="muted">{configState === 'error' ? '接続を再確認してください。' : config?.alignment?.automatic?.message ?? 'リポジトリのフォルダーで pnpm setup:audio を実行し、完了後 pnpm dev を起動してください。'}</p>
          {config?.alignment?.automatic?.status !== 'ready' && <p className="muted">セットアップはモデル約387 MBと専用Python環境を準備します。未準備の場合も音声は保存できますが、音声に基づく時刻の補正は使えません。</p>}
        </div>
        {provider !== 'irodori' && <details className="home-advanced-row"><summary>音声の区切りを調整する（任意）</summary>
          <Checkbox label="音声の区切りを自動調整する（実験）" checked={automaticChunking} disabled={Boolean(busy)} onChange={event => { setAutomaticChunking(event.currentTarget.checked); invalidate(true); }} />
          <p className="muted">通常は文ごとに生成します。自動調整は短い文をまとめ、長い文を分けます。実際の音声合成での速度・聞きやすさの改善は未検証です。</p>
        </details>}
        {provider === 'irodori' && <p className="muted">Irodoriは本文上限に合わせて短く自動分割します。推定時間で分けた後も、完成音声の長さを検査します。</p>}
        {provider === 'gemini' && <Select label="Geminiモデル" value={model} onChange={value => { if (value === GEMINI_MODELS[0] || value === GEMINI_MODELS[1]) { setModel(value); invalidate(true); } }} data={[{ value: GEMINI_MODELS[0], label: 'Flash-Lite · 既定' }, { value: GEMINI_MODELS[1], label: 'Flash' }]} allowDeselect={false} disabled={Boolean(busy)} />}

        <Select label="声・スタイル" value={voice || null} data={(voices ?? []).map(value => ({ value: value.id, label: value.name }))} searchable allowDeselect={false} disabled={Boolean(busy) || configState !== 'ready' || irodoriBusy || provider !== 'irodori' && !selectedProviderAvailable || !voices?.length} onChange={value => { if (value) { setVoice(value); if (provider === 'irodori') setIrodori(undefined); invalidate(true); } }} placeholder="接続できる声を選択" />
        {provider === 'irodori' && <IrodoriPanel key={voice} voice={voice || 'reception-female'} onSettingsChange={irodoriSettingsChanged} onBusyChange={setIrodoriBusy} onChange={() => { invalidate(true); void refreshConfig(); }} disabled={Boolean(busy) || Boolean(job && ['queued', 'running', 'cancel-requested'].includes(job.status))} />}
        {provider === 'gemini' && <><Select label="接続経路" value={transport} data={[{ value: 'direct', label: 'Gemini直結 · Google課金', disabled: !config?.transports.find(value => value.id === 'direct')?.available }, { value: 'gateway', label: 'Cloudflare · AI Gateway', disabled: !config?.transports.find(value => value.id === 'gateway')?.available }]} onChange={value => { if (value === 'direct' || value === 'gateway') { setTransport(value); invalidate(true); } }} allowDeselect={false} disabled={Boolean(busy)} />
          <p className="muted">{transport === 'gateway' ? <>{'Wranglerの既存ログインを使います。Googleキーや手動CF tokenは通常設定に不要です。'} {config?.transports.find(value => value.id === 'gateway')?.message}</> : config?.transports.find(value => value.id === 'gateway')?.message}</p></>}
        {home ? <details className="home-advanced-row"><summary>読みを調整する（任意）{readings.trim() && <span>設定あり</span>}</summary>        <Textarea label="読み辞書" description="1行に1件、表記=読み。例：図書館=トショカン" rows={3} value={readings} onChange={event => { setReadings(event.target.value); invalidate(true); }} disabled={Boolean(busy)} />
</details> : <>        <Textarea label="読み辞書" description="1行に1件、表記=読み。例：図書館=トショカン" rows={3} value={readings} onChange={event => { setReadings(event.target.value); invalidate(true); }} disabled={Boolean(busy)} />
</>}
        {home && <details className="home-advanced-row"><summary>生成する文を選ぶ · {preview ? `${chosenIds.length} / ${preview.chunks.length}文` : 'すべて'}</summary>{preview ? selection : <p className="muted">「生成内容を確認する」で本文を準備すると、文ごとに選べます。</p>}</details>}
        {provider === 'gemini' && (transport === 'direct' ? <Textarea label="読み上げ方の指示（任意）" description="Gemini直結で本文と一緒に送信します。" value={style} onChange={event => { setStyle(event.target.value); invalidate(true); }} rows={2} disabled={Boolean(busy)} /> : <p className="muted">Cloudflare経路は読み上げ方の指示に未対応です。直結用の指示は保持しますが、この経路には送信しません。</p>)}
        {costPreview}
        {!home && <Button onClick={() => void prepare()} disabled={!document || !voice || Boolean(busy) || configState !== 'ready' || !selectedProviderAvailable} fullWidth>生成計画を確認する</Button>}
      </section>}
      {home && <><div className="home-generation-actions">{audioEnabled && <Button onClick={() => void prepare()} disabled={!voice || Boolean(busy) || home.textBusy || configState !== 'ready' || !selectedProviderAvailable}>生成内容を確認する</Button>}<Button variant={audioEnabled ? 'outline' : 'filled'} onClick={home.onRead} disabled={Boolean(busy) || home.textBusy}>テキストのみ生成して読む</Button></div><p className="home-action-note">{audioEnabled ? '音声生成は、内容を確認してから開始します。' : 'テキストは端末内で準備します。本文を外へ送りません。'}</p></>}
      </div>
      {!home && selection}
      {audioEnabled && plan && <section className="generation-card generation-confirm"><h2>{home ? '開始前に確認' : '4. 開始前に確認'}</h2><dl><dt>送信先</dt><dd>{plan.options.provider === 'voicevox' ? 'VOICEVOX · このPC' : plan.options.provider === 'irodori' ? plan.options.model === 'irodori-tts-mf' ? 'Irodori MF · このPC' : 'Irodori v4.1 Small 通常 · このPC' : `${plan.options.transport === 'gateway' ? 'Cloudflare · Googleモデル' : 'Google'} · ${plan.options.model}`}</dd><dt>接続先</dt><dd>{plan.endpoint}</dd><dt>課金先</dt><dd>{plan.options.provider !== 'gemini' ? '無料 · このPC' : plan.options.transport === 'gateway' ? 'Cloudflare Gatewayの設定に従います' : 'Googleアカウント'}</dd><dt>対象</dt><dd>{plan.chunks.length}{plan.chunkPlan ? '区間' : '文'} · 保存音声の再利用 {plan.chunks.filter(chunk => chunk.cacheHit).length}{plan.chunkPlan ? '区間' : '文'}</dd><dt>音声の長さ（目安）</dt><dd>約{Math.ceil(plan.estimatedSeconds / 60)}分</dd><dt>概算費用</dt><dd>{plan.options.provider !== 'gemini' ? '無料' : `$${plan.estimatedOutputUsd.toFixed(4)} + 入力等`}<p className="muted">{plan.estimateNote}</p></dd></dl>
        {plan.chunkPlan && <p className="muted">自然な区切りで複数の文を音声区間にまとめます。区間内のフレーズ時刻は、補正がない部分では表示用の推定です。</p>}
        {plan.options.provider === 'irodori' && <p>声: {voices?.find(value => value.id === plan.options.voice)?.name ?? plan.options.voice} · {plan.options.irodori?.steps ?? (plan.options.model === 'irodori-tts-mf' ? 4 : 40)} steps · 速度 {plan.options.irodori?.speed ?? 1} · seed {plan.options.irodori?.seed ?? 42}。{plan.options.irodori?.instructions && `読み上げ指示: ${plan.options.irodori.instructions}`}</p>}
        <details><summary>正確な送信本文を確認（{plan.sendingText.length.toLocaleString()}文字）</summary><pre>{plan.sendingText}</pre>{plan.options.style && <p>読み上げ指示：{plan.options.style}</p>}</details>
        {!plan.sendingText && plan.chunks.length > 0 && <p className="muted">すべて保存音声を再利用するため、今回APIへ送る本文はありません。</p>}
        {plan.warnings.map((warning, i) => <p className="muted" key={i}>{warning}</p>)}
        {!plan.available && <Alert color="yellow" mt="md">{plan.unavailableReason ?? 'この接続では生成できません。'}</Alert>}
        {plan.options.provider === 'gemini' && <Checkbox mt="md" label="対象、選択した接続先への送信本文と概算費用を確認し、有料生成を開始します。" checked={paidConfirmed} onChange={event => setPaidConfirmed(event.currentTarget.checked)} disabled={Boolean(busy)} />}
        <Button mt="md" size="lg" onClick={() => void start()} disabled={Boolean(busy) || configState !== 'ready' || !selectedProviderAvailable || !plan.available || plan.chunks.length === 0 || plan.options.provider === 'gemini' && !paidConfirmed}>{plan.options.provider === 'gemini' ? '確認した対象を有料生成する' : '確認した対象を無料生成する'}</Button>
      </section>}
      {(!home || audioEnabled && jobs.length > 0) && <JobsContainer className="generation-card home-jobs" open={home && (Boolean(selectedJob) || job?.status === 'running' || job?.status === 'queued') ? true : undefined}>{home ? <summary>生成履歴と進捗 · {jobs.length}件</summary> : <h2>生成ジョブ</h2>}{!jobs.length ? <p className="muted">生成を開始すると、進捗と保存済みの音声がここに表示されます。</p> : <>
        <Select label="ジョブを選択" value={job?.id ?? null} onChange={value => { if (value) { setSelectedJob(value); setResumePlan(undefined); setResumeConfirmed(false); } }} data={jobs.map(value => ({ value: value.id, label: `${value.title} · ${STATUS[value.status]} · ${new Date(value.createdAt).toLocaleString()}` }))} allowDeselect={false} disabled={Boolean(busy)} />
        {job && <><div className="generation-job-heading"><Badge color={job.status === 'failed' || job.status === 'outcome-unknown' ? 'red' : 'ripola'}>{STATUS[job.status]}</Badge><span>{job.completedChunks} / {job.totalChunks}文 · 再利用 {job.chunks.filter(chunk => chunk.reused).length}文</span></div><Progress value={job.totalChunks ? job.completedChunks / job.totalChunks * 100 : 0} />
          {job.automaticAlignment && <p className="muted" role="status">{job.automaticAlignment.status === 'running' ? '音声を保存しました。保存音声を使って時刻を自動補正しています。' : job.automaticAlignment.status === 'completed' ? '保存音声の整列と時刻の補正が完了しました。根拠が足りない区切りは文字数による推定を使います。' : job.automaticAlignment.status === 'unavailable' ? '音声を保存しました。ローカル整列環境が未設定または利用できないため、時刻がない区切りは文字数から推定します。' : job.automaticAlignment.status === 'cancelled' ? '時刻の補正を停止しました。保存音声は残っています。' : '音声を保存しました。時刻の補正を完了できませんでした。保存音声の画面から整列を再実行できます。'}</p>}
          {job.automaticCompression && <p className="muted" role="status">{job.automaticCompression.status === 'running'
            ? `保存容量を削減しています。${job.automaticCompression.completedFiles} / ${job.automaticCompression.totalFiles}音声`
            : job.automaticCompression.status === 'completed'
              ? `再生用音声を圧縮して保存しました。${(job.automaticCompression.sourceBytes / 1_000_000).toFixed(1)} MB → ${(job.automaticCompression.compressedBytes / 1_000_000).toFixed(1)} MB。${job.automaticCompression.retainedWavFiles ? '再補正などに必要な元音声は保持しています。' : '検証済みの生成途中ファイルも整理しました。'}`
              : job.automaticCompression.status === 'unavailable'
                ? '圧縮ツールを利用できないため元音声で保存しました。ローカル音声環境を設定すると自動圧縮できます。'
                : job.automaticCompression.status === 'cancelled'
                  ? '容量の削減を停止しました。保存済み音声は再生できます。'
                  : '一部の音声の圧縮を完了できませんでした。該当する元音声を保持しているため、再生できます。'}</p>}
          {job.error && <Alert color="yellow" mt="md">{job.error}</Alert>}
          {job.status === 'outcome-unknown' && <Alert color="yellow" mt="md">送信後の結果が不明な文は自動再送しません。追加課金を避けるため、別途確認が必要です。</Alert>}
          <div className="generation-actions">{['queued', 'running'].includes(job.status) && <Button color="gray" variant="light" disabled={Boolean(busy)} onClick={() => void controlJob('cancel')}>ここで停止する</Button>}{resumeMode && (resumeMode === 'publication' || job.provider !== 'irodori' || irodoriEnabled) && <Button disabled={Boolean(busy)} onClick={() => { if (resumeMode === 'generate' && job.provider === 'gemini') void prepareResume(); else void controlJob('resume'); }}>{resumeMode === 'publication' ? '保存済み音声の公開を再試行' : job.provider === 'gemini' ? '再開する対象と費用を確認' : '保存済み音声を使って未完了分を再開'}</Button>}{job.completedChunks > 0 && <Button component="a" href={`/library?book=${encodeURIComponent(job.bookId)}&revision=${encodeURIComponent(job.revision)}&job=${encodeURIComponent(job.id)}`} variant="light">保存音声を読む</Button>}</div>
          {resumeMode === 'generate' && job.provider === 'irodori' && !irodoriEnabled && <p className="muted">この生成方法の再開には開発用の有効化が必要です。保存済み音声は引き続き読めます。</p>}
          {resumePlan && <div className="generation-resume"><h3>有料生成の再開前に確認</h3><p>{resumePlan.options.transport === 'gateway' ? 'Cloudflare AI Gateway' : 'Google課金'} · {resumePlan.options.model} · {resumePlan.endpoint}</p><p>{resumePlan.chunks.length}文 · 概算 ${resumePlan.estimatedOutputUsd.toFixed(4)} + 入力等</p><p className="muted">{resumePlan.estimateNote}</p><details><summary>再開時の正確な送信本文</summary><pre>{resumePlan.sendingText}</pre>{resumePlan.options.style && <p>読み上げ指示：{resumePlan.options.style}</p>}</details>{!resumePlan.available && <Alert color="yellow" mt="md">{resumePlan.unavailableReason}</Alert>}<Checkbox mt="md" checked={resumeConfirmed} disabled={Boolean(busy)} onChange={event => setResumeConfirmed(event.currentTarget.checked)} label="未完了分の送信先・本文・費用を確認し、有料生成を再開します。" /><Button mt="md" disabled={Boolean(busy) || !resumeConfirmed || !resumePlan.available} onClick={() => void controlJob('resume')}>確認した未完了分だけを有料生成する</Button></div>}
          <p className="muted">停止は以降の送信を止めます。送信中の処理や課金を取り消せるとは限りません。保存した音声は残り、再開時に再利用します。</p><details><summary>文ごとの状態</summary><ol>{job.chunks.map(chunk => <li key={chunk.id}>{CHUNK_STATUS[chunk.status]} {chunk.reused ? '· 再利用' : ''}{chunk.error ? ` · ${chunk.error}` : ''}</li>)}</ol></details>
        </>}
      </>}</JobsContainer>}
    </div>
  </div>;
  return view;
}
