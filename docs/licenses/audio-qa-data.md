# 音声QAの許容表記データ

`spellings.generated.ts` は [Common Voice Japanese accepted spellings](https://huggingface.co/datasets/sakasegawa/common-voice-ja-accepted-spellings) の `8.0/test.jsonl` から抽出した読みと許容表記です。ライセンスは **CC0 1.0**。音声は取得・再配布していません。

- dataset revision: `fb59dcd77b9b5608e6dbb3df97440336e1902fed`
- 入力SHA-256: `91a146b9cf300a644689e972e54869078a3d9835df3b1bf5c66af06e64fa10ad`
- 抽出version: `extract-v1`。7068 surface entries。24文字以下の語、16以下の候補だけを抽出。空文字の省略許容は取り込みません。
- 再生成: `python3 scripts/build-audio-qa-lexicon.py /private/pinned-test.jsonl`。script自体にdownload経路はありません。

元データは音声や認識候補を見ずにGPT-6.1 Solで作られた未人手レビューの注釈です。一般の日本語読み辞書ではなく、文脈で読みが変わる文字や未知語の限界があります。出典はOpenAI生成物の利用条件とCC0の関係も説明しています。評価補助にだけ使い、学習・品質合格保証に使いません。

[Karita et al., CAWL 2023](https://aclanthology.org/2023.cawl-1.8/) の許容表記latticeの考え方を参考に、文全体の組合せを列挙せずDAG上のedit distanceを計算します。この実装は論文のモデル・語彙資源・翻訳処理を再現するものではありません。同じ読みを持つ別の漢字を一律に正解へ変換しません。

既存手元モデルは [Reazon japanese-wav2vec2-base-rs35kh](https://huggingface.co/reazon-research/japanese-wav2vec2-base-rs35kh)、Apache-2.0。revisionと各ファイルhashは `scripts/alignment-model.json` で固定し、重みはPRへ含めません。音声だけのgreedy CTCを実行し、強制整列スコアをASRとして使用しません。
