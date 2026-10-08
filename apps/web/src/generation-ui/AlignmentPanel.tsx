import { Alert, Badge, Button, Checkbox, Progress, Select } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { AlignmentCapabilities, AlignmentJob, AudioBookManifest } from '../generation/contracts';
import { cancelAlignmentJob, getAlignmentCapabilities, listAlignmentJobs, resumeAlignmentJob, startAlignment } from './api';
import { mergeJobSnapshots } from './job-state';

const STATUS: Record<AlignmentJob['status'], string> = { queued: '待機中', running: '整列中', 'cancel-requested': '停止を受け付けました', cancelled: '停止済み', failed: '失敗', completed: '完了' };

export function AlignmentPanel({ book, onUpdated }: { book: AudioBookManifest; onUpdated: () => Promise<void> }) {
  const [capabilities, setCapabilities] = useState<AlignmentCapabilities>();
  const [jobs, setJobs] = useState<AlignmentJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [selected, setSelected] = useState<string[]>();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useRef('');
  const mounted = useRef(false);
  const refreshed = useRef('');
  const job = selectedJob ? jobs.find(value => value.id === selectedJob) : jobs[0];
  const ids = selected ?? book.chunks.map(chunk => chunk.id);

  useEffect(() => {
    mounted.current = true;
    void getAlignmentCapabilities().then(value => { if (mounted.current) setCapabilities(value); }).catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : '整列設定を確認できませんでした。'); });
    const refresh = () => { void listAlignmentJobs().then(value => {
      if (mounted.current) setJobs(previous => mergeJobSnapshots(previous, value.filter(job => job.bookId === book.id && job.revision === book.revision)));
    }).catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : '整列の進捗を取得できませんでした。'); }); };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [book.id, book.revision]);

  useEffect(() => {
    if (!job || !['completed', 'cancelled', 'failed'].includes(job.status) || !job.completedChunks) return;
    const key = `${job.id}:${job.updatedAt}`;
    if (refreshed.current === key) return;
    refreshed.current = key;
    void onUpdated().catch(() => { if (mounted.current) { refreshed.current = ''; setError('整列後の本文を再取得できませんでした。本棚からもう一度開いてください。'); } });
  }, [job, onUpdated]);

  function targetsChanged(value: string[] | undefined) { setSelected(value); operation.current = ''; setNotice(''); }

  async function start() {
    if (busy || !capabilities?.available || !ids.length) return;
    setBusy(true); setError('');
    if (!operation.current) operation.current = crypto.randomUUID();
    try {
      const result = await startAlignment({ data: { bookId: book.id, revision: book.revision, operationId: operation.current, selectedChunkIds: ids } });
      if (!mounted.current) return;
      setJobs(previous => mergeJobSnapshots(previous, [result])); setSelectedJob(result.id);
      setNotice('保存した音声の時刻を整列しています。音声の再生成や外部送信は行いません。');
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '整列を開始できませんでした。'); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function control(action: 'cancel' | 'resume') {
    if (!job || busy) return;
    setBusy(true); setError('');
    try {
      const result = action === 'cancel' ? await cancelAlignmentJob({ data: { jobId: job.id } }) : await resumeAlignmentJob({ data: { jobId: job.id } });
      if (mounted.current) { setJobs(previous => mergeJobSnapshots(previous, [result])); setSelectedJob(result.id); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '整列ジョブを更新できませんでした。'); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <section className="generation-card alignment-panel" aria-label="保存音声のフレーズ時刻を整列">
    <h2>保存音声にフレーズ時刻を追加</h2><p>原稿と保存済み音声をこのPCで整列します。TTSの再生成や有料API呼び出しはありません。</p>
    <p className="muted">時刻を確定できないフレーズ、無音、読み不一致でも区切りを表示します。時刻は表示用推定として区別します。CTCスコアは選別の指標で、時刻精度の確率ではありません。</p>
    {error && <Alert color="red" role="alert" mb="md">{error}</Alert>}{notice && <Alert color="ripola" role="status" mb="md">{notice}</Alert>}
    <p className="muted">{capabilities?.available ? 'このPCの整列モデルを利用できます。' : capabilities?.message ?? 'ローカル整列モデルの設定を確認しています…'}</p><Button variant="subtle" disabled={busy} onClick={() => { void getAlignmentCapabilities().then(value => { setCapabilities(value); operation.current = ''; }).catch(error => setError(error instanceof Error ? error.message : '設定を確認できませんでした。')); }}>整列設定を再確認</Button>
    <details><summary>対象の保存音声（{ids.length} / {book.chunks.length}文）</summary><div className="generation-actions"><Button variant="light" disabled={busy} onClick={() => targetsChanged(undefined)}>すべての保存音声</Button><Button variant="light" disabled={busy} onClick={() => targetsChanged(book.chunks.filter(chunk => !chunk.alignment || chunk.alignment.status !== 'aligned').map(chunk => chunk.id))}>未整列・一部整列の音声</Button></div><div className="chunk-selection">{book.chunks.slice(page * 20, (page + 1) * 20).map((chunk, index) => <Checkbox key={chunk.id} checked={ids.includes(chunk.id)} disabled={busy} label={`${page * 20 + index + 1}. ${chunk.alignment?.status === 'aligned' ? 'フレーズ時刻あり' : chunk.alignment?.status === 'partial' ? '一部のフレーズ時刻あり' : '発話境界の時刻なし'}`} onChange={event => targetsChanged(event.currentTarget.checked ? [...ids, chunk.id] : ids.filter(id => id !== chunk.id))} />)}</div>{book.chunks.length > 20 && <div className="generation-actions"><Button variant="subtle" onClick={() => setPage(value => value - 1)} disabled={page === 0}>前の20文</Button><span>{page + 1} / {Math.ceil(book.chunks.length / 20)}</span><Button variant="subtle" onClick={() => setPage(value => value + 1)} disabled={(page + 1) * 20 >= book.chunks.length}>次の20文</Button></div>}</details>
    <Button mt="md" onClick={() => void start()} disabled={busy || !capabilities?.available || !ids.length}>選択した保存音声の時刻を整列する</Button>
    {jobs.length > 0 && <><Select mt="lg" label="整列ジョブを選択" data={jobs.map(value => ({ value: value.id, label: `${STATUS[value.status]} · ${new Date(value.createdAt).toLocaleString()}` }))} value={job?.id ?? null} allowDeselect={false} onChange={value => { if (value) setSelectedJob(value); }} disabled={busy} />{job && <><div className="generation-job-heading"><Badge color={job.status === 'failed' ? 'red' : 'ripola'}>{STATUS[job.status]}</Badge><span>{job.completedChunks} / {job.totalChunks}文 · 再利用 {job.reusedChunks}文</span></div><Progress value={job.totalChunks ? job.completedChunks / job.totalChunks * 100 : 0} /><p className="muted">フレーズ整列 {job.chunks.filter(chunk => chunk.result === 'aligned').length}文 · 一部整列 {job.chunks.filter(chunk => chunk.result === 'partial').length}文 · 時刻未整列 {job.chunks.filter(chunk => chunk.result === 'fallback').length}文</p>{job.error && <Alert color="yellow" mt="md">{job.error}</Alert>}<div className="generation-actions">{['queued', 'running'].includes(job.status) && <Button color="gray" variant="light" disabled={busy} onClick={() => void control('cancel')}>整列をここで停止する</Button>}{['cancelled', 'failed'].includes(job.status) && <Button disabled={busy || !capabilities?.available} onClick={() => void control('resume')}>未完了の時刻整列だけを再開</Button>}<Button variant="subtle" disabled={busy} onClick={() => { void onUpdated().catch(() => setError('本文を再取得できませんでした。')); }}>保存した整列結果を表示</Button></div></>}</>}
  </section>;
}
