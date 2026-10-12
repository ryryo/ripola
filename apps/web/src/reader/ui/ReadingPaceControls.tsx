import { useId } from 'react';
import type { PaceTimeline, ReadingPace } from '../pace';

export function ReadingPaceControls({ value = 'legacy', summary, onChange }: {
  value?: ReadingPace; summary: Omit<PaceTimeline, 'durations'>; onChange: (value: ReadingPace) => void;
}) {
  const id = useId();
  return <div className="group-settings" data-testid="reading-pace-controls">
    <label htmlFor={id}>黙読ペース
      <select id={id} style={{ minHeight: 44 }} value={value} onChange={event => {
        const next = event.currentTarget.value;
        if (next === 'legacy' || next === 'text-load') onChange(next);
      }}>
        <option value="legacy">従来（文字数に比例）</option>
        <option value="text-load">本文の負荷に配分（評価）</option>
      </select>
    </label>
    <p className="muted">評価モードは数字・英字・括弧・長い句へ時間を配分します。ルビや読み辞書は不要です。重みは仮説で、理解度の向上は未検証です。</p>
    <p className="muted" data-testid="pace-budget">両モードの予定総時間 {(summary.totalMs / 1000).toFixed(1)}秒（休止込み約{Math.round(summary.effectiveCpm)}字/分）。</p>
    {summary.minimumOverheadMs > .001 && <p className="muted" data-testid="pace-constraint">従来と総時間をそろえるため、最低表示100msによる追加{(summary.minimumOverheadMs / 1000).toFixed(1)}秒を両モードで保ちます。句読点の休止は別に加わります。</p>}
    {summary.infeasibleCpm && <p className="muted">このCPMの文字時間では、全フレーズへ100msずつ配れません。休止込みの最低総時間は{(summary.minimumRequiredMs / 1000).toFixed(1)}秒です。</p>}
    {value === 'text-load' && summary.minimumUnits > 0 && <p className="muted">{summary.minimumUnits}フレーズが表示時間の下限です。下限に達した箇所では負荷による配分の差が出ない場合があります。</p>}
    <p className="muted">比較は先頭へ戻して、同じ速さで試してください。切替時は現在位置で停止します。速度・ペースを途中で変えると、表示中フレーズの時間を保ち、以降へ反映します。</p>
  </div>;
}
