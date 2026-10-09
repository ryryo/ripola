import { Alert, Button, Drawer, Progress, Switch, Textarea, TextInput } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useLayoutEffect, lazy, Suspense } from 'react';
import { DEFAULT_SETTINGS, MAX_INPUT_BYTES, MAX_TEXT_LENGTH, type ReadingDocument, type ReaderSettings, type ReadingUnit, type SourceAnchor } from '../model';
import { PlaybackController, sourceAnchorToIndex } from '../playback';
import { processDraft, processText } from '../text-service';
import { deleteReading, loadReading, saveReading, type SavedReading } from '../storage';
import { PdfSource } from './PdfSource';
import { PlaybackProgress } from './PlaybackProgress';
import { ShareLink } from '../../sharing/ShareLink';
import { decodeAozoraHtml } from '../aozora-import';
import { readingSentences, sentenceIndexAt } from '../sentences';
import { NavigationLayout } from './NavigationLayout';
import { AozoraInfo } from './AozoraInfo';
import type { DraftDocument } from '../model';
import { Brand } from '../../ui/Brand';
import { AudioDemo } from './AudioDemo';
import { PhraseDisplay, RubyText } from './PhraseDisplay';
import { WritingModeSelect } from './WritingModeSelect';
import { FontSelect, GroupSettings, ShortcutHelp, useReadingFont } from './ReadingOptions';
import { READING_FONTS } from '../reading-fonts';
import { groupIndexAt, groupReadingUnits } from '../display-groups';
import { shortcutBlocked, repeatedArrowAllowed } from '../shortcuts';
import { GuideReader } from './GuideReader';
import { StoppedContext } from './StoppedContext';
import { MAX_TITLE_LENGTH, resolveDocumentTitle } from '../document-title';
import { TitleEditor } from './TitleEditor';
import { InputFormatControl } from './InputFormatControl';
import { EnvironmentAvailability } from './EnvironmentAvailability';
import { FullscreenEnterButton, FullscreenReader, useFullscreenReader } from './FullscreenReader';
import { ReadingModeControls } from './ReadingModeControls';
import { useReaderPreferences } from './useReaderPreferences';
import { useScreenWakeLock } from './useScreenWakeLock';
import { hasStoredPreferences, resetDisplaySettings } from '../preferences';
import { resolveInputFormat, type InputFormat } from '../input-format';
import { readerCapabilities } from '../environment';
import { initialReadingDraft, PAGES_DEMO } from '../pages-demo';


const CAPABILITIES = readerCapabilities(import.meta.env.VITE_RSVP_PROFILE);
const LocalGeneration = import.meta.env.VITE_RSVP_PROFILE === 'local' ? lazy(() => import('../../generation-ui/GenerationApp').then(module => ({ default: module.GenerationApp }))) : null;

const SAMPLE = '# 朝の図書館\n\n静かな朝、私は<ruby>図書館<rt>としょかん</rt></ruby>へ向かった。窓辺で一冊の本を開く。\n\n今日は2026年10月5日。温かいお茶は1,200円でした。👩‍💻が書いたが、まだ終わっていない文章もある。\n\n急がず、ひとつずつ。分からないところでは立ち止まり、原文を読み返そう。';

export function ReaderApp() {
  const [initialDraft] = useState(() => initialReadingDraft(import.meta.env.VITE_RSVP_PROFILE, typeof window === 'undefined' ? undefined : window.history.state));
  const [controller] = useState(() => new PlaybackController(DEFAULT_SETTINGS));
  const playback = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [document, setDocument] = useState<ReadingDocument>();
  const [pdfData, setPdfData] = useState<ArrayBuffer>();
  const { settings, setSettings } = useReaderPreferences();
  const [cpmInput, setCpmInput] = useState(String(DEFAULT_SETTINGS.cpm));
  const [title, setTitle] = useState(() => initialDraft.title);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  const [generationDocument, setGenerationDocument] = useState<ReadingDocument>();
  const [draftPdfData, setDraftPdfData] = useState<ArrayBuffer>();
  const [input, setInput] = useState(() => initialDraft.text);
  const [format, setFormat] = useState<InputFormat>(() => initialDraft.format);
  const draftEdited = useRef(false);
  const historyDraft = useRef({ title, text: input, format });
  historyDraft.current = { title, text: input, format };
  const [importOpen, setImportOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [fallbackRaw, setFallbackRaw] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<SavedReading>();
  const [saving, setSaving] = useState(false);
  const storageBusy = useRef(false);
  const operation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const current = document?.units[playback.index];
  const sentences = useMemo(() => document ? readingSentences(document) : [], [document]);
  const sentenceIndex = sentenceIndexAt(sentences, playback.index);
  const pauseReading = useCallback(() => controller.pause(), [controller]);
  const fullscreen = useFullscreenReader(pauseReading);
  useScreenWakeLock(playback.status === 'playing');
  useEffect(() => { controller.updateSettings(settings); setCpmInput(String(settings.cpm)); }, [controller, settings]);
  const font = useReadingFont(document?.blocks, settings.fontFamily ?? 'system', pauseReading);
  const groups = useMemo(() => groupReadingUnits(document?.units ?? [], { target: settings.groupTarget ?? 0, minimum: settings.groupMinimum ?? 0 }, new Set(sentences.map(sentence => sentence.target))), [document, sentences, settings.groupTarget, settings.groupMinimum]);
  const groupIndex = groupIndexAt(groups, playback.index);
  const displayGroup = groups[groupIndex];
  const arrowAt = useRef(0);
  const chapters = useMemo(() => {
    if (!document?.provenance) return [];
    const headings = new Set(document.blocks.filter(block => block.kind === 'heading').map(block => block.id));
    return document.provenance.chapters.map(chapter => {
      const heading = document.units.findIndex(unit => unit.blockId === chapter.blockId);
      return { title: chapter.title, target: document.units.findIndex((unit, index) => index > heading && !headings.has(unit.blockId)) };
    }).filter(chapter => chapter.target >= 0);
  }, [document]);

  useEffect(() => {
    let active = true;
    void loadReading().then(value => { if (active) setSaved(value); }).catch(e => {
      if (active) setNotice(`保存したデータを開けませんでした。${message(e)}「保存を削除」で消去できます。`);
    });
    const stop = () => controller.pause();
    const pageHide = () => {
      stop();
      if (import.meta.env.VITE_RSVP_PROFILE === 'pages' && draftEdited.current) {
        // Preserve only this edited form in its browser history entry, never in a URL or bookshelf.
        try { window.history.replaceState({ ...window.history.state, ripolaPagesDraft: historyDraft.current }, ''); }
        catch { /* Restricted browser history must not prevent navigation. */ }
      }
    };
    const visibility = () => { if (globalThis.document.hidden) stop(); };
    globalThis.document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', stop);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('resize', stop);
    return () => {
      active = false;
      abort.current?.abort();
      // React may rehearse effects in development; cleanup stops timers without retiring the shared controller.
      controller.pause();
      globalThis.document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', stop);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('resize', stop);
    };
  }, [controller]);

  const update = useCallback((patch: Partial<ReaderSettings>) => {
    if (patch.cpm !== undefined) setCpmInput(String(patch.cpm));
    const next = { ...settings, ...patch };
    controller.updateSettings(next);
    setSettings(next);
  }, [controller, settings]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (shortcutBlocked(event) || !document || loading || font.busy || importOpen || sourceOpen || settingsOpen || helpOpen) return;
      if (event.code.startsWith('Arrow') && !repeatedArrowAllowed(event, arrowAt)) { event.preventDefault(); return; }
      if (event.code === 'Space') { event.preventDefault(); if (event.repeat) return; if (playback.status === 'playing') controller.pause(); else if (playback.status === 'completed') controller.seek(0); else controller.play(); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); if (event.shiftKey) controller.seek(sentences[Math.max(0, sentenceIndex - 1)]?.target ?? 0); else controller.step(-1); }
      if (event.code === 'ArrowRight') { event.preventDefault(); if (event.shiftKey) controller.seek(sentences[Math.min(sentences.length - 1, sentenceIndex + 1)]?.target ?? document.units.length - 1); else controller.step(1); }
      if (event.code === 'ArrowUp') { event.preventDefault(); update({ cpm: Math.min(3000, settings.cpm + 100) }); }
      if (event.code === 'Home' || event.code === 'End') { event.preventDefault(); controller.seek(event.code === 'Home' ? 0 : document.units.length - 1); }
      if (event.code === 'ArrowDown') { event.preventDefault(); update({ cpm: Math.max(100, settings.cpm - 100) }); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [controller, document, importOpen, loading, playback.status, settings.cpm, settingsOpen, sourceOpen, helpOpen, font.busy, sentences, sentenceIndex, update]);

  const cancel = () => {
    operation.current++;
    abort.current?.abort();
    abort.current = null;
    setLoading(false);
    setNotice('読み込みを取り消しました。入力を変更して、もう一度読み込めます。');
  };

  async function importInput(file?: File, sample?: string, aozoraSample = false, prepareOnly = false): Promise<ReadingDocument | undefined> {
    controller.pause();
    abort.current?.abort();
    const request = ++operation.current;
    const task = new AbortController();
    abort.current = task;
    setLoading(true); setProgress(0); setError(''); setNotice(''); setFallbackRaw('');
    try {
      let result: ReadingDocument;
      let pdf: ArrayBuffer | undefined;
      if (generationDocument && !file && !sample && !aozoraSample) {
        result = { ...generationDocument, title: resolveDocumentTitle(generationDocument.title) }; pdf = draftPdfData;
      } else if (aozoraSample) {
        setPhase('吾輩は猫であるの全11章を準備しています');
        const response = await fetch(`${import.meta.env.BASE_URL}samples/wagahai.json`, { signal: task.signal, redirect: 'error' });
        if (!response.ok) throw new Error('青空文庫サンプルを取得できませんでした。');
        const bytes = await response.arrayBuffer(); if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('サンプルの容量が正しくありません。');
        const value = JSON.parse(new TextDecoder().decode(bytes)) as { schemaVersion: number; scope: string; draft: DraftDocument };
        if (value.schemaVersion !== 1 || value.scope !== 'full-text-eleven-chapters' || value.draft.format !== 'aozora'
          || value.draft.provenance?.chapters.length !== 11) throw new Error('サンプルの形式が正しくありません。');
        result = await processDraft(value.draft, { signal: task.signal, onProgress: value => { if (request === operation.current) setProgress(value * 100); } });
      } else if (file) {
        if (file.size > MAX_INPUT_BYTES) throw new Error('ファイルは20 MB以下にしてください。');
        const extension = file.name.split('.').pop()?.toLowerCase();
        if (!['md', 'markdown', 'txt', 'pdf', 'html', 'htm'].includes(extension ?? '')) throw new Error('MD・TXT・PDF・青空文庫HTMLを選んでください。');
        if (extension === 'pdf') {
          setPhase('PDFから本文を取得しています');
          pdf = await file.arrayBuffer();
          const { importPdf } = await import('../pdf-import');
          const draft = await importPdf(pdf, file.name.slice(0, MAX_TITLE_LENGTH), { signal: task.signal, onProgress: (done, total) => { if (request === operation.current) setProgress(total ? done / total * 70 : 0); } });
          if (request !== operation.current || task.signal.aborted) return;
          setFallbackRaw(draft.blocks.map(block => block.text).join('\n\n'));
          setPhase('フレーズを準備しています');
          result = await processDraft(draft, { signal: task.signal, onProgress: value => { if (request === operation.current) setProgress(70 + value * 30); } });
        } else {
          setPhase('本文とフレーズを準備しています');
          const html = extension === 'html' || extension === 'htm';
          const raw = html ? decodeAozoraHtml(await file.arrayBuffer()) : await file.text();
          if (request === operation.current && !task.signal.aborted) setFallbackRaw(raw);
          result = await processText(raw, html ? 'aozora' : extension === 'txt' ? 'txt' : 'md', file.name.slice(0, MAX_TITLE_LENGTH), { signal: task.signal, onProgress: value => { if (request === operation.current) setProgress(value * 100); } });
        }
      } else {
        const raw = sample ?? input;
        if (raw.length > MAX_TEXT_LENGTH) throw new Error('本文は100万文字以下にしてください。');
        if (!raw.trim()) throw new Error('読む文章を入力してください。');
        setFallbackRaw(raw);
        setPhase('本文とフレーズを準備しています');
        result = await processText(raw, sample ? 'md' : resolveInputFormat(raw, format), sample ? '朝の図書館' : resolveDocumentTitle(title), { signal: task.signal, onProgress: value => { if (request === operation.current) setProgress(value * 100); } });
      }
      if (request !== operation.current || task.signal.aborted) return;
      if (!result.units.some(unit => unit.kind === 'text' && unit.characters > 0)) throw new Error('読む本文がありません。コードや画像だけの文書は原文でご確認ください。');
      if (prepareOnly) {
        setGenerationDocument(result); setDraftPdfData(pdf); setTitle(result.title);
        if (file || aozoraSample) { setInput(result.format === 'md' || result.format === 'txt' ? result.rawText : result.blocks.map(block => block.text).join('\n\n')); setFormat('auto'); }
        setNotice('');
        return result;
      }
      setDocument(result); setPdfData(pdf); controller.load(result.units, aozoraSample ? Math.max(0, result.units.findIndex(unit => result.blocks.find(block => block.id === unit.blockId)?.kind === 'paragraph')) : 0);
      setImportOpen(false); setSourceOpen(result.format === 'pdf');
      setNotice('');
      return result;
    } catch (e) {
      if (request === operation.current && !task.signal.aborted) setError(message(e));
    } finally {
      if (request === operation.current) { setLoading(false); abort.current = null; }
    }
  }

  async function restore() {
    if (!saved) return;
    controller.pause(); abort.current?.abort();
    const request = ++operation.current;
    const task = new AbortController(); abort.current = task;
    setLoading(true); setProgress(0); setPhase('保存した本文を準備しています'); setError('');
    try {
      const restored = await processDraft(saved.document, { signal: task.signal, onProgress: value => { if (request === operation.current) setProgress(value * 100); } });
      if (request !== operation.current || task.signal.aborted) return;
      if (restored.contentHash !== saved.document.contentHash) throw new Error('保存した本文の一致を確認できませんでした。保存を削除して再度読み込んでください。');
      const restoredSettings = hasStoredPreferences() ? settings : saved.settings;
      setDocument(restored); setPdfData(saved.pdfData); setSettings(restoredSettings);
      controller.updateSettings(restoredSettings); controller.load(restored.units, sourceAnchorToIndex(restored, saved.anchor));
      setNotice('保存した位置を開きました。');
    } catch (e) { if (request === operation.current && !task.signal.aborted) setError(message(e)); }
    finally { if (request === operation.current) { setLoading(false); abort.current = null; } }
  }

  async function save() {
    if (!document || !current || storageBusy.current) return;
    storageBusy.current = true; controller.pause(); setSaving(true);
    try {
      await saveReading({ document, anchor: { blockId: current.blockId, offset: current.start }, settings: { ...settings, fontFamily: font.applied }, pdfData });
      setSaved(await loadReading()); setNotice('本文・現在位置・設定を、このブラウザに保存しました。');
    } catch (e) { setNotice(`保存できませんでした。${message(e)} 読書は続けられます。`); }
    finally { setSaving(false); storageBusy.current = false; }
  }
  async function removeSaved() {
    if (storageBusy.current) return;
    storageBusy.current = true; setSaving(true);
    try { await deleteReading(); setSaved(undefined); setNotice('このブラウザの保存を削除しました。読み込み中の本文は残ります。'); }
    catch (e) { setNotice(`保存を削除できませんでした。${message(e)}`); }
    finally { setSaving(false); storageBusy.current = false; }
  }
  async function renameDocument(name: string) {
    if (!document) return;
    controller.pause();
    const next = { ...document, title: resolveDocumentTitle(name) };
    let stored: SavedReading | undefined;
    try { stored = await loadReading(); } catch { /* Unsaved text can still be renamed without browser storage. */ }
    if (stored?.document.id === document.id) {
      await saveReading({ ...stored, document: { ...stored.document, title: next.title } });
      setSaved(await loadReading());
    }
    setDocument(next); setNotice(stored?.document.id === document.id ? '保存した本文の名前を変更しました。' : '本文の名前を変更しました。残すには「端末に保存」を押してください。');
  }
  const openSource = () => { fullscreen.exit(); controller.pause(); setSourceOpen(true); };
  const openSettings = () => { controller.pause(); setSettingsOpen(true); };
  const completed = playback.status === 'completed';
  const count = completed ? document?.totalCharacters ?? 0 : current?.cumulativeCharacters ?? 0;

  function changeDraft() { draftEdited.current = true; setGenerationDocument(undefined); setDraftPdfData(undefined); setDraftRevision(value => value + 1); }
  const draftDisabled = loading || audioBusy;
  const onGenerationBusy = useCallback((value: boolean) => setAudioBusy(value), []);
  const manuscriptFields = <>
    <TextInput label="タイトル" description="任意。未入力ならこの端末の日付と時刻を使います。後から変更できます。" placeholder="未入力なら作成日時" maxLength={MAX_TITLE_LENGTH} value={title} onChange={event => { draftEdited.current = true; setTitle(event.target.value); if (generationDocument) setGenerationDocument({ ...generationDocument, title: event.target.value }); setDraftRevision(value => value + 1); }} disabled={draftDisabled} />
    <Button component="label" htmlFor="reading-file" variant="light" fullWidth className="file-button" disabled={draftDisabled}>ファイルを選ぶ<span className="file-types">MD / TXT / PDF / HTML · 20 MBまで</span></Button>
    <input id="reading-file" aria-label="読み込むファイル" type="file" accept=".md,.markdown,.txt,.pdf,.html,.htm" className="visually-hidden" disabled={draftDisabled} onChange={e => { const file = e.target.files?.[0]; if (file) { draftEdited.current = true; setDraftRevision(value => value + 1); void importInput(file, undefined, false, true); } e.target.value = ''; }} />
    <div className="divider"><span>または、文章を貼り付け</span></div>
    <div className="manuscript-heading"><label htmlFor="home-manuscript">読む文章</label></div>
    <InputFormatControl text={input} value={format} sourceFormat={generationDocument?.format} disabled={draftDisabled} onChange={value => { setFormat(value); changeDraft(); }} />
    <Textarea id="home-manuscript" aria-label="読む文章" placeholder="ここに文章を貼り付けてください…" value={input} disabled={draftDisabled} onChange={e => { setInput(e.target.value); changeDraft(); }} rows={3} resize="vertical" maxLength={MAX_TEXT_LENGTH + 1} spellCheck={false} />
    {import.meta.env.VITE_RSVP_PROFILE === 'pages' && input === PAGES_DEMO.text && <p className="input-note">デモ文：夏目漱石『吾輩は猫である』冒頭（<a href={PAGES_DEMO.sourceUrl} target="_blank" rel="noreferrer">青空文庫</a>）。そのまま読み始めるか、自分の文章に書き換えられます。</p>}
    {generationDocument && <details className="home-manuscript-preview"><summary>取り込んだ本文を確認 · {generationDocument.title} · {generationDocument.totalCharacters.toLocaleString()}字</summary><pre>{generationDocument.blocks.map(block => block.text).join('\n\n')}</pre>{generationDocument.warnings.map((warning, i) => <p className="muted" key={i}>{warning}</p>)}</details>}
  </>;
  const sampleActions = <section className="home-samples" aria-label="サンプルで試す"><h2>サンプルで試す</h2>
    <AudioDemo disabled={draftDisabled} />
    <article className="home-sample-item" aria-label="短い黙読サンプル"><span className="sample-glyph" aria-hidden="true">Aa</span><div className="sample-copy"><h3>短く試す</h3><p>朝の図書館</p><p className="sample-meta">短い文章 · 音声なし</p></div><Button variant="light" onClick={() => { setInput(SAMPLE); setFormat('auto'); setTitle('朝の図書館'); changeDraft(); void importInput(undefined, SAMPLE); }} disabled={draftDisabled}>テキストで読む</Button></article>
    <article className="home-sample-item" aria-label="全文の黙読サンプル"><span className="sample-glyph" aria-hidden="true">▤</span><div className="sample-copy"><h3>全文を読む</h3><p>吾輩は猫である</p><p className="sample-meta">全11章 · ルビ付き · 音声なし</p></div><Button variant="light" disabled={draftDisabled} onClick={() => void importInput(undefined, undefined, true)}>全文で読む</Button></article>
  </section>;
  const importPanel = <>
    {LocalGeneration ? <Suspense fallback={<div className="loading-card">入力フォームを準備しています…</div>}><LocalGeneration home={{ input: manuscriptFields, rawText: input, inputFormat: format, document: generationDocument, revision: draftRevision, enabled: audioEnabled, onToggle: setAudioEnabled, prepareDocument: () => importInput(undefined, undefined, false, true), onRead: () => { void importInput(); }, textBusy: loading, onBusyChange: onGenerationBusy }} /></Suspense> : <div className="home-composer">{manuscriptFields}<EnvironmentAvailability /><div className="home-generation-actions"><Button disabled={draftDisabled} onClick={() => void importInput()}>テキストのみ生成して読む</Button></div><p className="home-action-note">本文を外へ送りません。</p></div>}
    {sampleActions}
    <p className="input-note import-scope">横書き1段のテキスト層付きPDF・青空文庫HTMLに対応。OCR・縦書き・段組PDFの自動復元には対応していません。</p>
  </>;

  return <div style={font.style} className={`app-shell ${document ? 'is-reading' : 'home-shell'} ${settings.contrast === 'night' ? 'night' : ''}`}>
    <header className="app-header"><Brand /><div className="header-actions">
      <Button component="a" href={`${import.meta.env.BASE_URL}${CAPABILITIES.audioRoute}`} variant="light" size="sm">{CAPABILITIES.localGeneration ? 'このPCの本棚' : '本棚'}</Button>
      <Button variant="subtle" size="sm" onClick={() => { controller.pause(); setHelpOpen(true); }}>使い方</Button>{document && <Button variant="subtle" size="sm" onClick={() => { controller.pause(); setImportOpen(true); setError(''); }}>別の文章を開く</Button>}</div></header>
    <main className={document ? 'reading-main' : 'welcome-main'}>
      {!document && <div className="welcome-intro"><h1><span>ひとつずつ、</span><wbr /><span>一定のペースで。</span></h1><p>{LocalGeneration ? '文章を入れて、テキストだけでも、音声と一緒でも。' : '文章を入れて、自分のペースで読みはじめる。'}</p></div>}
      <div className={document ? 'document-content' : 'welcome-content'}>
        {error && !importOpen && <Alert color="red" title="読み込めませんでした" role="alert" mb="md">{error}</Alert>}
        {error && !importOpen && fallbackRaw && <Textarea label="処理前の原文・抽出本文" value={fallbackRaw} readOnly rows={8} mb="md" />}
        {notice && <div className="notice" role="status">{notice}</div>}
        {loading && <div className="loading-card" role="status"><strong>{phase}</strong><Progress value={progress} mt="sm" /><Button variant="subtle" mt="sm" onClick={cancel}>読み込みを取り消す</Button></div>}
        {!document ? <>
          {saved && <div className="saved-card"><div><strong>{saved.document.title}</strong><p>このブラウザに保存した文章があります。</p></div><Button variant="light" onClick={() => void restore()}>続きから開く</Button></div>}
          {importPanel}
          <button type="button" className="text-link" disabled={saving} onClick={() => void removeSaved()}>保存を削除</button>
        </> : <NavigationLayout key={document.id} entries={sentences} current={sentenceIndex} playing={playback.status === 'playing'} chapters={chapters} onPause={() => controller.pause()} onResume={() => { if (font.busy) return; if (playback.status === 'completed') controller.seek(0); controller.play(); }} onJump={index => controller.seek(index)}>
          <div className="document-heading"><div><span className="eyebrow">{document.format.toUpperCase()} · 読書</span><h1>{document.title}</h1></div></div>
          {document.warnings.length > 0 && <details className="warnings"><summary>取り込み時の確認事項（{document.warnings.length}）</summary><ul>{document.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
          <ReadingModeControls mode={settings.mode} onChange={mode => { controller.pause(); update({ mode }); }} />
          {(font.busy || font.error) && <p className="font-stage-status" role="status">{font.error || '書体と文字の配置を準備しています。停止したままお待ちください。'}</p>}
          <FullscreenReader fullscreen={fullscreen} playing={playback.status === 'playing'} pause={pauseReading} disabled={loading || font.busy}
            playLabel={completed ? 'もう一度' : current?.kind === 'static' ? '次のフレーズへ' : '再生'}
            toggle={() => { if (completed) controller.seek(0); else controller.play(); }}
            seek={<label><span>読書の再生位置</span><input aria-label="読書の再生位置" type="range" min="0" max={Math.max(0, document.units.length - 1)} step="1" value={playback.index} disabled={document.units.length < 2} onChange={event => controller.seek(Number(event.target.value))} /></label>}
            modes={<ReadingModeControls mode={settings.mode} onChange={mode => { controller.pause(); update({ mode }); }} />}
            speed={<label>読む速さ（字/分）<input aria-label="読む速さ（字/分）" type="number" min="100" max="3000" step="50" value={cpmInput} onChange={event => { setCpmInput(event.target.value); const value = Number(event.target.value); if (Number.isFinite(value) && value >= 100 && value <= 3000) update({ cpm: Math.round(value) }); }} onBlur={() => setCpmInput(String(settings.cpm))} /></label>}>
          <section className={`reader-stage ${settings.mode === 'guide' ? 'guide-mode' : ''} ${settings.guide ? 'with-guide' : ''}`} aria-label="フレーズ表示" data-testid="reader-stage">
            <div className="stage-topline"><span>{completed ? '読了' : current?.kind === 'static' ? '原文で確認' : playback.status === 'playing' ? '再生中' : '一時停止'}</span><span className="playback-position-label">{playback.status === 'playing' ? '\u00a0' : `${playback.index + 1} / ${document.units.length} フレーズ`}</span></div>
            {settings.mode === 'guide' ? <GuideReader key={settings.writingMode} writingMode={settings.writingMode} blocks={document.blocks} units={document.units} currentIndices={displayGroup ? Array.from({ length: displayGroup.endIndex - displayGroup.startIndex + 1 }, (_, i) => displayGroup.startIndex + i) : [playback.index]} playing={playback.status === 'playing'} ruby={settings.ruby} family={READING_FONTS[font.applied].family} onJump={index => controller.seek(index)} onPause={pauseReading} /> : current?.kind === 'static' ? <div className="static-notice"><h2>コード・表は原文で。</h2><p>内容を確認してから、次のフレーズへ進めます。</p><Button variant="light" onClick={openSource}>原文を開く</Button></div> : <PhraseDisplay writingMode={settings.writingMode} unit={displayGroup?.unit ?? current} fontSize={settings.fontSize} ruby={settings.ruby} family={READING_FONTS[font.applied].family} />}

            <FullscreenEnterButton fullscreen={fullscreen} />
          </section>
          {(settings.mode ?? 'flash') === 'flash' && <StoppedContext groups={groups} groupIndex={groupIndex} playing={playback.status === 'playing'} enabled={settings.context ?? true} ruby={settings.ruby} onJump={index => controller.seek(index)} />}
          </FullscreenReader>
          <PlaybackProgress controller={controller} snapshot={playback} characters={count} totalCharacters={document.totalCharacters} />
          <div className="reader-controls"><div className="transport"><Button variant="light" onClick={() => controller.step(-1)} disabled={loading || playback.index === 0} aria-keyshortcuts="ArrowLeft" aria-label="1つ戻る"><Arrow direction="left" /><span>戻る</span></Button><Button className="play-button" onClick={() => { if (completed) controller.seek(0); else if (playback.status === 'playing') controller.pause(); else controller.play(); }} disabled={loading || font.busy} aria-keyshortcuts="Space" aria-label={completed ? 'もう一度' : playback.status === 'playing' ? '一時停止' : current?.kind === 'static' ? '次のフレーズへ' : '再生'}><span aria-hidden="true">{playback.status === 'playing' ? 'Ⅱ' : completed ? '↻' : '▶'}</span>{completed ? 'もう一度' : playback.status === 'playing' ? '一時停止' : current?.kind === 'static' ? '次へ' : '再生'}</Button><Button variant="light" onClick={() => controller.step(1)} disabled={loading || playback.index === document.units.length - 1} aria-keyshortcuts="ArrowRight" aria-label="1つ進む"><span>進む</span><Arrow direction="right" /></Button></div>
            <div className="speed-controls"><label htmlFor="cpm" title="CPM：句読点と空白を除いた文字数">読む速さ<span>文字/分</span></label><input id="cpm" aria-label="読む速さのスライダー" type="range" min="100" max="3000" step="50" value={settings.cpm} onChange={e => update({ cpm: Number(e.target.value) })} /><div className="speed-adjust"><button aria-label="100字遅く" onClick={() => update({ cpm: Math.max(100, settings.cpm - 100) })}>−</button><input aria-label="読む速さ（字/分）" type="number" min="100" max="3000" step="50" value={cpmInput} onChange={e => { setCpmInput(e.target.value); const value = Number(e.target.value); if (Number.isFinite(value) && value >= 100 && value <= 3000) update({ cpm: Math.round(value) }); }} onBlur={() => setCpmInput(String(settings.cpm))} /><button aria-label="100字速く" onClick={() => update({ cpm: Math.min(3000, settings.cpm + 100) })}>＋</button></div></div>
            <div className="secondary-controls"><Button variant="subtle" onClick={openSource}>原文</Button><Button variant="subtle" onClick={openSettings}>表示設定</Button><Button variant="subtle" onClick={() => void save()} loading={saving} disabled={font.busy}>端末に保存</Button></div>
          </div>
          <p className="keyboard-hint">Space 再生／一時停止 · ← → フレーズ · Shift＋← → 文 · ↑ ↓ 速さ · Home / End</p><ShortcutHelp />
          <p className="reader-note">まずは400文字/分から。研究を参考にした控えめな初期値です。読みやすさや内容に合わせて調整してください。</p>
          <AozoraInfo value={document.provenance} />
        </NavigationLayout>}
      </div>
    </main>
    <footer className="app-footer"><span>BudouXでフレーズ分割。厳密な文法的文節とは異なります。</span><span>速さより、読みやすさを。</span><details onToggle={() => controller.pause()}><summary>ページURLを共有</summary><ShareLink title="リーダー" /></details></footer>
    <Drawer className={`reader-drawer ${settings.contrast === 'night' ? 'night' : ''}`} closeButtonProps={{ 'aria-label': '閉じる' }} opened={importOpen} onClose={() => setImportOpen(false)} title="別の文章を開く" position="right" size="lg">{error && <Alert color="red" role="alert" mb="md">{error}</Alert>}{error && fallbackRaw && <Textarea label="処理前の原文・抽出本文" value={fallbackRaw} readOnly rows={8} mb="md" />}{loading && <div role="status"><p>{phase}</p><Button onClick={cancel}>読み込みを取り消す</Button></div>}{importPanel}</Drawer>
    <Drawer className={`reader-drawer ${settings.contrast === 'night' ? 'night' : ''}`} closeButtonProps={{ 'aria-label': '閉じる' }} opened={sourceOpen} onClose={() => setSourceOpen(false)} title="原文を確認" position="right" size="xl">{document && <SourceView document={document} current={current} index={playback.index} pdfData={pdfData} onSeek={index => controller.seek(index)} />}</Drawer>
    <Drawer className={`reader-drawer ${settings.contrast === 'night' ? 'night' : ''}`} closeButtonProps={{ 'aria-label': '閉じる' }} opened={settingsOpen} onClose={() => setSettingsOpen(false)} title="表示設定" position="right" size="md">
      <div className="settings-panel">
        {document && <section className="settings-section"><h2>本文の名前</h2><TitleEditor title={document.title} onRename={renameDocument} /></section>}
        <section className="settings-section"><h2>文字と表示</h2>
          <FontSelect value={settings.fontFamily ?? 'system'} onChange={fontFamily => { controller.pause(); update({ fontFamily }); }} phase={font.phase} error={font.error} />
          <WritingModeSelect value={settings.writingMode} onChange={writingMode => { controller.pause(); update({ writingMode }); }} />
          <GroupSettings settings={settings} onChange={patch => { controller.pause(); update(patch); }} />
          <Switch label="停止時に前後の文脈を表示" checked={settings.context ?? true} onChange={e => update({ context: e.currentTarget.checked })} />
          <label className="font-size-setting">文字サイズ <strong>{settings.fontSize} px</strong><input aria-label="文字サイズ" type="range" min="24" max="96" step="2" value={settings.fontSize} onChange={e => update({ fontSize: Number(e.target.value) })} /></label>
          <Switch label="ルビを表示" checked={settings.ruby} onChange={e => update({ ruby: e.currentTarget.checked })} />
          <Switch label="注視点ガイド" checked={settings.guide} onChange={e => update({ guide: e.currentTarget.checked })} />
          <Switch label="暗い背景" checked={settings.contrast === 'night'} onChange={e => update({ contrast: e.currentTarget.checked ? 'night' : 'paper' })} />
          <p className="muted">長いフレーズは、画面に収まる大きさに調整します。</p><Button variant="light" onClick={() => { controller.pause(); update(resetDisplaySettings(settings)); }}>表示設定をリセット</Button>
        </section>
        <section className="settings-section"><h2>読むリズム</h2>
          <Switch label="句読点で間をとる" checked={settings.punctuationPause} onChange={e => update({ punctuationPause: e.currentTarget.checked })} />
          <p className="muted">読点100ms・文末250ms・段落400ms・見出し600msを追加します。個別の長さ調整はありません。</p><p className="muted">速度や間の変更は、次のフレーズから反映します。設定を閉じても停止状態が続きます。</p>
        </section>
        <section className="settings-section storage-section"><h2>このブラウザの保存</h2>
          <p className="muted">速度と表示設定はこのブラウザに自動保存します。本文と読書位置を残すには、読書画面の「端末に保存」を押してください。</p>
          <Button variant="light" color="gray" disabled={saving} onClick={() => void removeSaved()}>保存を削除</Button>
          <p className="input-note">保存した1冊を削除します。読み込み中の本文は残ります。</p>
        </section>
        <p className="settings-footnote">BudouXのフレーズ分割は、厳密な文法的文節とは異なります。</p>
      </div>
    </Drawer>
    <Drawer className={`reader-drawer ${settings.contrast === 'night' ? 'night' : ''}`} opened={helpOpen} onClose={() => setHelpOpen(false)} title="使い方" position="right" size="md" closeButtonProps={{'aria-label':'閉じる'}}><p className="muted">文章を貼り付けるかファイルを選び、「テキストのみ生成して読む」で読みはじめます。</p>{LocalGeneration && <p className="muted">「音声も生成する」をオンにすると、声・読み・生成する文を選べます。無料VOICEVOXはこのPCのEngineを使用します。有料Geminiは本文をGoogleに送信するため、送信内容と概算費用を確認してから開始します。</p>}<p className="muted">貼り付け形式は自動判定です。「変更」でテキスト・Markdownを指定できます。フォーム下の3つのサンプルは、音声付き冒頭・短い黙読・全文11章から直接開けます。</p>{!LocalGeneration && <p className="muted">公開デモと個人用Workerは、端末内のテキスト取り込み・RSVP生成と準備済み音声の再生に対応します。Gemini・VOICEVOXの音声生成はローカルPC版限定です。</p>}<p className="muted">読書は一時停止や前後の移動ができ、原文も確認できます。急がず、自分のペースでどうぞ。</p></Drawer>
  </div>;
}

function SourceView({ document, current, index, pdfData, onSeek }: { document: ReadingDocument; current?: ReadingUnit; index: number; pdfData?: ArrayBuffer; onSeek: (index: number) => void }) {
  const context = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = context.current;
    const active = panel?.querySelector<HTMLElement>('[aria-current="location"]');
    if (panel && active) panel.scrollTop = Math.max(0, active.offsetTop - panel.clientHeight / 2 + active.offsetHeight / 2);
  }, [current?.id]);
  const fullText = useMemo(() => {
    let start = 0;
    const blocks = document.blocks.map(block => { const range = { block, start, end: start + block.text.length }; start = range.end + 2; return range; });
    return { text: document.blocks.map(block => block.text).join('\n\n'), blocks };
  }, [document]);
  const select = (offset: number) => {
    const block = fullText.blocks.find(range => range.start <= offset && range.end >= offset);
    if (block) { const anchor: SourceAnchor = { blockId: block.block.id, offset: offset - block.start }; onSeek(sourceAnchorToIndex(document, anchor)); }
  };
  const rawSelect = (offset: number) => {
    const found = document.units.findIndex(unit => unit.sources.some(source => source.kind === 'text' && source.start <= offset && source.end > offset));
    if (found >= 0) onSeek(found);
  };
  return <div className="source-view"><p className="muted">フレーズを選ぶと、その位置に移動して停止します。スクロールだけでは位置は変わりません。</p>
    <div ref={context} className="source-context" aria-label="現在位置の前後"><div className="eyebrow">現在位置の前後</div>{document.units.slice(Math.max(0, index - 20), index + 21).map((unit, i) => <button key={unit.id} type="button" className={`source-unit ${unit.id === current?.id ? 'active' : ''} ${unit.kind === 'static' ? 'source-static' : ''}`} aria-current={unit.id === current?.id ? 'location' : undefined} onClick={() => onSeek(Math.max(0, index - 20) + i)} title="ここから読む"><RubyText unit={unit} show /></button>)}</div>
    {current?.mapping !== 'exact' && <p className="input-note">このフレーズの元位置は、変換により範囲が近似されています。</p>}
    {document.format === 'pdf' && pdfData && <PdfSource data={pdfData} document={document} unit={current} />}
    <label className="full-text-label">抽出した全文<textarea readOnly value={fullText.text} onSelect={e => select(e.currentTarget.selectionStart)} aria-label="抽出した全文" rows={8} /></label>
    {document.format !== 'pdf' && <details><summary>元の{document.format === 'md' ? 'Markdown' : 'テキスト'}と照合</summary><label className="full-text-label">元の入力<textarea readOnly value={document.rawText} onSelect={e => rawSelect(e.currentTarget.selectionStart)} aria-label="元の入力" rows={8} /></label>{current?.sources.filter(source => source.kind === 'text').map((source, i) => <pre className="source-snippet" key={i}>{document.rawText.slice(Math.max(0, source.start - 24), source.start)}<mark>{document.rawText.slice(source.start, source.end)}</mark>{document.rawText.slice(source.end, source.end + 24)}</pre>)}</details>}
  </div>;
}
function message(error: unknown) { return error instanceof Error ? error.message : '処理に失敗しました。もう一度お試しください。'; }
function Arrow({ direction }: { direction: 'left' | 'right' }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={direction === 'left' ? 'M15 5 8 12l7 7' : 'm9 5 7 7-7 7'} /></svg>; }
