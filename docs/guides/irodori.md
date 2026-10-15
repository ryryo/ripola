# Irodoriを開発用に有効化する

Irodoriは音声品質の検証中で、通常のGUIでは非表示・無効です。実装、導入済みモデル、設定、生成済み音声は保持します。保存済み音声の閲覧・再生に有効化は不要です。

ローカル開発・検証で使うときだけ、リポジトリの`.env.local`へ次を追加し、サーバーを再起動してください。

```dotenv
RSVP_ENABLE_EXPERIMENTAL_IRODORI=true
```

一時的に起動する場合は`RSVP_ENABLE_EXPERIMENTAL_IRODORI=true pnpm dev`も使えます。未設定・`false`など`true`以外では無効です。環境変数は`.env.local`より優先されます。戻す場合は設定を削除するか`false`にして再起動します。モデルの導入済み状態や実行ファイルの指定だけでは有効になりません。

有効なときだけ、ローカルGUIの生成方法へIrodoriと導入・設定画面が現れます。無効時は導入・設定のサーバー操作と、新規生成・生成再開も拒否します。既存音声の再生・保存処理の再試行は使えます。Pages/Workerの公開画面にはこの設定で生成UIは追加されません。CLIは従来どおり明示的な検証に利用できます。

Irodori v4.1 Small通常版は日本語のローカル音声合成です。VOICEVOX/Geminiを引き続き使えます。モデルは約1.91GB（1,905,903,936 bytes）で、新規導入には約2.2GBの空き容量が必要です。合成中のメモリーと完成音声用の容量は別途必要です。このPCでの速度・メモリー使用量・聴感は未測定です。記事や上流の測定値をこのPCの性能保証にはしていません。

通常起動、`pnpm setup:audio`、本の閲覧、スマホ再生ではIrodoriを取得しません。ローカルの音声設定から「Irodoriを追加する」を選んだときだけ取得します。モデルとvoiceはPCに置き、スマホとCloudflareの静的配布には完成したWAV/MP3と既存の本文・対応表だけを渡します。

## モデルの明示導入と再開

UIで取得容量と空き容量を確認して追加します。取得・検証の進捗を表示し、取消しと再開ができます。CLIからも同じ管理処理を使えます。

```sh
# 状態の確認だけ。取得はしない
pnpm exec tsx scripts/setup-irodori.ts status
# 明示取得。Ctrl+Cで取消し。同じコマンドで途中から再開
pnpm exec tsx scripts/setup-irodori.ts install
# 別ターミナルから取得・検証を取り消す
pnpm exec tsx scripts/setup-irodori.ts cancel
```

`.reader-data/irodori/`はGit管理外です。取得中は`.gguf.part`と固定資材の情報を保持します。再開時は同じrevisionの残りをHTTP Rangeで要求し、Rangeに対応しない応答は途中ファイルを置き換えます。失敗・取消し後の途中資材をruntimeへ渡しません。容量とSHA-256を検証してから完成`.gguf`へ変更し、検証記録を保存します。チェックサム不一致なら途中資材を破棄して再取得し、完成扱いにしません。容量不足や通信断では途中資材を残して再開できます。起動前にも完成モデルを検証します。

取得元は[sakasegawaのGGUF配布](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-GGUF/tree/66fe2cde1973fd44e7202fbe36df722103958188)です。

| 固定項目 | 値 |
| --- | --- |
| revision | `66fe2cde1973fd44e7202fbe36df722103958188` |
| ファイル | `Irodori-TTS-859M-v4.1-F16.gguf` |
| SHA-256 | `f334932bdf166579bada0a3c8bdabb7199af85682fdcefb6f1cb7e444f5c75b3` |

## 実行環境と既定の男女声

Ripolaはspeech.cpp実行ファイルを自動取得しません。[公式インストール手順](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/install.md)を確認して、対応するspeech.cpp 0.8.3以降の0.8系を用意してください。`PATH`、`~/.local/bin/speech`から検出します。別の場所では`.env.local`の`RSVP_IRODORI_EXECUTABLE`に絶対pathを指定してRipolaを再起動します。binaryの内容もcache identityに含めます。

既定は、受付声オーディションの合成音声から作った固定参照を使う「丁寧な受付（女）」「丁寧な受付（男）」です。男女それぞれの同じ参照を全区間へ渡します。通常版、40 steps、速度1、seed 42を使います。

| 声 | 既定プロンプト |
| --- | --- |
| 女 | 明朗快活な受付嬢。明るく丁寧にてきぱきと |
| 男 | 明朗快活な男性の受付スタッフ。明るく丁寧にてきぱきと |

「声・スタイル」で男女を選び、合成設定の「声・読み上げ方のプロンプト」を編集して保存します。男女の設定は別々にPCへ保存され、「プロンプトを既定に戻す」で選択中の声の指示文を復元できます。変更後は生成計画を更新してください。プロンプトは参照の声に合った読み方・感情の調整に使います。話者と矛盾する指示は音質を不安定にすることがあります。固定参照は話者を条件付けますが、完全な声質一致を保証するものではありません。

通常版には `sway_coeff=-1`、`cfg_guidance_mode=independent`、`cfg_scale_text=3`、`cfg_scale_instructions=3`、`cfg_min_t=0.5`、`cfg_max_t=1`を指定します。以前のMFで作成した計画・cacheを通常版として再開せず、新しい計画を作ります。保存済みの完成音声はそのまま再生できます。

通常版の受付声では同梱の男女固定参照を読み込み、従来のMF固定voice登録は読み込みません。MF用のvoiceが残っていても通常版の起動を妨げません。登録情報と従来の設定ファイルはPCに保管します。以下は旧固定voiceの登録形式です。受付声の準備には不要です。

話者の明示的な同意、利用・再配布条件を確認できる**既存のGGUF voice資材**だけを登録できます。自作fixtureを実voiceと説明しません。Ripolaは録音、voice生成、話者学習、speaker inversionを自動実行しません。voiceの作成・同梱・配布権利はモデルのMIT条件だけでは決まりません。許可が確認できない資料・第三者録音を使用しないでください。

```sh
pnpm exec tsx scripts/setup-irodori.ts register-voice \
  --file=/absolute/path/authorized.voice.gguf \
  --label='許諾済みの声' \
  --source='資材の取得元・同意記録の参照' \
  --license='利用・配布の条件' \
  --attribution='必要なクレジット' \
  --confirm-voice-rights
```

登録時と利用時に資材のchecksumを検証します。既存GGUFのcodec互換性はnative runtimeが確認します。参照録音由来のvoiceは、上流仕様では合計120秒までの参照を保持し、codecのhashに結び付いています。speaker inversion由来のvoiceは作成元のモデルだけに対応します。[公式voice条件](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/models/irodori-tts.md#voices)と[第三者条件の記録](../licenses/irodori.md)を確認してください。

登録voiceの帰属は保存bookへ記録します。静的配布では既存のallowlistで指定した`attribution`が使われるため、そこにもvoiceの必要クレジットを含め、完成音声の配布条件を確認してください。モデル・voice本体や私的な同意記録は配布しません。

モデル・実行ファイルが揃ってからUIの「このPCで起動」を押します。Ripolaが所有するprocessだけを起動・終了します。通常起動や状態確認では起動しません。起動失敗は生成不可として示し、VOICEVOX/Geminiへ勝手に切り替えません。runtime停止中でも完成音声の閲覧・配布は継続できます。

補助CLIでは、Irodoriの`plan`/`start`/`resume`コマンドに`--irodori-start`を付けたときだけ、そのCLIが所有するruntimeを起動します。モデル取得は行わず、コマンド終了時にruntimeを終了します。設定確認や従来providerのコマンドには追加の起動条件はありません。

## 合成設定、長文、保存

通常版の既定は40 stepsです。以前の固定voice用設定は別の`settings.json`に保持し、新しい男女声の設定とは混ぜません。stepsを減らすことは計算回数の変更で、F16モデルの保存容量を小さくする操作とは別です。速度、steps、seed、任意の指示、モデル・voiceのchecksum、native実行ファイルとモデル情報をfingerprintに含め、変更した条件のcacheを区別します。参照なしで生成した既存cacheとも区別します。モデル・voice・設定が変わった計画は見直してください。完成音声を表示・整列・圧縮の変更だけで再合成しません。

上流の上限は1回256 tokens・30秒です。Ripola側では1回90文字、正規化後のbyte fallbackを含む256 token予算、速度に応じた推定時間予算で送信前に制限します。90文字はアプリ側の制限で、モデルの固定上限ではありません。正確なtoken数はnative tokenizerが判断し、音声の上限は速度と原稿にも左右されます。上限で切れた出力や30秒を超える出力を完成扱いにしません。Irodoriでは自動分割と組み合わせ、元位置を保って短いchunkへ計画します。推定時間は実測時間ではなく、正確なnative token数・音質・速度は実モデルで確認する必要があります。辞書登録は利用の前提ではありません。

Ripolaは[HTTP API](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/server.md)の`POST /v1/audio/speech`へ送信します。選択した固定voiceと読み方のプロンプト、WAV形式を要求し、完了header、PCM形式・容量・長さ・全無音を検査して、既存のWAV保存→alignment→MP3→静的配布へ接続します。HTTP側も文単位に再分割し、文間の静かな部分が0.9秒以上になるよう補います。アプリの区間数とnativeの合成回数は一致しないことがあります。これは声の自然さ・読みの正確さの保証ではありません。合成取消しはHTTP接続をabortし、nativeも停止します。取得取消しと合成取消しは別です。

公式[worker protocol v3](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/worker.md)も調査しましたが、この実装はHTTPを使います。対応仕様の確認元はspeech.cpp commit `60a8e1ec068280e5e803ee5d7079e90886c323cb`（2026-10-12確認）です。

## この実装で未確認のこと

大容量モデルを新規取得せず、短い自作fixture・mock native endpoint/processで導入・再開・取消し・送信・保存・cacheを検査します。固定参照は同じ通常版モデルで作った合成音声です。参照元の長さは女声5.32秒・男声5.4秒で、上流が推奨する30秒以上より短いため、完全な話者一致を確認した成果としては扱いません。複数の異なる文章を実際に生成して聴き比べてください。後続の実測は専用benchmark lockを取得して直列実行し、モデル版・設定・原稿・実行回数・失敗・ばらつきを記録してください。
