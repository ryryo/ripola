# Gemini直結とCloudflare AI Gateway

Cloudflare経路はローカルNodeからWrangler remote AI bindingを使います。認証情報をブラウザや公開Workerへ配置しません。

## ローカルセットアップ

| 経路 | 必要な設定 | 送信先 |
| --- | --- | --- |
| Gemini Direct | `.env.local`の`GEMINI_API_KEY` | Google Interactions API。Googleアカウント課金 |
| Cloudflare | 既存Wranglerログイン＋Gateway ID | Nodeからremote AI binding。課金元はGateway設定に従う |

通常利用では有料許可envを設定せず、開始／再開ごとに本文・経路・概算を確認します。旧envの有料停止指定は尊重します。追加の確認フラグはありません。

次の設定例を**ローカル設定がない場合だけ**コピーします。既存の設定は上書きしません。

```sh
pnpm --filter @ripola/web exec wrangler login
cp deployment/local-ai.example.wrangler.jsonc deployment/local-ai.wrangler.jsonc
```

Git除外されたローカル設定の`vars.RSVP_AI_GATEWAY_ID`へ使う**既存Gateway ID**を指定します。任意のenv上書き`RSVP_AI_GATEWAY_ID`も利用できます。空なら経路の選択は無効です。`default`への自動補完はしません。複数アカウントがある場合はWrangler設定の`account_id`に対象を明示します。公開用Worker設定に生成APIは追加しません。

通常経路の手動CF tokenやaccount-ID envは不要です。Wranglerが既存認証とremote接続を扱います。[公式Node API](https://developers.cloudflare.com/workers/wrangler/api/)、[remote bindings](https://developers.cloudflare.com/workers/local-development/)

## Gatewayの課金設定について

Googleの`default` alias BYOKがGatewayに保存されていれば、そのキーがUnified Billingより優先されます。アプリはGeminiキーをこの経路へ送りませんが、Gateway自身の保存キーは通常仕様どおり使われます。BYOKがなければCloudflare管理キーとUnified Billingのクレジットが使用されます。[binding仕様](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)、[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)、[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

Dashboardで一度確認する場合は、**AI → AI Gateway → 対象Gateway → Provider Keys**のGoogle `default`、**Settings → Require provider credentials**、必要ならCredits Availableを読みます。アプリにはその読み取りや確認済み状態を組み込みません。既存キーの削除、Gateway作成、権限追加、購入は別の操作です。[Gateway設定](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/)



## 生成・保存・エラー

Gateway IDはplanの`routeIdentity`に固定します。生成時は公式`getPlatformProxy`でremote bindingへ接続し、送信台帳を記録して`AI.run`を1回呼びます。本文はルビ・読み辞書を適用した発話本文です。Gateway側の独立したstyle指示は未対応で、非空なら送信前に拒否します。

有効なbase64 WAVまたは許可した`*.aig.cloudflare.com`のHTTPS WAVを受け取り、音声URLへ認証情報を転送しません。応答に既知の`keySource`があればreceiptへ記録しますが、BYOKやmetadataの欠落だけで合成結果を拒否しません。receiptは請求額の証明ではありません。

接続失敗は未送信として処理し、呼び出し後の通信失敗・不正音声は結果不明として保存します。自動retryやGemini直結へのfallbackはありません。取消後の未送信分は止め、完成音声を再利用します。アプリは1回呼び出しますが、Gateway側のRetry Requests設定は未確認です。Nodeのlibrary、VOICEVOX、Direct、保存WAVの整列は同じ構成です。

設定ありの表示は、実接続や有料合成の成功を意味しません。実行時の認証・quota・残高エラーは生成結果として扱います。

## REST互換経路

`RSVP_AI_GATEWAY_TRANSPORT=rest`を明示した時のみ、account ID・Gateway ID・tokenの3項目で公式`/ai/run`へ接続します。このtokenには推論用のWorkers AI Readが必要です。Gatewayの管理API Readは要求しません。通常のWrangler経路からRESTへ自動切替しません。

## 検証範囲

Direct・CloudflareのLite音声は保存済みの3音声サンプルとして確認しています。生成APIの応答や実請求額は、画面の概算と同じとは限りません。新規アカウントの課金設定・初回Gateway作成は未検証です。設定後も明示した計画だけを開始し、モデルや経路を自動で切り替えません。
