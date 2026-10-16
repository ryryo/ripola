import { Button, Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import './generation.css';

export function AudioDisclosure({ enabled, disabled, onToggle }: { enabled: boolean; disabled: boolean; onToggle: (enabled: boolean) => void }) {
  return <div className={`audio-disclosure ${enabled ? 'is-open' : ''}`}>
    <div className="audio-disclosure-heading"><div><strong>音声も生成する</strong><span className="advanced-label">アドバンスド設定</span><p>声や読みを選んで、同じ文章に音声を付けます。</p></div><Switch role="switch" aria-label="音声も生成する" aria-controls="home-audio-settings" checked={enabled} disabled={disabled} onChange={event => onToggle(event.currentTarget.checked)} size="md" /></div>
  </div>;
}

export function HomeTextComposer({ input, disabled, onToggle, onRead }: { input: ReactNode; disabled: boolean; onToggle: (enabled: boolean) => void; onRead: () => void }) {
  return <div className="generation-shell home-generation"><div className="home-generation-content"><div className="home-composer">
    {input}<AudioDisclosure enabled={false} disabled={disabled} onToggle={onToggle} />
    <div className="home-generation-actions"><Button onClick={onRead} disabled={disabled}>テキストのみ生成して読む</Button></div>
    <p className="home-action-note">テキストは端末内で準備します。本文を外へ送りません。</p>
  </div></div></div>;
}
