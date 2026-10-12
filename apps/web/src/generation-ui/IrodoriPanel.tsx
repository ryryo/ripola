import { Alert, Button, NumberInput, Progress, Textarea } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultIrodoriSettings, IRODORI_MODEL, type IrodoriSettings, type IrodoriStatus } from '../generation/irodori-contracts';
import { cancelIrodoriInstall, getIrodoriSettings, getIrodoriStatus, installIrodori, saveIrodoriSettings, startIrodoriRuntime, stopIrodoriRuntime } from '../generation/irodori-functions';

const label: Record<IrodoriStatus['phase'], string> = { 'not-installed': '未導入', downloading: '取得中', verifying: '検証中', ready: '導入済み', cancelled: '取消し・中断', failed: '導入失敗' };
export function IrodoriPanel({ voice = 'reception-female', onChange, onSettingsChange, onBusyChange, disabled = false }: { voice?: string; onChange: () => void; onSettingsChange: (settings: IrodoriSettings) => void; onBusyChange: (busy: boolean) => void; disabled?: boolean }) {
  const [status, setStatus] = useState<IrodoriStatus>();
  const [settings, setSettings] = useState<IrodoriSettings>(() => defaultIrodoriSettings(voice));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const operation = useRef(0);
  const settingsRevision = useRef(0);
  const statusRequest = useRef(0);
  const pendingStatus = useRef<{ id: number; run: number } | undefined>(undefined);
  const refresh = useCallback(async (run: number, polling = false) => {
    if (run !== operation.current || polling && pendingStatus.current?.run === run) return;
    const id = ++statusRequest.current;
    pendingStatus.current = { id, run };
    const current = () => operation.current === run && statusRequest.current === id;
    try {
      const value = await getIrodoriStatus();
      if (current()) setStatus(value);
    } catch (error) {
      if (current()) setError(error instanceof Error ? error.message : '状態を取得できません。');
    } finally {
      if (pendingStatus.current?.id === id) pendingStatus.current = undefined;
    }
  }, []);
  useEffect(() => { let active = true; const revision = settingsRevision.current; const current = () => active && settingsRevision.current === revision;
    setSettings(defaultIrodoriSettings(voice));
    void getIrodoriSettings({ data: voice }).then(value => { if (current()) { setSettings(value); onSettingsChange(value); } }).catch(() => { if (current()) setError('合成設定を読めません。設定を確認・保存してから計画してください。'); });
    void refresh(operation.current, true); const timer = window.setInterval(() => { if (active) void refresh(operation.current, true); }, 1000); return () => { active = false; window.clearInterval(timer); }; }, [refresh, onSettingsChange, voice]);
  useEffect(() => () => { operation.current++; statusRequest.current++; onBusyChange(false); }, [onBusyChange]);
  const working = status?.phase === 'downloading' || status?.phase === 'verifying';
  function editSettings(change?: Partial<IrodoriSettings>) {
    settingsRevision.current++;
    if (change) setSettings(previous => ({ ...previous, ...change }));
  }
  async function act(action: (run: number) => Promise<unknown>, cancellation = false) {
    const run = ++operation.current;
    setCancelling(cancellation);
    setBusy(true); onBusyChange(true); setError('');
    try { await action(run); if (operation.current === run) { await refresh(run); if (operation.current === run) onChange(); } }
    catch (error) { if (operation.current === run) setError(error instanceof Error ? error.message : '操作を完了できません。'); }
    finally { if (operation.current === run) { setBusy(false); setCancelling(false); onBusyChange(false); } }
  }
  return <section className="generation-card" aria-label="Irodoriの任意追加">
    <h3>Irodori · このPCに任意追加</h3>
    <p>実験機能です。このPCでの速度・音質を確認してから利用してください。</p>
    <p>日本語をこのPCで合成します。v4.1 Small通常版モデル約1.91GB、新規導入には約2.2GBの空き容量が必要です。通常の起動・音声セットアップでは取得しません。スマホへは完成した音声だけを配ります。</p>
    <p>speech.cppの実行環境を用意すると、指示文から「丁寧な受付」の男女声を生成できます。声・スタイルを選び、下の指示文を変更して使えます。</p>
    <p role="status">{status ? `${label[status.phase]} · ${status.message}` : '導入状態を確認しています。'}</p>
    {status?.freeBytes !== undefined && <p>空き容量 {(status.freeBytes / 1e9).toFixed(2)}GB · 追加で必要な空き容量 {(status.requiredFreeBytes / 1e9).toFixed(2)}GB</p>}
    {status && (working || status.downloadedBytes > 0 && status.phase !== 'ready') && <><Progress value={status.downloadedBytes / status.totalBytes * 100} aria-label="モデル取得の進捗" /><p>{(status.downloadedBytes / 1e9).toFixed(2)} / {(status.totalBytes / 1e9).toFixed(2)}GB · 途中の資材はまだ利用できません。</p></>}
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <div className="generation-actions">
      {status && status.phase !== 'ready' && !working && <Button disabled={busy || disabled || status.freeBytes !== undefined && status.freeBytes < status.requiredFreeBytes} onClick={() => void act(() => installIrodori())}>{status.downloadedBytes > 0 ? '途中から導入を再開する' : status.phase === 'failed' ? '導入を再試行する（約1.91GB）' : 'Irodoriを追加する（約1.91GB）'}</Button>}
      {working && <Button color="gray" variant="light" disabled={cancelling} onClick={() => void act(() => cancelIrodoriInstall(), true)}>取得・検証を取り消す</Button>}
      {(status?.runtime === 'running' || status?.runtime === 'starting') && <Button disabled={cancelling || disabled} onClick={() => void act(() => stopIrodoriRuntime(), true)}>{status.runtime === 'starting' ? 'Irodoriの起動を取り消す' : 'このPCのIrodoriを停止'}</Button>}
      {status?.phase === 'ready' && status.runtime !== 'running' && <Button disabled={busy || disabled || !status.executableAvailable || !status.voiceAvailable || status.runtime === 'starting'} onClick={() => void act(() => startIrodoriRuntime())}>{status.runtime === 'starting' ? '起動中' : 'このPCで起動'}</Button>}
    </div>
    {status?.phase === 'ready' && status.referenceMode === 'fixed' && !status.voiceAvailable && <p>同じ声で読み続けるには、話者の同意と利用条件を確認した固定voice資材が必要です。現在は製品voiceを同梱していません。voiceがない状態では声が変わる可能性があるため生成を開始できません。</p>}
    {status?.voiceLabel && <p>固定voice: {status.voiceLabel} · {status.voiceAttribution}</p>}
    <p><a href="https://github.com/ryryo/ripola/blob/main/docs/guides/irodori.md" target="_blank" rel="noreferrer">実行環境の準備ガイド</a> · <a href={`https://huggingface.co/${IRODORI_MODEL.repository}/tree/${IRODORI_MODEL.revision}`} target="_blank" rel="noreferrer">モデルの取得元と利用条件</a></p>
      <Textarea label="声・読み上げ方のプロンプト" maxLength={256} value={settings.instructions} disabled={busy || disabled} onChange={event => editSettings({ instructions: event.currentTarget.value })} />
      <Button mt="sm" variant="light" disabled={busy || disabled} onClick={() => editSettings({ instructions: defaultIrodoriSettings(voice).instructions })}>プロンプトを既定に戻す</Button>
      <Button mt="sm" disabled={busy || disabled || status?.phase !== 'ready'} onClick={() => { settingsRevision.current++; void act(async run => { await saveIrodoriSettings({ data: { voice, settings } }); if (operation.current === run) onSettingsChange(settings); }); }}>設定を保存して計画を更新</Button>
    <details><summary>合成設定・取得資材の詳細</summary>
      <p>stepsは合成の計算回数です。減らしてもモデルの保存容量は減りません。長文は短いチャンクに分けます。音質・速度はPCと原稿によって変わります。</p>
      <NumberInput label="合成steps" min={1} max={voice === 'ripola' ? 16 : 100} value={settings.steps} disabled={busy || disabled} onChange={value => editSettings(typeof value === 'number' ? { steps: value } : undefined)} />
      <NumberInput label="速度" min={.25} max={4} step={.1} value={settings.speed} disabled={busy || disabled} onChange={value => editSettings(typeof value === 'number' ? { speed: value } : undefined)} />
      <NumberInput label="合成seed" min={0} max={Number.MAX_SAFE_INTEGER} value={settings.seed} disabled={busy || disabled} onChange={value => editSettings(typeof value === 'number' ? { seed: value } : undefined)} />
      <p style={{ overflowWrap: 'anywhere' }}>固定revision: <code>{IRODORI_MODEL.revision}</code><br />SHA-256: <code>{IRODORI_MODEL.sha256}</code><br />取得後の検証が完了した資材だけを使います。</p>
    </details>
  </section>;
}
