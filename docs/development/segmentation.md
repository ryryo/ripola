# BudouXによる日本語の表示単位

更新日：2026-10-06。分割器はBudouX 0.9.3の日本語モデルです。本文を保った表示単位と元位置の契約を示します。文法的な文節精度の報告ではありません。動作試験は検証記録へ分けます。

## 出力の意味

単語・文節・読みやすいフレーズは異なります。「私は本を読んでいます。」を単語に分けた`私 / は / 本 / を / 読ん / で / い / ます / 。`を、そのまま一単位ずつ表示すると細かすぎます。BudouXは改行向けのフレーズ境界を推定し、品詞や係り受け、厳密な文法的文節を返しません。画面では「フレーズ／文節相当」と説明します。

まずBudouXの結果で基本の読書体験を作ります。助詞・助動詞を必ず文法どおり結合することを初期の合否条件にはせず、読みにくい箇所を確認したら局所的な境界保護で直します。

## 使うAPIと根拠

JSの純粋な`Parser`と日本語`jaModel`を使い、抽出済みの本文を渡します。HTMLProcessorやWeb ComponentはRSVPには不要です。`parseBoundaries`はUTF-16位置、`parse`は原文sliceの配列を返します。確認した実コードは[parser.ts](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/javascript/src/parser.ts)です。

同実装はsurrogate pairの内部を切りませんが、結合濁点・variation selector・絵文字ZWJ列を丸ごと守ることとは異なります。`Intl.Segmenter('ja', { granularity: 'grapheme' })`で得た境界に制限し、原文UTF-16位置と表示用の書記素数を区別します。[Intl.Segmenterの粒度・位置定義](https://github.com/tc39/proposal-intl-segmenter)。対応ブラウザでの能力を確認し、使えない場合は静的原文を提示します。別の語分割器へ黙って切り替えません。

外部の語彙辞書や有料APIは不要です。上流はモデル込み約15 KBと説明していますが、最終bundleの実測値ではありません。確認したJSのpackage.jsonは0.9.3で、導入versionとモデルhashは[依存記録](../licenses/README.md#budouxモデル)へ固定しています。[JS README](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/javascript/README.md)、[package.json](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/javascript/package.json)、[Apache-2.0 LICENSE](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/LICENSE)。依存のlicenseを製品licenseとして採用する意味ではありません。

## 小さな境界保護

1. 入力処理で段落・見出しと原文位置を取得する。PDFの誤った読順をBudouXで修正しようとしない。
2. 各ブロックの本文にBudouXを適用し、UTF-16の候補境界を得る。元本文を一律NFKCに置換しない。
3. graphemeの内部境界を除く。数値・日付・英数字identifier・URL・明示rubyの親文字範囲に入る境界も必要最小限で除く。
4. 句読点と閉じ括弧だけを独立表示せず直前の本文に付け、開き括弧は続く本文に付ける。引用全体を一つに固定する必要はない。
5. 確定境界から本文sliceを作り、連結が入力本文と完全一致することを確認する。空unitや黙った削除・重複を作らない。
6. 各chunkにblock内範囲と原文rangeを結び付け、句読点・段落の休止をmetadataにする。

これは表層の保護であり、形態素解析や大きな辞書規則集を足す設計ではありません。例えば`1,200円`の桁区切りや`v2.1`は守りますが、否定・複合語の完全解析は保証しません。URL末尾の日本語助詞を無制限に取り込まないよう、原文例で保護範囲を確認します。

```text
for block in document.readingOrder:
    text, sourceMap, annotations = block
    cuts = budouParser.parseBoundaries(text)
    cuts = cuts intersect graphemeBoundaries(text)
    cuts = removeCutsInsideProtectedSpans(cuts, text, annotations)
    cuts = attachPunctuationAndBrackets(cuts, text)
    chunks = slicesFromCuts(text, cuts)
    assert concat(chunks) == text
    attachSourceRangesAndPauseMetadata(chunks, sourceMap)
```

## 原文同期と長い表示単位

BudouX由来の`chunkId`と元のUTF-16範囲を保持します。表示上の分割が本当に必要になった場合だけ`displayUnitId`を別にし、元chunkを追えるようにします。原文に同じ語が繰り返されても、全文の`indexOf`で後から位置を推測せず、入力時のsource mapを使います。

長い固有名詞・ルビ・括弧付き表現を固定文字数で切りません。まず文字幅の測定、下限付き文字サイズ調整、折返しまたは手動送りで全文を読めるようにします。表示都合の追加境界を置く場合は句読点等の安全な位置に限定し、graphemeとrubyの途中を避けます。MVPのために形態素境界を取得する必要はありません。

保存するのはsource anchor、content hash、BudouXのpackage／model version、境界保護のrulesVersionです。再分割後は元位置から復元し、古い配列indexを使い回しません。モデルの初期化失敗時は説明と再試行・静的原文を提供します。

## 検証を絞る

自作8例とfixtureで、内容復元・Unicode境界・数値・ruby・原文位置を確認します。fixtureのpreferredChunksは望ましい表示の例で、BudouXの実行結果や完全一致必須の正解ではありません。BudouXで出た境界を観察し、破損や読書上の明確な問題を修正します。

長文初期化やスマホの負荷は、採用したBudouX構成の動作確認として測ります。別解析器との比較で採用を再決定する工程にはしません。過去の候補比較と辞書条件が必要なら[参考調査](../research/segmentation.md)を参照してください。
