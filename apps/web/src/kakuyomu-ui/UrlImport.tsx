import { Alert, Button, Checkbox, Loader, Progress, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { getKakuyomuBook, getKakuyomuJob, previewKakuyomu, startKakuyomu } from '../kakuyomu/api';
import type { KakuyomuJobView, KakuyomuPreview } from '../kakuyomu/contracts';
import { forgetUrlImportJob, readStoredUrlImportJob, rememberUrlImportJob } from '../kakuyomu/storage';
import type { ReadingDocument } from '../reader/model';
import './url-import.css';

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'URLからの読み込みに失敗しました。';
}

/**
 * Shown inside the existing manuscript input after the user pastes a work URL
 * and invokes the normal read action. It adds chapter selection only; it has no
 * URL field or site-specific screen of its own.
 */
export function UrlImport({ url, onRead }: { url: string; onRead: (document: ReadingDocument) => void }) {
  const [preview, setPreview] = useState<KakuyomuPreview>();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<KakuyomuJobView>();
  const [busy, setBusy] = useState<'' | 'preview' | 'restore' | 'start'>('');
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const request = useRef(0);
  const openRequest = useRef(0);
  const running = job?.status === 'queued' || job?.status === 'running';

  async function loadPreview(generation = ++request.current) {
    setBusy('preview'); setError(''); setPreview(undefined);
    try {
      const value = await previewKakuyomu({ data: { url } });
      if (generation !== request.current) return;
      setPreview(value);
      setSelected(new Set(value.parts.map(part => part.order)));
    } catch (cause) {
      if (generation === request.current) setError(message(cause));
    } finally {
      if (generation === request.current) setBusy('');
    }
  }

  useEffect(() => {
    const generation = ++request.current;
    const saved = readStoredUrlImportJob();
    if (saved && saved.url === url) {
      setBusy('restore');
      void (async () => {
        try {
          const value = await getKakuyomuJob({ data: { jobId: saved.jobId } });
          if (generation !== request.current) return;
          setJob(value); setSelected(new Set(value.selectedParts));
          if (value.status === 'completed') forgetUrlImportJob(); else rememberUrlImportJob(value);
          try {
            const page = await previewKakuyomu({ data: { url } });
            if (generation !== request.current) return;
            setPreview(page); setSelected(new Set(value.selectedParts)); setError('');
          } catch (cause) {
            if (generation === request.current) setError(message(cause));
          } finally {
            if (generation === request.current) setBusy('');
          }
        } catch {
          if (generation !== request.current) return;
          forgetUrlImportJob();
          await loadPreview(generation);
        }
      })();
    } else {
      if (saved) forgetUrlImportJob();
      void loadPreview(generation);
    }
    return () => { request.current++; openRequest.current++; };
  }, [url]);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const next = await getKakuyomuJob({ data: { jobId: job.id } });
        if (!active) return;
        failures = 0;
        setJob(next); setError('');
        if (next.status === 'completed') {
          // A finished job no longer needs to reopen the input on every reload.
          forgetUrlImportJob();
          return;
        }
        rememberUrlImportJob(next);
        if (next.status === 'failed') {
          setError(next.error ?? '取り込みに失敗しました。');
          return;
        }
        timer = setTimeout(() => { void tick(); }, 700);
      } catch (cause) {
        if (!active) return;
        failures++;
        const missing = message(cause).includes('見つかりません');
        if (missing || failures >= 5) {
          setJob(undefined); setError(`${message(cause)} 目次を取得し直して、取得済みデータで再試行できます。`);
          forgetUrlImportJob();
          return;
        }
        setError(`${message(cause)} 再接続を待っています…`);
        timer = setTimeout(() => { void tick(); }, 2000);
      }
    };
    timer = setTimeout(() => { void tick(); }, 500);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [job?.id, job?.status]);

  async function start() {
    if (!preview || busy || running || !selected.size) return;
    setBusy('start'); setError('');
    try {
      const value = await startKakuyomu({ data: { url: preview.url, parts: [...selected] } });
      setJob(value); rememberUrlImportJob(value);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy('');
    }
  }

  async function openBook(id: string, revision: string) {
    if (opening) return;
    const generation = ++openRequest.current;
    setOpening(id); setError('');
    try {
      const book = await getKakuyomuBook({ data: { bookId: id, revision } });
      // The URL/manuscript may have been edited while the book was loading.
      if (generation !== openRequest.current) return;
      // Keep the job record while another chapter is still being acquired so a
      // reload can reconnect. A finished/failed job is safe to forget.
      if (!running) forgetUrlImportJob();
      onRead(book.document);
    } catch (cause) {
      if (generation === openRequest.current) setError(message(cause));
    } finally {
      if (generation === openRequest.current) setOpening('');
    }
  }

  const totalEpisodes = preview?.parts.filter(part => selected.has(part.order)).reduce((sum, part) => sum + part.episodeCount, 0) ?? 0;
  const estimatedMinutes = totalEpisodes ? Math.max(1, Math.ceil(totalEpisodes * 1.2 / 60)) : 0;
  const progress = job && job.totalEpisodes ? Math.floor(job.completedEpisodes / job.totalEpisodes * 100) : 0;
  const completed = job?.status === 'completed';

  return <section className="url-import" aria-label="URLから読み込む">
    {(busy === 'preview' || busy === 'restore') && <p className="url-import-status" role="status"><Loader size="sm" /> 目次を確認しています…</p>}
    {error && <Alert color="red" role="alert" mt="sm">{error}{!preview && !running && <div><Button variant="light" mt="sm" loading={busy === 'preview'} disabled={Boolean(busy)} onClick={() => void loadPreview()}>目次を再取得</Button></div>}</Alert>}
    {preview && <div className="url-import-preview">
      <div className="url-import-work"><div><h3>{preview.title}</h3><Text size="sm" c="dimmed">{preview.author}</Text></div><Text size="xs" c="dimmed">{preview.cached ? '取得済みの目次' : '目次を取得済み'}</Text></div>
      <p className="url-import-note">取り込む章・節を選んでください。章の中に節がある作品は、節ごとに1冊になります。</p>
      <div className="url-import-parts" role="group" aria-label="取り込む章・節">
        {preview.parts.map(part => <Checkbox key={part.order} checked={selected.has(part.order)} disabled={Boolean(busy) || running}
          label={<span><strong>{part.title}</strong><span className="url-import-part-meta">{part.episodeCount}話{part.firstEpisode ? ` · ${part.firstEpisode}` : ''}{part.episodeCount > 1 && part.lastEpisode ? ` 〜 ${part.lastEpisode}` : ''}</span></span>}
          onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => { const next = new Set(previous); if (checked) next.add(part.order); else next.delete(part.order); return next; }); }} />)}
      </div>
      <div className="url-import-actions"><span>{selected.size}冊 / {totalEpisodes.toLocaleString('ja-JP')}話{estimatedMinutes ? ` · 目安 約${estimatedMinutes}分` : ''}</span><Button onClick={() => void start()} loading={busy === 'start'} disabled={Boolean(busy) || running || !selected.size}>{job?.status === 'failed' ? '再試行する' : 'この範囲を取り込む'}</Button></div>
      <Text size="xs" c="dimmed">取得には話数に応じて時間がかかります。中断しても、取得済みデータから再開できます。</Text>
    </div>}
    {job && <div className="url-import-progress" role="status" aria-live="polite">
      <div className="url-import-progress-heading"><strong>{completed ? '本棚に保存しました' : job.status === 'failed' ? '取り込みを停止しました' : '取り込み中'}</strong><span>{job.completedEpisodes.toLocaleString('ja-JP')} / {job.totalEpisodes.toLocaleString('ja-JP')}話 · {job.completedParts} / {job.totalParts}冊</span></div>
      <Progress value={completed ? 100 : progress} />
      {job.current && !completed && job.status !== 'failed' && <p className="url-import-current">「{job.current.partTitle}」第{job.current.episodeOrder}話 {job.current.episodeTitle}</p>}
      {job.books.length > 0 && <div className="url-import-books"><p>本棚に保存した本</p><ul>{job.books.map(book => <li key={book.id}><span>{book.title} · {book.totalCharacters.toLocaleString('ja-JP')}字</span><Button size="compact-sm" variant="light" loading={opening === book.id} disabled={Boolean(opening)} onClick={() => void openBook(book.id, book.revision)}>読む</Button></li>)}</ul></div>}
      {job.status === 'failed' && <Text size="sm" c="dimmed">完了した本は本棚に残しています。失敗した章・節は保存していません。再試行では取得済みデータを再利用します。</Text>}
      {completed && <Text size="sm" c="dimmed">音声は生成していません。本棚からいつでも読み直せます。</Text>}
    </div>}
  </section>;
}
