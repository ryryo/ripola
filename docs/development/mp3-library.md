# 保存音声を検証済みMP3へ移行する

新規生成はVOICEVOX／Geminiとも、WAVを中間保存した後に同期補正、MP3圧縮と検証まで自動で実行する。ユーザーの追加指示や形式指定は不要。検証済みMP3を標準再生音声とし、今回新しく合成したWAVは、保存済み補正が元音声hashと一致し、他の本にも補正待ちの参照がなければ中間ファイルとして削除する。削除前の証拠と対象は`audio-compression-jobs/<jobId>.json`へ保存し、実際の解放byte数を生成jobへ記録する。既存WAVや再利用した音声のWAVを自動削除しない。

補正未完了・圧縮ツール未設定・変換や検証の失敗では必要なWAVを保持し、生成画面に状態を表示する。音声の再合成や追加の有料API呼び出しは行わない。圧縮中のプロセス停止は次回の起動時に保存済み音声から自動再開する。

既存の完了book/revisionを移行する補助入口として`pnpm run compress:audio`も使える。このCLIは原稿・生成job・元cache・保存bookを書き換えない。

## 音声と同期の対応

`audio/<speechKey>.mp3`と`audio-media/<speechKey>.json`を追加する。speechKey、元WAVのSHA-256、元cacheのduration、保存済みcueを維持し、MP3のhash・bytesを別に記録する。MP3を不足キャッシュと判断して再生成しない。MP3や検証記録が破損した場合も再送せず停止する。

変換はlibmp3lame、mono、24kHz、64kbps。Xing/LAMEのgapless情報を残す。[FFmpegのMP3 muxer](https://ffmpeg.org/ffmpeg-formats.html#mp3)はXing/LAMEフレームを書き出せる。コンテナdurationだけをタイムラインとして採用しない。

元WAVとMP3を24kHz PCMへ復号し、フレーム数差1以下、元duration差2ms以下、3個以上の独立した音声区間、相互相関0.8以上、全音声長で時計差2ms以下を要求する。通常は320msの検査窓を使い、独立した活動区間が不足する短い見出しなどは80msの窓で再検査する。相関・ピークの識別性・活動量・時計差の基準は変えない。encoder skip/padding、両PCM hash、検査窓長、offset/scale/residualを保存する。条件を満たさない無音・周期的なチャンクなどはreportに具体的な理由を残す。人手による発話境界の精度保証ではない。

ローカル本棚は検証済みMP3があれば`.mp3`と`audio/mpeg`を返す。旧`.wav` URLはWAVがあればWAVを返し、退避後はMP3へ307 redirectする。GET/HEAD/byte Rangeに対応する。WAV退避後の同期再開は元音声hashが一致する保存済み補正を再利用し、損失圧縮されたPCMからVOICEVOXの発音時刻を再構築しない。別文書で同じ音声を再利用するときも、対応するCTC cacheがあれば元の時計のまま表示位置へ再射影できる。異なるモデルで再補正するなど、保存済み補正やcacheを使えない場合は元WAVが必要。新規生成で削除済みの中間WAVには退避・復元機能はない。

ブラウザがMP3 durationを小数6桁へ丸めることがある。自然終了後のカーソルは保存済みのチャンク末尾へ固定し、遅れて届くtimeupdateで「もう一度」が通常の再生ボタンへ戻らないようにする。

## 完了章の変換

選択ファイルは私的LibraryまたはGit外の作業フォルダに置く。

```json
{
  "libraryDir": "/absolute/private/library",
  "books": [{ "id": "book-example", "revision": "64桁のrevision" }]
}
```

```sh
pnpm run compress:audio --config /private/selected.json --report /private/convert-plan.json
pnpm run compress:audio --config /private/selected.json --report /private/convert-result.json --apply
```

reportのパスは毎回新しくする。`--apply`なしでは計画のみ。選択した章の生成・同期jobが完了し、保存bookの全チャンクに対応する補正が必要。変換済みの検証情報は再利用する。未選択bookが同じspeechKeyを参照する場合は、そのWAV/形式を変更せずreportに残す。実行中の別章がある間は変換のみとし、元WAVは移動しない。現在動いている旧WAV専用コントローラーは読み込み済みコードで動くため、更新しても自動でMP3対応にはならない。

## 再生検証後のWAV退避と復元

旧コントローラーと生成・補正writerを停止し、MP3対応のプロセスで再生、シーク、文節、原文、末尾とキャッシュ再開を確認する。実行中jobやlive run lockがあれば退避を拒否する。停止確認を`--writers-stopped`で明示する。

```sh
pnpm run compress:audio --action archive-wav --operation archive-example --config /private/selected.json --report /private/archive-plan.json
pnpm run compress:audio --action archive-wav --operation archive-example --config /private/selected.json --report /private/archive-result.json --apply --writers-stopped
```

MP3のbytes/hashを再検査してから、WAVを同じLibraryの`audio-archive/<operation>/<speechKey>.wav`へ上書きなしで移動する。ファイルごとの意図をreportに先に保存する。途中で停止した場合もreportの正確な対象・退避先・元hashを使い、実ファイルの所在を確認して復元できる。元cache、book、queryと補正のJSONは残す。

```sh
pnpm run compress:audio --action restore-wav --operation archive-example --config /private/selected.json --report /private/restore-result.json --apply --writers-stopped
```

復元時は元hashを照合し、元WAVと形式の参照を戻す。MP3ファイル自体は残す。退避は復元可能だが、同じディスク内なので空き容量は増えない。不可逆消去はこのコマンドに実装していない。必要ならreportの`status=archived`の正確な`archivePath`一覧と`archivedBytes`を別途確認する。未検証・未補正WAVや他bookのWAVは削除候補に含めない。

## Worker/Pages配布

形式指定を省略すると、検証済みMP3をそのまま配布する。既存の明示的な配布allowlistに`"mediaFormat": "mp3"`を指定する方法も使える。検証済みMP3は同じbytesのままcopyし、元WAV→MP3のPCM証拠に基づいて公開cueを投影する。元MP3への再圧縮は行わない。MP3検証に不合格でWAVを保持したチャンクは、従来のAAC経路で配布する。未移行のWAVには従来のAAC圧縮を使う。`"mediaFormat": "aac"`を明示した場合はAAC出力を強制できる。

音声URLは`library/books/<id>/<revision>/media/<sha256>.mp3`、MIMEは`audio/mpeg`。WorkerはMP3にもRange/HEADを返す。私的cache・query・形式検証記録・WAV退避物は配布に含めない。個人WorkerとOSSデモの分離、および生成API・AI binding・秘密情報を持たない構成は維持する。
