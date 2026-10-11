# PR6 音声QAの実評価範囲

2026-10-12 JST。性能改善・一般ASR精度の主張ではありません。重い認識処理は指定共有 `benchmark.lock` を `fcntl.flock` で取得して直列に実行しました。追加model・有料providerの呼出しはありません。

## 手元Reazonの音声のみgreedy候補

model: `reazon-research/japanese-wav2vec2-base-rs35kh`、revision `46afc596052b612293c8db256b3a69447a2f57dc`。実行版 `reazon-rs35kh-46afc596-greedy-v1`。既存CPython 3.13 / torch 2.8.0 / transformers 4.57.6、CPU、mono 16kHz、前後0.5秒のpadding。本文をPythonへ渡さずargmaxをcollapseしてdecodeしました。

自作本文：**今日は図書館で本を読みます。明日は公園を散歩します。** 正常用、`図書館で`を除いた欠落用、`図書館で`を二回にした重複用の短文を各一回評価しました。既に使えるmacOS Kyokoでローカル検証用に作り、[AppleのSystem Voices条件](https://www.apple.com/legal/sla/docs/macOSSequoia.pdf)に合わせ、音声はPRへ含めません。結果だけを記録します。音声の人手gold確認は未実施です。

| 入力 | duration | 実greedy候補 | token posterior平均 | 内容結果 |
| --- | --- | --- | --- | --- |
| 正常用 | 5.022秒 | 今日は図書館で本を読みますを散歩します。 | 0.923 | 判定不能。`明日は公園`が候補から消える |
| 欠落用 | 4.105秒 | 今日は本を読みますを散歩します。 | 0.913 | 判定不能。意図した欠落と追加の認識差がある |
| 重複用 | 5.939秒 | 今日は図書館で図書館で本を読みますを散歩します。 | 0.944 | 判定不能。重複候補と追加の認識差がある |

いずれも軽量PCMのwarningはありません。軽量検査で通常の長さの部分欠落を保証できないこと、token posteriorが高くても本文との一致を保証しないことを確認しました。正常用の一節も認識候補から消えるため、既存ASRで品質合格や欠落確定を判定しません。差分と元範囲を参考として出し、製品の音声異常warningへは昇格しません。

音声hash（再合成が同じbytesになる保証はありません）：

- 正常用：`281dd9611505ead412c13267da7b6b853ae6bd40e59ea2b97e9f9c57f7a8ccf2`
- ローカル実行証拠：`.reader-data/audio-qa-evaluation/asr-results.json`、`comparisons.json`。Git外。

## fixtureと製品検査

公開fixtureは自作tone/chirpと、明示的なmock候補です。正常・欠落・重複・無音・極端なrate、表記ゆれ、元範囲、hash変更、再検査cache、ASR失敗、fatal保存、MP3実復号をunitで検査します。mock成功を実ASR精度へ読み替えません。

製品の確認入口はローカル本棚の専用Panel、CLIは同じ `AudioInspectionService` を使います。ブラウザ検査は隔離したlibraryと有料生成を無効にしたlocal serverで行い、PC幅／スマホ幅エミュレーションを区別して報告します。実機スマホ、一般の長文・固有名詞の認識精度、VOICEVOX/Gemini/Irodoriの実合成、追加ASRモデルは今回未評価です。
