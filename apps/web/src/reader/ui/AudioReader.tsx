import { Brand } from '../../ui/Brand';
import { Alert, Badge, Button, Drawer, Select, Switch } from '@mantine/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adjacentAudioPhrase, audioDisplayAt, audioPhraseTargets, audioSegments, audioTimeLabel, locateAudioTime, mediaPosition } from '../audio-clock';
import { type ReaderSettings, type RubySpan, type TextBlock } from '../model';
import { inspectAudioPresentation, requireAudioPresentation } from '../audio-presentation';
import { audioAlignmentWarning, audioFallbackMessage } from '../audio-labels';
import { ShareLink } from '../../sharing/ShareLink';
import '../../generation-ui/generation.css';
import { NavigationLayout } from './NavigationLayout';
import { AozoraInfo } from './AozoraInfo';
import { PhraseDisplay } from './PhraseDisplay';
import { WritingModeSelect } from './WritingModeSelect';
import { FontSelect, GroupSettings, ShortcutHelp, useReadingFont } from './ReadingOptions';
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
import { resetDisplaySettings } from '../preferences';
import { AudioPrefetch, audioAssetKey, browserPrefetchEnvironment } from '../audio-prefetch';
import { continuation, contiguousChunks, playbackAnchor, restoreAnchor, type PlaybackAnchor, type ProgressiveBook } from '../audio-progressive';
import type { JobStatus } from '../../generation/contracts';

export function AudioReader({ book, onClose, attribution, localTools, demo = false, onRename, generationStatus, onPlaybackPosition }: { book: ProgressiveBook; generationStatus?: JobStatus; onPlaybackPosition?: (chunkId: string) => void; onClose: () => void; attribution?: string; localTools?: ReactNode; demo?: boolean; onRename?: (title: string) => Promise<void> }) {
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
  const storageKey = `rsvp-audio-position:${book.id}:${book.revision}`;
  const assetIdentity = segment ? `${storageKey}:${audioAssetKey(segment.chunk)}` : storageKey;
  // Snapshot a ready URL only when changing files. Completing a speculative
  // fetch must never replace or restart the audio that is currently playing.
  const audioSource = useMemo(() => segment ? (prefetchBook.current === storageKey ? prefetch.current?.source(segment.chunk) : undefined) ?? segment.chunk.audioUrl : '', [assetIdentity]);
  const display = audioDisplayAt(segment, position - (segment?.startSeconds ?? 0));
  const reading = playing || intent.current;
  const playableUnits = useMemo(() => phraseTargets.flatMap(target => target.cue.units), [phraseTargets]);
  const unitPositions = useMemo(() => new Map(playableUnits.map((unit, index) => [unit.id, index])), [playableUnits]);
  const unitTimes = useMemo(() => new Map(phraseTargets.flatMap(target => target.cue.units.map(unit => [unit.id, target.seconds] as const))), [phraseTargets]);
  const groups = useMemo(() => groupReadingUnits(playableUnits, { target: options.groupTarget ?? 0, minimum: options.groupMinimum ?? 0 }, new Set(segments.flatMap(value => { const first = value.displayCues[0]?.units[0]; return first ? [unitPositions.get(first.id)!] : []; }))), [playableUnits, options.groupTarget, options.groupMinimum, segments, unitPositions]);
  const displayIndex = unitPositions.get(display.units[0]?.id) ?? 0;
  const groupIndex = groupIndexAt(groups, displayIndex);
  const displayGroup = groups[groupIndex];
  const alignmentWarnings = useMemo(() => [...new Set(segments.flatMap(value => value.chunk.alignment?.warnings ?? []).map(audioAlignmentWarning))], [segments]);
  const previousPhrase = adjacentAudioPhrase(phraseTargets, position, -1);
  const nextPhrase = adjacentAudioPhrase(phraseTargets, position, 1);
  const sentenceEntries = useMemo(() => segments.map((segment, index) => ({ id: segment.chunk.id, text: segment.text, target: index,
    blockId: segment.chunk.timeline[0]?.blockId ?? '', start: segment.chunk.timeline[0]?.start ?? 0, end: segment.chunk.timeline[0]?.end ?? 0 })), [segments]);

  const persist = useCallback((seconds: number) => {
    try { localStorage.setItem(storageKey, String(seconds)); } catch { /* Playback remains usable without browser storage. */ }
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

  const pause = useCallback(() => {
    playRequest.current++;
    intent.current = false;
    setWaitingFor(null);
    audio.current?.pause();
    setPlaying(false);
    setBuffering(false);
    persist(sample());
    prefetch.current?.update(audioChunks, 0, 0, Number(rate), false);
  }, [persist, sample, audioChunks, rate]);

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
    pendingSeek.current = target.localSeconds;
    const nextPosition = mediaPosition(segments[target.index], target.localSeconds);
    positionRef.current = nextPosition;
    setPosition(nextPosition);
    persist(nextPosition);
    setError('');
    prefetch.current?.update(contiguousChunks(book, segments[target.index]?.chunk.id ?? ''), 0, target.localSeconds, Number(rate), continuePlaying);
    if (target.index === index && audio.current && audio.current.readyState >= 1) {
      audio.current.currentTime = target.localSeconds;
      if (continuePlaying) void audio.current.play().catch(() => { if (attempt !== playRequest.current) return; intent.current = false; setPlaying(false); setError('再生を開始できませんでした。「再生」をもう一度押してください。'); });
      else setPlaying(false);
    } else {
      setSelectedChunk(segments[target.index]?.chunk.id ?? '');
      setPlaying(false);
      setBuffering(continuePlaying);
    }
  }, [index, persist, segments, rate, book]);

  useLayoutEffect(() => {
    const owner = new AudioPrefetch(browserPrefetchEnvironment());
    prefetchBook.current = storageKey;
    prefetch.current = owner;
    return () => { owner.dispose(); if (prefetch.current === owner) prefetch.current = null; };
  }, [storageKey]);

  useEffect(() => {
    const localSeconds = audio.current && audio.current.readyState >= 1 ? audio.current.currentTime : pendingSeek.current;
    prefetch.current?.update(audioChunks, 0, localSeconds, Number(rate), intent.current);
  }, [segments, index, rate, playing, storageKey]);

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
    let saved = 0;
    try { saved = Number(localStorage.getItem(storageKey) ?? 0); } catch { /* Optional local position only. */ }
    activeBook.current = storageKey;
    intent.current = false; playRequest.current++;
    setWaitingFor(null);
    audio.current?.pause(); setPlaying(false); setBuffering(false);
    const target = locateAudioTime(segments, saved);
    const restored = segments[target.index];
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
    if (wait) onPlaybackPosition?.(currentId);
  }, [book, segments, seek, persist, generationStopped, onPlaybackPosition]);

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
    if (waitingFor && intent.current) advance(waitingFor, true);
  }, [segments]);

  useEffect(() => {
    if (generationStopped && waitingFor) { intent.current = false; setWaitingFor(null); setPlaying(false); setBuffering(false); }
  }, [generationStopped, waitingFor]);

  useEffect(() => { if (segment) onPlaybackPosition?.(segment.chunk.id); }, [segment, generationStatus, onPlaybackPosition]);

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
        if (event.shiftKey) { const active = locateAudioTime(segments, seconds).index; seek(segments[Math.max(0, Math.min(segments.length - 1, active + direction))]?.startSeconds ?? 0); }
        else seek(seconds + direction * 5);
      }
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') { event.preventDefault(); setRate(value => String(Math.max(.5, Math.min(5, Number(value) + (event.code === 'ArrowUp' ? .25 : -.25))))); }
      if (event.code === 'Home' || event.code === 'End') { event.preventDefault(); seek(event.code === 'Home' ? 0 : total, false); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [index, pause, seek, segments, sourceOpen, settingsOpen, font.busy, rate, segment, sample, total]);

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
    prefetch.current?.update(audioChunks, 0, media.currentTime, Number(rate), true);
    try { await media.play(); }
    catch { if (attempt !== playRequest.current || media !== audio.current) return; intent.current = false; setPlaying(false); setBuffering(false); setError('音声を再生できませんでした。音声ファイルと端末の再生設定を確認してください。'); }
  }

  if (!validation.valid || display.precision === 'unavailable') return <Alert color="red" role="alert" data-testid="audio-presentation-error">原稿の区切りの被覆・順序を検査できないため、再生を開始できません。保存音声の再生成は不要です。原稿の区切り情報を修復してから開いてください。<Button variant="subtle" onClick={onClose}>{demo ? 'トップへ戻る' : '本棚へ戻る'}</Button><details><summary>保存された原文</summary>{Array.isArray(book.document?.blocks) && book.document.blocks.map(block => <p key={block.id}>{block.text}</p>)}</details></Alert>;
  if (!segment) return <Alert color="yellow">再生できる音声がありません。<Button variant="subtle" onClick={onClose}>{demo ? 'トップへ戻る' : '本棚へ戻る'}</Button></Alert>;

  return <div className={`generation-shell audio-reader ${options.contrast === 'night' ? 'night' : ''}`} style={font.style}>
    <header className="generation-header"><Brand /><Button variant="subtle" onClick={() => { pause(); onClose(); }}>{demo ? 'トップへ戻る' : '本棚へ戻る'}</Button></header>
    <main>
      <NavigationLayout key={`${book.id}:${book.revision}`} entries={sentenceEntries} current={index} playing={reading} onPause={pause} onResume={() => void play()} onJump={target => seek(segments[target].startSeconds, false)}>
      <div className="generation-title"><div><span className="eyebrow">{demo ? '音声付きデモ' : 'SAVED AUDIO'}</span><h1>{book.title}</h1></div><Badge color="ripola" variant="light">表示：{options.groupTarget || options.groupMinimum ? 'まとめ表示' : '1区切り'}</Badge></div>
      <p className="muted">{phraseTargets.length ? '文章の区切りを一つずつ表示します。推定部分は利用できる音声情報と前後の時刻、文字数から補います。' : '保存データに区切り情報がありません。原文を確認してください。'}</p>
      {book.completedChunks < book.totalChunks && <Alert color="yellow" mb="md">保存済み {book.completedChunks} / {book.totalChunks} 文を再生します。次の音声が完成すると、本文の順に続きを再生できます。</Alert>}
      {generationStopped && <Alert color="yellow" mb="md" role="status">{generationStatus === 'failed' || generationStatus === 'outcome-unknown' ? '生成が完了していません。保存済み音声は再生できます。生成画面で状態を確認してください。' : '生成の停止が要求されています。保存済み音声は再生できます。続きは生成画面から再開してください。'}</Alert>}
      {error && <Alert color="red" role="alert" mb="md">{error}<Button variant="subtle" onClick={() => { pendingSeek.current = audio.current?.currentTime ?? 0; audio.current?.load(); setError(''); }}>保存音声を再読込</Button></Alert>}
      <ReadingModeControls mode={options.mode} onChange={mode => updateOptions({ mode })} />
      {(font.busy || font.error) && <p className="font-stage-status" role="status">{font.error || '書体と文字の配置を準備しています。停止したままお待ちください。'}</p>}
      <FullscreenReader fullscreen={fullscreen} playing={reading} pause={pause} disabled={font.busy} playLabel={position >= total && book.completedChunks >= book.totalChunks ? 'もう一度' : '再生'} toggle={() => void play()}
        seek={<label><span>音声の再生位置</span><input aria-label="音声の再生位置" type="range" min="0" max={total} step="0.01" value={Math.min(position, total)} onChange={event => seek(Number(event.target.value))} /></label>}
        modes={<ReadingModeControls mode={options.mode} onChange={mode => updateOptions({ mode })} />}
        speed={<label>音声の速さ<select aria-label="音声の速さ" value={rate} onChange={event => setRate(event.target.value)}>{Array.from({ length: 19 }, (_, i) => String(.5 + i * .25)).map(value => <option key={value} value={value}>{value}倍</option>)}</select></label>}>
      <section className={`audio-stage ${options.mode === 'guide' ? 'guide-mode' : ''} ${guide ? 'with-guide' : ''}`} aria-label="音声同期表示" data-testid="audio-stage">
        <div className="stage-topline"><span role="status">{waitingFor ? '次の音声の生成を待っています' : reading ? '音声再生中' : buffering ? '音声を準備中' : position >= total ? '再生終了' : '一時停止'}</span><span className="playback-position-label">{reading ? '\u00a0' : <>{index + 1} / {segments.length} 文{display.unitIndices.length > 0 && <> · フレーズ {display.unitIndices[0] + 1}{display.unitIndices.length > 1 ? `–${display.unitIndices.at(-1)! + 1}` : ''}</>}</>}</span></div>
        {options.mode === 'guide' ? <GuideReader key={options.writingMode} writingMode={options.writingMode} blocks={book.document.blocks} units={playableUnits} currentIndices={displayGroup ? Array.from({ length: displayGroup.endIndex - displayGroup.startIndex + 1 }, (_, i) => displayGroup.startIndex + i) : [displayIndex]} playing={reading} ruby={ruby} family={READING_FONTS[font.applied].family} onJump={target => seek(unitTimes.get(playableUnits[target]?.id) ?? 0, false)} onPause={pause} /> : <PhraseDisplay writingMode={options.writingMode} unit={displayGroup?.unit ?? display.units[0]} fontSize={options.fontSize} ruby={ruby} family={READING_FONTS[font.applied].family} audio precision={display.precision} unitIds={displayGroup?.units.map(unit => unit.id).join(' ') ?? display.units.map(unit => unit.id).join(' ')} />}
      <ReaderPlayButton playing={reading} disabled={font.busy} label={position >= total && book.completedChunks >= book.totalChunks ? 'もう一度' : '再生'}
        onPlay={() => { void play(); fullscreen.containerRef.current?.focus({ preventScroll: true }); }} />
      <FullscreenEnterButton fullscreen={fullscreen} />
      </section>
      {(options.mode ?? 'flash') === 'flash' && <StoppedContext groups={groups} groupIndex={groupIndex} playing={reading} enabled={options.context ?? true} ruby={ruby} onJump={target => seek(unitTimes.get(playableUnits[target]?.id) ?? 0, false)} />}
      </FullscreenReader>
      <p className="audio-alignment-status" data-testid="audio-precision" data-precision={display.precision} data-method={display.method} data-score={display.score}>{reading ? <>時刻：推定を含む音声同期<span>発話境界の精度を保証するものではありません。区切りごとの詳細は、一時停止すると確認できます。</span></> : <>時刻：{display.method === 'acoustic-estimated' ? '音声補助推定' : display.method === 'estimated' ? '表示用推定（時刻未検証）' : display.method === 'voicevox-mora' ? '音素時計（推定）' : display.precision === 'phrase' ? '整列結果（推定）' : '検査不能'}{display.score !== undefined ? ` · スコア${display.score.toFixed(3)}（時刻精度の確率ではありません）` : ''}<span>{display.method === 'acoustic-estimated' ? '音声の活動区間と整列の手掛かりを使う推定です。文節の発話境界を確定した時刻ではありません。' : display.method === 'estimated' ? '前後の時刻と文字数による表示用の推定です。発話境界を確定した時刻ではありません。' : display.method === 'voicevox-mora' ? display.querySource === 'captured' ? 'VOICEVOXの音素時刻（合成時に保存）を使用しています。' : 'VOICEVOXの音素時刻（再構成による推定）。元queryとの同一性は未確認です。' : display.precision === 'phrase' ? '整列時刻を使用しています。' : audioFallbackMessage(display.reason)}</span></>}</p>
      <audio key={assetIdentity} ref={bindAudio} src={audioSource} preload="auto"
        onLoadedMetadata={event => {
          if (!audio.current || event.currentTarget !== audio.current) return;
          const attempt = playRequest.current;
          audio.current.currentTime = Math.min(pendingSeek.current, audio.current.duration || segment.chunk.durationSeconds);
          audio.current.playbackRate = Number(rate);
          sample();
          if (intent.current && !waitingFor) void audio.current.play().catch(() => { if (attempt !== playRequest.current) return; intent.current = false; setPlaying(false); setBuffering(false); setError('「再生」を押して音声を開始してください。'); });
        }}
        onPlay={event => { if (event.currentTarget !== audio.current) return; setPlaying(true); setBuffering(false); }}
        onPlaying={event => { if (event.currentTarget !== audio.current) return; setPlaying(true); setBuffering(false); }}
        onPause={event => {
          // A browser/OS interruption can pause without calling our controls.
          // A delayed pause from seek or natural completion must not cancel continuation.
          if (event.currentTarget !== audio.current || !event.currentTarget.paused || event.currentTarget.ended) return;
          intent.current = false; setWaitingFor(null); setPlaying(false); setBuffering(false); persist(sample());
          prefetch.current?.update(audioChunks, 0, 0, Number(rate), false);
        }}
        onWaiting={event => { if (event.currentTarget !== audio.current) return; sample(); setBuffering(true); }}
        onSeeking={event => { if (event.currentTarget === audio.current) sample(); }} onSeeked={event => { if (event.currentTarget !== audio.current) return; sample(); setBuffering(false); }}
        onTimeUpdate={event => { if (event.currentTarget !== audio.current) return; sample(); prefetch.current?.update(audioChunks, 0, event.currentTarget.currentTime, Number(rate), intent.current); }}
        onEnded={event => { if (event.currentTarget !== audio.current) return; advance(segment.chunk.id, intent.current); }}
        onError={event => { if (event.currentTarget !== audio.current) return; intent.current = false; setPlaying(false); setBuffering(false); setError('保存音声を開けませんでした。ローカルサーバーと保存データを確認してください。音声の再生成は行いません。'); }} />
      <div className="audio-progress"><label htmlFor="audio-position">音声の再生位置 <span className="audio-time-label">{reading ? '\u00a0' : `${audioTimeLabel(position)} / ${audioTimeLabel(total)}`}</span></label><input id="audio-position" aria-label="音声の再生位置" type="range" min="0" max={total} step="0.01" value={Math.min(position, total)} onChange={event => seek(Number(event.target.value))} /></div>
      <div className="audio-controls"><Button variant="light" onClick={() => seek(segments[Math.max(0, index - 1)].startSeconds)} disabled={index === 0}>前の文</Button><Button size="lg" disabled={font.busy} aria-keyshortcuts="Space" onClick={() => { if (intent.current) pause(); else void play(); }}>{playing || buffering && intent.current ? '一時停止' : position >= total && book.completedChunks >= book.totalChunks ? 'もう一度' : '再生'}</Button><Button variant="light" onClick={() => seek(segments[Math.min(segments.length - 1, index + 1)].startSeconds)} disabled={index === segments.length - 1}>次の文</Button></div>
      <div className="audio-seek-controls"><Button variant="light" aria-keyshortcuts="ArrowLeft" onClick={() => seek(sample() - 5)}>5秒戻す</Button><Button variant="light" aria-keyshortcuts="ArrowRight" onClick={() => seek(sample() + 5)}>5秒進める</Button><Button variant="subtle" aria-keyshortcuts="End" onClick={() => seek(total, false)}>末尾へ</Button></div>
      {phraseTargets.length > 0 && <div className="audio-phrase-controls"><Button variant="light" onClick={() => { if (previousPhrase) seek(previousPhrase.seconds); }} disabled={!previousPhrase}>前のフレーズ</Button><Button variant="light" onClick={() => { if (nextPhrase) seek(nextPhrase.seconds); }} disabled={!nextPhrase}>次のフレーズ</Button></div>}
      <div className="audio-options"><Select label="音声の速さ" value={rate} onChange={value => { if (value) setRate(value); }} data={['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2', '2.25', '2.5', '2.75', '3', '3.25', '3.5', '3.75', '4', '4.25', '4.5', '4.75', '5'].map(value => ({ value, label: `${value}倍` }))} allowDeselect={false} /><Switch label="注視点ガイド" checked={guide} onChange={event => updateOptions({ guide: event.currentTarget.checked })} /><Switch label="ルビを表示" checked={ruby} onChange={event => updateOptions({ ruby: event.currentTarget.checked })} /><Button variant="subtle" onClick={() => { pause(); setSourceOpen(true); }}>原文</Button><Button variant="subtle" onClick={() => { pause(); setSettingsOpen(true); }}>表示設定</Button><Button variant="subtle" aria-keyshortcuts="Home" onClick={() => { pause(); seek(0, false); }}>先頭へ戻る</Button></div>
      <p className="keyboard-hint">Space 再生／一時停止 · ← → 原音声±5秒 · Shift＋← → 文 · ↑ ↓ 0.25倍 · Home / End</p><ShortcutHelp audio />
      <p className="muted">停止位置はこのブラウザに保存します。画面を離れた時は停止し、自動再生せずに続きから開きます。</p>
      <details data-testid="audio-presentation-report"><summary>区切り表示の検査</summary><p>表示 {validation.report.displayedUnits} / {validation.report.expectedUnits} 区切り · 欠落 {validation.report.missingUnitIds.length} · 重複 {validation.report.duplicateUnitIds.length}。整列時刻 {validation.report.forcedAlignmentUnits}、音素時計 {validation.report.voicevoxUnits}、音声補助推定 {validation.report.acousticEstimatedUnits ?? 0}、文字数推定 {validation.report.estimatedUnits - (validation.report.acousticEstimatedUnits ?? 0)}。この検査は発話境界の実測精度を保証しません。</p></details>
      {book.warnings.length > 0 && <details><summary>音声の確認事項</summary><ul>{book.warnings.map((warning, i) => <li key={i}>{/文単位|フレーズ時刻/.test(warning) ? '保存された音声時刻と表示単位は別です。時刻がない区切りは表示用推定を使います。' : warning}</li>)}</ul></details>}
      {alignmentWarnings.length > 0 && <details><summary>音声の整列確認事項</summary><ul>{alignmentWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      {localTools}
      {(book.attribution || attribution) && <p className="audio-attribution">{book.attribution || attribution}</p>}
      <AozoraInfo value={book.document.provenance} />
      <div className="audio-sharing"><ShareLink title={book.title} /></div>
      </NavigationLayout>
    </main>
    <Drawer className={`reader-drawer ${options.contrast === 'night' ? 'night' : ''}`} opened={settingsOpen} onClose={() => setSettingsOpen(false)} title="表示設定" position="right" size="md" closeButtonProps={{ 'aria-label': '閉じる' }}><div className="settings-panel">{onRename && <TitleEditor title={book.title} onRename={onRename} />}<FontSelect value={options.fontFamily ?? 'system'} onChange={fontFamily => updateOptions({ fontFamily })} phase={font.phase} error={font.error} /><WritingModeSelect value={options.writingMode} onChange={writingMode => updateOptions({ writingMode })} /><GroupSettings settings={options} onChange={updateOptions} /><Switch label="停止時に前後の文脈を表示" checked={options.context ?? true} onChange={event => updateOptions({ context: event.currentTarget.checked })} /><label className="font-size-setting">文字サイズ <strong>{options.fontSize} px</strong><input aria-label="文字サイズ" type="range" min="24" max="96" step="2" value={options.fontSize} onChange={event => updateOptions({ fontSize: Number(event.target.value) })} /></label><Switch label="暗い背景" checked={options.contrast === 'night'} onChange={event => updateOptions({ contrast: event.currentTarget.checked ? 'night' : 'paper' })} /><Button variant="light" onClick={() => updateOptions(resetDisplaySettings(options))}>表示設定をリセット</Button><p className="muted">速度と表示設定はこのブラウザに自動保存します。リセットしても速度と読書位置は残ります。</p><p className="muted">音声の休止は保存された音声に従います。追加の句読点待ち時間は加えません。</p></div></Drawer>
    <Drawer className={`reader-drawer ${options.contrast === 'night' ? 'night' : ''}`} opened={sourceOpen} onClose={() => setSourceOpen(false)} title="原文と音声の位置" position="right" size="lg" closeButtonProps={{ 'aria-label': '閉じる' }}>
      <p className="muted">文やフレーズを選ぶと移動して停止します。時刻未検証のフレーズには表示用の推定位置を使います。</p>
      {display.units.some(unit => unit.mapping !== 'exact') && <p className="muted">元位置は本文変換のため近似を含みます。原文で確認してください。</p>}
      {sourceOpen && <div className="audio-source">{book.document.blocks.map(block => {
        const mark = display.cue?.blockId === block.id ? display.cue : segment.chunk.timeline.find(mark => mark.blockId === block.id);
        return <section key={block.id}><AudioSourceText block={block} start={mark?.start} end={mark?.end} /><div>{segmentsByBlock.get(block.id)?.map(({ segment: value, index: i }) => <div key={value.chunk.id}><button type="button" aria-current={i === index && display.precision === 'unavailable' ? 'true' : undefined} onClick={() => { seek(value.startSeconds, false); setSourceOpen(false); }}>{value.text}</button>{value.displayCues.map(cue => <button type="button" className="audio-source-phrase" aria-current={i === index && cue === display.cue ? 'true' : undefined} key={cue.unitId} onClick={() => { seek(value.startSeconds + cue.startSeconds, false); setSourceOpen(false); }}>{cue.timingMethod === 'estimated' && <small>時刻未検証 · </small>}{cue.units.map(unit => <AudioRubyText key={unit.id} text={unit.text} ruby={unit.ruby} />)}</button>)}</div>)}</div></section>;
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
