import { Button, CheckIcon, ColorSwatch, Slider, Switch } from '@mantine/core';
import { useId, type ReactNode } from 'react';
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
      <Switch classNames={{ label: 'settings-item-label' }} label="ルビを表示" checked={settings.ruby} onChange={event => onChange({ ruby: event.currentTarget.checked })} />
    </section>
    <section className="settings-section"><h2>読書の補助</h2>
      <Switch classNames={{ label: 'settings-item-label' }} label="注視点ガイド" checked={settings.guide} onChange={event => onChange({ guide: event.currentTarget.checked })} />
    </section>
    <HighlightSettings settings={settings} onChange={onChange} />
    <section className="settings-section"><h2>全画面</h2>
      <Switch classNames={{ label: 'settings-item-label' }} label="全画面で進行バーを表示" checked={settings.fullscreenProgress ?? true} onChange={event => onChange({ fullscreenProgress: event.currentTarget.checked })} />
    </section>
    <Button variant="light" onClick={() => onChange(resetDisplaySettings(settings))}>表示設定をリセット</Button>
  </div>;
}

const HIGHLIGHT_INTENSITIES = [
  { value: 'light', label: '薄い' },
  { value: 'normal', label: '標準' },
  { value: 'strong', label: '濃い' },
] as const;
const MULTILINE_SPACING_OPTIONS = [
  { value: 'narrow', label: '狭い' },
  { value: 'normal', label: '標準' },
  { value: 'wide', label: '広い' },
] as const;

function ThreeStepSetting<T extends string>({ label, options, value, onChange, color = 'ripola' }: {
  label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void; color?: string;
}) {
  const index = options.findIndex(option => option.value === value);
  return <div className="reader-step-setting" role="group" aria-label={label}>
    <div className="settings-item-label">{label}</div>
    <div className="reader-step-control">
      <Slider className="reader-step-slider" min={0} max={2} step={1} restrictToMarks value={index} onChange={next => onChange(options[next].value)}
        color={color} size="sm" thumbSize={18} label={null} thumbLabel={label} thumbValueText={next => options[next].label}
        marks={options.map((_, next) => ({ value: next }))} />
      <div className="reader-step-labels">{options.map((option, next) => <button key={option.value} className="settings-option-label" type="button" aria-pressed={index === next} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
    </div>
  </div>;
}

function HighlightSettings({ settings, onChange }: { settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void }) {
  const id = useId();
  const color = settings.highlightColor ?? 'blue';
  return <section className="settings-section highlight-settings">
    <div className="highlight-section-heading"><h2>複数行・複数列の表示設定</h2>
      <p className="muted">表示量が2行・2列以上のときに適用されます。</p>
    </div>
    <ThreeStepSetting label="行間・列間" options={MULTILINE_SPACING_OPTIONS} value={settings.multilineSpacing ?? 'normal'} onChange={multilineSpacing => onChange({ multilineSpacing })} />
    <div className="highlight-controls" role="group" aria-label="ハイライトの設定">
    <fieldset className="highlight-color-palette"><legend className="settings-item-label">ハイライトの色</legend>
      {([{ value: 'blue', label: '青系', color: 'var(--mantine-primary-color-filled)', ink: 'white' }, { value: 'yellow', label: '黄色系', color: '#f2c94c', ink: '#302606' }] as const).map(option => <label className="highlight-color-option" key={option.value}>
        <input className="visually-hidden" type="radio" name={`${id}-color`} value={option.value} checked={color === option.value} onChange={() => onChange({ highlightColor: option.value })} />
        <ColorSwatch className="highlight-color-chip" color={option.color} size={28} style={{ color: option.ink }} aria-hidden="true">
          {color === option.value && <CheckIcon size={12} />}
        </ColorSwatch>
        <span className="settings-option-label">{option.label}</span>
      </label>)}
    </fieldset>
    <ThreeStepSetting label="ハイライトの濃さ" options={HIGHLIGHT_INTENSITIES} value={settings.highlightIntensity ?? 'normal'} onChange={highlightIntensity => onChange({ highlightIntensity })} color={color === 'yellow' ? '#f2c94c' : 'ripola'} />
    </div>
  </section>;
}

export function ReaderDisplayControls({ settings, onChange }: { settings: ReaderSettings; onChange: (patch: Partial<ReaderSettings>) => void }) {
  return <div className="reader-display-controls" role="group" aria-label="表示の調整">
    <WritingModeSelect value={settings.writingMode} onChange={writingMode => onChange({ writingMode })} />
    <DisplayAmount settings={settings} onChange={onChange} label="表示量" compact />
    <FontSize settings={settings} onChange={onChange} label="フォントサイズ" />
  </div>;
}
