import { Brand } from '../../ui/Brand';
import { ThemeControl } from '../../ui/ThemeControl';
import { Alert, Button, Drawer, Loader, Select } from '@mantine/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { audioDisplayAt, audioPhraseTargets, audioSegments, audioTimeLabel, locateAudioTime, mediaPosition, type PlayableAudioChunk } from '../audio-clock';
import { audioSentenceIndexAt, audioSentenceTargets } from '../audio-sentences';
import { type ReaderSettings, type RubySpan, type TextBlock } from '../model';
import { inspectAudioPresentation, requireAudioPresentation } from '../audio-presentation';
import { audioPositionKey, loadAudioPosition } from '../audio-position';
import { ShareLink } from '../../sharing/ShareLink';
import '../../generation-ui/generation.css';
import { NavigationLayout } from './NavigationLayout';
import { AozoraInfo } from './AozoraInfo';
import { PhraseDisplay } from './PhraseDisplay';
import { ShortcutHelp, useReadingFont } from './ReadingOptions';
import { READING_FONTS } from '../reading-fonts';
import { groupIndexAt, groupReadingUnits } from '../display-groups';
import { shortcutBlocked, repeatedArrowAllowed } from '../shortcuts';
import { GuideReader } from './GuideReader';
import { StoppedContext } from './StoppedContext';
import { TitleEditor } from './TitleEditor';
import { FullscreenEnterButton, FullscreenReader, ReaderPlayButton, useFullscreenReader } from './FullscreenReader';
import { useScreenWakeLock } from './useScreenWakeLock';
import { ReadingModeControls } from './ReadingModeControls';
import { useReaderPreferences } from './useReaderPreferences';
import { AudioPrefetch, audioAssetKey, audioBufferReadyForAhead, browserPrefetchEnvironment } from '../audio-prefetch';
import { continuation, contiguousChunks, playbackAnchor, restoreAnchor, savedPlaybackAnchor, serializePlaybackAnchor, type PlaybackAnchor, type ProgressiveBook } from '../audio-progressive';
import type { JobStatus } from '../../generation/contracts';
import { ReaderAudioNavigation, ReaderDisplaySettings, ReaderDisplayToolbar, ReaderTransport } from './ReaderWorkspace';

export function AudioReader({ book, onClose, attribution, localTools, demo = false, onRename, generationStatus }: { book: ProgressiveBook; generationStatus?: JobStatus; onClose: () => void; attribution?: string; localTools?: ReactNode; demo?: boolean; onRename?: (title: string) => Promise<void> }) {
  const validation = useMemo(() => {
    try { return { report: requireAudioPresentation(book), valid: true }; }
    catch { return { report: inspectAudioPresentation(book), valid: false }; }
  }, [book]);
  const segments = useMemo(() => validation.valid ? audioSegments(book) : [], [book, validation.valid]);
  const phraseTargets = useMemo(() => audioPhraseTargets(segments), [segments]);
  const segmentsByBlock = useMemo(() => {
    const result = new Map<string, Array<{ segment: typeof segments[number]; index: number }>>();
    segments.forEach((segment, index) => {
      for (const blockId of new Set(segment.chunk.timeline.map(mark => mark.blockId))) {
        const values = result.get(blockId) ?? [];
        values.push({ segment, index }); result.set(blockId, values);
      }
    });
    return result;
  }, [segments]);
  const total = segments.at(-1)?.endSeconds ?? 0;
  const [selectedChunk, setSelectedChunk] = useState(book.chunks[0]?.id ?? '');
  const index = Math.max(0, segments.findIndex(value => value.chunk.id === selectedChunk));
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const { settings: options, setSettings: setOptions, rate, setRate } = useReaderPreferences();
  const guide = options.guide;
  const ruby = options.ruby;
  const [error, setError] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const arrowAt = useRef(0);
  const audio = useRef<HTMLAudioElement>(null);
  const mediaClock = useRef<{ media: HTMLAudioElement; segment: typeof segments[number]; bookKey: string } | null>(null);
  const intent = useRef(false);
  const anchor = useRef<PlaybackAnchor | null>(null);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const playRequest = useRef(0);
  const pendingSeek = useRef(0);
  const positionRef = useRef(0);
  const activeBook = useRef('');
  const prefetch = useRef<AudioPrefetch | null>(null);
  const prefetchBook = useRef('');
  const segment = segments[index];
  const audioChunks = useMemo(() => segment ? contiguousChunks(book, segment.chunk.id) : [], [book, segment]);
  const generationStopped = generationStatus && ['failed', 'cancelled', 'cancel-requested', 'outcome-unknown'].includes(generationStatus);
  const storageKey = audioPositionKey(book);
  const assetIdentity = segment ? `${storageKey}:${audioAssetKey(segment.chunk)}` : storageKey;
  // Snapshot a ready URL only when changing files. Completing a speculative
  // fetch must never replace or restart the audio that is currently playing.
  const audioSource = useMemo(() => segment ? (prefetchBook.current === storageKey ? prefetch.current?.source(segment.chunk) : undefined) ?? segment.chunk.audioUrl : '', [assetIdentity]);
  const display = audioDisplayAt(segment, position - (segment?.startSeconds ?? 0));
  const reading = playing || intent.current;
  const loading = reading && buffering;
  const playableUnits = useMemo(() => phraseTargets.flatMap(target => target.cue.units), [phraseTargets]);
  const unitPositions = useMemo(() => new Map(playableUnits.map((unit, index) => [unit.id, index])), [playableUnits]);
  const unitTimes = useMemo(() => new Map(phraseTargets.flatMap(target => target.cue.units.map(unit => [unit.id, target.seconds] as const))), [phraseTargets]);
  const groups = useMemo(() => groupReadingUnits(playableUnits, { target: options.groupTarget ?? 0, minimum: options.groupMinimum ?? 0 }, new Set(segments.flatMap(value => { const first = value.displayCues[0]?.units[0]; return first ? [unitPositions.get(first.id)!] : []; }))), [playableUnits, options.groupTarget, options.groupMinimum, segments, unitPositions]);
  const displayIndex = unitPositions.get(display.units[0]?.id) ?? 0;
  const groupIndex = groupIndexAt(groups, displayIndex);
  const displayGroup = groups[groupIndex];
  const sentenceEntries = useMemo(() => audioSentenceTargets(book, segments), [book, segments]);
  const sentenceIndex = audioSentenceIndexAt(sentenceEntries, position);

  const persist = useCallback((seconds: number) => {
    if (activeBook.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, String(seconds));
      if (anchor.current) localStorage.setItem(`${storageKey}:source`, serializePlaybackAnchor(anchor.current));
    } catch { /* Playback remains usable without browser storage. */ }
  }, [storageKey]);

  const bindAudio = useCallback((media: HTMLAudioElement | null) => {
    const old = mediaClock.current;
    if (!media && old && old.bookKey === activeBook.current && old.media.readyState >= 1 && anchor.current?.chunkId === old.segment.chunk.id && anchor.current.asset === audioAssetKey(old.segment.chunk)) {
      anchor.current = playbackAnchor(old.segment, old.media.currentTime, old.media.ended);
    }
    audio.current = media;
    mediaClock.current = media && segment ? { media, segment, bookKey: storageKey } : null;
  }, [segment, storageKey]);

  const sample = useCallback(() => {
    // A queued frame can run after React commits the next <audio>, before the
    // previous effect is cleaned up. Read its matching offset, never a closure
    // from the previous file. Before metadata, keep the explicit pending target.
    const clock = mediaClock.current;
    if (!clock || clock.media !== audio.current || clock.media.readyState < 1 || clock.bookKey !== activeBook.current) return positionRef.current;
    const seconds = mediaPosition(clock.segment, clock.media.currentTime, clock.media.ended);
    anchor.current = playbackAnchor(clock.segment, clock.media.currentTime, clock.media.ended);
    positionRef.current = seconds;
    setPosition(seconds);
    return seconds;
  }, []);

  const readyForAhead = useCallback((chunk: PlayableAudioChunk | undefined) => {
    const clock = mediaClock.current;
    const media = audio.current;
    if (activeBook.current !== storageKey || prefetchBook.current !== storageKey || clock?.bookKey !== storageKey) return false;
    if (!chunk || !segment || !clock || !media || clock.media !== media || media.readyState < 1 || !media.currentSrc || !audioSource) return false;
    const targetAsset = audioAssetKey(chunk);
    if (targetAsset !== audioAssetKey(segment.chunk) || targetAsset !== audioAssetKey(clock.segment.chunk)) return false;
    try { if (media.currentSrc !== new URL(audioSource, media.ownerDocument.baseURI).href) return false; }
    catch { return false; }
    return audioBufferReadyForAhead(media, chunk.durationSeconds);
  }, [storageKey, segment, audioSource]);

  const reconcilePrefetch = useCallback((media = audio.current) => {
    if (media !== audio.current || prefetchBook.current !== storageKey) return;
    const localSeconds = media && media.readyState >= 1 ? media.currentTime : pendingSeek.current;
    prefetch.current?.update(audioChunks, 0, localSeconds, Number(rate), intent.current, readyForAhead(audioChunks[0]));
  }, [audioChunks, rate, readyForAhead, storageKey]);

  const pause = useCallback(() => {
    playRequest.current++;
    intent.current = false;
    setWaitingFor(null);
    audio.current?.pause();
    setPlaying(false);
    setBuffering(false);
    persist(sample());
    prefetch.current?.update(audioChunks, 0, 0, Number(rate), false, readyForAhead(audioChunks[0]));
  }, [persist, sample, audioChunks, rate, readyForAhead]);

  const font = useReadingFont(book.document.blocks, options.fontFamily ?? 'system', pause);
  const fullscreen = useFullscreenReader(pause);
  useScreenWakeLock(reading && validation.valid && display.precision !== 'unavailable' && !error && !font.busy);
  useEffect(() => { if (error && fullscreen.active) fullscreen.exit(); }, [error, fullscreen.active, fullscreen.exit]);
  const updateOptions = (patch: Partial<ReaderSettings>) => { pause(); setOptions(previous => ({ ...previous, ...patch })); };

  const seek = useCallback((seconds: number, continuePlaying = intent.current) => {
    const attempt = ++playRequest.current;
    const target = locateAudioTime(segments, seconds);
    setWaitingFor(null);
    anchor.current = segments[target.index] ? playbackAnchor(segments[target.index], target.localSeconds) : null;
    // Invalidate the old clock before any delayed pause/frame callback can run.
    if (target.index !== index) mediaClock.current = null;
    audio.current?.pause();
    intent.current = continuePlaying;
    setBuffering(continuePlaying && (target.index !== index || !audio.current || audio.current.readyState < 3));
    pendingSeek.current = target.localSeconds;
    const nextPosition = mediaPosition(segments[target.index], target.localSeconds);
    positionRef.current = nextPosition;
    setPosition(nextPosition);
    persist(nextPosition);
    setError('');
    prefetch.current?.update(contiguousChunks(book, segments[target.index]?.chunk.id ?? ''), 0, target.localSeconds, Number(rate), continuePlaying, readyForAhead(segments[target.index]?.chunk));
    if (target.index === index && audio.current && audio.current.readyState >= 1) {
      audio.current.currentTime = target.localSeconds;
      if (continuePlaying) void audio.current.play().catch(() => { if (attempt !== playRequest.current) return; intent.current = false; setPlaying(false); setBuffering(false); setError('再生を開始できませんでした。「再生」をもう一度押してください。'); });
      else setPlaying(false);
    } else {
      setSelectedChunk(segments[target.index]?.chunk.id ?? '');
      setPlaying(false);
    }
  }, [index, persist, segments, rate, book, readyForAhead]);

  const moveSentence = useCallback((direction: -1 | 1, seconds = sample()) => {
    const target = sentenceEntries[audioSentenceIndexAt(sentenceEntries, seconds) + direction];
    if (target) seek(target.seconds);
  }, [sentenceEntries, sample, seek]);

  useLayoutEffect(() => {
    const owner = new AudioPrefetch(browserPrefetchEnvironment());
    prefetchBook.current = storageKey;
    prefetch.current = owner;
    return () => { owner.dispose(); if (prefetch.current === owner) prefetch.current = null; };
  }, [storageKey]);

  useEffect(() => { reconcilePrefetch(); }, [reconcilePrefetch, playing, storageKey]);

  useLayoutEffect(() => {
    const media = audio.current;
    // StrictMode repeats setup after cleanup while retaining the same DOM node.
    if (media && audioSource && media.getAttribute('src') !== audioSource) {
      media.src = audioSource; media.load();
    }
    return () => {
      // Removing src and loading also cancels the native media/Range request.
      media?.pause(); media?.removeAttribute('src'); media?.load();
    };
  }, [assetIdentity, audioSource]);

  // New books restore once. Same-book publications retain the native clock.
  useLayoutEffect(() => {
    const position = loadAudioPosition(book);
    const saved = position.status === 'saved' ? position.seconds : 0;
    let stored: PlaybackAnchor | undefined;
    try { stored = savedPlaybackAnchor(localStorage.getItem(`${storageKey}:source`)); } catch { /* Optional local position only. */ }
    activeBook.current = storageKey;
    intent.current = false; playRequest.current++;
    setWaitingFor(null);
    audio.current?.pause(); setPlaying(false); setBuffering(false);
    const target = stored && restoreAnchor(segments, stored) || locateAudioTime(segments, saved);
    const restored = segments[target.index];
    if (target.index !== index) mediaClock.current = null;
    pendingSeek.current = target.localSeconds;
    anchor.current = restored ? playbackAnchor(restored, target.localSeconds) : null;
    positionRef.current = mediaPosition(restored, target.localSeconds);
    if (target.index === index && audio.current && audio.current.readyState >= 1) audio.current.currentTime = target.localSeconds;
    setSelectedChunk(restored?.chunk.id ?? ''); setPosition(positionRef.current);
    return () => { intent.current = false; playRequest.current++; };
  }, [storageKey]);

  const advance = useCallback((currentId: string, continuePlaying: boolean) => {
    const next = continuation(book, currentId);
    if (next.kind === 'next') { seek(segments[next.index].startSeconds, continuePlaying); return; }
    const current = segments.find(value => value.chunk.id === currentId);
    if (current) {
      anchor.current = playbackAnchor(current, current.chunk.durationSeconds, true);
      positionRef.current = current.endSeconds; setPosition(current.endSeconds); persist(current.endSeconds);
    }
    setPlaying(false);
    const wait = next.kind === 'waiting' && continuePlaying && !generationStopped;
    intent.current = Boolean(wait); setBuffering(Boolean(wait)); setWaitingFor(wait ? currentId : null);
  }, [book, segments, seek, persist, generationStopped]);

  useLayoutEffect(() => {
    if (!anchor.current) return;
    const restored = restoreAnchor(segments, anchor.current);
    if (!restored) { pause(); setError('再生中の音声が更新結果に含まれていません。保存位置を保持して停止しました。'); return; }
    const current = segments[restored.index];
    if (!restored.assetChanged && !waitingFor && audio.current?.readyState && mediaClock.current?.segment.chunk.id === current.chunk.id) {
      restored.localSeconds = audio.current.currentTime;
    }
    setSelectedChunk(current.chunk.id);
    if (restored.assetChanged) {
      playRequest.current++;
      pendingSeek.current = restored.localSeconds;
      setPlaying(false); setBuffering(intent.current);
    }
    anchor.current = playbackAnchor(current, restored.localSeconds, anchor.current.ended);
    positionRef.current = mediaPosition(current, restored.localSeconds, anchor.current.ended);
    setPosition(positionRef.current);
    if (waitingFor && intent.current && !generationStopped) advance(waitingFor, true);
  }, [segments]);

  useEffect(() => {
    if (generationStopped && waitingFor) { intent.current = false; setWaitingFor(null); setPlaying(false); setBuffering(false); }
  }, [generationStopped, waitingFor]);


  useEffect(() => {
    if (audio.current) audio.current.playbackRate = Number(rate);
  }, [index, rate]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { sample(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, sample]);

  useEffect(() => {
    const hide = () => { if (document.hidden) pause(); };
    const leave = () => pause();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave); };
  }, [pause]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (sourceOpen || settingsOpen || font.busy || !segment || shortcutBlocked(event)) return;
      if (event.code.startsWith('Arrow') && !repeatedArrowAllowed(event, arrowAt)) { event.preventDefault(); return; }
      if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) { if (intent.current) pause(); else void play(); } }
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault(); const direction = event.code === 'ArrowLeft' ? -1 : 1; const seconds = sample();
        if (event.shiftKey) moveSentence(direction, seconds);
        else seek(seconds + direction * 5);
      }
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') { event.preventDefault(); setRate(value => String(Math.max(.5, Math.min(5, Number(value) + (event.code === 'ArrowUp' ? .25 : -.25))))); }
      if (event.code === 'Home' || event.code === 'End') { event.preventDefault(); seek(event.code === 'Home' ? 0 : total, false); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [index, pause, seek, moveSentence, sourceOpen, settingsOpen, font.busy, rate, segment, sample, total]);

  async function play() {
    if (!audio.current || !segment || font.busy) return;
    const attempt = ++playRequest.current;
    const media = audio.current;
    setError('');
    if (audio.current.ended || position >= segment.endSeconds) {
      if (continuation(book, segment.chunk.id).kind === 'end') seek(0, true);
      else advance(segment.chunk.id, true);
      return;
    }
    intent.current = true;
    setBuffering(media.readyState < 3);
    prefetch.current?.update(audioChunks, 0, media.currentTime, Number(rate), true, readyForAhead(audioChunks[0]));
    try { await media.play(); }
    catch { if (attempt !== playRequest.current || media !== audio.current) return; intent.current = false; setPlaying(false); setBuffering(false); setError('音声を再生できませんでした。音声ファイルと端末の再生設定を確認してください。'); }
  }

  if (!validation.valid || display.precision === 'unavailable') return <Alert color="red" role="alert" data-testid="audio-presentation-error">本文と音声の対応を確認できないため、再生できません。下から元の文章を確認できます。<Button variant="subtle" onClick={onClose}>{demo ? 'トップへ戻る' : '本棚へ戻る'}</Button><details><summary>保存された原文</summary>{Array.isArray(book.document?.blocks) && book.document.blocks.map(block => <p key={block.id}>{block.text}</p>)}</details></Alert>;
  if (!segment) return <Alert color="yellow">再生できる音声がありません。<Button variant="subtle" onClick={onClose}>{demo ? 'トップへ戻る' : '本棚へ戻る'}</Button></Alert>;

  return <div className="generation-shell audio-reader" style={font.style}>
    <header className="generation-header"><Brand /><div className="header-actions"><ThemeControl /><Button variant="subtle" onClick={() => { pause(); onClose(); }}>{demo ? 'トップへ戻る' : '本棚へ戻る'}</Button></div></header>
    <main>
      <NavigationLayout key={`${book.id}:${book.revision}`} entries={sentenceEntries} current={sentenceIndex} playing={reading} onPause={pause} onResume={() => void play()} onJump={target => seek(sentenceEntries[target].seconds, false)}
        heading={<div className="generation-title"><div><span className="eyebrow">音声付きの読書</span><h1>{book.title}</h1></div></div>}
        actions={<Button variant="subtle" onClick={() => { pause(); setBookOpen(true); }}>本の操作</Button>}>
      {book.completedChunks < book.totalChunks && <Alert color="yellow" mb="md">保存済み {book.completedChunks} / {book.totalChunks} 音声を再生します。次の音声が完成すると、本文の順に続きを再生できます。</Alert>}
      {generationStopped && <Alert color="yellow" mb="md" role="status">{generationStatus === 'failed' || generationStatus === 'outcome-unknown' ? '生成が完了していません。保存済み音声は再生できます。生成画面で状態を確認してください。' : '生成の停止が要求されています。保存済み音声は再生できます。続きは生成画面から再開してください。'}</Alert>}
      {error && <Alert color="red" role="alert" mb="md">{error}<Button variant="subtle" onClick={() => { pendingSeek.current = audio.current?.currentTime ?? 0; audio.current?.load(); setError(''); }}>保存音声を再読込</Button></Alert>}
      <ReaderDisplayToolbar settings={options} onChange={updateOptions} onSettings={() => { pause(); setSettingsOpen(true); }} />
      {(font.busy || font.error) && <p className="font-stage-status" role="status">{font.error || '書体と文字の配置を準備しています。停止したままお待ちください。'}</p>}
      <FullscreenReader fullscreen={fullscreen} playing={reading} pause={pause} disabled={font.busy} showProgress={options.fullscreenProgress ?? true} playLabel={position >= total && book.completedChunks >= book.totalChunks ? 'もう一度' : '再生'} toggle={() => void play()}
        context={(options.mode ?? 'flash') === 'flash' && <StoppedContext entries={sentenceEntries} blocks={book.document.blocks} current={sentenceIndex} playing={reading} enabled={options.context ?? true} ruby={ruby} onJump={target => seek(sentenceEntries[target].seconds, false)} />}
        seek={<label><span>音声の再生位置</span><input aria-label="音声の再生位置" type="range" min="0" max={total} step="0.01" value={Math.min(position, total)} onChange={event => seek(Number(event.target.value))} /></label>}
        modes={<ReadingModeControls mode={options.mode} onChange={mode => updateOptions({ mode })} />}
        speed={<label>音声の速さ<select aria-label="音声の速さ" value={rate} onChange={event => setRate(event.target.value)}>{Array.from({ length: 19 }, (_, i) => String(.5 + i * .25)).map(value => <option key={value} value={value}>{value}倍</option>)}</select></label>}>
      <section className={`audio-stage ${options.mode === 'guide' ? 'guide-mode' : ''} ${guide ? 'with-guide' : ''}`} aria-label="音声同期表示" data-testid="audio-stage" data-buffering={loading} style={{ '--reader-font-size': `${options.fontSize}px` } as CSSProperties}>
        <div className="stage-topline"><span role="status" className="audio-playback-status">{loading && <Loader size={16} aria-hidden="true" />}{waitingFor ? '次の音声の生成を待っています' : loading ? '音声を読み込み中…' : reading ? '音声再生中' : position >= total ? '再生終了' : '一時停止'}</span><span className="playback-position-label">{reading ? '\u00a0' : <>{sentenceIndex + 1} / {sentenceEntries.length} 文{display.unitIndices.length > 0 && <> · フレーズ {display.unitIndices[0] + 1}{display.unitIndices.length > 1 ? `–${display.unitIndices.at(-1)! + 1}` : ''}</>}</>}</span></div>
        {options.mode === 'guide' ? <GuideReader key={options.writingMode} writingMode={options.writingMode} blocks={book.document.blocks} units={playableUnits} currentIndices={displayGroup ? Array.from({ length: displayGroup.endIndex - displayGroup.startIndex + 1 }, (_, i) => displayGroup.startIndex + i) : [displayIndex]} playing={reading} ruby={ruby} family={READING_FONTS[font.applied].family} onJump={target => seek(unitTimes.get(playableUnits[target]?.id) ?? 0, false)} onPause={pause} /> : <PhraseDisplay writingMode={options.writingMode} unit={displayGroup?.unit ?? display.units[0]} sourceUnits={displayGroup?.units} activeUnit={display.units[0]} playing={reading} getProgress={() => display.cue && segment ? (positionRef.current - segment.startSeconds - display.cue.startSeconds) / (display.cue.endSeconds - display.cue.startSeconds) : 0} fontSize={options.fontSize} ruby={ruby} family={READING_FONTS[font.applied].family} audio precision={display.precision} timingMethod={display.method} timingScore={display.score} unitIds={displayGroup?.units.map(unit => unit.id).join(' ') ?? display.units.map(unit => unit.id).join(' ')} />}
      {fullscreen.active && <ReaderPlayButton playing={reading} disabled={font.busy} label={position >= total && book.completedChunks >= book.totalChunks ? 'もう一度' : '再生'}
        onPlay={() => { void play(); fullscreen.containerRef.current?.focus({ preventScroll: true }); }} />}
      <FullscreenEnterButton fullscreen={fullscreen} />
      </section>
      </FullscreenReader>
      <audio key={assetIdentity} ref={bindAudio} src={audioSource} preload="auto"
        onLoadedMetadata={event => {
          if (!audio.current || event.currentTarget !== audio.current) return;
          const attempt = playRequest.current;
          audio.current.currentTime = Math.min(pendingSeek.current, audio.current.duration || segment.chunk.durationSeconds);
          audio.current.playbackRate = Number(rate);
          sample();
          reconcilePrefetch(event.currentTarget);
          if (intent.current && !waitingFor) void audio.current.play().catch(() => { if (attempt !== playRequest.current) return; intent.current = false; setPlaying(false); setBuffering(false); setError('「再生」を押して音声を開始してください。'); });
        }}
        onPlay={event => { if (event.currentTarget !== audio.current) return; setPlaying(true); }}
        onPlaying={event => { if (event.currentTarget !== audio.current) return; setPlaying(true); setBuffering(false); }}
        onPause={event => {
          // A browser/OS interruption can pause without calling our controls.
          // A delayed pause from seek or natural completion must not cancel continuation.
          if (event.currentTarget !== audio.current || !event.currentTarget.paused || event.currentTarget.ended) return;
          intent.current = false; setWaitingFor(null); setPlaying(false); setBuffering(false); persist(sample());
          prefetch.current?.update(audioChunks, 0, 0, Number(rate), false, readyForAhead(audioChunks[0]));
        }}
        onWaiting={event => { if (event.currentTarget !== audio.current || !intent.current) return; sample(); setBuffering(true); }}
        onSeeking={event => { if (event.currentTarget === audio.current) sample(); }} onSeeked={event => { if (event.currentTarget !== audio.current) return; sample(); setBuffering(intent.current && event.currentTarget.readyState < 3); }}
        onLoadedData={event => reconcilePrefetch(event.currentTarget)} onProgress={event => reconcilePrefetch(event.currentTarget)} onCanPlayThrough={event => reconcilePrefetch(event.currentTarget)} onEmptied={event => reconcilePrefetch(event.currentTarget)}
        onTimeUpdate={event => { if (event.currentTarget !== audio.current) return; sample(); reconcilePrefetch(event.currentTarget); }}
        onEnded={event => { if (event.currentTarget !== audio.current) return; advance(segment.chunk.id, intent.current); }}
        onError={event => { if (event.currentTarget !== audio.current) return; pause(); setError('保存音声を開けませんでした。ローカルサーバーと保存データを確認してください。音声の再生成は行いません。'); }} />
      <ReaderTransport playing={reading} playLabel={position >= total && book.completedChunks >= book.totalChunks ? 'もう一度' : '再生'} disabled={font.busy}
        onToggle={() => { if (intent.current) pause(); else void play(); }}
        progress={<div className="audio-progress"><label htmlFor="audio-position">再生位置 <span className="audio-time-label">{reading ? '\u00a0' : `${audioTimeLabel(position)} / ${audioTimeLabel(total)}`}</span></label><input id="audio-position" aria-label="音声の再生位置" type="range" min="0" max={total} step="0.01" value={Math.min(position, total)} onChange={event => seek(Number(event.target.value))} /></div>}
        previous={<Button variant="light" aria-keyshortcuts="ArrowLeft" disabled={position <= 0} onClick={() => seek(sample() - 5)}>5秒戻す</Button>}
        next={<Button variant="light" aria-keyshortcuts="ArrowRight" disabled={position >= total} onClick={() => seek(sample() + 5)}>5秒進める</Button>}
        speed={<Select label="音声の速さ" value={rate} onChange={value => { if (value) setRate(value); }} data={Array.from({ length: 19 }, (_, i) => String(.5 + i * .25)).map(value => ({ value, label: `${value}倍` }))} allowDeselect={false} />}
        secondary={<><ReaderAudioNavigation
          hasPreviousSentence={sentenceIndex > 0} hasNextSentence={sentenceIndex < sentenceEntries.length - 1}
          previousSentence={() => moveSentence(-1)} nextSentence={() => moveSentence(1)} />
          <Button variant="subtle" onClick={() => { pause(); setSourceOpen(true); }}>原文</Button></>} />
      {!fullscreen.active && (options.mode ?? 'flash') === 'flash' && <StoppedContext entries={sentenceEntries} blocks={book.document.blocks} current={sentenceIndex} playing={reading} enabled={options.context ?? true} ruby={ruby} onJump={target => seek(sentenceEntries[target].seconds, false)} />}

      </NavigationLayout>
    </main>
    <Drawer className="reader-drawer" opened={settingsOpen} onClose={() => setSettingsOpen(false)} title="表示設定" position="right" size="md" closeButtonProps={{ 'aria-label': '閉じる' }}><ReaderDisplaySettings settings={options} onChange={updateOptions} font={font} /></Drawer>
    <Drawer className="reader-drawer reader-book-panel" opened={bookOpen} onClose={() => setBookOpen(false)} title="本の操作" position="right" size="lg" closeButtonProps={{ 'aria-label': '閉じる' }}><div className="settings-panel">
      {onRename && <section className="settings-section"><h2>タイトル</h2><TitleEditor title={book.title} onRename={onRename} /></section>}
      <section className="settings-section"><h2>読書位置</h2><div className="reader-book-actions"><Button variant="light" aria-keyshortcuts="Home" onClick={() => { seek(0, false); setBookOpen(false); }}>先頭へ戻る</Button><Button variant="subtle" aria-keyshortcuts="End" onClick={() => { seek(total, false); setBookOpen(false); }}>末尾へ</Button></div><p className="muted">続きの位置は自動で保存されます。</p></section>
      <section className="settings-section"><ShortcutHelp audio /></section>
      {localTools && <section className="settings-section"><h2>音声の調整</h2>{localTools}</section>}
      <section className="settings-section"><h2>作品情報</h2>{(book.attribution || attribution) && <p className="audio-attribution">{book.attribution || attribution}</p>}<AozoraInfo value={book.document.provenance} />
      </section>
      <section className="settings-section"><h2>ページURLを共有</h2><ShareLink title={book.title} /></section>
    </div></Drawer>
    <Drawer className="reader-drawer" opened={sourceOpen} onClose={() => setSourceOpen(false)} title="原文と音声の位置" position="right" size="lg" closeButtonProps={{ 'aria-label': '閉じる' }}>
      <p className="muted">文やフレーズを選ぶと、その位置へ移動します。</p>
      {display.units.some(unit => unit.mapping !== 'exact') && <p className="muted">元位置は本文変換のため近似を含みます。原文で確認してください。</p>}
      {sourceOpen && <div className="audio-source">{book.document.blocks.map(block => {
        const mark = display.cue?.blockId === block.id ? display.cue : segment.chunk.timeline.find(mark => mark.blockId === block.id);
        return <section key={block.id}><AudioSourceText block={block} start={mark?.start} end={mark?.end} /><div>{segmentsByBlock.get(block.id)?.map(({ segment: value, index: i }) => <div key={value.chunk.id}><button type="button" aria-current={i === index && display.precision === 'unavailable' ? 'true' : undefined} onClick={() => { seek(value.startSeconds, false); setSourceOpen(false); }}>{value.text}</button>{value.displayCues.map(cue => <button type="button" className="audio-source-phrase" aria-current={i === index && cue === display.cue ? 'true' : undefined} key={cue.unitId} onClick={() => { seek(value.startSeconds + cue.startSeconds, false); setSourceOpen(false); }}>{cue.units.map(unit => <AudioRubyText key={unit.id} text={unit.text} ruby={unit.ruby} />)}</button>)}</div>)}</div></section>;
      })}</div>}
    </Drawer>
  </div>;
}

function AudioRubyText({ text, ruby }: { text: string; ruby: RubySpan[] }) {
  let cursor = 0;
  const pieces: ReactNode[] = [];
  for (const span of ruby) {
    if (span.start > cursor) pieces.push(text.slice(cursor, span.start));
    pieces.push(<ruby key={`${span.start}:${span.end}`}>{text.slice(span.start, span.end)}<rt>{span.reading}</rt></ruby>);
    cursor = span.end;
  }
  pieces.push(text.slice(cursor));
  return <>{pieces}</>;
}

function AudioSourceText({ block, start, end }: { block: TextBlock; start?: number; end?: number }) {
  if (start === undefined || end === undefined) return <p>{block.text}</p>;
  return <p>{block.text.slice(0, start)}<mark>{block.text.slice(start, end)}</mark>{block.text.slice(end)}</p>;
}
