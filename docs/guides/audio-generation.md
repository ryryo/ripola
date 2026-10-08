# ブラウザから音声を生成・再利用する

更新日：2026-10-06（Asia/Tokyo）。ローカル版のトップページでテキストのみの生成と音声生成を選べます。以下はその操作・設定の入口です。実行済みの接続・生成・保存・再開・再生試験は検証記録で確認してください。公開サイトの来訪者が音声生成する構成ではありません。 公開版には「VOICEVOX · ローカルPC版限定」と理由を表示し、「ローカルPC版とは」から環境の違いを確認できます。公開Gemini生成も提供していません。

## 無料VOICEVOXで始める

1. [VOICEVOX公式サイト](https://voicevox.hiroshiba.jp/)で自分のOS用インストーラーを取得し、公式の案内に従ってデスクトップアプリをインストール・起動します。検証したEngineは0.25.2です。Dockerは不要です。
2. [起動手順](setup.md#最小の読書)で開発サーバーを開き、トップページへ進みます。
3. ファイルまたは貼り付けで原稿を指定し、「音声も生成する」をオンにします。確認中・最終確認結果と時刻が表示されます。未接続なら同じPCでEngineを起動して「接続を再確認」を押します。同じ原稿のまま、無料VOICEVOXと起動中Engineから取得した声を選びます。「読みを調整する」から読み辞書を設定できます。
4. 「生成内容を確認する」で本文・対象文・再利用・発話原稿を確認し、「確認した対象を無料生成する」で開始します。
5. jobの完了後、「保存した音声」（`/library`）から「保存音声を読む」で本を開きます。原文の区切りを一つずつ表示します。未整列では表示用の推定時刻を使い、採用できるCTCやEngine時刻は別方式として示します。

音声設定を閉じても、タイトル・本文・自動／手動の貼り付け形式・読み辞書を保持します。接続再確認は合成を開始せず、確認中・取得失敗・未接続では生成操作を無効にします。表示時刻は最後の確認時点で、稼働し続ける保証ではありません。「テキストのみ生成して読む」は音声生成を開始しません。音声の接続に失敗した場合もテキストで読めます。`/generate` の従来の詳細生成フォームも利用できます。

Nodeサーバーは固定の`http://127.0.0.1:50021`へ接続します。ブラウザ、スマホ、配布先WorkerからEngineを直接呼びません。起動中の仕様は`http://127.0.0.1:50021/docs`で確認できます。[公式Engine案内](https://github.com/VOICEVOX/voicevox_engine/blob/master/README.md#api-ドキュメント)を参照してください。起動していなければアプリ起動を案内し、クラウドへfallbackしません。

無料選択にGoogle keyは不要です。音声と対応表を保存した後はVOICEVOXを閉じて構いません。再生では保存済み音声を使います。選択する声・キャラクターごとの[音声利用規約](https://voicevox.hiroshiba.jp/term/)とクレジットを確認してください。Engine単体のnative配布も利用できますが、同じHTTP APIへの接続として扱います。

## PC側の設定

通常読書・VOICEVOX・音声補正にはenvの設定が不要です。補正環境は `pnpm setup:audio` が自動準備します。Directだけ `.env.local` に `GEMINI_API_KEY`、Cloudflareは既存Wrangler認証とプロジェクトのGateway選択を使います。VOICEVOXの標準URL・ずんだもん、Gemini Liteモデルを既定とします。

NodeとCLIが同じ設定を読み、既存envを保持してprocess環境を優先します。秘密はbrowser、manifest、QR、ログ、staging、Gitへ返しません。通常例は [.env.example](../../.env.example) の1項目、特殊な保存先と既存互換は[設定設計](configuration.md)を参照してください。
## 有料Geminiの開始前に確認する

採用モデルは`gemini-3.8-flash-lite-tts`（有料内の既定）と`gemini-3.8-flash-tts`（明示選択）の2種類だけです。Developer APIのDirect Interactions adapterを基準とします。Cloud Text-to-Speech APIの3.8対応を仮定しません。Enterpriseは認証・契約が異なる別経路です。[仕様・提供条件・費用調査](../research/tts.md)を確認してください。

有料生成前に、正確な発話本文、対象文、再利用/新規件数、provider/model、送信endpoint、概算費用を画面で確認します。本文・読み・声・model・対象を変えたら計画し直します。費用は出力音声の算術見積もりで、実入力token代、実duration、retry、税を含む請求保証ではありません。

承認済み試験ではCloudflare Liteの実合成・保存を確認しました。Directも実生成13文・67.76秒を保存済みです。新キーの作成・Google課金設定の変更・クレジット購入はしていません。設定済みでも利用条件・quota・billingを確認し、明示した計画だけを開始します。モデルや経路を自動で切り替えません。

明示opt-inのREST互換経路は公式`/ai/run`へ`google/`モデルIDと`text`・`voice`を送ります。アプリのGoogleキーを送らず、課金元はGatewayの設定に従います。Googleのdefault BYOKがあればそのキーが優先されます。mock検証済み、実合成・残高は未検証です。[2経路の設定ガイド](ai-gateway.md)を確認してください。自動fallback・有料再送は行いません。

### Directのローカル設定例

通常読書やVOICEVOXでは設定不要です。Geminiを使う段階で、repo rootの `.env.local` に次の行を追加します。実際のキーはこのファイルへ直接入力し、既存のalignment設定は保持してください。

```dotenv
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

変更後はローカルサーバーを再起動します。[Google公式のキー管理](https://ai.google.dev/gemini-api/docs/api-key)と[TTS仕様](https://ai.google.dev/gemini-api/docs/speech-generation)で利用条件・billing・quotaを確認してください。アプリの概算は請求上限ではありません。キー設定だけでは送信しません。生成ごとの明示確認を必要とし、旧envの有料停止指定も尊重します。

### Gatewayのローカル設定

[2経路ガイド](ai-gateway.md)に従い、既存Wranglerログインと既存Gatewayを使います。Gateway IDを指定すれば通常生成を利用できます。読み上げ方の独立した指示はこの経路で未対応と表示し、発話本文へ混ぜません。

トップと`/generate`でGeminiを選ぶと経路を明示選択できます。Gateway設定を読む管理APIや確認済みフラグは生成の条件にしません。Cloudflareへも本文が通ることを確認し、明示的な有料確認から開始します。通常は公式Wrangler APIが既存ログインを利用し、手動tokenは不要です。実キー設定・資源作成・有料合成は今回未実施です。

## 中断・再開・キャッシュ

「ここで停止する」は以降の送信を止め、進行中の1文が終われば停止します。完成済み音声は残します。タブを閉じてもサーバーが動けばjobは進み、画面を開き直して状態を取得できます。サーバー停止後は明示的に再開します。

同じ発話原稿・声・model・合成条件の完成音声は再利用します。表示設定、通信経路、alignment、圧縮、配布先の変更だけでTTSを再実行しません。生成後の対応表・圧縮失敗は保存済み音声から続けます。結果不明の有料requestは再起動だけで再送せず、未送信/安全に再開できる分を対象にします。取消は上流課金の取消を意味しません。

未整列でも原文の全区切りを表示用の推定時刻で一つずつ表示します。前後の文・フレーズ、原文からのseek、0.5〜3倍の再生率（既定2.5倍）を使えます。非表示で停止し、保存した読書位置へ戻る時も停止状態です。

基本の文境界は1文の実WAV durationから得ます。任意の日本語CTC整列は保存したWAVと確定発話原稿を使い、採用できる時刻だけをBudouXフレーズへ対応させます。Geminiのnative timestampや有料実音声での整列精度は未確認です。読みの補正後も表示本文と発話本文を別に保存します。[ジョブと保存の契約](../development/local-generation.md)を参照してください。

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

`input.json`は`PrepareGenerationInput`（表示文書＋生成options）です。原稿・plan出力には私的本文を含み得るためGitへ入れません。有料開始/再開には`--paid-confirmed`も必要で、先に送信本文・endpoint・費用を確認します。共有DTOは[contracts.ts](../../apps/web/src/generation/contracts.ts)、計画・ジョブ・再利用は[core/service.ts](../../apps/web/src/generation/core/service.ts)を正本とします。

## 配布準備

完成した本を明示allowlistで選び、検証済みの圧縮音声を専用stagingへ出します。圧縮済み音声はそのまま使い、再圧縮しません。公開Pagesのデモには権利と声の再配布条件を確認した自作文や出典を示した青空文庫サンプルを使い、個人の原稿を混ぜません。初期はR2なしです。QRは実際に本を配布した通常HTTPS URLを開く用途で、localhostの本をスマホへ自動転送しません。[静的配布ガイド](../development/distribution.md)を参照してください。

## 音声を保存した後の自動補正

このPCのローカル整列Pythonと固定モデルが設定済みで利用可能なら、全選択文を保存した後に時刻の整列・音声補助推定も自動実行します。VOICEVOX／Gemini直結／Cloudflare経由で共通です。設定がない場合は音声を保存し、文字数から時刻を推定します。モデルを自動取得せず、補正失敗時も音声を再生成しません。[条件と制限](forced-alignment.md#新しい音声の自動補正)を参照してください。

## 保存容量の自動削減

VOICEVOX／Geminiとも、新しい音声は同期補正後に自動で圧縮・検証し、圧縮済み音声で再生します。形式を指定する操作は不要です。容量が小さくなり、元音声の時計と一致することを検証したものだけ採用します。今回新しく合成したWAVは、補正が完了し、他の本でも必要とされていなければ中間ファイルとして削除し、実際の保存容量を減らします。元音声が必要な場合や圧縮に失敗した場合は保持し、生成画面に状態を表示します。圧縮や配布のために音声を再生成することはありません。
