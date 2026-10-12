# Irodori / speech.cppの第三者条件

2026-10-12に一次資料を確認しました。Ripolaの製品ライセンスとモデル・codec・voiceの条件を区別します。モデルと実行ファイルは通常起動や配布buildに同梱・自動取得しません。

| 資材 | 一次資料と条件 | Ripolaの扱い |
| --- | --- | --- |
| speech.cpp | [commit 60a8e1ecのLICENSE](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/LICENSE)、MIT | 任意のローカル実行環境。[原文](irodori/speech.cpp-LICENSE)を記録 |
| Irodori-TTS v4.1-Small-MF / F16 GGUF | [固定revisionの配布card](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF/blob/69d307a472a1708c5637edcfe376d31c2685829d/README.md)、[原著者card](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small-MF)、MITとcardの倫理上の制限 | 明示追加時だけ取得。[MIT原文](irodori/LICENSE-MIT)を記録 |
| Semantic-DACVAE-Japanese-32dim（GGUF内codec） | [原著者card](https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim)、MIT | GGUF内に含まれる。別モデルを自動取得しない |
| codecの元facebook/dacvae-watermarked | [MetaのLICENSE](https://github.com/facebookresearch/dacvae/blob/main/LICENSE)、Apache-2.0。GGUF cardは2025-12-19のSAM表記訂正を説明 | [GGUFに付属するApache原文](irodori/LICENSE-APACHE-2.0)を記録 |
| 固定voice・参照録音 | 資材ごとの話者の同意、利用・配布条件が必要 | 製品voiceは同梱なし。権利確認済み既存GGUFを明示登録。取得元・条件・帰属・checksumをPC側に保存 |

cardは個人の声の複製・なりすましに明示同意を求め、deepfake・誤情報などの有害利用を禁止しています。参照音声を使わない生成でも偶然実在人物に似る場合がある旨を記しています。Ripolaは録音・話者の学習・voice作成を行わず、voiceがない状態を声の連続性が確認された完成機能として提供しません。

GGUF固定情報はrevision `69d307a472a1708c5637edcfe376d31c2685829d`、`Irodori-TTS-866M-MF-v4.1-F16.gguf`、1,920,321,792 bytes、SHA-256 `e237dc3eefe469b8bba87872beacf12fb7fe00dbdf85767edca8ec04ab910d13`です。[導入ガイド](../guides/irodori.md)を参照してください。MIT/Apacheのnoticeを満たすことと、voiceの個別条件・合成音声の配布可否を確認することは別です。
