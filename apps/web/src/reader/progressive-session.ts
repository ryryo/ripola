import { useEffect, useRef, useState } from 'react';
import type { AudioBookManifest, GenerationJob } from '../generation/contracts';
import { getBook, getJob, listJobs } from '../generation-ui/api';
import { acceptsManifest, mergeManifest } from './audio-progressive';

export function useProgressiveBook(initial: AudioBookManifest, requestedJobId?: string) {
  const [book, setBook] = useState(initial);
  const [job, setJob] = useState<GenerationJob>();
  const [error, setError] = useState('');
  const current = useRef(initial);
  const epoch = useRef(0);
  useEffect(() => {
    if (acceptsManifest(current.current, initial)) { current.current = mergeManifest(current.current, initial); setBook(current.current); }
  }, [initial]);
  useEffect(() => {
    const run = ++epoch.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => epoch.current === run;
    current.current = initial; setBook(initial); setError(''); setJob(undefined);
    const poll = async (jobId: string) => {
      try {
        const state = await getJob({ data: { jobId }, signal: abort.signal });
        if (!alive()) return;
        if (state.id !== jobId || state.bookId !== initial.id || state.revision !== initial.revision || initial.generation && state.planId !== initial.generation.planId) { setError('生成中の本の更新元が一致しないため、更新を停止しました。'); return; }
        setJob(state);
        const incoming = await getBook({ data: { bookId: initial.id, revision: initial.revision }, signal: abort.signal });
        if (!alive()) return;
        if (!acceptsManifest(current.current, incoming, state)) { setError('古い生成結果の更新を停止しました。保存済み音声は保持します。'); return; }
        current.current = mergeManifest(current.current, incoming); setBook(current.current); setJob(state); setError('');
        if (state.status === 'completed') return;
        // Continue watching failed/cancelled jobs: explicitly resuming the same
        // job can produce more chunks. Polls never request synthesis themselves.
      } catch (reason) {
        if (alive()) setError(reason instanceof Error ? reason.message : '生成状態を取得できませんでした。');
      }
      if (alive()) timer = setTimeout(() => void poll(jobId), 1500);
    };
    void (async () => {
      try {
        const owner = initial.generation?.jobId;
        if (owner && requestedJobId && requestedJobId !== owner) throw new Error('指定した生成処理は、この保存音声と一致しません。');
        let id = owner ?? requestedJobId;
        if (!id && initial.completedChunks < initial.totalChunks) {
          const jobs = await listJobs({ signal: abort.signal });
          if (!alive()) return;
          id = jobs.find(job => job.bookId === initial.id && job.revision === initial.revision)?.id;
        }
        if (id && alive()) await poll(id);
      } catch (reason) { if (alive()) setError(reason instanceof Error ? reason.message : '生成状態を取得できませんでした。'); }
    })();
    return () => { epoch.current++; abort.abort(); clearTimeout(timer); };
  }, [initial.id, initial.revision, requestedJobId]);
  return { book, job, error };
}
