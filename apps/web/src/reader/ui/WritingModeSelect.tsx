import { NativeSelect } from '@mantine/core';
import type { WritingMode } from '../model';
import './vertical-reading.css';

export function WritingModeSelect({ value = 'horizontal-tb', onChange }: { value?: WritingMode; onChange: (value: WritingMode) => void }) {
  return <div className="writing-mode-setting reader-setting-field"><label><span>本文の向き</span><NativeSelect aria-label="本文の向き" value={value} onChange={event => {
    const next = event.target.value;
    if (next === 'horizontal-tb' || next === 'vertical-rl') onChange(next);
  }}><option value="horizontal-tb">横書き</option><option value="vertical-rl">縦書き</option></NativeSelect></label></div>;
}
