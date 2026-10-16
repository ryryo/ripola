import { Button, Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import type { ReaderSettings } from '../model';
import { resetDisplaySettings } from '../preferences';
import { FontSelect, DisplayAmount, FontSize } from './ReadingOptions';
import { ReadingModeControls } from './ReadingModeControls';
import { WritingModeSelect } from './WritingModeSelect';
import './reader-workspace.css';

export function ReaderDisplayToolbar({ settings, onChange, onSettings }: {
  settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void; onSettings: () => void;
}) {
  return <div className="reader-display-toolbar" aria-label="読書の表示">
    <ReadingModeControls mode={settings.mode} onChange={mode => onChange({ mode })} />
    <Button variant="subtle" onClick={onSettings}>表示設定</Button>
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
    <section className="settings-section"><h2>書体とルビ</h2>
      <FontSelect value={settings.fontFamily ?? 'system'} onChange={fontFamily => onChange({ fontFamily })} phase={font.phase} error={font.error} />
      <Switch label="ルビを表示" checked={settings.ruby} onChange={event => onChange({ ruby: event.currentTarget.checked })} />
    </section>
    <section className="settings-section"><h2>読書の補助</h2>
      <Switch label="注視点ガイド" checked={settings.guide} onChange={event => onChange({ guide: event.currentTarget.checked })} />
    </section>
    <section className="settings-section"><h2>全画面</h2>
      <Switch label="全画面で進行バーを表示" checked={settings.fullscreenProgress ?? true} onChange={event => onChange({ fullscreenProgress: event.currentTarget.checked })} />
    </section>
    <Button variant="light" onClick={() => onChange(resetDisplaySettings(settings))}>表示設定をリセット</Button>
  </div>;
}

export function ReaderDisplayControls({ settings, onChange }: { settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void }) {
  return <div className="reader-display-controls" role="group" aria-label="表示の調整">
    <WritingModeSelect value={settings.writingMode} onChange={writingMode => onChange({ writingMode })} />
    <DisplayAmount settings={settings} onChange={onChange} label="表示量" compact />
    <FontSize settings={settings} onChange={onChange} label="フォントサイズ" />
  </div>;
}
