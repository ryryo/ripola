import { Alert, Button, NumberInput, Progress, Textarea } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_IRODORI_SETTINGS, IRODORI_MODEL, type IrodoriSettings, type IrodoriStatus } from '../generation/irodori-contracts';
import { cancelIrodoriInstall, getIrodoriSettings, getIrodoriStatus, installIrodori, saveIrodoriSettings, startIrodoriRuntime, stopIrodoriRuntime } from '../generation/irodori-functions';

const label: Record<IrodoriStatus['phase'], string> = { 'not-installed': '未導入', downloading: '取得中', verifying: '検証中', ready: '導入済み', cancelled: '取消し・中断', failed: '導入失敗' };
export function IrodoriPanel({ onChange, onSettingsChange, onBusyChange, disabled = false }: { onChange: () => void; onSettingsChange: (settings: IrodoriSettings) => void; onBusyChange: (busy: boolean) => void; disabled?: boolean }) {
  const [status, setStatus] = useState<IrodoriStatus>();
  const [settings, setSettings] = useState<IrodoriSettings>(DEFAULT_IRODORI_SETTINGS);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setStatus(await getIrodoriStatus()); } catch (error) { setError(error instanceof Error ? error.message : '状態を取得できません。'); }
  }, []);
  useEffect(() => { let active = true; void getIrodoriSettings().then(value => { if (active) { setSettings(value); onSettingsChange(value); } }).catch(() => { if (active) setError('合成設定を読めません。設定を確認・保存してから計画してください。'); }); void refresh(); const timer = window.setInterval(() => { if (active) void refresh(); }, 1000); return () => { active = false; window.clearInterval(timer); }; }, [refresh, onSettingsChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const working = status?.phase === 'downloading' || status?.phase === 'verifying';
  async function act(action: () => Promise<unknown>) {
    setBusy(true); onBusyChange(true); setError('');
    try { await action(); await refresh(); onChange(); } catch (error) { setError(error instanceof Error ? error.message : '操作を完了できません。'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="generation-card" aria-label="Irodoriの任意追加">
    <h3>Irodori · このPCに任意追加</h3>
    <p>日本語をこのPCで合成します。モデル約1.92GB、新規導入には約2.2GBの空き容量が必要です。通常の起動・音声セットアップでは取得しません。スマホへは完成した音声だけを配ります。</p>
    <p>利用にはspeech.cppの実行環境と、話者の同意・利用条件を確認した固定voiceが別途必要です。現在は製品voiceを同梱していません。準備ガイドを確認してから追加してください。</p>
    <p role="status">{status ? `${label[status.phase]} · ${status.message}` : '導入状態を確認しています。'}</p>
    {status?.freeBytes !== undefined && <p>空き容量 {(status.freeBytes / 1e9).toFixed(2)}GB · 追加で必要な空き容量 {(status.requiredFreeBytes / 1e9).toFixed(2)}GB</p>}
    {status && (working || status.downloadedBytes > 0 && status.phase !== 'ready') && <><Progress value={status.downloadedBytes / status.totalBytes * 100} aria-label="モデル取得の進捗" /><p>{(status.downloadedBytes / 1e9).toFixed(2)} / {(status.totalBytes / 1e9).toFixed(2)}GB · 途中の資材はまだ利用できません。</p></>}
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <div className="generation-actions">
      {status && status.phase !== 'ready' && !working && <Button disabled={busy || disabled || status.freeBytes !== undefined && status.freeBytes < status.requiredFreeBytes} onClick={() => void act(() => installIrodori())}>{status.downloadedBytes > 0 ? '途中から導入を再開する' : status.phase === 'failed' ? '導入を再試行する（約1.92GB）' : 'Irodoriを追加する（約1.92GB）'}</Button>}
      {working && <Button color="gray" variant="light" disabled={busy} onClick={() => void act(() => cancelIrodoriInstall())}>取得・検証を取り消す</Button>}
      {status?.phase === 'ready' && <Button disabled={busy || disabled || !status.executableAvailable || !status.voiceAvailable || status.runtime === 'starting'} onClick={() => void act(() => status.runtime === 'running' ? stopIrodoriRuntime() : startIrodoriRuntime())}>{status.runtime === 'running' ? 'このPCのIrodoriを停止' : status.runtime === 'starting' ? '起動中' : 'このPCで起動'}</Button>}
    </div>
    {status?.phase === 'ready' && !status.voiceAvailable && <p>同じ声で読み続けるには、話者の同意と利用条件を確認した固定voice資材が必要です。現在は製品voiceを同梱していません。voiceがない状態では声が変わる可能性があるため生成を開始できません。</p>}
    {status?.voiceLabel && <p>固定voice: {status.voiceLabel} · {status.voiceAttribution}</p>}
    <p><a href="https://github.com/ryryo/ripola/blob/codex/speech-irodori/docs/guides/irodori.md" target="_blank" rel="noreferrer">実行環境・固定voiceの準備ガイド</a> · <a href={`https://huggingface.co/${IRODORI_MODEL.repository}/tree/${IRODORI_MODEL.revision}`} target="_blank" rel="noreferrer">モデルの取得元と利用条件</a></p>
    <details><summary>合成設定・取得資材の詳細</summary>
      <p>MFのstepsは合成の計算回数です。減らしてもモデルの保存容量は減りません。長文は短いチャンクに分けます。音質・速度はPCと原稿によって変わります。</p>
      <NumberInput label="MF steps" min={1} max={16} value={settings.steps} disabled={busy || disabled} onChange={value => { if (typeof value === 'number') setSettings(previous => ({ ...previous, steps: value })); }} />
      <NumberInput label="速度" min={.25} max={4} step={.1} value={settings.speed} disabled={busy || disabled} onChange={value => { if (typeof value === 'number') setSettings(previous => ({ ...previous, speed: value })); }} />
      <NumberInput label="合成seed" min={0} max={Number.MAX_SAFE_INTEGER} value={settings.seed} disabled={busy || disabled} onChange={value => { if (typeof value === 'number') setSettings(previous => ({ ...previous, seed: value })); }} />
      <Textarea label="読み上げ方の指示（任意）" maxLength={256} value={settings.instructions} disabled={busy || disabled} onChange={event => { const instructions = event.currentTarget.value; setSettings(previous => ({ ...previous, instructions })); }} />
      <Button mt="sm" disabled={busy || disabled || status?.phase !== 'ready'} onClick={() => void act(async () => { await saveIrodoriSettings({ data: settings }); onSettingsChange(settings); })}>設定を保存して計画を更新</Button>
      <p style={{ overflowWrap: 'anywhere' }}>固定revision: <code>{IRODORI_MODEL.revision}</code><br />SHA-256: <code>{IRODORI_MODEL.sha256}</code><br />取得後の検証が完了した資材だけを使います。</p>
    </details>
  </section>;
}
