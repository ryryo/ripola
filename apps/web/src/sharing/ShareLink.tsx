import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import * as React from 'react';
import { createShareQr, getShareTarget, type ShareTarget } from './qr';

export interface ShareLinkProps {
  /** An ordinary deployed page URL. Omit to use this browser's current URL. */
  url?: string;
  title?: string;
}

export function ShareLink({ url, title = 'このページ' }: ShareLinkProps) {
  // Resolve URLs after hydration; QR encoding stays in the browser.
  const [currentUrl, setCurrentUrl] = React.useState('');
  const [status, setStatus] = React.useState('');
  const descriptionId = React.useId();
  React.useEffect(() => {
    const update = () => { setCurrentUrl(url ?? window.location.href); setStatus(''); };
    update();
    if (url) return;
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, [url]);
  const target = React.useMemo(() => getShareTarget(currentUrl), [currentUrl]);
  const qr = React.useMemo(() => createShareQr(target.url), [target.url]);

  async function copyUrl() {
    if (!target.url) return;
    try {
      await navigator.clipboard.writeText(target.url);
      setStatus('URLをコピーしました。');
    } catch {
      setStatus('コピーできませんでした。URL欄から選択してコピーしてください。');
    }
  }

  return <Stack gap="sm" component="section" aria-label="ページURLを共有">
    <Group align="flex-start" gap="lg" wrap="wrap">
      {qr && <svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label={`${title}を開くQRコード`} aria-describedby={descriptionId}
        data-testid="share-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} width="212" height="212" style={{ maxWidth: '100%', height: 'auto' }} shapeRendering="crispEdges">
        <title>{title}を開くQRコード</title><desc>公開ページのURLだけを含むQRコードです。</desc>
        <rect width={qr.size} height={qr.size} fill="#fff" /><path d={qr.path} fill="#000" />
      </svg>}
      <Stack gap="xs" style={{ flex: '1 1 240px', minWidth: 0 }}>
        <Text fw={600}>{title}のURL</Text>
        <TextInput label="共有用URL" value={target.url} readOnly onFocus={event => event.currentTarget.select()} />
        <Button variant="light" onClick={() => void copyUrl()} disabled={!target.url}>URLをコピー</Button>
        <Text id={descriptionId} size="sm" c="dimmed">{shareDescription(target)}</Text>
        {target.stripped && target.url && <Text size="xs" c="dimmed">本文・認証情報につながるqueryやfragmentは共有URLに含めません。</Text>}
        {status && <Text role="status" size="sm">{status}</Text>}
      </Stack>
    </Group>
  </Stack>;
}

function shareDescription(target: ShareTarget): string {
  if (target.reason === 'local') return 'このURLはローカル環境用です。スマホで開くには、HTTPSで配信したページのURLを使ってください。';
  if (target.reason === 'https') return 'QRコードはHTTPSで配信したページで表示します。';
  if (target.reason === 'too-long') return 'URLが長すぎます。書籍の通常のページURLを使ってください。';
  if (target.reason === 'invalid') return '共有できるページURLを確認しています。';
  return 'スマホのカメラで、このページを開けます。端末内に取り込んだ本文や保存データは転送されません。';
}
