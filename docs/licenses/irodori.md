# Irodori / speech.cppの第三者条件

2026-10-13に一次資料を確認しました。Ripolaの製品ライセンスとモデル・codec・voiceの条件を区別します。モデルと実行ファイルは通常起動や配布buildに同梱・自動取得しません。

| 資材 | 一次資料と条件 | Ripolaの扱い |
| --- | --- | --- |
| speech.cpp | [commit 60a8e1ecのLICENSE](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/LICENSE)、MIT | 任意のローカル実行環境。[原文](irodori/speech.cpp-LICENSE)を記録 |
| Irodori-TTS v4.1-Small通常版 / F16 GGUF | [固定revisionの配布card](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-GGUF/blob/66fe2cde1973fd44e7202fbe36df722103958188/README.md)、[原著者card](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small)、MITとcardの倫理上の制限 | 明示追加時だけ取得。[MIT原文](irodori/LICENSE-MIT)を記録 |
| Semantic-DACVAE-Japanese-32dim（GGUF内codec） | [原著者card](https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim)、MIT | GGUF内に含まれる。別モデルを自動取得しない |
| codecの元facebook/dacvae-watermarked | [MetaのLICENSE](https://github.com/facebookresearch/dacvae/blob/main/LICENSE)、Apache-2.0。GGUF cardは2025-12-19のSAM表記訂正を説明 | [GGUFに付属するApache原文](irodori/LICENSE-APACHE-2.0)を記録 |
| 受付声の指示文 | [irodori-voice-audition固定commitのcaptions.json](https://github.com/shinshin86/irodori-voice-audition/blob/3c66b32072bed04f4bbf779d54c9caf990d798c7/captions.json)、MIT | 女声のvoice-46を使用、男声はその文を受付スタッフに変更。[原文](irodori/irodori-voice-audition-LICENSE)を記録。参照録音は使わない |
| 固定voice・参照録音 | 資材ごとの話者の同意、利用・配布条件が必要 | 製品voiceは同梱なし。権利確認済み既存GGUFを明示登録。取得元・条件・帰属・checksumをPC側に保存 |

cardは個人の声の複製・なりすましに明示同意を求め、deepfake・誤情報などの有害利用を禁止しています。参照音声を使わない生成でも偶然実在人物に似る場合がある旨を記しています。Ripolaは録音・話者の学習・voice作成を行わず、既定男女声は参照音声なしのVoiceDesignです。指示文とseedの固定を、固定話者や区間間の声質連続性の保証として説明しません。

GGUF固定情報はrevision `66fe2cde1973fd44e7202fbe36df722103958188`、`Irodori-TTS-859M-v4.1-F16.gguf`、1,905,903,936 bytes、SHA-256 `f334932bdf166579bada0a3c8bdabb7199af85682fdcefb6f1cb7e444f5c75b3`です。[導入ガイド](../guides/irodori.md)を参照してください。MIT/Apacheのnoticeを満たすことと、voiceの個別条件・合成音声の配布可否を確認することは別です。
