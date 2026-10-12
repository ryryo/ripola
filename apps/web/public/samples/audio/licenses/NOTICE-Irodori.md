# Irodori 音声サンプルの出典

夏目漱石『吾輩は猫である』の冒頭13文を、Irodori-TTS v4.1 Small MF / Aratakoで合成した比較サンプルです。本文とルビは既存のRipola公開サンプルと同じ[青空文庫の作品](https://www.aozora.gr.jp/cards/000148/card789.html)を使用しています。

男声は `energetic-young-man`、女声は `calm-young-woman` を使用しています。ASIST / Sakasegawaが配布する、声の説明から合成して作られた声データです。[配布元の説明](https://github.com/nyosegawa/asist/blob/518b70b04fea2ec3518ea1d0e9647add059847e0/website/src/content/docs/en/docs/reference/bundled.md)と[MITライセンス](https://github.com/nyosegawa/asist/blob/518b70b04fea2ec3518ea1d0e9647add059847e0/LICENSE)を確認しています。

生成時の固定資材:

- [音声モデル](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF/tree/69d307a472a1708c5637edcfe376d31c2685829d): `Irodori-TTS-866M-MF-v4.1-F16.gguf`
- [声データ](https://github.com/nyosegawa/asist/tree/518b70b04fea2ec3518ea1d0e9647add059847e0/resources/irodori-voices): 男声SHA-256 `4600929a79aadc3e94ff8f811f12e130e6e4383a44303c9f5a746aa6fc2d2d89`、女声SHA-256 `5c1db7bbdb9688cefe08e594b741425a195b121c7bcccd9d4e050a23bcec1571`
- speech.cpp 0.8.3、steps 4、speed 1、seed 42、instructions 空。各声の13文すべてに同じ声データを使用。

完成音声は24 kHz / 64 kbpsのMP3で、男声69.76秒、女声76.60秒です。配信するのは完成MP3と読書用manifestで、モデルや声データをダウンロード・起動する必要はありません。

同梱の `LICENSE-ASIST.txt`（Copyright © 2026 Sakasegawa）、`LICENSE-Irodori.txt`（Copyright © 2026 Aratako）、`LICENSE-codec.txt` にMIT / Apache 2.0の通知を保持しています。モデルの利用条件は[モデルカード](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF/blob/69d307a472a1708c5637edcfe376d31c2685829d/README.md)を参照してください。

本文96区切りの表示とMP3圧縮前後のPCM時刻相関を検証しています。区切り時刻は文内での推定です。表示の欠落・重複がないという検証は、実際の読み上げの認識精度を保証しません。発音・聞きやすさ・文の間での声の連続性の聴感評価は未実施です。
