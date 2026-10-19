# ブラウザから音声を生成・再利用する

手順整理：2026-10-19（Asia/Tokyo）。ローカル版のトップページでテキストのみの生成と音声生成を選べます。この資料は人が直接使える操作手順です。実行済みの接続・生成・保存・再開・再生試験は[検証記録](../../../../docs/validation/public-release/README.md)で確認してください。公開サイトの来訪者が音声生成する構成ではありません。公開版には「VOICEVOX · ローカルPC版限定」と理由を表示し、「ローカルPC版とは」から環境の違いを確認できます。公開Gemini生成も提供していません。

## 生成方式を選ぶ

- 無料のローカル合成は[VOICEVOXの手順](voicevox.md)へ。
- GeminiをGoogleへ直接送る場合は[Directの手順](gemini-direct.md)へ。
- GeminiをCloudflare経由で使う場合は[Gatewayの手順](gemini-cloudflare.md)へ。
- 実験中のIrodoriは[明示的に有効化する手順](irodori.md)へ。通常の生成には不要です。

指定された方式の手順だけを読み、別providerや経路へ自動で切り替えません。以下は方式に共通する確認・保存・再開の手順です。

## 原稿を取り込んで生成する

1. [起動手順](setup.md#最初の起動)でローカルサーバーを開き、トップページでファイルまたは貼り付けから原稿を指定します。長い原稿やOCR由来の崩れがある場合は[原稿整形](../../ripola-prepare-manuscript/references/cleanup.md)と[分割](../../ripola-prepare-manuscript/references/splitting.md)を先に行います。
2. 「音声も生成する」をオンにし、選んだprovider・経路・声と読み辞書を設定します。新しい声や未確認の固有名詞は、短い代表範囲を生成して試聴します。
3. 「生成内容を確認する」で表示本文・発話原稿・対象文・新規/再利用件数・送信先、有料時は概算費用を確認して開始します。初回は試聴した声・読みを確認してから残りを生成します。設定変更時は計画を作り直します。
4. jobの完了後、「このPCの本棚」（`/library`）から本を開きます。生成・再利用・未完了件数、補正と圧縮の状態を確認します。読み飛ばしや音割れ等が疑われる場合は[保存音声QA](../../ripola-check-audio/references/saved-audio.md)を使います。

元の個人原稿、CLI入力JSON、分割記録、計画はGit対象外へ保存します。既に生成済みの同じ範囲を、試聴のためだけに再合成する必要はありません。

## PC側の設定

通常読書・VOICEVOX・音声補正にはenvの設定が不要です。補正環境は `pnpm setup:audio` が自動準備します。Directだけ `.env.local` に `GEMINI_API_KEY`、Cloudflareは既存Wrangler認証とプロジェクトのGateway選択を使います。VOICEVOXの標準URL・ずんだもん、Gemini Liteモデルを既定とします。

補正セットアップはmacOS ARM64とLinux x64・CPython 3.13が対象です。Ubuntu 24.04標準Python 3.12は使わず、Python 3.13とffmpeg/ffprobeを先に準備します。Windows native・Linux ARM64・Intel Macは対象外です。

NodeとCLIが同じ設定を読み、既存envを保持してprocess環境を優先します。秘密はbrowser、manifest、QR、ログ、staging、Gitへ返しません。通常例は [.env.example](../../../../.env.example) の1項目、特殊な保存先と既存互換は[設定設計](configuration.md)を参照してください。

## 有料Geminiの開始前に確認する

採用モデルは`gemini-3.8-flash-lite-tts`（有料内の既定）と`gemini-3.8-flash-tts`（明示選択）の2種類だけです。Developer APIのDirect Interactions adapterを基準とします。Cloud Text-to-Speech APIの3.8対応を仮定しません。Enterpriseは認証・契約が異なる別経路です。[仕様・提供条件・費用調査](../../../../docs/research/tts.md)を確認してください。

有料生成前に、正確な発話本文、対象文、再利用/新規件数、provider/model、送信endpoint、概算費用を画面で確認します。本文・読み・声・model・対象を変えたら計画し直します。費用は出力音声の算術見積もりで、実入力token代、実duration、retry、税を含む請求保証ではありません。

承認済み試験ではCloudflare Liteの実合成・保存を確認しました。Directも実生成13文・67.76秒を保存済みです。新キーの作成・Google課金設定の変更・クレジット購入はしていません。設定済みでも利用条件・quota・billingを確認し、明示した計画だけを開始します。モデルや経路を自動で切り替えません。

明示opt-inのREST互換経路は公式`/ai/run`へ`google/`モデルIDと`text`・`voice`を送ります。アプリのGoogleキーを送らず、課金元はGatewayの設定に従います。Googleのdefault BYOKがあればそのキーが優先されます。mock検証済み、実合成・残高は未検証です。[2経路の設定ガイド](gemini-cloudflare.md)を確認してください。自動fallback・有料再送は行いません。

### 接続の設定

Google直結は[Directの設定](gemini-direct.md)、Cloudflare経由は[Gatewayの設定](gemini-cloudflare.md)を使います。トップと`/generate`で経路を明示選択します。Gatewayの独立した読み上げ指示は未対応なので、発話本文へ混ぜません。設定を読む管理APIや確認済みフラグは生成条件にしません。

## 中断・再開・キャッシュ

「ここで停止する」は以降の送信を止め、進行中の1文が終われば停止します。完成済み音声は残します。タブを閉じてもサーバーが動けばjobは進み、画面を開き直して状態を取得できます。サーバー停止後は明示的に再開します。

同じ発話原稿・声・model・合成条件の完成音声は再利用します。表示設定、通信経路、alignment、圧縮、配布先の変更だけでTTSを再実行しません。生成後の対応表・圧縮失敗は保存済み音声から続けます。結果不明の有料requestは再起動だけで再送せず、未送信/安全に再開できる分を対象にします。取消は上流課金の取消を意味しません。

未整列でも原文の全区切りを表示用の推定時刻で一つずつ表示します。前後の文・フレーズ、原文からのseek、0.5〜5倍の再生率（既定2.5倍）を使えます。非表示で停止し、保存した読書位置へ戻る時も停止状態です。

再生中は、現在の音声の読み込み完了後に、再生速度を考慮して約20秒先までを目安に先読みします。通信の遅延に応じて範囲を広げますが、ファイル数・メモリの上限を設け、データ節約設定では次の1ファイルに抑えます。読み込みが間に合わない場合は、通常画面・全画面ともに「音声を読み込み中…」とローディング表示を出し、準備ができると続きを再生します。待機中も一時停止できます。未生成の続きは「次の音声の生成を待っています」と区別して表示します。

基本の文境界は1文の実WAV durationから得ます。任意の日本語CTC整列は保存したWAVと確定発話原稿を使い、採用できる時刻だけをBudouXフレーズへ対応させます。Geminiのnative timestampや有料実音声での整列精度は未確認です。読みの補正後も表示本文と発話本文を別に保存します。[ジョブと保存の契約](../../../../docs/development/local-generation.md)を参照してください。

## 保存音声にフレーズ時刻を追加する

任意の[日本語CTC整列ガイド](forced-alignment.md)で、Python runtimeと固定モデルを明示セットアップします。「保存音声にフレーズ時刻を追加」から対象文を選び、対応表だけを作成・中断・再開できます。TTSと有料APIを再実行しません。

原稿との元位置対応とCTCスコア0.75以上を満たすcueだけを整列時刻として採用します。弱い範囲・未知文字・無音・gapでも原文の区切りを保ち、表示用の推定と「時刻未検証」を示します。採用scoreを推定時刻へ流用しません。内部のprecision/method値はdata属性に保持します。スコアは時刻精度の確率ではありません。再生時にモデルや依存をdownloadする処理はありません。

## CLIは補助入口

CLIはbrowserからshellとして実行せず、同じ生成coreを直接呼びます。repo rootから利用します。

```sh
pnpm exec tsx scripts/generate-audio.ts config
pnpm exec tsx scripts/generate-audio.ts jobs
pnpm exec tsx scripts/generate-audio.ts books
pnpm exec tsx scripts/generate-audio.ts plan <input.json>
pnpm exec tsx scripts/generate-audio.ts start <plan-id> --operation=<一意の操作ID>
pnpm exec tsx scripts/generate-audio.ts cancel <job-id>
pnpm exec tsx scripts/generate-audio.ts resume <job-id>
```

`input.json`は`PrepareGenerationInput`（表示文書＋生成options）です。原稿・plan出力には私的本文を含み得るためGitへ入れません。有料開始/再開には`--paid-confirmed`も必要で、先に送信本文・endpoint・費用を確認します。共有DTOは[contracts.ts](../../../../apps/web/src/generation/contracts.ts)、計画・ジョブ・再利用は[core/service.ts](../../../../apps/web/src/generation/core/service.ts)を正本とします。

## 配布準備

完成した本を明示allowlistで選び、検証済みの圧縮音声を専用stagingへ出します。圧縮済み音声はそのまま使い、再圧縮しません。公開Pagesのデモには権利と声の再配布条件を確認した自作文や出典を示した青空文庫サンプルを使い、個人の原稿を混ぜません。初期はR2なしです。QRは実際に本を配布した通常HTTPS URLを開く用途で、localhostの本をスマホへ自動転送しません。[静的配布ガイド](../../../../docs/development/distribution.md)を参照してください。

## 音声を保存した後の自動補正

利用者のローカルPCで整列Pythonと固定モデルが設定済みで利用可能なら、全選択文を保存した後に時刻の整列・音声補助推定も自動実行します。VOICEVOX／Gemini直結／Cloudflare経由で共通です。設定がない場合は音声を保存し、文字数から時刻を推定します。モデルを自動取得せず、補正失敗時も音声を再生成しません。[条件と制限](forced-alignment.md#新しい音声の自動補正)を参照してください。

## 保存容量の自動削減

VOICEVOX／Geminiとも、新しい音声は同期補正後に自動で圧縮・検証し、圧縮済み音声で再生します。形式を指定する操作は不要です。容量が小さくなり、元音声の時計と一致することを検証したものだけ採用します。MP3は48kbps・モノラル・24kHzです。補正が完了し、他の本でも必要とされていなければ、今回生成したWAVに加え、以前の失敗で残った再利用WAVも削除して保存容量を減らします。元音声が必要な場合や圧縮に失敗した場合は保持し、生成画面に状態を表示します。圧縮や配布のために音声を再生成することはありません。


後工程で「保存音声にフレーズ時刻を追加」した場合も、完了後に検証済みMP3がある対象WAVを自動クリーニングします。生成jobの古い`automaticAlignment`状態だけでは判断せず、保存された補正の元音声hash、全蔵書の参照、MP3の実ファイルと時刻検証情報を確認します。選択chunkだけを補正した場合はその対象だけを確認します。未補正・異なるhashの参照・検証失敗・使用中のWAVは保持し、alignment jobの`wavCleanup`に結果を記録します。補正失敗・取消時はクリーニングを実行しません。`automaticCompression: false`の利用者設定では自動クリーニングも行いません。

過去の実行で残ったWAVや、クリーニングの中断・失敗は、音声生成や補正をやり直さず次のCLIで回復します。これはWAVを削除して空き容量を増やす処理です。同じディスク内の`archive-wav`への移動とは異なります。対象と削除操作が依頼で承認されている範囲だけ`--apply`します。

Git対象外の`selection.json`に自分の保存元と対象を明示します。

```json
{
  "libraryDir": "/absolute/path/to/your-library",
  "books": [{ "id": "YOUR_BOOK_ID", "revision": "YOUR_REVISION_HASH" }]
}
```

```sh
# 検証と計画だけ。WAVは削除しない
pnpm cleanup:audio --config /private/selection.json --operation cleanup-001 --report /private/cleanup-plan.json
# 同じ条件を再検証して適用。reportには新しいpathを使う
pnpm cleanup:audio --config /private/selection.json --operation cleanup-001 --report /private/cleanup-result.json --apply
```

中断した適用は同じ操作ID・同じ対象で再実行できます。hashに結び付けた削除意図と結果をlibrary内へ記録し、完了済み削除を重複計上しません。新たに削除が必要になった場合は別の操作IDを使います。結果の`removedWavBytes`、`retainedWavFiles`と各保持理由を確認します。保持対象を消すために参照や検証情報を書き換えません。原稿の原本・MP3・同期情報・配布物は削除対象外です。
