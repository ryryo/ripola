import { Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { PublicBookEntry } from '../../distribution/library';
import { AUDIO_DEMOS, audioDemoHref, loadAudioDemos } from '../audio-demo';

export function AudioDemo({ disabled = false }: { disabled?: boolean }) {
  const [samples, setSamples] = useState<PublicBookEntry[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    let active = true;
    setState('loading');
    void loadAudioDemos(import.meta.env.BASE_URL).then(entries => {
      if (active) { setSamples(entries); setState(entries.length ? 'ready' : 'unavailable'); }
    }).catch(() => { if (active) { setSamples([]); setState('unavailable'); } });
    return () => { active = false; };
  }, [attempt]);
  return <article className="home-sample-item home-audio-demo" aria-label="音声付きデモ">
    <span className="sample-glyph" aria-hidden="true">♫</span>
    <div className="sample-copy"><h3>音声と一緒に</h3><p>吾輩は猫である · 冒頭</p></div>
      <div className="sample-voice-group" role="group" aria-label="音声サンプルを開く">
        {AUDIO_DEMOS.map(option => {
          const sample = samples.find(entry => entry.id === option.id && entry.revision === option.revision);
          const content = <><span>{option.label}</span><small><span>{option.voice}</span><span>{sample ? `約${Math.round(sample.durationSeconds)}秒` : state === 'loading' ? '確認中' : '利用できません'}</span></small></>;
          return sample && state === 'ready' && !disabled
            ? <a key={option.key} className="sample-voice-link" aria-label={`${option.label}で読む`} href={audioDemoHref(option.key, import.meta.env.VITE_RSVP_PROFILE, import.meta.env.BASE_URL)}>{content}</a>
            : <button key={option.key} className="sample-voice-link" type="button" disabled aria-label={`${option.label}で読む`}>{content}</button>;
        })}
      </div>
    <div className="sample-audio-status">
      {state !== 'ready' && <p className="sample-status" role="status">{state === 'loading' ? '音声サンプルを確認しています…' : '音声サンプルを取得できません。黙読サンプルは使えます。'}</p>}
      {state === 'unavailable' && <Button variant="subtle" disabled={disabled} onClick={() => setAttempt(previous => previous + 1)}>音声サンプルを再確認</Button>}
    </div>
  </article>;
}
