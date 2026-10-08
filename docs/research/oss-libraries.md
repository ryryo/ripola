# GitHub実装例・候補ライブラリ（参考調査）

**現在の初期方針はBudouX採用、OCR対象外です。** この資料は過去に読んだ候補・実コード・ライセンスの記録として残します。他解析器の導入・比較、OCR基盤の用意はMVPの前提ではありません。実装では[現在の方針](../README.md)、[スタック](../development/architecture.md)、[BudouX分割](../development/segmentation.md)を優先します。

調査日：2026-10-05（UTC）。リポジトリmetadata、default branchのtree、commit endpoint、主要ソースとLICENSE／NOTICEを確認しました。以下の日付は**確認したhead commitのcommitter日時（UTC）**であり、最新npm公開日や最終機能改善日ではありません。repositoryのpushed_atは他refへのpushも含み得るため、別にJSON記録へ保存しました。stars数だけで保守性を評価しません。

2026-10-05の調査で確認した18 repositoryはいずれもarchived=falseでした。古いheadや新しいheadだけで、安定性・安全性・精度を保証しません。固定commitは読み取った根拠を再現するためのもので、そのまま依存versionとして採用する決定ではありません。

## 日本語候補の比較

本体と辞書／モデルの条件を分けます。MITという名称だけを選定理由にせず、必要な出力（文節かフレーズか）、容量、初期化、位置情報で選びます。候補ごとの詳細と一次資料は[比較記録](segmentation.md)にあります。

| 候補 | 本体のライセンス | 辞書・モデル | 出力 | ブラウザ | 容量・初期化 | 推奨用途／注意 |
| --- | --- | --- | --- | --- | --- | --- |
| [BudouX](https://github.com/google/budoux) | Apache-2.0 | 同repo日本語モデル・LICENSE確認 | 改行向けフレーズ境界。品詞・文節なし | JS Parser可。Worker案 | 上流説明はモデル込み約15 KB、実測なし | **初期採用**。grapheme・URL等を境界保護し「文節相当」と表示 |
| [kuromoji.js](https://github.com/takuyaa/kuromoji.js) | Apache-2.0 | IPADIC／NAIST／ICOTのNOTICEを別保存 | 品詞付き形態素。文節は規則を追加 | 純JS、XHR gzip辞書 | 12 gzip計17,791,956 bytes。初期化・展開RAM未測定 | 助詞／助動詞連結の比較候補。2018年head、位置・配信設定に注意 |
| [Lindera WASM](https://github.com/lindera/lindera/tree/main/lindera-wasm) | MIT | 採用するIPADIC／UniDic等の条件を別確認 | 品詞付き形態素。文節なし | WASM、async init、runtime辞書、OPFS | WASM・辞書・初期化は未測定 | 現代的置換候補。byte offset変換と辞書配信が必要 |
| [GiNZA](https://github.com/megagonlabs/ginza) | MIT | 日本語UDモデルMITの説明あり。依存辞書は別 | bunsetu_spansで文節、形態素・依存構造 | Python/spaCy。初期には導入しない | モデル・辞書load必要。未測定 | 実文節を求める比較基準。phrase APIと取り違えない |
| [SudachiPy](https://github.com/WorksApplications/sudachi.rs/tree/develop/python) | Apache-2.0 | SudachiDict LEGAL（UniDic／NEologd等）別 | A/B/C粒度の形態素。文節なし | Python/Rust binding。ローカル案 | 上流core説明約70 MB、実測なし | 固有名詞・粒度比較。engine/dict形式をセット固定 |
| [TinySegmenter mirror](https://github.com/leungwensen/tiny-segmenter) | root MIT／原実装new BSD記載 | 内蔵モデル。原作者本文照合は未完了 | 単語。品詞なし | JS | 外部辞書なし、bundle・時間未測定 | 優先度低。単一MITと断定せずUnicodeとライセンスを再確認 |
| [Intl.Segmenter](https://tc39.es/proposal-intl-segmenter/) | ブラウザ内蔵標準API（npm本体ではない） | ブラウザ／ICU。polyfillは別調査 | grapheme／word／sentence。文節なし | 能力確認して使用 | 独自辞書DL不要。環境差あり | 書記素保護と字数。wordを文節にしない |

ライセンスの存在・原文へのリンクを記録したもので、具体的な配布形態の法律判断を断定する資料ではありません。採用時は選んだnpm／WASM配布物・モデル・辞書のLICENSE／NOTICEを保存し、推移的依存も確認します。このrepo自体の製品LICENSEは未選定です。

## 入力候補と参照した実コード

| 候補 | 本体ライセンス／主なファイル | 採用判断 |
| --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) | Apache-2.0。[api.js](https://github.com/mozilla/pdf.js/blob/df8482898bb01f97b2b18d558b7caee4d0730993/src/display/api.js)／[text_layer.js](https://github.com/mozilla/pdf.js/blob/df8482898bb01f97b2b18d558b7caee4d0730993/src/display/text_layer.js) | ブラウザPDF候補。文字・方向・座標は得られるが本文読順復元はアプリ側の課題 |
| [remark / remark-parse](https://github.com/remarkjs/remark) | MIT。[parser](https://github.com/remarkjs/remark/blob/1146b3a274fc1f4607111e5d6607a3a769a0e89a/packages/remark-parse/lib/index.js) | MD AST候補。GFM／frontmatter等を明示し、本文をblock別に巡回 |
| [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) | MIT。[dev/lib/index.js](https://github.com/syntax-tree/mdast-util-from-markdown/blob/afe9516d97683e51974694f944a799a915a242c0/dev/lib/index.js) | remarkを通さずASTが必要な場合の候補 |
| [mdast-util-to-string](https://github.com/syntax-tree/mdast-util-to-string) | MIT。[lib/index.js](https://github.com/syntax-tree/mdast-util-to-string/blob/91a3f931b82b5493e4c4e4f4f9e1487a516003d4/lib/index.js) | 補助関数。root一発では段落・位置・除外方針を保持できない |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0。[createWorker.js](https://github.com/naptha/tesseract.js/blob/a1ca80d9e31c34512d0ded75ff8821ddcf3f2f91/src/createWorker.js)／[README](https://github.com/naptha/tesseract.js/blob/a1ca80d9e31c34512d0ded75ff8821ddcf3f2f91/README.md) | 初期スコープ外の参考候補。画像OCRでありPDF直接入力不可。言語資材と品質は別評価 |
| [pdfminer.six](https://github.com/pdfminer/pdfminer.six) | MIT。[layout.py](https://github.com/pdfminer/pdfminer.six/blob/a18de2a9c479b4c847538500017b449ddaec177e/pdfminer/layout.py)／[high_level.py](https://github.com/pdfminer/pdfminer.six/blob/a18de2a9c479b4c847538500017b449ddaec177e/pdfminer/high_level.py) | ローカル補助候補。detect_vertical／layout閾値の比較が可能。複雑PDF完全復元ではない |

PDF.jsのCMap、標準フォント、画像decoder等やOCRのモデル資材には別noticeが含まれ得ます。本体ライセンスだけで配布物全体を一括判定しません。追加plugin（remark-gfm、remark-frontmatter等）も導入versionのLICENSEを確認します。

## RSVP実装の参照

| 実装 | 本体ライセンス | 入口／参考にする箇所 | 日本語向けの不足 |
| --- | --- | --- | --- |
| Glance-Bookmarklet | MIT | 最小RSVPと文末の間 | 空白split、語の複製による休止、外部記事抽出 |
| thomaskolmans/rsvp-reading | MIT | PDF入口、表示関数、再帰timer、保存導線 | PDF座標喪失、空白split、ASCII休止 |
| kevinsslin/obsidian-rsvp-reader | MIT | tokenとtimelineの分離、anchor付きcheckpoints | regex MD、空白split、後付けsource照合 |
| SplashReader | GPL v2 | 原文範囲との往復、停止位置scroll | Web選択用、空白/dash区切り、非ASCII一律時間補正 |
| LetoReader | GPL v3 | 複数形式importと周辺文脈 | 空白split・文字数切断、固定待機、位置mapなし |
| madhusudan-kulkarni/obsidian-speed-reader | 0BSD | engine、code/math/table停止、micropause分離 | regex MD、空白split、加工後offset、長文時間走査 |

詳細、具体的参照ファイル、実行未検証の注意点は[6実装のコード比較](rsvp-implementations.md)にあります。GPL例のコードはコピーせず、設計の参考としました。依存候補のライセンスを、このrepoの製品ライセンスとして採用していません。

## 確認したheadと更新状況

| Repository | 固定head | head日付（UTC） | 本体ライセンスの読取り |
| --- | --- | --- | --- |
| [Axym-Labs/LetoReader](https://github.com/Axym-Labs/LetoReader) | [fcf27ed](https://github.com/Axym-Labs/LetoReader/commit/fcf27ed9c69b196996b237a97f8986f84f5f4e3e) | 2024-11-10 | GPL v3 |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | [df84828](https://github.com/mozilla/pdf.js/commit/df8482898bb01f97b2b18d558b7caee4d0730993) | 2026-10-05 | Apache-2.0 |
| [remarkjs/remark](https://github.com/remarkjs/remark) | [1146b3a](https://github.com/remarkjs/remark/commit/1146b3a274fc1f4607111e5d6607a3a769a0e89a) | 2026-09-27 | MIT |
| [naptha/tesseract.js](https://github.com/naptha/tesseract.js) | [a1ca80d](https://github.com/naptha/tesseract.js/commit/a1ca80d9e31c34512d0ded75ff8821ddcf3f2f91) | 2026-05-17 | Apache-2.0 |
| [pdfminer/pdfminer.six](https://github.com/pdfminer/pdfminer.six) | [a18de2a](https://github.com/pdfminer/pdfminer.six/commit/a18de2a9c479b4c847538500017b449ddaec177e) | 2026-03-13 | MIT |
| [madhusudan-kulkarni/obsidian-speed-reader](https://github.com/madhusudan-kulkarni/obsidian-speed-reader) | [5676e25](https://github.com/madhusudan-kulkarni/obsidian-speed-reader/commit/5676e254468d989fcd6027cae1ec5ffb532d75bb) | 2026-09-21 | 0BSD |
| [google/budoux](https://github.com/google/budoux) | [a139e51](https://github.com/google/budoux/commit/a139e51bbb11a22c4a8948bf4a7e698bcd77b595) | 2026-10-05 | Apache-2.0 |
| [takuyaa/kuromoji.js](https://github.com/takuyaa/kuromoji.js) | [71ea847](https://github.com/takuyaa/kuromoji.js/commit/71ea8473bd119546977f22c61e4d52da28ac30a6) | 2018-11-24 | Apache-2.0＋辞書NOTICE別 |
| [leungwensen/tiny-segmenter](https://github.com/leungwensen/tiny-segmenter) | [174c5e7](https://github.com/leungwensen/tiny-segmenter/commit/174c5e71578459cbac67deb7c25d8a53566c6120) | 2016-10-20 | root MIT／原実装BSD要照合 |
| [lindera/lindera](https://github.com/lindera/lindera) | [e5c6c68](https://github.com/lindera/lindera/commit/e5c6c685f385f390d5a2fab4d26fd234b0b980e0) | 2026-10-05 | MIT＋辞書別 |
| [megagonlabs/ginza](https://github.com/megagonlabs/ginza) | [fd0317e](https://github.com/megagonlabs/ginza/commit/fd0317e48aadfc69eee9267bbcabce81210aa613) | 2026-09-30 | MIT＋依存辞書別 |
| [WorksApplications/sudachi.rs](https://github.com/WorksApplications/sudachi.rs) | [1c21940](https://github.com/WorksApplications/sudachi.rs/commit/1c21940d1ca6b045eb211ecc1cdb767326f3783f) | 2026-10-02 | Apache-2.0＋辞書別 |
| [Miserlou/Glance-Bookmarklet](https://github.com/Miserlou/Glance-Bookmarklet) | [27db904](https://github.com/Miserlou/Glance-Bookmarklet/commit/27db9046e2bb363a86de34f4ea1a6e829bc47133) | 2017-09-22 | MIT |
| [thomaskolmans/rsvp-reading](https://github.com/thomaskolmans/rsvp-reading) | [14ad25c](https://github.com/thomaskolmans/rsvp-reading/commit/14ad25c12b0150bb98d793260cb3ed08ccd6ead4) | 2026-01-18 | MIT |
| [kevinsslin/obsidian-rsvp-reader](https://github.com/kevinsslin/obsidian-rsvp-reader) | [3bc0289](https://github.com/kevinsslin/obsidian-rsvp-reader/commit/3bc0289c431254a1d40fb37adb620bb5f98dfd70) | 2026-07-15 | MIT |
| [rattrayalex/splashreader](https://github.com/rattrayalex/splashreader) | [5ca29d2](https://github.com/rattrayalex/splashreader/commit/5ca29d2e49edea2134bc435b4163c11a27eb8680) | 2016-09-08 | GPL v2 |
| [syntax-tree/mdast-util-to-string](https://github.com/syntax-tree/mdast-util-to-string) | [91a3f93](https://github.com/syntax-tree/mdast-util-to-string/commit/91a3f931b82b5493e4c4e4f4f9e1487a516003d4) | 2024-04-30 | MIT |
| [syntax-tree/mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) | [afe9516](https://github.com/syntax-tree/mdast-util-from-markdown/commit/afe9516d97683e51974694f944a799a915a242c0) | 2026-10-03 | MIT |

補足：PDF.jsのlatest releaseはv6.4.299（2026-10-03）、Tesseract.jsはv7.0.0（2025-12-15）、追加比較のObsidian Speed Readerは1.4.0（2026-09-21）をAPIで確認しました。remark repoのlatest release表示はremark-cli@12.0.0であり、remark-parseの最新npm版を意味しません。head snapshotのpackage versionと配布releaseは区別します。

## 調査の制約

この比較調査自体では候補の実行・精度比較を行っていません。後続の初期実装ではBudouX・対応入力・PC／スマホエミュレーションを検証し、導入依存を[棚卸し](../licenses/README.md)しました。実機性能・全PDF形式の復元評価とTinySegmenter原作者ライセンスの全文照合は未実施です。候補比較の再実施は初期の必須作業ではありません。
