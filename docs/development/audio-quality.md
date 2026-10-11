# 保存済み生成音声の品質検査（PR6）

通常の本文と保存WAV/MP3から、無音・clipping・極端な文字数対duration・読み飛ばし／繰り返しの疑いを独立したwarningとして保存します。辞書やルビの登録は不要です。既存の指定がある場合は比較候補に反映します。原文・cue・音声・speechKeyは変更しません。

## 既存の検査との違い

`audit:audio` / `inspectAudioPresentation` は本文の元範囲、unit、表示cueの被覆・順序・有限な時計を検査する構造検査です。このQAはその結果を参照し、構造不正をfatalとして区別します。構造検査を別名で再実装しません。

`alignment-acoustic.ts` は `align_audio.py` の10ms RMS活動区間と信頼できる強制整列tokenから表示時刻を推定します。このQAの20ms RMS・飽和・長さ検査は表示時計を変更せず、音声の品質を確認する手掛かりを生成します。強制整列スコアを独立ASRや内容の正しさとして使いません。

## 入口と保存境界

ローカル本棚で本を開き、音声の詳細の「保存音声の品質を確認」を開きます。内容検査は手元モデルを使う明示選択です。検査後、各chunkの原文・UTF-16元範囲・疑わしい音声区間・ASR候補・根拠を読め、保存済み音声を試聴できます。モデル未設定でも軽量検査を使えます。

```sh
pnpm inspect:audio --book BOOK_ID --revision REVISION --library /private/library
# 既存の手元Reazonだけを使う。追加downloadなし。
pnpm inspect:audio --book BOOK_ID --revision REVISION --content
pnpm inspect:audio --book BOOK_ID --revision REVISION --content --refresh
pnpm inspect:audio --book BOOK_ID --revision REVISION --read
```

`--chunks ID,ID` で選択できます。未選択chunkの結果をsidecarで保持します。終了コード0はコマンド実行成功で、品質合格ではありません。fatal構造不正は2、コマンド失敗は1です。

| 設計候補 | 保存と責務 | 採用判断 |
| --- | --- | --- |
| manifest/alignmentへ書き込む | QAが生成や整列writerのlockと保存契約を共有する | 不採用。QA再検査に原稿・音声保存の変更は不要 |
| QA専用sidecarとcache | `AudioInspectionService` が保存音声を読み、QAだけを書き込む | 採用。生成サービスを構築せず、providerへ到達しない |

結果は `audio-inspections/<bookId>_<revision>.json`、cacheは `audio-inspection-cache/<key>.json` です。keyは **元audioHash + inspection version** に、検査bytesのmediaHash、本文と既存読み指定・durationのtextHash、許容表記版、ASR版／無効状態、構造状態を加えて固定します。MP3は元WAV hashと検査した圧縮bytes hashを別記します。WAVが残れば元WAVを優先し、退避・削除後は既存のgapless検証済みMP3を復号します。lossy PCMを元WAVの品質保証へ読み替えません。取得時にも現在の音声hashと本文を照合し、古い結果を隠します。

同じkeyの検査はLibraryDisk lockで直列化し、sidecarの選択結果はbook別lockで統合します。privateな中間音声は0o600の一時ファイルで、検査後にhashを確かめて除去します。本文・結果の更新で再合成しません。整列・圧縮・再開jobも起動しません。Worker/Pagesと旧AAC再生は変更せず、QA結果の静的配布は今回の範囲外です。

## 根拠と限界

軽量検査の上限は120秒／chunk。整数PCM WAV（8/16/24/32bit）とfloat32 WAVを直接読み、各channelのenergyを保持します。MP3は手元ffmpeg/ffprobeで復号します。破損はfatal、対象外のWAV形式・ツール不足・サイズ上限は判定不能です。

- 20ms RMS。相対的な90th percentileと絶対floorから無音閾値を決めます。RMS < 0.0005または無音比率 > 98%で全体の無音warning。
- 2秒以上かつ全durationの35%以上の間を長い無音として示します。意図した間を否定しません。
- |sample| >= 0.999の連続0.5ms以上と、全sampleの0.1%以上を併せてclippingの疑いとします。単一ピークでwarningを出しません。MP3のピーク変化や音割れのない大音量でも誤検知・見逃しがあります。
- 8文字以上で0.8未満または18超の文字/秒を極端なrateとして示します。漢字・数値・見出し・速度指定で意味が変わるため、一般の発話rateを保証する閾値ではありません。
- 保存durationとPCM時計が150msまたは2%を超えてずれる場合はfatalです。

内容検査は既存Reazon modelの音声だけのgreedy CTCです。Python requestには音声path・hashだけを渡し、本文入力を拒否します。モデルのhash・標準architectureを検証し、`local_files_only`・safetensors・offline設定を維持します。上限30秒、追加modelは自動取得しません。追加ASRを導入する場合は、別途明示的に取得・版固定・評価を行って `AsrAdapter` を渡す入口を使います。UIから任意command/modelを受け付ける入口はありません。

NFKC、かなの表記統一、内部の読み／許容表記DAGとedit distanceで比較します。空候補・サイズ制限・低score・少ない一致anchorは判定不能です。3文字以上の連続欠落、本文に既出の追加部分を、周辺一致とtoken posteriorを条件に抽出します。既存Reazonは正常用fixtureでも一節が認識候補から消えたため、差分を音声異常warningへ採用せず、判定不能と元範囲を表示します。warningへ採用できるのは実評価済みadapterの明示qualificationだけです。mockの`test-only`指定はunit用で、製品設定にはありません。候補との差分は本文範囲を示し、ASRから発話時刻を保証しません。token posteriorは校正された認識確率ではありません。

繰り返し候補の元範囲は、本文中の同じ語句を指します。同じ語句が複数ある場合は最初の一致を示し、どの発話位置で繰り返したかは確定しません。

**この版には品質合格という状態がありません。** 候補一致でもReazonの実用精度が未確立なら判定不能です。warningは必ず聴いて確認してください。ASR誤りや未知表記を「音声が正しい」へ変換しません。[データの版と条件](../licenses/audio-qa-data.md)を参照してください。

## 検証

公開fixtureは自作文と自作PCM波形・認識候補のmockです。正常／欠落／重複／無音／極端なrate、channel相殺、単一ピーク、hash更新、再検査cache、ASR失敗、fatal保存、実MP3復号を確認します。mock候補の成功を実ASR精度に読み替えません。既存modelの短い実音声評価とブラウザ確認の結果はPR／検証記録へ記載します。有料TTS呼出し、大容量model取得、一般的な精度・性能保証は行いません。
