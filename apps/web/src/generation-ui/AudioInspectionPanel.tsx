import { Alert, Button, Checkbox } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { AudioBookManifest } from '../generation/contracts';
import type { AudioInspection, AudioInspectionReport } from '../generation/audio-quality/contracts';
import { getSavedAudioInspections, inspectSavedAudio } from '../generation/audio-quality/functions';

export function AudioInspectionResult({ result, audioUrl }: { result: AudioInspection; audioUrl?: string }) {
  const metrics = result.lightweight.metrics;
  return <details data-testid="audio-inspection-result">
    <summary>{result.chunkId} · {result.status === 'fatal' ? '構造不正' : result.status === 'warning' ? '要確認' : '内容は判定不能'} · {result.text || '元範囲を取得できません'}</summary>
    {result.source && <p>元本文：{result.source.blockId} · UTF-16 {result.source.start}–{result.source.end}</p>}
    <p>軽量検査：{result.lightweight.status === 'no-warning' ? '検査した指標でwarningなし' : result.lightweight.status === 'warning' ? '要確認' : result.lightweight.status === 'fatal' ? '構造不正' : '判定不能'}{result.lightweight.reason && ` · ${result.lightweight.reason}`}</p>
    {metrics && <p>duration {metrics.durationSeconds.toFixed(2)}秒 · {metrics.charactersPerSecond.toFixed(2)}文字/秒 · RMS {metrics.rms.toFixed(4)} · peak {metrics.peak.toFixed(4)} · 飽和 {(metrics.clippingRatio * 100).toFixed(2)}% · 無音 {(metrics.silentRatio * 100).toFixed(1)}%</p>}
    <p>内容検査：{result.content.status === 'review' ? '候補との差を要確認（正しさは判定不能）' : '判定不能'} · {result.content.reason}</p>
    {result.content.candidate !== undefined && <><p>音声のみのASR候補：<q>{result.content.candidate || '空の認識候補'}</q></p><p>許容表記edit distance：{result.content.editDistance ?? '比較不能'} · 一致文字 {result.content.matchedCharacters ?? '未計測'} / {result.content.referenceCharacters ?? '未計測'}。token scoreは認識精度の確率ではありません。</p></>}
    {!!result.content.differences?.length && <ul>{result.content.differences.map((difference, index) => <li key={index}>ASRとの差分（音声異常とは未判定）：{difference.message} · 元範囲 {(result.source?.start ?? 0) + difference.start}–{(result.source?.start ?? 0) + difference.end}</li>)}</ul>}
    {result.issues.length > 0 && <ul>{result.issues.map((issue, index) => <li key={index}>{issue.severity === 'fatal' ? '構造不正' : 'warning'}：{issue.message}{issue.source && <> 元範囲 {issue.source.start}–{issue.source.end}{result.source && `「${result.text.slice(issue.source.start - result.source.start, issue.source.end - result.source.start)}」`}</>}{issue.audio && <> 音声 {issue.audio.startSeconds.toFixed(2)}–{issue.audio.endSeconds.toFixed(2)}秒</>}</li>)}</ul>}
    {audioUrl && <audio controls preload="none" src={audioUrl} aria-label={`${result.chunkId}の確認用音声`} onPlay={event => { document.querySelectorAll('audio').forEach(audio => { if (audio !== event.currentTarget) audio.pause(); }); }} style={{ maxWidth: '100%', width: '100%' }} />}
    <details><summary>検査の根拠と版</summary><p>検査版：{result.inspectionVersion} · {result.inspectedAt}</p><p>元音声hash：<code style={{ overflowWrap: 'anywhere' }}>{result.audioHash}</code></p><p>検査した{result.mediaFormat.toUpperCase()} hash：<code style={{ overflowWrap: 'anywhere' }}>{result.mediaHash}</code></p><p>ASR：{result.content.modelVersion ?? '未実行'} · 許容表記：{result.content.spellingVersion}</p></details>
  </details>;
}

export function AudioInspectionPanel({ book }: { book: AudioBookManifest }) {
  const [report, setReport] = useState<AudioInspectionReport>();
  const [content, setContent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [page, setPage] = useState(0);
  useEffect(() => {
    let active = true;
    setReport(undefined); setPage(0); setError('');
    void getSavedAudioInspections({ data: { bookId: book.id, revision: book.revision } }).then(value => { if (active) setReport(value); }).catch(() => { if (active) setError('保存した検査結果を取得できませんでした。'); });
    return () => { active = false; };
  }, [book.id, book.revision]);
  async function inspect(refresh: boolean) {
    setBusy(true); setError('');
    try { setReport(await inspectSavedAudio({ data: { bookId: book.id, revision: book.revision, content, refresh } })); }
    catch (error) { setError(error instanceof Error ? error.message : '検査を実行できませんでした。'); }
    finally { setBusy(false); }
  }
  return <section className="generation-card" aria-label="保存音声の品質検査">
    <h2>保存音声の品質を確認</h2>
    <p>無音・音割れ・長さの異常と、読み飛ばしや繰り返しの疑いを調べます。warningは聴いて確認する手掛かりです。</p>
    <p>本文・音声はこのPCで検査します。再合成・有料API呼び出し・追加モデルの自動取得はありません。結果が一致しても内容の正しさを保証しません。</p>
    <Checkbox label="手元Reazonモデルで内容の認識候補も比較する" checked={content} disabled={busy} onChange={event => setContent(event.currentTarget.checked)} />
    <div className="generation-actions"><Button disabled={busy} onClick={() => void inspect(false)}>{busy ? '保存音声を検査中…' : '保存音声を検査する'}</Button>{report && <Button variant="light" disabled={busy} onClick={() => void inspect(true)}>再検査する（再合成なし）</Button>}</div>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {report && <><p role="status">要確認 {report.chunks.filter(c => c.status === 'warning').length} · 構造不正 {report.chunks.filter(c => c.status === 'fatal').length} · 内容判定不能 {report.chunks.filter(c => c.content.status === 'indeterminate').length} · cache再利用 {report.reusedChunks}文</p><p>軽量検査と内容検査の根拠は、各chunkを開いて確認できます。</p>{report.chunks.slice(page * 10, (page + 1) * 10).map(result => <AudioInspectionResult key={result.chunkId} result={result} audioUrl={book.chunks.find(c => c.id === result.chunkId)?.audioUrl} />)}{report.chunks.length > 10 && <div className="generation-actions"><Button variant="subtle" disabled={page === 0} onClick={() => setPage(value => value - 1)}>前の10文</Button><span>{page + 1} / {Math.ceil(report.chunks.length / 10)}</span><Button variant="subtle" disabled={(page + 1) * 10 >= report.chunks.length} onClick={() => setPage(value => value + 1)}>次の10文</Button></div>}</>}
  </section>;
}
