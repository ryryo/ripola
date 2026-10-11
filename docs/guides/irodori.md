# IrodoriをこのPCへ任意追加する

Irodori MFは日本語のローカル音声合成です。VOICEVOX/Geminiを引き続き使えます。モデルは約1.92GB（1,920,321,792 bytes）で、新規導入には約2.2GBの空き容量が必要です。合成中のメモリーと完成音声用の容量は別途必要です。このPCでの速度・メモリー使用量・聴感は未測定です。記事や上流の測定値をこのPCの性能保証にはしていません。

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

取得元は[sakasegawaのGGUF配布](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF/tree/69d307a472a1708c5637edcfe376d31c2685829d)です。

| 固定項目 | 値 |
| --- | --- |
| revision | `69d307a472a1708c5637edcfe376d31c2685829d` |
| ファイル | `Irodori-TTS-866M-MF-v4.1-F16.gguf` |
| SHA-256 | `e237dc3eefe469b8bba87872beacf12fb7fe00dbdf85767edca8ec04ab910d13` |

## 実行環境と固定voice

Ripolaはspeech.cpp実行ファイルを自動取得しません。[公式インストール手順](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/install.md)を確認して、対応するspeech.cpp 0.8.3以降の0.8系を用意してください。`PATH`、`~/.local/bin/speech`から検出します。別の場所では`.env.local`の`RSVP_IRODORI_EXECUTABLE`に絶対pathを指定してRipolaを再起動します。binaryの内容もcache identityに含めます。

製品用の固定voiceは同梱していません。モデルの`none`はチャンクごとに声が変わり得るため、Ripolaは固定voice不在で生成を開始しません。説明文の指定やseed固定だけを、声の連続性の保証にはしません。

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

モデル・実行ファイル・voiceが揃ってからUIの「このPCで起動」を押します。Ripolaが所有するprocessだけを起動・終了します。通常起動や状態確認では起動しません。起動失敗は生成不可として示し、VOICEVOX/Geminiへ勝手に切り替えません。runtime停止中でも完成音声の閲覧・配布は継続できます。

補助CLIでは、Irodoriの`plan`/`start`/`resume`コマンドに`--irodori-start`を付けたときだけ、そのCLIが所有するruntimeを起動します。モデル取得は行わず、コマンド終了時にruntimeを終了します。設定確認や従来providerのコマンドには追加の起動条件はありません。

## 合成設定、長文、保存

MFの既定は4 MeanFlow stepsです。stepsを減らすことは計算回数の変更で、F16モデルの保存容量を小さくする操作とは別です。速度、steps、seed、任意の指示、モデル・voiceのchecksum、native実行ファイルとモデル情報をfingerprintに含め、変更した条件のcacheを区別します。モデル・voice・設定が変わった計画は見直してください。完成音声を表示・整列・圧縮の変更だけで再合成しません。

上流の上限は1回256 tokens・30秒で、MFは長い文の途中に発音の乱れが出ることがあります。Ripolaは推奨90文字を能力情報としてplannerへ渡します。音声の上限は速度と原稿にも左右されます。長いchunkは送信前に拒否し、上限で切れた出力を完成扱いにしません。planner担当の分割機能を統合すると、元位置・ルビを保って短いchunkへ計画できます。辞書登録は利用の前提ではありません。

Ripolaは[HTTP API](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/server.md)の`POST /v1/audio/speech`へ送信します。固定voiceとWAV形式を要求し、完了header、PCM形式・容量・長さ・全無音を検査して、既存のWAV保存→alignment→MP3→静的配布へ接続します。これは声の自然さ・読みの正確さの保証ではありません。合成取消しはHTTP接続をabortし、nativeも停止します。取得取消しと合成取消しは別です。

公式[worker protocol v3](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/worker.md)も調査しましたが、この実装はHTTPを使います。対応仕様の確認元はspeech.cpp commit `60a8e1ec068280e5e803ee5d7079e90886c323cb`（2026-10-12確認）です。

## この実装で未確認のこと

大容量モデルを新規取得せず、短い自作fixture・mock native endpoint/processで導入・再開・取消し・送信・保存・cacheを検査します。実MFモデルによる速度・聴感、実voiceのcodec互換性・権利記録・チャンク間の話者連続性は未確認です。製品固定voiceを確認した成果としては扱いません。後続の実測は専用benchmark lockを取得して直列実行し、モデル版・設定・原稿・実行回数・失敗・ばらつきを記録してください。
