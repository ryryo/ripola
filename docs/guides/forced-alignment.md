# 保存音声へ日本語のフレーズ時刻を追加する

2026-10-07：保存音声の活動区間と信頼できるCTC tokenを使う「音声補助推定」を追加しました。採用cueがない範囲も、根拠が揃う時は休止を除いた音声活動時間へ読みを配分します。従来の文字数推定・採用CTC・VOICEVOX音素時計と区別し、採用閾値を下げません。既存モデルを使用し、新依存は不要です。変更前後と検証を参照してください。

VOICEVOX Engine 0.25.2の保存音声には、CTCに加えて音素フレームから時刻を検証する方式を追加しています。[青空文庫・文移動・音素時刻のガイド](aozora-and-navigation.md#保存音声の低信頼部分)を参照してください。以下の9採用・3低scoreはCTC単独の履歴です。新方式はCTCの閾値を変えず、別の検証情報を持ちます。

保存済みWAVと、その生成時に確定した発話原稿（`spokenText`）を同じPCで整列します。TTSを再実行せず、有料APIも呼びません。ASRで本文を再文字起こししたり、推測した本文へ置き換えたりしません。追加のCPU runtimeとモデルは任意の明示セットアップです。表示用の推定時計による区切り表示は未設定のまま使えます。

整列ジョブ、原稿との対応検査、フレーズcue、低信頼時は音響時刻なしとし、表示用推定で全区切りを進めます。保存済み自作3WAV（合計7.701333秒）の整列は9.449秒で3chunk完了し、12BudouX単位中9が採用、3は低scoreでした。3文とも一部整列で、TTS再実行/ASR再文字起こしは0回です。これは1条件の実測で、全原稿の精度や処理性能を保証しません。実行結果の詳細は検証記録へ記載します。人手goldを用意していないためp50/p95/最大時刻誤差は未測定です。CTCスコアは時刻精度の確率ではありません。

## 任意のローカルセットアップ

固定lockは**macOS ARM64／Linux x64・CPython 3.13**用です。別OS/architecture/Python版へそのまま使う保証はありません。依存の入力は[alignment-requirements.in](../../scripts/alignment-requirements.in)、25依存のwheel hash lockは[Mac用](../../scripts/alignment-requirements.txt)と[Linux用](../../scripts/alignment-requirements-linux-x64.txt)です。[共通platform設定](../../scripts/alignment-platforms.json)でNode setupとPython readinessが同じlockを選びます。Linuxはtorch **2.8.0+cpu**の公式CPU wheel URLを固定し、CUDA/NVIDIA・torchaudio・librosaを追加しません。公式配布wheelだけを使い、依存のsource buildや別モデルの自動取得は行いません。Linuxはglibc 2.28以上が必要です。

repo rootから `pnpm setup:audio` を実行します。Python 3.13とffmpeg／ffprobeが不足していれば導入方法を表示して停止し、OS全体へ自動インストールしません。

```sh
pnpm setup:audio
pnpm dev
```

専用venv・hash付き依存・固定モデル・自動設定まで準備します。初回容量を取得前に表示し、完成済みファイルは再利用します。読書・再生からインストールを始めません。[初回導入と回復](setup.md)を参照してください。
モデルは[Reazon Research japanese-wav2vec2-base-rs35kh](https://huggingface.co/reazon-research/japanese-wav2vec2-base-rs35kh/blob/46afc596052b612293c8db256b3a69447a2f57dc/README.md)の固定commit `46afc596052b612293c8db256b3a69447a2f57dc`、1種類だけです。公開元のライセンスはApache-2.0です。[固定manifest](../../scripts/alignment-model.json)に7ファイルのsize/SHA-256を保存します。

| ダウンロード対象 | byte |
| --- | --- |
| `model.safetensors` | 386,749,964 |
| 設定・tokenizer等のJSONを含むモデル合計 | 386,888,750（約386.9 MB） |
| Mac用25依存wheel合計 | 110,048,507（約110.0 MB） |
| Linux x64用25依存wheel合計 | 234,122,748（約234.1 MB、torch CPU wheel 183,917,315 bytesを含む） |

上のbyteは配布ファイルの値です。検証Macでは、初回import前のvenv約487 MiBとモデル約369 MiBに加え、Python bytecode cacheの生成後はruntime全体で約902 MiB（約946 MB）になりました。resolverの一時metadata約15 MiBは別で、pip cache等はこの合計に含めません。RAMや実行速度の値ではありません。モデルdownloadは不足ファイル分に加えて512 MiBの空き領域を要求し、size/SHA-256一致済みファイルを再取得しません。モデルをGitや公開assetへ入れません。[ライセンス記録](../licenses/README.md#任意の日本語ctc整列runtimeとモデル)を参照してください。

## サーバーだけへ自動設定する

セットアップ完了後の `alignment-runtime/setup.json` をNodeサーバーとCLIが読みます。Python/modelのpathや固定versionを手でenvへ書く必要はありません。既存envによる外部環境指定は優先して検証し、秘密・利用者設定を上書きしません。[互換設定の扱い](configuration.md)を参照してください。

音声生成の画面に準備状態を表示します。セットアップ後にサーバーを再起動し、「音声補正：利用可能」を確認します。再生だけでモデルを取得／実行しません。

## 新しい音声の自動補正

ローカルPythonと固定モデルの設定・利用可否が揃う場合、通常の新規生成は全ての選択文を保存した後、自動で整列・補正・保存まで進みます。VOICEVOX、Gemini直結、Cloudflare経由とCLI／ブラウザで同じ経路です。完了済み音声cacheも再利用し、新方式の整列cacheがあればCPU推論も省きます。再生中のモデル実行ではありません。

未設定・利用不可なら音声を保存し、文字数推定を使います。補正失敗でもTTSを再送しません。根拠不足の区切りには文字数推定が残ります。生成未完了、保存本を開くだけ、旧完了ジョブの取得だけでは自動補正を始めません。通常生成の回帰試験と実cache検証を参照してください。

## 保存した本から操作する

1. 「保存した音声」で保存済みの本を開きます。
2. 「保存音声にフレーズ時刻を追加」で対象文を選びます。「未整列・一部整列の音声」で対象を絞れます。
3. 「選択した保存音声の時刻を整列する」を押します。開始時にTTSは呼びません。
4. chunkごとの整列、一部整列、時刻なし、再利用件数を確認します。
5. 「保存した整列結果を表示」で対応表を読み直します。

「整列をここで停止する」はローカルchildを中断し、完成した対応表と元WAVを残します。「未完了の時刻整列だけを再開」は未完成分だけを処理します。タブ終了でもserverが動けばjobは続きます。server停止後は明示再開し、音声を再合成しません。

## フレーズが表示される条件

モデルは既知原稿に沿ったCTC経路を求めます。標準CTC tokenizerの複数文字tokenも扱い、token列が正規化本文を完全一致で再構成できることを検査します。原文UTF-16位置→ルビ・辞書を反映した発話位置→NFKC等の整列用位置→時刻を対応させ、保存した`spokenText`との完全一致を検査します。表示本文そのものをNFKCで書き換えません。

BudouXの表示単位へ戻せて、必要なspanが揃い、CTCスコア0.75以上、時刻が有効・順序どおりの範囲だけをフレーズcueとして採用します。同じ読み範囲を共有する隣接単位はまとめる場合があります。再生中もunit ID・block・元位置とcueを検査します。

低スコア、読み不一致、未対応文字、無音・小さい音では音響cueを採用しません。Readerは原文の区切りを一つずつ表示し、gapや未採用区間を表示用の推定時計で補います。未知の文字やtokenからの本文再構成不一致は文chunkをfallbackにし、wildcardや文字数比例の時刻を付けません。1chunkが**音声60秒超または整列用512文字超**ならモデルを実行せず文fallbackです。長文は既存の文chunkごとに処理します。nodeから起動したchildには別途5分の処理timeoutがあります。

Readerは「表示：1区切り」と時刻の根拠を分け、「整列結果（推定）」と「表示用推定（時刻未検証）」を区別します。内部のprecision/method値はdata属性に保持します。採用cue・欠落区間・複数フレーズを含むcueを独立した一つずつの表示計画にし、末尾も最後のフレーズを保持します。時計は引き続きaudioの`currentTime`です。フレーズがある場合は「前のフレーズ」「次のフレーズ」や原文の該当フレーズから移動して停止できます。読み辞書で「一冊→いっさつ」のように発話表記が変わった範囲も低scoreになり得ます。閾値を下げて採用せず、保存結果のfallbackと表示用の推定を分けます。モデルの文字/読み表記には限界があります。スコア0.75は採用判定の閾値で、75%の時刻精度や一定ms以内を保証しません。モデルの20 ms frameも時刻精度ではありません。

## ローカルの追加検証

保存済みの自作音声を使い、次を確認しました。これらはキャッシュ・採用判定・fallbackの試験で、人手goldによる境界時刻の精度評価ではありません。

| 対象 | 実測結果 |
| --- | --- |
| 新しいserviceで再整列 | 3/3chunkのCTC cacheを再利用。同じoperation IDは同じjobを返し、TTS provider呼出し0回 |
| 音声と生成状態 | 全WAVのhash、音声生成job、speech cacheは変更なし |
| 意図的に異なる既知原稿 | CTC score 0.37708で0.75未満。全tokenをフレーズとして採用せず文fallback |
| 語彙にないemoji | UTF-16範囲の終端2を保持してunmatched。時刻を付けたsegmentは0 |
| PCM無音 | unmatched、時刻を付けたsegmentは0 |
| 固定外のaligner version | runtimeが拒否 |
| [Python synthetic tests](../../scripts/test_align_audio.py) | 5件通過。実モデルの境界誤差を保証する試験ではない |

人手goldを用意していないため、p50/p95/最大時刻誤差は引き続き未測定です。CTCの20 ms frameも時刻精度の値ではありません。Readerのブラウザ契約試験と実WAVでの操作試験は、素材・実行条件を区別して検証記録に残します。

## キャッシュと配布

整列cacheは元audio hash、正確な`spokenText`、model/aligner version、正規化versionから作ります。元WAVは変更しません。対応表更新・失敗・取消・再開・UI設定変更ではTTSを再実行しません。モデルや正規化versionが変わる時は別の整列cacheを使います。失敗しても既存の文timelineを保持します。

AAC/M4Aへの配布時は元PCMとdecode後PCMの相関からoffset/driftを測り、確認できた場合だけcue時刻を補正して持ち出します。相関・元位置・cueの検査に通らない範囲は文fallbackです。公開assetにモデル、runtime、確定発話原稿、正規化本文、cache key、個人path、jobログを入れません。選択した表示本文の`rawText`は従来どおり配布対象です。[配布契約](../development/distribution.md)を参照してください。

補助CLIも同じ整列serviceを使います。

```sh
pnpm exec tsx scripts/generate-audio.ts align <book-id> --revision=<revision> --operation=<一意の操作ID>
pnpm exec tsx scripts/generate-audio.ts alignment-jobs
pnpm exec tsx scripts/generate-audio.ts alignment-cancel <alignment-job-id>
pnpm exec tsx scripts/generate-audio.ts alignment-resume <alignment-job-id>
```

必要なら`align`へ`--chunks=<chunk-id,chunk-id>`を指定します。実装契約は[ローカル生成](../development/local-generation.md)、[再生と同期](../development/playback.md)を参照してください。有料Gemini実合成、実機スマホでの同期、幅広い日本語文書での時刻誤差は別途検証が必要です。

表示用の推定時計・120 ms未満のcue・全区切りの到達性と末尾の契約は[再生設計](../development/playback.md#全区切りを表示する推定時計)を参照してください。音響処理の`sentence-fallback`は保存結果の精度で、Readerに文全体を出す指示ではありません。

原稿と全表示単位の検査、検査不能時の停止、生成・配布の自動検査は[品質検査の契約](../development/audio-presentation-quality.md)を参照してください。
