import { Button, Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import type { ReaderSettings } from '../model';
import { resetDisplaySettings } from '../preferences';
import { FontSelect, DisplayAmount } from './ReadingOptions';
import { ReadingModeControls } from './ReadingModeControls';
import { WritingModeSelect } from './WritingModeSelect';
import './reader-workspace.css';

export function ReaderDisplayToolbar({ settings, onChange, onSettings }: {
  settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void; onSettings: () => void;
}) {
  return <div className="reader-display-toolbar" aria-label="読書の表示">
    <ReadingModeControls mode={settings.mode} onChange={mode => onChange({ mode })} />
    <DisplayAmount settings={settings} onChange={onChange} /><Button variant="subtle" onClick={onSettings}>表示設定</Button>
  </div>;
}

export function ReaderTransport({ progress, previous, next, playing, playLabel, disabled, onToggle, speed, secondary }: {
  progress: ReactNode; previous: ReactNode; next: ReactNode; playing: boolean; playLabel: string;
  disabled: boolean; onToggle: () => void; speed: ReactNode; secondary?: ReactNode;
}) {
  return <section className="reader-player" aria-label="再生操作">
    {progress}
    <div className="reader-player-main">
      <div className="reader-player-transport">
        {previous}
        <Button className="play-button" size="lg" disabled={disabled} aria-keyshortcuts="Space" onClick={onToggle}>{playing ? '一時停止' : playLabel}</Button>
        {next}
      </div>
    </div>
    <div className="reader-player-secondary"><div className="reader-player-speed">{speed}</div>{secondary}</div>
  </section>;
}

export function ReaderDisplaySettings({ settings, onChange, font }: {
  settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void; font: { phase: string; error: string };
}) {
  return <div className="settings-panel">
    <section className="settings-section"><h2>文字と向き</h2>
      <FontSelect value={settings.fontFamily ?? 'system'} onChange={fontFamily => onChange({ fontFamily })} phase={font.phase} error={font.error} />
      <WritingModeSelect value={settings.writingMode} onChange={writingMode => onChange({ writingMode })} />
      <Switch label="ルビを表示" checked={settings.ruby} onChange={event => onChange({ ruby: event.currentTarget.checked })} />
      <label className="font-size-setting">文字サイズ <strong>{settings.mode === 'guide' ? settings.documentFontSize ?? 20 : settings.fontSize} px</strong><input aria-label="文字サイズ" type="range" min={settings.mode === 'guide' ? 14 : 24} max={settings.mode === 'guide' ? 48 : 96} step="2" value={settings.mode === 'guide' ? settings.documentFontSize ?? 20 : settings.fontSize} onChange={event => onChange(settings.mode === 'guide' ? { documentFontSize: Number(event.target.value) } : { fontSize: Number(event.target.value) })} /></label>
      {settings.mode !== 'guide' && settings.focusedDisplay?.kind === 'multiline' && <p className="input-note">複数行では、この大きさを上限に、指定行数が収まる文字サイズへ自動調整します。</p>}
    </section>
    <section className="settings-section"><h2>表示する量</h2>
      <DisplayAmount settings={settings} onChange={onChange} />
      <Switch label="注視点ガイド" checked={settings.guide} onChange={event => onChange({ guide: event.currentTarget.checked })} />
      <Switch label="停止時に前後の文脈を表示" checked={settings.context ?? true} onChange={event => onChange({ context: event.currentTarget.checked })} />
    </section>
    <section className="settings-section"><h2>全画面</h2>
      <Switch label="全画面で進行バーを表示" checked={settings.fullscreenProgress ?? true} onChange={event => onChange({ fullscreenProgress: event.currentTarget.checked })} />
    </section>
    <Button variant="light" onClick={() => onChange(resetDisplaySettings(settings))}>表示設定をリセット</Button>
  </div>;
}

export function ReaderAudioNavigation({ previousSentence, nextSentence, hasPreviousSentence, hasNextSentence }: {
  previousSentence: () => void; nextSentence: () => void;
  hasPreviousSentence: boolean; hasNextSentence: boolean;
}) {
  return <div className="reader-step-actions" role="group" aria-label="文の先頭へ移動">
    <span title="句点や段落で区切った、一文の先頭へ移動">一文</span>
    <Button variant="subtle" aria-label="一文戻る" disabled={!hasPreviousSentence} onClick={previousSentence}>戻る</Button>
    <Button variant="subtle" aria-label="一文進む" disabled={!hasNextSentence} onClick={nextSentence}>進む</Button>
  </div>;
}
