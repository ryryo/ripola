import { useEffect, useMemo, useState } from 'react';
import type { TextBlock } from '../model';
import type { SentenceLocation } from '../sentences';
import { RubyText } from './PhraseDisplay';

/** Keep the preview and its space stable while the reading body advances. */
export function StoppedContext({ entries, blocks, current, playing, enabled, ruby, onJump }: {
  entries: SentenceLocation[]; blocks: TextBlock[]; current: number; playing: boolean; enabled: boolean; ruby: boolean; onJump: (target: number) => void;
}) {
  const [stopped, setStopped] = useState(current);
  const byId = useMemo(() => new Map(blocks.map(block => [block.id, block])), [blocks]);
  useEffect(() => { if (!playing) setStopped(current); }, [current, playing]);
  const index = playing ? stopped : current;
  const hidden = playing || !enabled;
  return <div className="stopped-context" data-testid="stopped-context" aria-label="前後の文" aria-hidden={hidden} style={{ visibility: hidden ? 'hidden' : 'visible' }}>
    {[index - 1, index + 1].map((target, i) => {
      const entry = entries[target];
      const block = entry && byId.get(entry.blockId);
      const spans = entry && block?.text.slice(entry.start, entry.end) === entry.text
        ? block.ruby.filter(span => span.start >= entry.start && span.end <= entry.end).map(span => ({ ...span, start: span.start - entry.start, end: span.end - entry.start })) : [];
      const label = i === 0 ? '前の文' : '次の文';
      return <button key={i} type="button" className="stopped-context-link" disabled={!entry} tabIndex={hidden ? -1 : 0}
        aria-label={entry ? `${label}へ：${entry.text}` : `${label}はありません`} title={entry?.text}
        onClick={() => { if (entry) onJump(entry.target); }}>
        <span className="stopped-context-label">{label}</span>
        <span className="stopped-context-text">{entry ? <RubyText unit={{ text: entry.text, ruby: spans }} show={ruby} /> : i === 0 ? 'ここが最初の文です' : 'ここが最後の文です'}</span>
      </button>;
    })}
  </div>;
}
