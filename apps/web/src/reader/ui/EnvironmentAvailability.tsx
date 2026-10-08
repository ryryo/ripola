import { Badge, Button } from '@mantine/core';
import { readerCapabilities } from '../environment';

export function EnvironmentAvailability() {
  const capabilities = readerCapabilities(import.meta.env.VITE_RSVP_PROFILE);
  if (capabilities.localGeneration) return null;
  return <section className="environment-availability" aria-label="音声生成の利用状態">
    <div className="environment-heading"><strong>音声も生成する</strong><Badge color="gray" variant="light">{capabilities.environmentLabel}</Badge></div>
    <Button variant="light" color="gray" disabled aria-describedby="public-voicevox-reason">VOICEVOX · ローカルPC版限定</Button>
    <p id="public-voicevox-reason">音声生成はローカルPC版で利用できます。公開デモ・個人用Workerとも、端末内の文章取り込み・RSVP生成と準備済み音声の再生を使えます。Gemini・VOICEVOXの音声生成はWorkerでは行いません。</p>
    <details><summary>ローカルPC版とは</summary><p>PCで起動するripolaと、そのPCのVOICEVOX Engineを使う版です。配布ページをPCやスマートフォンで開いても、生成APIやEngineには接続しません。音声サンプルは、インストールなしで下から開けます。</p></details>
  </section>;
}
