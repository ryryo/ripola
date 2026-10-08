import { useEffect, useState } from 'react';
import type { DisplayGroup } from '../display-groups';
import { RubyText } from './PhraseDisplay';

/** Freeze context while playing, including its hidden DOM, so only the reading body changes. */
export function StoppedContext({ groups, groupIndex, playing, enabled, ruby, onJump }: {
  groups: DisplayGroup[]; groupIndex: number; playing: boolean; enabled: boolean; ruby: boolean; onJump: (index: number) => void;
}) {
  const [stopped, setStopped] = useState(groupIndex);
  useEffect(() => { if (!playing) setStopped(groupIndex); }, [groupIndex, playing]);
  const index = playing ? stopped : groupIndex;
  return <div className="stopped-context" data-testid="stopped-context" aria-hidden={playing || !enabled} style={{ visibility: playing || !enabled ? 'hidden' : 'visible' }}>
    {[index - 1, index + 1].map((target, i) => <div className="stopped-context-line" key={i}><span>{i === 0 ? '前' : '次'}</span>{groups[target] ? <button type="button" tabIndex={playing || !enabled ? -1 : 0} onClick={() => onJump(groups[target].startIndex)} title={groups[target].unit.text}><RubyText unit={groups[target].unit} show={ruby} /></button> : <span className="muted">{i === 0 ? '先頭です' : '末尾です'}</span>}</div>)}
  </div>;
}
