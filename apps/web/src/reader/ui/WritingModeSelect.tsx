import type { WritingMode } from '../model';
import './vertical-reading.css';

export function WritingModeSelect({ value = 'horizontal-tb', onChange }: { value?: WritingMode; onChange: (value: WritingMode) => void }) {
  return <div className="writing-mode-setting"><label>本文の向き<select aria-label="本文の向き" value={value} onChange={event => {
    const next = event.target.value;
    if (next === 'horizontal-tb' || next === 'vertical-rl') onChange(next);
  }}><option value="horizontal-tb">横書き</option><option value="vertical-rl">縦書き</option></select></label><p className="input-note">縦書きは上から下、右から左へ読みます。</p></div>;
}
