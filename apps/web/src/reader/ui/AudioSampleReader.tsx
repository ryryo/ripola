import { Alert, Button, Loader } from '@mantine/core';
import { useEffect, useState } from 'react';
import { distributionLoadError, loadDistributedBook, type PublicAudioBookManifest } from '../../distribution/library';
import { audioDemo, audioDemoBaseUrl, loadAudioDemos } from '../audio-demo';
import { AudioReader } from './AudioReader';

/** Bundled samples use the same verified static audio on every build profile. */
export function AudioSampleReader({ sampleKey }: { sampleKey: string }) {
  const [book, setBook] = useState<PublicAudioBookManifest>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void (async () => {
      const sample = audioDemo(sampleKey);
      if (!sample) throw new Error('Unknown sample');
      const entries = await loadAudioDemos(import.meta.env.BASE_URL);
      const entry = entries.find(entry => entry.id === sample.id && entry.revision === sample.revision);
      if (!entry) throw new Error('Missing sample');
      const loaded = await loadDistributedBook(entry, audioDemoBaseUrl(import.meta.env.BASE_URL));
      if (active) setBook(loaded);
    })().catch(error => { if (active) setError(distributionLoadError(error)); });
    return () => { active = false; };
  }, [sampleKey, attempt]);
  const close = () => location.assign(import.meta.env.BASE_URL);
  if (book) return <AudioReader book={book} demo onClose={close} />;
  return <div className="generation-shell"><main>
    <Button variant="subtle" onClick={close}>トップへ戻る</Button>
    {error ? <Alert color="red" role="alert">{error}<Button variant="light" onClick={() => setAttempt(value => value + 1)}>音声サンプルを再確認</Button></Alert>
      : <Loader aria-label="音声サンプルを読み込み中" />}
  </main></div>;
}
