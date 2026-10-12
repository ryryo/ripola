import { Button, Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import type { ReaderSettings } from '../model';
import { resetDisplaySettings } from '../preferences';
import { FontSelect, GroupSettings } from './ReadingOptions';
import { ReadingModeControls } from './ReadingModeControls';
import { WritingModeSelect } from './WritingModeSelect';
import './reader-workspace.css';

export function ReaderDisplayToolbar({ settings, onChange, onSettings }: {
  settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void; onSettings: () => void;
}) {
  return <div className="reader-display-toolbar" aria-label="読書の表示">
    <ReadingModeControls mode={settings.mode} onChange={mode => onChange({ mode })} />
    <div className="reader-display-tools">
      <div className="reader-text-size" role="group" aria-label="文字の大きさ">
        <button type="button" aria-label="文字を小さく" disabled={settings.fontSize <= 24} onClick={() => onChange({ fontSize: Math.max(24, settings.fontSize - 4) })}>小</button>
        <span>{settings.fontSize}<span className="visually-hidden"> px</span></span>
        <button type="button" aria-label="文字を大きく" disabled={settings.fontSize >= 96} onClick={() => onChange({ fontSize: Math.min(96, settings.fontSize + 4) })}>大</button>
      </div>
      <Switch label="ルビを表示" checked={settings.ruby} onChange={event => onChange({ ruby: event.currentTarget.checked })} />
      <Button variant="subtle" onClick={onSettings}>表示設定</Button>
    </div>
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
      <label className="font-size-setting">文字サイズ <strong>{settings.fontSize} px</strong><input aria-label="文字サイズ" type="range" min="24" max="96" step="2" value={settings.fontSize} onChange={event => onChange({ fontSize: Number(event.target.value) })} /></label>
    </section>
    <section className="settings-section"><h2>フレーズの表示</h2>
      <GroupSettings settings={settings} onChange={onChange} />
      <Switch label="注視点ガイド" checked={settings.guide} onChange={event => onChange({ guide: event.currentTarget.checked })} />
      <Switch label="停止時に前後の文脈を表示" checked={settings.context ?? true} onChange={event => onChange({ context: event.currentTarget.checked })} />
    </section>
    <Button variant="light" onClick={() => onChange(resetDisplaySettings(settings))}>表示設定をリセット</Button>
  </div>;
}

export function ReaderAudioNavigation({ previousSentence, nextSentence, previousPhrase, nextPhrase, hasPreviousSentence, hasNextSentence, hasPreviousPhrase, hasNextPhrase }: {
  previousSentence: () => void; nextSentence: () => void; previousPhrase: () => void; nextPhrase: () => void;
  hasPreviousSentence: boolean; hasNextSentence: boolean; hasPreviousPhrase: boolean; hasNextPhrase: boolean;
}) {
  return <div className="reader-step-navigation">
    <div className="reader-step-actions" role="group" aria-label="文の先頭へ移動">
      <span title="句点や段落で区切った、一文の先頭へ移動">一文</span>
      <Button variant="subtle" aria-label="一文戻る" disabled={!hasPreviousSentence} onClick={previousSentence}>戻る</Button>
      <Button variant="subtle" aria-label="一文進む" disabled={!hasNextSentence} onClick={nextSentence}>進む</Button>
    </div>
    <div className="reader-step-actions" role="group" aria-label="文の中の短い区切りへ移動">
      <span title="一文を分けた短いまとまりへ移動">短い区切り</span>
      <Button variant="subtle" aria-label="一区切り戻る" disabled={!hasPreviousPhrase} onClick={previousPhrase}>戻る</Button>
      <Button variant="subtle" aria-label="一区切り進む" disabled={!hasNextPhrase} onClick={nextPhrase}>進む</Button>
    </div>
  </div>;
}
