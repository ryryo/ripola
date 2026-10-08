# 静的配布・認証・公開準備

更新日：2026-10-07 UTC。初期配布はR2を使わず、選択した本文・圧縮音声・manifestとReader UIをWorkers Static Assetsへ同梱する構成です。公開サンプルは通常取り込みのトップと、許可済み音声の本一覧を別ページにします。build/stagingの準備と実デプロイは別です。専用の[Workerプレビュー](https://ripola-preview-20261006.ryomini13.workers.dev/)へ公開サンプルを配置しました。Access設定は変更していません。検証記録に確認済み範囲を残します。

## 公開デモと個人用Worker

公開OSSデモは掲載許可済みサンプルだけ、個人用Workerは本人のCloudflareアカウントへ選択した私用本文・音声・同期用対応表を配布します。どちらも端末内テキスト取り込み・RSVP生成と音声再生を使い、サーバー音声生成は無効です。[個人用Workerの実行手順](../guides/personal-worker.md)で入力・manifest・Git外保存・出力・設定の分離を説明します。

## 生成と配布を分ける

同じPCのローカルサーバーでTTS・保存・対応表・圧縮を済ませ、配布側は完成assetを読むだけです。Workerにはローカル生成route/API・TTS secretを含めません。Static Assetsはdeploy時にuploadする読み取り用資材で、Workerの[filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)は生成正本の永続保存先ではありません。本の追加・更新・削除は再build/deployで反映します。

audioは通常のassetファイルにし、base64のJS定数や巨大import、Worker memoryへ埋め込みません。[ASSETS binding](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)を使う場合も全編を`arrayBuffer()`へ展開せず配信します。正本は[ローカル生成の契約](local-generation.md)のGit外フォルダーです。

## 明示allowlistからstagingする

public Pages用と個人Worker用で対象・directoryを分けます。個人の生成フォルダーをglobでcopyする工程を作りません。Git除外は配信許可ではなく、ignoredファイルもcopyすれば配信されます。

stagingの入口は`scripts/stage-library.ts`、静的出力は`dist/distribution/<profile>`を使う構成です。コマンド例は次です。実行前に現在のscriptと検証記録を確認してください。

```sh
node --import tsx scripts/stage-library.ts --config <allowlist.json> --output <新規の専用staging>
```

allowlistは`target`（pages/worker）、ローカルの`libraryDir`、明示した`books`のid/revision・`rightsConfirmed: true`・帰属を持ちます。demo用途（省略時もdemo）ではWorkerを含め全冊`publicDemo: true`を要求します。個人用は`audience: "personal"`とtarget=workerを明示し、`pnpm build:worker --audience personal --staging ...`でdist/personal-workerへ準備します。用途を違えたstageの混入と既存出力の上書きを拒否します。権利確認のflagは利用許諾の取得やライセンス選択の代わりではありません。

| 出力に含めるもの | 出力へ含めないもの |
| --- | --- |
| 選択した本の一覧、本文artifact、manifest、対応表、圧縮M4A | 元WAV、元PDF/MDファイル、全library、jobログ、env、key、認証JSON |

選択した`ReadingDocument.rawText`には元の本文が含まれます。元ファイルのcopyをOFFにしても全文が配布されるため、private配布と公開demoの対象を確認します。公開配布は権利と声の再配布条件を確認した自作文または青空文庫の公開サンプルに限定します。

stagingでは全参照の存在、schema、元cacheの完成状態とhash、実duration、各byte・file数・総byteを検査します。変換前後のduration差が100 msを超えた音声を拒否します。秘密の不在は追加の出力検査でも確認します。元データは変更しません。staging削除・再build・再deployではTTSを呼びません。Git連携clean checkoutには個人生成物がないため、個人Workerは生成物を持つPCから明示stage/deployする手順にします。

## 圧縮と配信chunk

Geminiの[出力形式](https://ai.google.dev/gemini-api/docs/speech-generation#audio-output-formats)からAAC/Opusを直接得られるとは仮定せず、元audioをPCへ保存してから圧縮します。初期候補はAAC-LC/M4A、mono、平均64 kbit/sです。ffmpegは設定済みbinaryへ引数配列で渡し、shell文字列を実行しません。圧縮失敗は元audioから再試行し、TTSを再実行しません。

生成は文ごと、配信は章/小節の5〜10分程度にまとめる将来案を分けます。生成ID、配信ID、順序、結合offset、圧縮後durationを対応させます。現stagingは**文ごとのM4Aファイル**を出力します。5〜10分への結合は未実装の追加案です。encoder delay/padding・先頭無音・chunk境界は対応表だけの修正対象です。

| 算術条件 | 再生時間 | 64 kbit/s | 24 kHz/16 bit/mono PCM |
| --- | --- | --- | --- |
| 10万文字、実効400文字/分 | 250分 | 約120 MB | 約720 MB |
| 20万文字、同条件 | 500分 | 約240 MB | 約1,440 MB |

式は`秒 × bit/s ÷ 8`。音質・速度・container増分は実測値ではありません。5〜10分なら約2.4〜4.8 MBです。圧縮はTTSの生成料金を減らしません。Opusは将来候補で、[Safari 18.4のOgg内Opus対応](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)を旧iPhoneや全WebViewへ一般化しません。

### AACへの時刻対応を測る

元WAVと圧縮後AACをffmpegで同じ24 kHz/monoのPCMへdecodeし、[media-timing.ts](../../scripts/media-timing.ts)の正規化相互相関でoffsetとclock driftを測ります。採用時は`mediaTime = sourceTime × scale + offset`でcueを変換し、元/圧縮audio hash、PCM duration、anchor、相関score、残差をmanifestへ記録します。duration差が小さいだけでcue時刻をコピーしません。

現policyは独立した活動anchorが3点以上、相関0.8以上、競合peak差0.015以上、offset絶対値250 ms以内、drift 1,000 ppm以内、最大残差8 ms以内です。これらは補正を採用する条件で、人手によるフレーズ時刻誤差の保証ではありません。無音、相関の曖昧さ、不安定なdrift、cueの元位置/score不一致では文fallbackへ戻します。PCM decode自体に失敗した場合はstagingを停止し、元音声を保持します。

[public-alignment.ts](../../scripts/public-alignment.ts)は元audio hashに対応するcueと、元位置が一致するunitだけを公開DTOへ含めます。CTCはscore 0.75以上を必要とします。`voicevox-mora`は検証済みEngine情報とscoreを持たないcue／unitを検査し、CTC確率を付けません。どちらもAACのPCM相関検証が必要です。[Engine方式・旧query再構成の限界](../guides/aozora-and-navigation.md#保存音声の低信頼部分)も公開時に保ちます。保存query本体・`spokenText`・正規化本文・cache key・原稿のprivate path・job/runtime/modelは含めません。公開Readerも採用cueを再検査し、cue間の隙間では文を表示します。測定はローカルffmpeg decodeとの比較で、実スマホ/ブラウザdecoderや、人手の発話境界精度を確認した結果ではありません。

## 静的profileとPagesのURL

| profile | base/出力 | Readerの入口 |
| --- | --- | --- |
| local | loopback開発サーバー | 通常取り込みと詳細生成 |
| pages | `/ripola/`、`dist/pages/client` → `dist/distribution/pages` | 取り込みトップ、`demo/`と固定デモの別ページ |
| worker | `/`、`dist/worker/client` → `dist/distribution/worker` | 共通Readerと選択した本 |

[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)は静的hostingです。Node serverや秘密keyを置きません。Viteの[Pages base規則](https://vite.dev/guide/static-deploy.html#github-pages)とRouter、ホームリンク、PDF資材、text Worker、manifest、QRを揃えます。SPA shellだけでなくトップと固定route用HTMLを生成し、任意rewriteを前提にせず直リンク/reloadを静的serverで確認します。JSON/audioの404をHTML shellへ変えません。

Pagesの[制限](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)はsite 1 GB、月100 GB soft bandwidth、deploy timeout 10分等です。全巻音声や個人蔵書は公開デモへ入れません。repoがprivateでもPagesの公開範囲は別なので、sourceのvisibilityを保護の根拠にしません。

`pnpm build:pages` / `pnpm build:worker`はprofileごとの静的出力を準備する入口です。`scripts/build-distribution.mjs --profile pages|worker --staging <選択済みstaging>`で選択assetを組み合わせ、追加stage未指定なら空の追加libraryを出し、許可済み同梱3音声デモは維持します。個人用は明示stageが必須です。公開demo音声を自動生成しません。Worker用設定案の`.wrangler.jsonc`はasset rootの外へ出し、`workers_dev: false`にします。認証設定・deployは別の明示操作です。

local UIを隠すだけでなく、公開entry・route・handler・生成function manifest・Node coreをbuild対象から除外します。公開outputに未知の原稿/audio、個人PDF、env、秘密、不要source mapがないことを調べます。通常buildにGoogle keyやCloudflare tokenを要求せず、未信頼PRへ秘密を渡しません。

## Workers Static Assetsの制約

[Limits](https://developers.cloudflare.com/workers/platform/limits/)は1ファイル25 MiB、1 Worker versionのファイル数Free 20,000/Paid 100,000、isolate memory 128 MBです。memoryは全asset保存容量ではありません。総byteの上限は単体・file数とは別で、確認できないものを「無制限storage」と説明しません。

[静的requestとasset保存](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)の追加料金は通常ありません。Workerコードを動かす場合は[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)が適用され、Freeは10万request/日・CPU 10 ms/request、Paidはaccount最低$5/月です。TTS/Gateway等は別です。[Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)のhash再利用は未変更uploadを省ける仕組みで、永続backupの保証ではありません。

標準audioと圧縮chunkを使い、全巻decode/先読みを既定にしません。[Assets Headers](https://developers.cloudflare.com/workers/static-assets/headers/)を踏まえ、Content-Type、GET/HEAD、Rangeの206/Content-Range、ETag、missing audioを配布先で確認します。今回の実ホストの応答は検証記録に分けて記録します。実機スマホのseekは別途確認が必要です。

ローカルの検証serverではContent-Length/Range不足によりAACのseekable範囲が0秒になったため、HEAD・Accept-Ranges・206/Content-Rangeを備えた静的配信で実seekを確認しました。再生表示の時刻を変更して回避せず、配信の応答を確かめます。検証記録はローカルHTTPでの確認で、実CDN・認証付き配信の代わりにはなりません。

## optional AccessとQR

個人用Workerの名称やaudienceはHTTP認証ではありません。認証なし公開assetsはURLを知る人が本文・rawText・音声・manifestを閲覧できます。有料生成の遮断と閲覧認証を分けます。閲覧を制限したい利用者だけ、任意の[Worker単位Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)のAll trafficを推奨します。HTMLだけでなく本文JSON/manifest/audio、production/preview/workers.dev/custom domainも保護します。`noindex`、推測しにくいURL、QRは認証ではありません。認証OFFなら別の保護がない限りInternet公開です。

AccessはStatic Assetsも保護できます。独自Worker認証では保護全体を`run_worker_first`に通してからASSETSへ進めます。asset-firstで認証を迂回させません。`_headers`はWorker生成応答へ適用されないため、[適用範囲](https://developers.cloudflare.com/workers/static-assets/headers/)を分けます。個人の本文/audioのbrowser cacheは`private, no-store`を初期案とし、offline複製は別設計です。

[Email OTP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)を使うなら許可メールを利用者が設定します。閲覧者にCloudflare管理権限は不要です。[Zero Trust無料枠](https://www.cloudflare.com/plans/zero-trust-services/)とWorkers料金は別です。設定案の提示と、認証設定の実変更を区別します。

QRは確認済みの通常HTTPS URLをブラウザ内で生成し、外部QRサービスへ送りません。API key、service token、署名付きURL、本文を入れません。スマホ自身が認証してから同じ本へ戻ります。未配布のlocalhost本はQRだけで移りません。トップのQRはトップを開く用途です。

## 公開前の履歴監査

現行の公開候補から内部参考、非公開入力の転載画像、個人の絶対path、内部ID/転送記録を除外します。第三者のLICENSE/NOTICE/帰属と、公開OSSの出典は保持します。製品LICENSEはMITです。依存固有の条件は保持します。デモの本文・voice・音声利用条件は別に確認します。

通常commitで削除しても、過去のGit履歴には内容が残ります。公開前に全branch/tag/削除済み履歴、CIログ・artifact、release、Wiki、Issue/PR、スクリーンショット・録画を別途監査する必要があります。既存repoのvisibility変更と、監査済みtreeから新public repoへexportする方式は別判断です。公開版は監査した現行treeから始める独立した履歴です。

[visibility変更の影響](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)を確認し、credentialが見つかればまず失効・交換します。現行treeから削除するだけでは履歴やcloneから露出を消せません。[機密情報削除の公式手順](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)を参照してください。

## R2を追加する条件と残る検証

本の追加をdeployと独立させたい、クラウドupload APIが必要、file数・単体size・deploy時間が支障になる、多数利用者の蔵書を分けたい場合にR2を検討します。ローカルブラウザ生成UIの採用だけではR2は必要ありません。移行時は認証済みWorker、immutable audio/本文/mapと最後に確定するmanifest、Range・削除・料金を別に設計します。

今回の公開WorkerではHEAD/Rangeと直リンクを確認しました。個人配布の全hostの認証、QRを実機で読み取った後の復帰、iPhone/Androidのseek・倍速・buffering・lock/復帰、PCM補正後cueの人手時刻誤差は引き続き検証する必要があります。これらはbuild成功やPCエミュレーションだけでは完了しません。受入条件に集約します。

## 今回の公開Workerプレビュー

専用名は`ripola-preview-20261006`、入口は https://ripola-preview-20261006.ryomini13.workers.dev/ 、音声は[本一覧](https://ripola-preview-20261006.ryomini13.workers.dev/books/)から開きます。通常のworker profileを使い、青空文庫の公開全文と、明示allowlistで選んだ『吾輩は猫である・冒頭約1分（ずんだもん）』1冊だけを配置しています。local library全体をcopyせず、元WAV・生成query・job・env・秘密鍵は出力に含めません。

設定は配布rootの外に置き、今回だけ`workers_dev: true`、`preview_urls: false`を明示しました。生成された一般設定案の`workers_dev: false`は個人配布の既定として維持します。公開サンプルにはAccessを設定していません。`assets.directory`は検査済みの静的出力、`html_handling`は`auto-trailing-slash`、`not_found_handling`は`none`を使います。`/`と`/books/`の実HTMLを配り、任意のmissing assetや生成APIへHTMLを返すSPA fallbackを使わない構成です。音声Rangeだけを補う[専用Worker script](../../scripts/public-audio-worker.mjs)を追加しました。永続storage・provider secret・生成APIは追加しません。

更新時は公開権利とbook/revisionを確認し、専用allowlistからstage、新しいdirectoryへworker build、配布監査、`wrangler deploy --config deployment/public-preview.wrangler.jsonc --assets <検査済みの公開出力>`の順で反映します。アカウントを確認し、同名の別サービスを上書きしません。ビルドとdeployはTTSを呼びません。[localとの分担・将来の保存と同期](local-cloud.md)に現在の一方向配布と追加案をまとめます。

### 公開音声のRange補助

実ホストのasset直接配信はRange要求にも200全体応答だったため、専用公開プレビューだけは`run_worker_first: ["/library/books/*"]`とASSETS bindingを使います。Worker内のASSETS応答にはContent-Lengthがないため、build時に選択済みmanifestの検査済みbyte数だけを`library/audio-sizes.json`へ取り出します。HEADはそのサイズを返し、Range要求では元asset streamをContent-Length付きの200としてCache APIへ保存してから部分応答を取得します。audioを`arrayBuffer()`やbase64へ展開せず、asset streamをcloneもしません。manifestと未知のpathはASSETSへそのまま渡します。

[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)はContent-Length付きcacheのRangeへ206を返します。これは公開の内容hash付き音声の配信cacheで、永続蔵書・backup・localとの同期ではありません。cacheはdata centerごとで失効し得ます。metadataやcacheが使えなければ全体asset配信へ戻します。音声routeだけWorker実行の料金・CPU制約が適用されます。Access付き個人配布にこの公開cache設定をそのまま使わず、保護・cache方針を別途設計します。
