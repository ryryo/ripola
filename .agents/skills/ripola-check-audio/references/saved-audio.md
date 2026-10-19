# 保存済み音声の品質を確認する

ローカル保存された音声に、無音・clipping・極端な文字数対durationの疑いがないか調べます。音声や本文・cue・speechKeyは変更しません。検査はQA用のsidecar/cacheを書き、TTSや整列jobを起動しません。

## 通常の操作

ローカル本棚で本を開き、音声の詳細の「保存音声の品質を確認」を開きます。通常画面は軽量検査だけを実行します。chunkごとの原文の元範囲、疑わしい音声区間と根拠を見ながら、保存音声を試聴できます。モデル未設定でも軽量検査を使えます。

CLIはrepo rootから実行します。以下の`BOOK_ID`、`REVISION`、pathは利用者の値へ置き換えます。

```sh
pnpm inspect:audio --book BOOK_ID --revision REVISION --library /absolute/path/to/private-library
pnpm inspect:audio --book BOOK_ID --revision REVISION --library /absolute/path/to/private-library --chunks CHUNK_ID,CHUNK_ID
pnpm inspect:audio --book BOOK_ID --revision REVISION --library /absolute/path/to/private-library --read
```

`--library`を省く場合は利用者の設定された保存先を使います。`--read`は現在の音声hashに対応する保存済み結果を読み、再検査しません。結果がない、または古ければエラーです。`--chunks`で対象を絞った場合も、未選択chunkの既存結果は保持します。

検査のためにモデルを追加downloadしません。保存WAVがあれば優先し、削除・退避後は検証済みMP3を手元ffmpeg/ffprobeで復号します。元WAVそのものを検査した結果とは区別します。ツール不足・形式未対応・上限超過は判定不能です。

## 結果を読む

終了コード0はコマンド実行成功であり、品質合格ではありません。fatal構造不正は2、コマンド失敗は1です。

- warningは無音・音割れ・長すぎる間・不自然な長さの兆候です。意図した間や固有名詞でも出るため、対象chunkと前後を試聴します。
- 内容を検査していない音声は「未検査」です。軽量検査だけで読み飛ばし・繰り返しがないとは言えません。
- 構造不正は[構造監査](presentation-audit.md)で調べます。TTSを再生成して隠しません。
- この版には音声品質を「合格」と認定する状態がありません。機械検査、試聴、判定不能を分けて報告します。

本文・結果の更新、音声hashと検査cacheの扱い、具体的な閾値は[QAの開発契約](../../../../docs/development/audio-quality.md)にあります。QA結果は静的配布の対象外です。

## 明示された内容ASR実験だけ

通常画面から内容ASRは起動しません。利用者が内容検査の実験を依頼した場合だけ、既存の手元Reazon modelを使い、対象chunkを絞って実行します。

```sh
pnpm inspect:audio --book BOOK_ID --revision REVISION --library /absolute/path/to/private-library --content --chunks CHUNK_ID
pnpm inspect:audio --book BOOK_ID --revision REVISION --library /absolute/path/to/private-library --content --chunks CHUNK_ID --refresh
```

`--refresh`は検査cacheの再利用を避けて再検査する操作で、TTS再生成ではありません。`--read`と併用しても再検査にはなりません。

既存ASRの実用精度は未確立です。候補に差分があっても音声異常とは確定できず、候補一致も正しさの保証ではありません。認識候補で原稿や時刻を置き換えず、試聴が必要な元範囲と根拠として扱います。新しいASRモデルの取得はこの検査に含めません。
