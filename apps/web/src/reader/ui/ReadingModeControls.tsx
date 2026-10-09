import { Button } from '@mantine/core';
import type { ReaderSettings } from '../model';

export function ReadingModeControls({ mode = 'flash', onChange }: {
  mode: ReaderSettings['mode']; onChange: (mode: NonNullable<ReaderSettings['mode']>) => void;
}) {
  return <div className="reading-mode-controls" role="group" aria-label="表示方式">
    <Button variant={mode === 'flash' ? 'light' : 'subtle'} aria-pressed={mode === 'flash'} title="フレーズを一つずつ切り替えて表示" onClick={() => onChange('flash')}>フレーズ表示</Button>
    <Button variant={mode === 'guide' ? 'light' : 'subtle'} aria-pressed={mode === 'guide'} title="全文の中で読んでいる部分を強調して表示" onClick={() => onChange('guide')}>全文表示</Button>
  </div>;
}
