# ローカル生成UI・ジョブ・永続保存の契約

更新日：2026-10-06 UTC。詳細生成の主導線は同じPCの開発サーバーをブラウザから操作する画面です。CLIは共通の型付き生成サービスを呼ぶ補助入口です。本資料は開発契約であり、すべての項目が実装・検証済みという意味ではありません。現状は検証記録、操作と設定は[音声生成ガイド](../../.agents/skills/ripola-generate-audio/references/audio-generation.md)を参照してください。

公開先との機能の違い、将来のAPI生成・永続保存・持ち帰りと競合の段階案は[ローカルとクラウドの分担](local-cloud.md)を参照してください。現在のstage/deployは一方向の配布で、自動双方向同期ではありません。

## ブラウザとサーバーの分担

通常の取り込みReaderを保ち、ローカル版だけに詳細生成の入口を追加します。静的WebからPCのフォルダーへ自動保存する構成にはしません。IndexedDB／OPFSはorigin内のcacheであり、Git外のPC正本やバックアップとは別です。[File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)も、選択フォルダーへのアクセスとorigin内保存を分けています。

| 段階 | ブラウザが指定・確認するもの | 同じPCのサーバーが処理するもの |
| --- | --- | --- |
| 原稿 | 本文、抽出プレビュー、章・文・除外対象 | 検証した表示本文と原文、book/revisionを保存 |
| 読みと声 | ルビ・読み辞書、声、合成設定 | 発話原稿と辞書versionを固定。起動中Engineの声を取得 |
| 生成計画 | 無料VOICEVOX／有料Gemini、モデル、Google直結／Cloudflare Unified Billing（mock検証）、対象 | cache hit、対象差分、送信先、費用・容量を計算 |
| 開始確認 | 正確な送信本文、件数、対象、provider/model/endpoint、概算費用 | 確認したplanと対象を検査し、永続jobを登録 |
| 進捗・再開 | 完了・失敗・結果不明、取消、未完了分の再開 | TTS、音声保存、対応表、圧縮、状態とusageを保存 |
| 配布準備 | 本/revision、配布先、本文範囲、権利・帰属 | 明示allowlistから専用stagingを作る。deployは別操作 |

有料開始前の確認は必須です。本文・辞書・voice・model・対象が変わればplanを無効にし、再見積もりします。Cloudflareを選ぶ時は本文の送信先とクレジット課金を示します。未設定・未検証adapterを実行可能と表示しません。

無料の初期標準はVOICEVOXデスクトップアプリ同梱Engineです。同じPCのサーバーだけが`http://127.0.0.1:50021`へ接続します。Docker・Google keyは不要です。生成・保存後のスマホ再生にはEngineを使いません。

## 型付きの共通生成サービス

client-safe契約とNode側の設定・保存・providerを分けます。画面は計画・開始・状態取得・取消・再開の型付き操作を呼び、CLIも同じcoreを直接呼びます。cacheとjobの意味を入口ごとに変えません。StartのRPCを使う場合は[createServerFn](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)の薄いhandlerからcoreへ接続します。[SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode)とローカルserver機能は併用可能です。

server helperには[import protection](https://tanstack.com/start/latest/docs/framework/react/guide/import-protection)を適用し、Node coreもclient importを禁止します。client-safe DTOとsecret loaderを同じbarrelからexportしません。通常のroute loaderはclientでも実行され得るため、env読込・生成を置きません。[実行境界](https://tanstack.com/start/latest/docs/framework/react/guide/code-execution-patterns)を守ります。`createServerOnlyFn`はclientが呼ぶRPCの代替ではありません。

ブラウザからコマンド文字列を受け取ってCLIを起動するAPIは作りません。ffmpegやローカルPython alignment runtimeを使う場合は、設定済みbinaryへ検証済み引数配列を渡し、shellを介さず実行します。

## localhost・秘密・ファイルの境界

待受は`127.0.0.1`のみです。Hostを設定したloopback host/portに限定し、Origin／Fetch MetadataとCSRFを検査します。外部origin・不正Host・確認不能なbrowser requestを拒否します。Hostから信頼originを組み立てず、広いCORSで代替しません。StartのCSRF middlewareを使う場合も独自start設定で防御が外れないことを確認します。

`.env.local`はサーバー起動時に明示ロードし、CLIも同じ読込を使います。browserへ返すのは設定済み/未設定と非秘密の接続情報だけです。API key・token・ADC内容・生のenvをRPC、bundle、ログ、manifest、QR、stagingへ入れません。`VITE_*`は秘密の保存先ではありません。

保存rootはサーバー設定で管理し、画面から任意の絶対pathや`../`を受け付けません。book/revision/job/chunkのIDで操作します。upload名をpathへ流用せず、schema・size・hash、root外参照、symlink越しのアクセスを検査します。provider/endpointは設定済みadapterから選び、任意URLをbrowser入力でfetchしません。VOICEVOXはloopbackだけを許可します。

## 永続保存と完成状態

正本はGit管理外のフォルダーに置きます。保存先は起動設定で指定し、再clone、アプリ更新、配布先削除の影響から分けます。本文・原稿・音声・対応表・生成履歴を一緒に復旧できるようにします。初期coreの保存構成は次のとおりです。schemaはコードを正本とします。alignmentのjob/cacheはTTSと別に保持します。圧縮cacheは生成後に自動で作成し、配布時も検証済みbytesを再利用します。

```text
library/
  sources/<revision>.json          表示本文・元位置・rawText
  plans/<plan-id>.json             発話原稿・対象・見積もり
  jobs/<job-id>.json               attempt・完了/失敗/結果不明
  operations/<operation-key>.json  二重開始を同じjobへ結び付ける
  audio/<speech-key>.wav           保存した元音声
  cache/<speech-key>.json          完成状態・hash・実duration
  books/<id>_<revision>.json       文timelineを含むmanifest
  alignment-cache/<key>.json      CTC結果・元audio/spokenTextのhash・version
  alignment-jobs/<job-id>.json    整列chunkの進捗・再利用・中断/再開
  alignment-operations/           同じ開始operationを整列jobへ結び付ける
  alignment-owners/               runnerの生存確認（ローカルだけ）
  locks/                          server/CLI共有の排他
```

秘密は蔵書JSONに含めません。元MD/PDFを保存・配布するかは別の明示選択です。`ReadingDocument.rawText`には元本文が含まれるため、元ファイルのcopyをOFFにしても本文artifactは全文を含みます。

一時ファイルへ書き、hashとdurationを確認してrename等で完成状態を確定します。audio保存済み、対応表検査済み、staging検査済み、deploy取得確認済みを別の状態にします。完成audioを未完成map/manifestと組み合わせません。stagingは再作成できる複製で、正本のバックアップではありません。

## TTSを再実行しないキャッシュ

| keyの責務 | 入力 | 変更時の処理 |
| --- | --- | --- |
| 音声 | upstream API/engine version、model、voice、発話本文、辞書・正規化、合成条件 | 変更した文だけTTS。Lite/Flashは別音声で保存 |
| alignment | audio hash、発話本文、alignment version・条件 | 同じ音声から対応表だけ計算 |
| Reader map | alignment、表示offset、BudouX/規則version | 表示単位への対応だけ計算 |
| 圧縮 | 順序付きaudio hash、配信chunk、codec/bitrate/sample rate | 保存済み音声を圧縮。TTSを呼ばない |
| 本のrevision | artifact hash/schema、配布対象 | manifest/staging更新。TTSを呼ばない |

表示サイズ、黙読CPM、テーマ、配布URL、認証設定、Direct/Gatewayの通信経路だけを音声keyへ含めません。APIの意味やモデル条件が変わる時は別keyです。canonical入力、出力hash、実duration、request ID/attempt、usageを記録します。modelの更新でも完成物を黙って上書きせず、再生成は明示操作にします。

## jobを画面の寿命から分ける

開始ではplanとoperation IDを検査し、jobを保存してIDを返します。長い生成をHTTP応答やReact effectに結び付けず、画面はjob IDをpollします。二重クリック・通信再試行・reloadは同じoperationから既存jobを返します。複数タブとCLIは同じspeech keyの排他的lockを共有します。

queued/running/cancel-requested/cancelled/failed/outcome-unknown/completedを区別し、chunk別attemptと保存状態を残します。HMRでexecutorを重複起動しません。タブを閉じてもサーバーが動けばjobは進み、再接続で状態を読めます。サーバー終了後は完成物を照合し、送信済みで結果不明の有料chunkを自動再送しません。

取消は以降の送信を止め、完成物を残します。進行中requestのabortは上流の課金取消とは扱いません。明示再開でも保存済みTTSを再利用し、未送信・確認済み失敗分を対象にします。結果不明の再送は追加課金の可能性を示す別操作です。音声生成後のalignment/圧縮失敗では元audioから続けます。

## TTSと独立した整列ジョブ

[alignment-service.ts](../../apps/web/src/generation/core/alignment-service.ts)はspeech providerを呼びません。保存したbook/revision・対象chunk、確定`spokenText`を選び、元WAVのhashと発話原稿の完全一致を検査して整列します。ブラウザとCLIが同じserviceを使います。runtime/モデル未設定では文表示を保ち、自動install/downloadしません。

cache keyは`audioHash + exact spokenText + alignerVersion + normalizeVersion`です。完成CTC結果を再利用し、表示unitへの射影は元位置から計算します。原稿・audio・versionの不一致では採用しません。元WAVを変更せず、対応表をmanifestへ別途付けます。表示/配布失敗のためにTTSを再実行しません。

整列jobはqueued/running/cancel-requested/cancelled/failed/completedを区別し、chunk別のcompleted/failed/pending、aligned/partial/fallback、reusedを保存します。同じoperationとalignment keyは排他的lockを使います。HMRではprocess内runnerを共有し、停止後はowner/lockを検査して明示再開します。取消はPython childへabortを送り、完成cacheと元WAVを残します。中断したchunkは未完了へ戻し、再開では対応表だけを作ります。

runtimeのbinary・固定script・model directoryはserver設定だけから選びます。childへ渡す環境を限定し、Google key等を継承させません。stdin/stdoutのversion付きJSONで原稿・UTF-16区間・時刻を受け渡し、stderrに私的path/本文/生envを記録しません。`local_files_only`、offline設定、safetensors、標準CPUモデル、入力60秒/512整列文字とchild timeoutで処理を限定します。設定と明示セットアップは[利用者ガイド](../../.agents/skills/ripola-generate-audio/references/forced-alignment.md)を参照してください。

## 同期と公開build

初期は文ごとに合成し、実audio durationから文単位の境界を得ます。精度を文単位と表示し、文字数比例を精密alignmentと説明しません。保存WAVと確定した発話原稿へ日本語CTC forced alignmentを実行する独立serviceを実装しています。短い保存済み自作文で整列・再利用を確認し、人手goldによる境界時刻誤差は未測定です。VOICEVOXのmoraから時刻を生成する方式とGeminiのnative timestampは採用実装とは別です。[再生・同期設計](playback.md)を参照してください。

local profileだけに生成UI/API/Node coreを含めます。Pages/Workerはroute登録・entry・handler・生成function manifestから除外し、ナビゲーションを隠すだけにしません。公開WebからMacの生成APIへ自動接続する機能は追加しません。R2なしで正本からStatic Assetsへstageする契約を保ちます。

受入条件は検証計画へまとめます。設計の安全境界・重複防止を保証済みと説明する前に、実出力・endpointと再起動を検証します。

## Gateway adapterの現在の契約

通常経路は公式Wrangler remote AI bindingです。REST `/ai/run`は明示opt-in互換経路です。[設定・認証・応答metadata・ログ/cache・timeout・receipt](../../.agents/skills/ripola-generate-audio/references/gemini-cloudflare.md)が正本です。REST互換の3変数はサーバー内だけで読み、Googleキーをこの経路には送信しません。Gateway IDとadapter versionをplanの`routeIdentity`へ固定し、旧adapter計画やGateway指定変更後の実行を拒否します。`text`・`voice`入力、base64/信頼できるURLのWAV、結果不明の再送禁止、経路間の完成cache共有をmock検証しました。独立したstyle指示は未対応と明示し、非空のAPI入力を拒否します。実認証・残高・有料合成は未検証です。


## Wrangler既存ログインへの移行（2026-10-07）

通常CF経路は公式`getPlatformProxy`のremote AI bindingへ変更しました。手動tokenは必須ではありません。以前のRESTは明示opt-in互換経路です。Gateway ID指定と既存Wranglerログインで通常実行する実装です。管理API Readや課金設定の確認済みフラグは要求しません。有料実推論は未実施です。[現行設定と制約](../../.agents/skills/ripola-generate-audio/references/gemini-cloudflare.md)を正本としてください。Node保存・VOICEVOX・直Geminiは維持します。

## 新規生成後の自動整列・補正

`GenerationService.run`は全選択chunkのWAV/cache/manifestを保存した後、サーバーのPython/modelが設定済みでCTC adapterが利用可能なら`AlignmentService.start/wait`を自動実行します。CLI／ブラウザと全TTS経路で共通です。`GenerationJob.automaticAlignment`にrunning/completed/unavailable/failed/cancelledと整列job IDを記録します。生成ジョブは任意処理の終了後に完了し、補正だけの失敗をTTS失敗や再課金の理由にしません。停止要求は実行中のローカル整列jobも停止します。

音声cacheが揃う新しい生成ジョブにも適用します。旧完了操作の取得と本の閲覧では開始しません。モデル未設定時は追加取得しません。詳細・185回帰試験・実保存3冊のcache検証は補正記録へ記載しました。

## 生成後の自動圧縮

全経路の生成runnerは同期補正後に共通のMP3圧縮・検証処理を実行し、その処理の終了後に生成jobを完了します。`automaticCompression`に進捗、元／圧縮bytes、削除済み中間WAV bytes、保持WAV数と結果を記録します。生成途中の新規WAVだけを削除候補とし、保存済み補正・他文書の必要性・source hashとMP3のhashを検査します。圧縮と整列はspeech-keyのlockを共有し、読み取り中のWAVを削除しません。詳細な証拠・削除意図・失敗理由は私的`audio-compression-jobs`へ保存します。圧縮中のプロセス停止だけなら次回起動時にcacheを検査して自動再開し、TTSや有料APIを再送しません。補正待ちやcodecエラーでは必要なWAVを保持します。[保存形式と検証](mp3-library.md)を参照してください。

## 音声改善の共通接続口

`GenerationService`の`ServiceDependencies.providers`で任意providerを明示登録します。`SpeechAdapter`のoptional `endpoint`・`capabilities`・`fingerprint(options)`はサーバー側で管理し、`GenerationConfig.providers`へ秘密を含まない利用状態を返します。Irodoriを未登録でも通常のVOICEVOX/Geminiは変わりません。共通coreはモデルの取得やnative runtimeの起動を行いません。

合成要求はoptional `signal`と計画の`providerVersion`を渡します。`capabilities.cancellation='abort'`を明示したadapterだけが同じrunnerからの停止で進行中signalを受けます。未指定の既存adapterは以降の送信を止め、進行中の完成音声を保存する従来動作です。上流の課金取消を意味しません。

`GenerationOptions.chunking`の欠落時は文単位です。`mode='auto'`は明示登録した`planChunks`へ、本文・options・providerVersion・能力・既定の文範囲を渡します。plannerは`{spans, version, settingsFingerprint}`を返し、coreが本文順・全範囲・ルビ境界を検査して安定chunk IDとspeech keyを作ります。planner identityは計画と本のrevisionへ含め、同じ発話本文・合成条件の完成音声は再利用します。`getJobPlan`は保存済み計画の未完了subsetを返す再開用プレビューです。新plannerを実行せず、旧chunkやcache keyを変更しません。

`startGeneration.prioritizedChunkIds`と`prioritizeJobChunks(jobId, chunkIds)`は未来の実行順だけを変えます。指定は重複のない対象IDのsubsetで、残りは本文順です。各jobのrunnerの並行数は1を維持し、進行中requestは置換しません。plan/job/manifestのchunk配列は本文順を保ちます。`GenerationJob.executionOrder`がない旧jobは従来順です。

部分manifestにはoptional `plannedChunkIds`（未保存分を含む本文順）と`generation={jobId,planId,planHash,sequence}`を保存します。`sequence`はbook lock内で公開ごとに増え、音声cacheのrevisionとは別です。これはmanifest公開の識別であり、整列・圧縮の検証を代替しません。`SavedAudioChunk.sourceOrder`は全計画内の位置です。旧本でこれらが欠ける場合は既存配列の順序を使い、閲覧時に保存本や音声を書き換えません。


### 後工程の補正とWAVクリーニング

`AlignmentService`は完了した補正の対象に対して`cleanupSavedWavs`を実行し、jobの`wavCleanup`へ削除件数・bytes・保持件数を記録する。取消・失敗時と`automaticCompression: false`では実行しない。クリーニング失敗で補正を再送しない。待機APIはクリーニングまで待つ。

生成直後と後工程の削除は`WavReferences`の共通参照検証を使う。speech lockとbook-references lockの下で、MP3 bytes/proof、元WAV hash、保存補正のhash、全bookの参照を照合する。未補正・異なるhash・使用中・破損は保持する。明示CLI `pnpm cleanup:audio`は同じ検証で計画と適用を行い、合成・model・再encodeは起動しない。操作IDごとの対象hashとファイル単位の削除意図を保存して、中断後の再実行にも対応する。
