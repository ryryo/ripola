import { NativeSelect } from '@mantine/core';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReaderSettings, TextBlock } from '../model';
import { isReadingFont, loadReadingFont, READING_FONTS, type ReadingFontId } from '../reading-fonts';

export function useReadingFont(blocks: TextBlock[] | undefined, requested: ReadingFontId, pause: () => void) {
  const [applied, setApplied] = useState<ReadingFontId>('system');
  const [phase, setPhase] = useState<'ready' | 'loading' | 'measuring' | 'error'>('ready');
  const [error, setError] = useState('');
  const pauseRef = useRef(pause); pauseRef.current = pause;
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    if (!blocks) return;
    pauseRef.current();
    setError('');
    if (requested === 'system') { setApplied('system'); setPhase('measuring'); return; }
    setPhase('loading');
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 25_000); });
    const text = blocks.map(block => block.text + block.ruby.map(span => span.reading).join('')).join('');
    void Promise.race([loadReadingFont(requested, text), timeout]).then(() => {
      if (version !== generation.current) return;
      setApplied(requested); setPhase('measuring');
    }).catch(() => {
      if (version !== generation.current) return;
      setApplied('system'); setPhase('error'); setError('書体を読み込めませんでした。端末標準で表示しています。通信を確認し、書体を選び直してください。');
    }).finally(() => clearTimeout(timer));
    return () => { generation.current++; clearTimeout(timer); };
  }, [blocks, requested]);
  useLayoutEffect(() => {
    if (phase !== 'measuring') return;
    // Child layout effects measure the committed family; readiness follows the next layout.
    const frame = requestAnimationFrame(() => setPhase('ready'));
    return () => cancelAnimationFrame(frame);
  }, [phase, applied]);
  return { applied, phase, error, busy: phase === 'loading' || phase === 'measuring', style: { '--reading-font': READING_FONTS[applied].family } as CSSProperties };
}

export function FontSelect({ value, onChange, phase, error }: { value: ReadingFontId; onChange: (id: ReadingFontId) => void; phase: string; error: string }) {
  return <div className="reading-font-setting"><label>本文の書体<NativeSelect aria-label="本文の書体" value={value} onChange={event => { if (isReadingFont(event.target.value)) onChange(event.target.value); }}>{Object.entries(READING_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}</NativeSelect></label><p role="status" className="font-status" data-state={phase}>{phase === 'loading' ? '書体を読み込んでいます…' : phase === 'measuring' ? '文字の配置を確認しています…' : error || ''}</p><a href={`${import.meta.env.BASE_URL}fonts/NOTICE.md`} target="_blank" rel="noreferrer">書体とライセンス</a></div>;
}

export function DisplayAmount({ settings, onChange, label = '一度に表示する量', compact = false }: { settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void; label?: string; compact?: boolean }) {
  const display = settings.focusedDisplay;
  const value = display?.kind === 'multiline' ? display.maxLines : 1;
  const amount = settings.mode === 'guide' ? '全文' : value === 1 ? '1文' : `${value}${settings.writingMode === 'vertical-rl' ? '列' : '行'}`;
  return <label className="reader-setting-slider display-amount"><span>{label}<strong>{amount}</strong></span>
    <input aria-label={label} aria-valuetext={amount} type="range" min="1" max="10" step="1" value={value} disabled={settings.mode === 'guide'} onChange={event => onChange({ focusedDisplay: Number(event.target.value) === 1 ? { kind: 'phrase' } : { kind: 'multiline', maxLines: Number(event.target.value) } })} />
    {!compact && <span className="input-note">縦書きでは列数です。指定行数を優先し、文字サイズを画面に合わせて自動調整します。</span>}
  </label>;
}

export function FontSize({ settings, onChange, label = '文字サイズ' }: { settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void; label?: string }) {
  const full = settings.mode === 'guide';
  const value = full ? settings.documentFontSize ?? 20 : settings.fontSize;
  const maximum = !full && settings.focusedDisplay?.kind === 'multiline';
  return <label className="reader-setting-slider font-size-setting"><span>{label}<strong>{maximum ? '上限 ' : ''}{value} px</strong></span><input aria-label={label} aria-valuetext={`${maximum ? '上限 ' : ''}${value}ピクセル`} type="range" min={full ? 14 : 24} max={full ? 48 : 96} step="2" value={value} onChange={event => onChange(full ? { documentFontSize: Number(event.target.value) } : { fontSize: Number(event.target.value) })} /></label>;
}

export function ShortcutHelp({ audio = false }: { audio?: boolean }) {
  return <details className="shortcut-help"><summary>キーボード操作</summary><dl><dt>Space</dt><dd>再生・一時停止</dd><dt>← / →</dt><dd>{audio ? '原音声を5秒戻す・進める（再生状態を維持）' : '前・次の元フレーズへ移動して停止'}</dd><dt>Shift + ← / →</dt><dd>前・次の文へ移動{audio ? '（再生状態を維持）' : 'して停止'}</dd><dt>↑ / ↓</dt><dd>{audio ? '再生率を0.25倍ずつ変更（0.5〜5倍）' : '100字/分ずつ変更（100〜3000）'}</dd><dt>Home / End</dt><dd>先頭・末尾へ移動して停止</dd></dl></details>;
}
