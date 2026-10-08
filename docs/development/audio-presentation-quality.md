# 音声の区切り表示と自動検査

更新日：2026-10-07 UTC。表示の単位と発話時刻の根拠を分け、時刻が未採用でも原文の区切りを一つずつ表示します。採用cue・score・整列閾値を変更しません。BudouXの表示単位は厳密な文法的文節ではなく、自然に一つの単位となる「はい。」などは分割しません。

## 共通化済みだった部分と追加した保証

`AudioReader`と`audio-clock.ts`はローカルWAVと公開AACで共通です。採用cueと表示専用`displayCues`の分離、欠落・低信頼・結合cueの表示用推定、gap・末尾の隣接区切り保持、seek・停止・再開・位置復元は共通の処理でした。個別のデモIDに合わせた分岐ではありません。

追加した検査は、表示計画を作る前の原稿、作成後の全区切り、保存された検査記録、最終配布物を対象にします。原稿のunit欠落・誤った一文への結合・順序異常を検出し、読み込めないデータを文全体の表示で成功扱いする経路をなくしました。公開Readerでも検査失敗を「本が未配置」と隠さず説明します。

音声文境界をまたぐ元unitは、[audio-units.ts](../../apps/web/src/reader/audio-units.ts)が表示用のコピーだけを元位置に沿って分けます。原文・保存unit・WAV・queryは変更しません。断片IDは元IDとUTF-16範囲から決定し、ルビやgraphemeを切る境界は拒否します。

## 一つの検査をすべての入口で使う

正本は[audio-presentation.ts](../../apps/web/src/reader/audio-presentation.ts)の`inspectAudioPresentation`と`requireAudioPresentation`です。

| 入口 | 検査する時点 |
| --- | --- |
| 新規生成計画 | 合成要求前。原稿の元位置と表示被覆を検査 |
| 新規保存 | 実durationの全表示計画を再計算し、`presentation`を保存 |
| 整列結果の保存 | 新しいcueを反映した表示計画と検査記録を保存 |
| 既存本の取得・Reader | 原稿・音声時計・表示計画を再検査。旧形式は書き換えずメモリー上で検査 |
| AAC stage | 圧縮前を検査し、PCM対応確認と時刻補正の後に再検査・記録 |
| 静的build・upload監査 | 検査記録を必須とし、再計算と一致することを確認 |

原稿unitのID・block・text・UTF-16範囲・順序・重複、timelineの範囲と順序、元本文の欠落、ルビ保持、grapheme境界を検査します。現在の分割モデル／規則の文書は境界を再計算し、一文へ誤って結合されたunitを拒否します。古い／未知versionは保存された元位置との一致を検査し、`sourceBoundaryCheck: stored-positions`としてモデル境界の再確認と区別します。この場合は未知モデルの分割結果そのものを保証しません。

表示側は一つのcueが一つの元区切りを指すこと、全IDが期待順に一度ずつ現れること、各区間が正・有限・非重複・音声内であること、連結すると元本文に一致することを検査します。missing、duplicate、order、interval等の異常は失敗です。有限の一時的な負のローカル時計は最初の区切りへclampし、chunk切替時にReaderを消しません。非有限時計や有効な計画がない場合は再生を許可しません。

## 保存する検査記録と画面

`presentation`のpolicyは`all-source-phrases-v1`、schemaは1です。状態は`valid`、`invalid`、`unverifiable`。総数とchunk別に期待ID／表示ID、欠落、重複、順序異常、問題コードを記録します。表示時刻の内訳は`forcedAlignmentUnits`、`voicevoxUnits`、`estimatedUnits`です。`acousticEstimatedUnits`は音声補助推定の内数です。0の場合は旧記録との互換性を保つため省略し、`estimatedUnits`は推定全体の件数を保ちます。未採用音響cue数も残します。保存記録だけを信用せず再計算し、一致しなければ停止します。新規配布物に記録がない場合もbuildを拒否します。

画面は「表示：1区切り」と、時刻の方式を別に示します。「表示用推定（時刻未検証）」「音声補助推定」「音素時計（推定）」「整列結果（推定）」を区別し、表示用推定にscoreを作りません。再生中は音声全体の推定を含む固定注記を表示し、区切りごとの方式・scoreは一時停止すると更新します。検査件数は詳細欄に表示します。区切り情報欠落や破損で検査不能なら、理由と原文確認を残して再生を止めます。追加合成で修復しません。

音響処理の既存enum `sentence-fallback`とmanifestの`precision: sentence`は文音声を保存する契約です。画面を文全体へ戻す指示ではありません。採用時刻も手計測goldで確認した発話精度ではありません。

## 通常の検査コマンド

```sh
pnpm test
pnpm check
pnpm test:e2e
pnpm audit:audio --library /path/to/saved-library
pnpm audit:audio --distribution /path/to/upload-directory
```

`pnpm test`には同期なし・部分欠落・低信頼・ルビ・長文・自然な一単位・旧データ・意図的破損の回帰試験と、新規生成から保存／再利用／AAC stage／静的build／読み込みの試験を含みます。実TTSの代わりに自作本文と合成toneを保存し、元WAV hashと合成adapter呼出し数も確認します。`pnpm check`も同じ単体試験を実行します。

`pnpm test:e2e`のPC／スマホ幅試験は新しい隔離libraryへ実保存し、実ローカルAPIのWAV、通常構成でbuildした静的HTTPのAACを実audio要素（`muted=false`）で再生します。再開・seek・ルビ・末尾・全表示IDを検査し、両入口の壊れた原稿が再生を拒否することも確認します。staticのnetwork fulfillmentで成功を作りません。通常E2Eはheadlessであり、OSからの音の出力確認とは区別します。ビルドは隔離したアプリコピーで実行し、稼働中アプリの成果物と混ぜません。

これらの統合試験はインストール済み`ffmpeg`／`ffprobe`を必要とし、不在を成功やskipにしません。E2EにはChromiumが必要です。CIで通常コマンドを実行する場合も同じ依存を用意します。新しいCIサービスは追加していません。

library監査は保存原稿と表示計画の確認です。配布物監査はさらにcatalogのmanifest hash／size／identity／duration、実M4A hash／size、参照先と未選択assetの混入も確認します。空のlibrary・検査不能・破損は非0終了です。明示的に音声なしの静的配布物は別の有効な構成です。

## 検証と限界

今回の検証記録に通常試験、実保存・実配布、既存データ、公開Workerの結果を記録します。全表示単位の正の区間と到達性を検査する仕組みであり、極端に短い音声・高倍率・端末負荷・背景停止で人が全区切りを認識する時間を保証しません。実機Android／iOS／Safari、OS中断、人手goldによる時刻誤差、理解度・速度の向上は未検証です。
