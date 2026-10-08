# 黙読の再生時計と音声同期

読書機能では黙読CPMの単一タイマー、音声機能ではmediaの再生時計を使います。停止・戻る・原文確認を共通の操作として扱い、2つの時計を同時に走らせません。保存音声の文境界と、採用できるCTC cueのフレーズ表示を実装し、実行済みの範囲は検証記録を参照してください。理解度・速読の効果は未検証です。

## 黙読の字/分と休止

「字」は空白・Unicode Punctuationを除くgrapheme clusterです。UTF-16の`.length`や英語OSSのWPMを日本語CPMへ直結しません。ルビの読みを本文の速度字数へ加えません。

```text
g_i        = 表示単位の速度字数
duration_i = max(100 ms, 60,000 × g_i / CPM) + pause_i
effectiveCPM = 60,000 × Σg_i / Σduration_i
```

現在のCPMは100〜3,000、初期600です。休止ONでは読点100 ms、文末250 ms、段落400 ms、見出し600 msの最長分類を1回だけ加算します。初期値は実証された最適値ではありません。休止と100 ms下限により、実効速度は設定値より低くなります。

[playback.ts](../../apps/web/src/reader/playback.ts)は1つの状態と予約タイマーを所有します。停止・seek・再読込は古いcallbackを無効にします。一時停止で単位内の経過時間を保存し、再開は残りから続けます。表示途中の速度変更はその単位を短縮せず、次から反映します。遅れを取り戻すために単位を飛ばしません。最終単位の時間を確保して読了します。コード・表では手動送りへ停止します。

可視進捗は句読点休止を含む時間割合です。ゲージと単位送りは同じmonotonic clockを参照し、CSS transitionを時計代わりにしません。設定変更では現在割合を保って残り時間へ配分し、seekでは移動先の累積時間へ更新します。コード・表の確認時間は残り時間へ含めません。

累積時間はload/設定変更時に計算し、frameごとの全unit走査を避けます。[PlaybackProgress.tsx](../../apps/web/src/reader/ui/PlaybackProgress.tsx)はfill transformを30 fps以下、再生中の数字は固定し、進捗と残り時間は停止・操作時に表示します。ARIAも再生中は固定の説明を使います。reduced motionでは連続描画を控えます。過去の実測はUI検証資料に残します。

## 元位置・長いフレーズ・操作

安定ID、block内offset、元range、content hash、parser/model/rules versionを保持します。同じ語が繰り返されても全文`indexOf`から元位置を推測しません。再分割後の再開はsource anchorから引き直し、古いunit indexを流用しません。[分割契約](segmentation.md)を参照してください。

原文を選ぶと対象へ移動して停止します。現在範囲は最大41単位と静的全文で示し、PDFは元ページと近似rectを表示します。長句は24pxの下限まで縮小し、折返し/スクロールで全文を残します。Flashの文字幅は表示中の本文を変更せず、非表示の測定用要素で指定サイズから計算します。ResizeObserverは枠幅が変わる時だけ再計測し、折返しによる高さの変化を再計算の入力にしません。スマホの表示枠は固定高さと余白を確保し、Guideの全文追従とは別に扱います。複数行の検証記録を参照してください。固定文字数で切り捨てたり、ruby/grapheme内部を切りません。

主操作は44px以上、Spaceと左右キーで読書できます。入力・操作要素にフォーカスがある時はショートカットを奪いません。resize/visibility/blur/pagehideで停止し、戻っても自動再開しません。人物色・縦表示は未対応です。

## 音声の本文対応

表示本文と発話本文を分けます。原文→表示offset→読み/辞書を反映した発話offset→音声時刻はmany-to-manyです。ルビの基底「図書館」と発話「としょかん」、数字の読み展開等を同一indexとみなしません。sourceの`transformed/approximate`精度と音声alignment精度を別に記録します。

基本の文境界は1文ずつ合成した保存WAVのsample数/実durationから得ます。保存済みのBudouXフレーズを常に一つずつ表示します。採用cueがない箇所は、利用できるCTC token時刻とPCM活動区間で音声補助推定し、根拠不足なら前後の採用時刻と文字数で補います。両方とも確定した整列時刻とは分けます。表示用フレーズと生成用文chunkを分け、文字数比例の時刻を精密な同期と説明しません。

`AudioBookManifest`は表示文書、生成条件、保存済み音声chunk、durationと文timelineを持ちます。契約の正本は[contracts.ts](../../apps/web/src/generation/contracts.ts)です。初期のmimeはローカルWAVで、配布時のAAC/M4Aは別処理です。圧縮後duration/offset/encoder delayを検査し、元の時刻を無条件に流用しません。

## 日本語CTCによる既知原稿の整列

保存済みWAVと生成時に確定した`spokenText`を使い、CTC emissionを既知原稿に沿って整列します。TTSを再実行せず、ASRの推測結果で本文を置き換えません。採用モデルはReazon Researchの固定日本語Wav2Vec2ForCTC 1種類です。[セットアップと固定モデル](../guides/forced-alignment.md)を参照してください。短い保存済み自作文で12単位中9の採用を実測しています。人手goldによる時刻誤差は未測定で、一定ms以内を保証しません。

[prepareSpeech/normalizeSpeech](../../apps/web/src/generation/core/speech-source.ts)は表示UTF-16区間→ルビ/辞書展開後の発話区間→NFKC後の整列用区間を保存します。正規化ではgraphemeごとにNFKCを適用し、空白/句読点を除外します。表示本文は変えません。保存した発話原稿と再構成した`spokenText`が完全一致しない時は対応表を採用しません。

モデルの標準CTC tokenizerは複数文字のadded tokenも扱います。token列から整列用本文をexactに再構成できることを確認し、tokenのUTF-16 spanへ時刻を付けます。token index、code point、UTF-16、grapheme、表示unit IDを混同しません。未知字や再構成不能の原稿へwildcardの時刻は付けず、その文chunkをfallbackにします。

[alignment-projection.ts](../../apps/web/src/generation/core/alignment-projection.ts)は必要spanの被覆、時刻順序/範囲、元位置、CTCスコアを検査します。score 0.75以上かつsource mapping一致の範囲だけを採用します。読み展開で同じtokenを共有する隣接単位は1cueにまとめ、時刻の重なるcueは採用しません。低score・未対応・無音・時刻のgapには音響cueを付けず、表示用の推定時計で原文の区切りを進めます。scoreは校正された時刻精度の確率ではありません。

モデル実行前に元WAVのhash、固定モデルのsize/SHA-256、標準architectureを確認します。CPU/eager/safetensorsとlocal-files-onlyを使い、1文60秒/正規化後512文字を超える入力は音響時刻を採用しません。表示は原文区切りと表示用推定を使います。既知原稿/音声/versionをキーに整列cacheを保存し、進捗/中断/再開はTTSと別のジョブで管理します。[生成・整列の保存契約](local-generation.md#ttsと独立した整列ジョブ)を参照してください。

VOICEVOXのquery秒数やmoraを単純合算する方式は、upspeak/pause/速度/frame丸め等の影響があるためこのCTC時刻の代替にはしません。Geminiのnative文字timestampは未確認です。VOICEVOX/Geminiの保存音声へ同じ既知原稿整列を適用できる契約ですが、Kore実音声の活動区間と表示境界の変化を実測しましたが、人手goldによる精度は未測定です。

## 音声時計と操作の契約

音声時は[HTMLMediaElement.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime)を唯一の時計にします。RAFは描画だけで時計を進めません。全フレーズの独立した表示計画を読み、採用cue内では整列方式、欠落・結合cue・無音の隙間ではestimatedを明示します。文境界を越えたら次chunkへ進み、末尾の間と自然終了後は最後のフレーズを保持します。文末のRSVP休止は二重加算しません。

| 操作・状態 | 動作 |
| --- | --- |
| pause/非表示 | mediaと表示を同じ位置で停止。復帰しても自動再生しない |
| 原文seek/前後 | 文の開始または採用cueの時刻へ移動し、media準備後にseekして停止。未対応範囲は表示用の推定位置を使う |
| 再生率変更 | [playbackRate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate)を変更。mediaの時計へ壁時計倍率を二重乗算しない |
| buffering/error | 表示を先へ送らず、停止位置と対象を残す |
| 最終chunk | endedとtimelineを確認して完了。未再生の末尾を飛ばさない |
| コード/表 | 発話原稿へ黙って含めず、静的確認の対象とする |

合成speedScaleの変更はaudio条件の変更です。再生率変更とは異なり、音声と対応表を再生成する必要があります。CTC時刻の誤差、全操作の実機対応、圧縮後chunk境界は別途検証します。Readerは日本語の同期粒度・スコア・fallback理由を表示し、内部のprecision/methodはdata属性に保持します。[audio-clock.ts](../../apps/web/src/reader/audio-clock.ts)でもunit/元範囲/score/intervalを検査します。

## 保存とアクセシビリティ

原稿・音声・対応表はGit外のPC正本へ保存し、Readerは保存済みmanifestを読みます。通常のIndexedDB保存1冊は別の機能で、音声全巻を黙って追加しません。[ジョブとキャッシュ](local-generation.md)は取消/再開・結果不明・重複防止を定義します。公開ReaderにTTS keyや生成APIは不要です。

静的全文と手動送りを残し、高速更新の本文は`aria-live=off`とします。focus、コントラスト、reduced motion、タッチ/キーボードの経路を確認します。音声があることをスクリーンリーダーの完全対応とみなさず、実読上げは別検証です。

## 全区切りを表示する推定時計

`AudioSegment.cues`は検査済みの音響cueで、保存scoreと採用閾値は変更しません。`displayCues`は原文unitを一つずつ含む別の表示計画です。欠落区間は前後の採用cueと文durationの間を文字数で配分し、複数unitを含むcueも区切りごとに配分して`estimated`とします。短すぎるcue（120 ms未満）や前後に未対応unitの表示時間を残せないcueは表示anchorから外し、音響証拠として保持します。配分時は可能な範囲で短い区切りの表示時間を確保しますが、極端に短い音声や負荷・背景停止で全区切りの目視時間を保証しません。

`ctc-energy-v1`の補正が有効な推定区間は`acoustic-estimated`とし、前後の採用CTC／VOICEVOX時刻を維持します。PCM活動区間と高score tokenを使う実装・限界は検証記録を参照してください。

`estimated`と`acoustic-estimated`には音響scoreを付けず、「時刻未検証」と表示します。無音のgapは直前（冒頭なら最初）の区切りを保持します。ルビ・元位置・全文は変更しません。元unitが欠けた旧データは検査不能と説明し、原文確認を残して再生を止めます。検証では全unitの列挙と対応数、各表示区間の正時間、実再生時の到達unit、末尾表示を確認します。

生成・保存・既存データ・AAC配布・最終buildで同じ検査を使う契約と通常の回帰試験は[区切り表示と自動検査](audio-presentation-quality.md)にまとめています。

## 再生中の補助文字

本文以外の番号・時間・区切りごとの時刻方式を再生中に切り替えません。音声は再生意図が続くchunk切替中も同じ注記を使い、推定を含むことを明示します。停止した位置の方式・score・説明は従来どおり確認できます。音声の注意事項は全体分をまとめ、文一覧の現在位置は再生中に固定して停止時に更新します。滑らかなゲージ、seek、ルビ、全区切りの表示計画は継続します。通常ブラウザ試験は可視文字・配置・本文の変化・ゲージ増分を同時に測ります。
