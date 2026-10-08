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
  return <div className="reading-font-setting"><label>本文の書体<select aria-label="本文の書体" value={value} onChange={event => { if (isReadingFont(event.target.value)) onChange(event.target.value); }}>{Object.entries(READING_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}</select></label><p className="input-note">選んだ書体だけをこのサイトから取得します。本文・ルビを準備した後も停止したままです。</p><p role="status" className="font-status">{phase === 'loading' ? '書体を読み込んでいます…' : phase === 'measuring' ? '文字の配置を確認しています…' : error || '書体の準備完了'}</p><a href={`${import.meta.env.BASE_URL}fonts/NOTICE.md`} target="_blank" rel="noreferrer">書体とライセンス</a></div>;
}

export function GroupSettings({ settings, onChange }: { settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void }) {
  return <div className="group-settings"><label>まとめる<select aria-label="まとめる" value={settings.groupTarget ?? 0} onChange={event => onChange({ groupTarget: Number(event.target.value) })}><option value="0">1区切りずつ</option>{[6, 8, 12, 16, 24].map(value => <option key={value} value={value}>約{value}字ずつ</option>)}</select></label><label>最小字数<select aria-label="最小字数" value={settings.groupMinimum ?? 0} onChange={event => onChange({ groupMinimum: Number(event.target.value) })}><option value="0">指定なし</option>{[2, 3, 4, 6, 8, 12].map(value => <option key={value} value={value}>{value}字以上</option>)}</select></label><p className="input-note">元の区切りを保ってまとめます。文末・段落・見出し・コード・表を越えず、短い文末は最小字数より短くなる場合があります。</p></div>;
}

export function ShortcutHelp({ audio = false }: { audio?: boolean }) {
  return <details className="shortcut-help"><summary>キーボード操作</summary><dl><dt>Space</dt><dd>再生・一時停止</dd><dt>← / →</dt><dd>{audio ? '原音声を5秒戻す・進める（再生状態を維持）' : '前・次の元フレーズへ移動して停止'}</dd><dt>Shift + ← / →</dt><dd>前・次の文へ移動{audio ? '（再生状態を維持）' : 'して停止'}</dd><dt>↑ / ↓</dt><dd>{audio ? '再生率を0.25倍ずつ変更（0.5〜3倍）' : '100字/分ずつ変更（100〜3000）'}</dd><dt>Home / End</dt><dd>先頭・末尾へ移動して停止</dd></dl><p className="input-note">入力欄・ボタン・スライダー・日本語変換中・開いたダイアログでは通常の操作を優先します。1文字キーのR・Vは割り当てていません。</p></details>;
}
