# 日本語分割ライブラリの比較記録（参考）

**現在の初期方針はBudouX採用です。** 以下は採用方針を絞る前の静的比較記録で、解析器比較・形態素モード・辞書導入を初期実装に要求するものではありません。実装時は[BudouX分割設計](../development/segmentation.md)と現在のMVPを参照してください。

調査日：2026-10-05。公開GitHubの実コードとライセンスを確認した静的調査です。この候補比較は静的調査で、各候補の実行・速度比較は行っていません。実装結果は検証記録へ分けます。[固定commitと更新状況](oss-libraries.md)を参照してください。

## 単語・文節・表示単位は別

「私は本を読んでいます。」は、形態素なら`私 / は / 本 / を / 読ん / で / い / ます / 。`となり得ます。表示上は`私は / 本を / 読んでいます。`が候補です。後者も、学校文法の文節・解析器の短単位・画面で読みやすいフレーズと常に一致するわけではありません。

MVPの軽量候補は**BudouXの日本語モデル＋境界保護**です。これは改行向けのフレーズ推定で、UIでは「フレーズ表示／文節相当」と呼びます。文節の品質を確認する比較対象は**kuromoji.js＋品詞連結ルール**。文法的な文節が必須条件なら、BudouXを文節解析器と扱わず、**GiNZAの文節spanとの比較評価を先に行います**。採用は自作の評価文と利用者の読みやすさを確認した後に決めます。

文法寄りの`bunsetsu`と画面上の`displayUnit`を分け、表示の都合で分割／結合した理由を記録します。分割モード・辞書・規則バージョンも保存します。

## 候補別の実コード確認

### BudouX：軽量な第一候補

品詞・活用・係り受けを返す解析器ではありません。JSの純粋な`Parser`と日本語`jaModel`をWorkerで使い、HTMLProcessorやWeb ComponentはRSVPに使う必要がありません。

`parseBoundaries`はUTF-16位置、`parse`は原文sliceの配列を返します。サロゲートペアの内部は切りませんが、結合文字や絵文字ZWJ列の全体を守る保証とは異なるため、アプリでgrapheme境界に制限します。[parser.ts](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/javascript/src/parser.ts)。

外部の語彙辞書や有料APIは不要です。上流READMEの「モデル込み約15 KB」は上流の説明値で、本プロジェクトの実配布物・圧縮条件・最終bundleの計測値ではありません。確認時のJS package.jsonは0.9.3。採用するnpm versionとモデルhashを別途固定します。本体Apache-2.0。[JS README](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/javascript/README.md)、[package.json](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/javascript/package.json)、[LICENSE](https://github.com/google/budoux/blob/a139e51bbb11a22c4a8948bf4a7e698bcd77b595/LICENSE)。

HTML入力をsanitizeする機能としては扱いません。MDの生HTMLを`translateHTMLString`へ直接渡さず、抽出済み本文を`textContent`で表示します。

### kuromoji.js：品詞規則を作る場合

純JSの辞書型形態素解析器で、`surface_form`、`pos`、`pos_detail_1..3`、活用型・活用形・原形・未知語情報等を返します。文節・依存構造は返しません。Viterbi lattice/searchとIPADIC formatterを使います。[README](https://github.com/takuyaa/kuromoji.js/blob/71ea8473bd119546977f22c61e4d52da28ac30a6/README.md)、[Tokenizer](https://github.com/takuyaa/kuromoji.js/blob/71ea8473bd119546977f22c61e4d52da28ac30a6/src/Tokenizer.js)。

ブラウザでは本体に加えて`dict/*.dat.gz`が必要です。BrowserDictionaryLoaderはXHRでArrayBufferを取り、zlibjsでgunzipします。読込・展開・初期化を完了してから使い、Worker内で一度だけ初期化する案が有力です。[loader](https://github.com/takuyaa/kuromoji.js/blob/71ea8473bd119546977f22c61e4d52da28ac30a6/src/loader/BrowserDictionaryLoader.js)。

固定commitのContents APIのsizeを合計した辞書12 gzipファイルは**17,791,956 bytes（17.8 MB、約17.0 MiB）**です。これはリポジトリ上の圧縮ファイル総量で、展開後RAM・JS bundle・HTTP overhead・所要時間ではありません。端末別の時間とメモリは未測定。[辞書metadata](https://api.github.com/repos/takuyaa/kuromoji.js/contents/dict?ref=71ea8473bd119546977f22c61e4d52da28ac30a6)、サイズとblobの記録。

`.dat.gz`をHTTP Content-Encodingにより自動展開すると、loader側がさらにgunzipしようとする可能性があります。gzipをアプリデータとしてそのまま取得できる配信設定を試験します。

**word_positionをJS sliceへ直接渡さないこと。** ViterbiBuilderはSurrogateAwareString由来の位置を用います。本文とsurface_formを前から照合し、UTF-16位置を別に作って復元一致を確認します。[ViterbiBuilder](https://github.com/takuyaa/kuromoji.js/blob/71ea8473bd119546977f22c61e4d52da28ac30a6/src/viterbi/ViterbiBuilder.js)。

本体Apache-2.0と、同梱NOTICEのIPADIC／NAIST／ICOT条項を区別します。NOTICEを捨てて辞書まで全てApacheと扱いません。[本体LICENSE](https://github.com/takuyaa/kuromoji.js/blob/71ea8473bd119546977f22c61e4d52da28ac30a6/LICENSE-2.0.txt)、[NOTICE](https://github.com/takuyaa/kuromoji.js/blob/71ea8473bd119546977f22c61e4d52da28ac30a6/NOTICE.md)。確認したdefault-branch headは2018年のcommitです。repositoryのpushed_atは2023年ですが、これは他refへのpushも含み得るため、headの日付と混同しません。新しいforkを採用するならそのpackageの由来・互換性・保守を別に調べます。

### TinySegmenter：単語分割の比較候補

単語分割のみで品詞・原形・文節情報を返しません。モデル重みはJS内にあり外部辞書は不要ですが、bundle sizeや速度は測定していません。確認mirrorの`input.split('')`はUTF-16 code unit分割のため、外側でsurrogate／grapheme保護が必要です。

mirrorのroot LICENSEはMITですが、`lib/index.js`冒頭にはTaku Kudo原作のnew BSDの記載があります。単一MITと断言せず両方のnoticeを確認します。原作者側のライセンス全文は照合できておらず、完全な確認済みとは扱いません。[実装と原著作権記載](https://github.com/leungwensen/tiny-segmenter/blob/174c5e71578459cbac67deb7c25d8a53566c6120/lib/index.js)、[mirror LICENSE](https://github.com/leungwensen/tiny-segmenter/blob/174c5e71578459cbac67deb7c25d8a53566c6120/LICENSE)。

### Intl.Segmenter：Unicode境界の補助

標準の粒度はgrapheme／word／sentenceで、bunsetsuや品詞はありません。wordモードを文節として直接使いません。indexはUTF-16 offset。graphemeモードを結合濁点・variation selector・ZWJ emoji内部の切断防止と文字数計数に使います。[TC39 APIとoffset定義](https://github.com/tc39/proposal-intl-segmenter)、[仕様](https://tc39.es/proposal-intl-segmenter/)。

ブラウザ内蔵なら独自辞書ダウンロードは不要です。ネイティブAPIにnpmライブラリの配布ライセンスを割り当てません。polyfillを同梱する場合は実装とデータを別に調べます。`typeof Intl.Segmenter`で能力確認を行い、ブラウザ／ICU差で語分割が完全に固定されるとは仮定しません。

### Lindera WASM：将来の置換候補

現行は`lindera/lindera`内の`lindera-wasm`です。旧独立repoは移転を告知しています。Rust形態素解析のWASMで、文節解析ではありません。async WASM init、外部辞書runtime load、OPFSでの辞書保存が説明されています。[WASM README](https://github.com/lindera/lindera/blob/e5c6c685f385f390d5a2fab4d26fd234b0b980e0/lindera-wasm/README.md)、[旧repo](https://github.com/lindera/lindera-wasm)。

tokenのbyteStart／byteEndはbyte offsetなので、UTF-16へ明示変換します。filter正規化後の対応も試験します。本体とlindera-wasmともMIT、辞書条件は別。WASM・辞書・OPFS quota・CSP・MIME／CORS・初期化の運用が増えるため、MVPでは保留します。WASMだから小さく速いとは推定しません。[本体LICENSE](https://github.com/lindera/lindera/blob/e5c6c685f385f390d5a2fab4d26fd234b0b980e0/LICENSE)、[WASM LICENSE](https://github.com/lindera/lindera/blob/e5c6c685f385f390d5a2fab4d26fd234b0b980e0/lindera-wasm/LICENSE)。

### SudachiPy／GiNZA：ローカル比較

SudachiPyのA/B/Cは形態素の粒度で、文節解析ではありません。現行はRust binding、辞書small/core/full。READMEのcore約70 MBは上流の説明で実測ではありません。engine・辞書・設定をセットで固定します。本体Apache-2.0と、SudachiDict LEGALのUniDic／NEologd由来noticeを区別します。[現行README](https://github.com/WorksApplications/sudachi.rs/blob/1c21940d1ca6b045eb211ecc1cdb767326f3783f/python/README.md)、[LICENSE](https://github.com/WorksApplications/sudachi.rs/blob/1c21940d1ca6b045eb211ecc1cdb767326f3783f/LICENSE)、[SudachiDict LEGAL](https://github.com/WorksApplications/SudachiDict/blob/develop/LEGAL)。READMEにはv0.7の辞書形式変更とpatch versionでも破壊的変更があり得る説明があります。

GiNZAはspaCyとSudachiを使い、依存構造に基づく`ginza.bunsetu_spans(doc)`を提供します。比較対象の中では実際に文節spanを得る経路です。`bunsetu_phrase_spans`は内容語phraseを取り出す別APIなので取り違えません。[文節実装](https://github.com/megagonlabs/ginza/blob/fd0317e48aadfc69eee9267bbcabce81210aa613/ginza/bunsetu_recognizer.py)。ライブラリ／日本語UDモデルはMIT、依存辞書等は別条件。[README](https://github.com/megagonlabs/ginza/blob/fd0317e48aadfc69eee9267bbcabce81210aa613/README.md)、[LICENSE](https://github.com/megagonlabs/ginza/blob/fd0317e48aadfc69eee9267bbcabce81210aa613/LICENSE)。

Python全体をブラウザへ持ち込むMVPは避け、ローカル評価なら標準ja_ginzaを比較基準とします。Transformer系は最初の狭い比較では過大な候補で、モデルdownloadも考慮します。GiNZA出力を無条件の正解にはしません。

## 推奨パイプライン（設計案）

1. 入力時に段落・見出し・page/item/AST nodeの元位置を保持。壊れたPDF読順を分割器で修正しようとしない。
2. 抽出原文と表示本文を分け、UTF-16 spanから原文へのsource mapを作る。元ファイルを一律NFKC等で置換しない。
3. URL／email／inline code／数値・日付／latin identifier／ruby baseとgraphemeを保護spanにする。
4. 段落内の短い区間ごとにBudouXで候補境界を得る。句点・改行は休止metadataとして別に扱う。
5. grapheme／保護span内部の境界を削除。句読点・閉じ括弧は左、開き括弧は次の本体へ。引用内部は通常どおり分割可能。
6. 形態素モードでは表層・位置を復元検証し、品詞規則で境界を調整。辞書読込失敗時はモード変更を明示してfallback、再生中に黙って変更しない。
7. 確定境界から原文sliceを作り、空unitなし、位置単調、欠落・重複なし、全unitの結合が本文と一致することを検証。
8. 過長unitは表示時間、文字サイズ、ユーザー修正で救済。必要な再分割は安全な形態素／句読点境界に限定し、元のbunsetsu IDを保持。

```text
document = extractWithProvenance(file)
for block in document.readingOrder:
    text, sourceMap, ruby = buildDisplayText(block)
    protectedSpans = findProtectedSpans(text, ruby)
    graphemeBoundaries = segmentGraphemes(text)
    cuts = budouParser.parseBoundaries(text) ∩ graphemeBoundaries
    cuts = cuts outside interior(protectedSpans)
    if morphologyMode and tokenizerReady:
        tokens = alignSurfacesForward(text, tokenizer.tokenize(text))
        if alignmentIsExact(tokens, text):
            cuts = adjustWithPOS(cuts, tokens, policy)
        else:
            recordWarning('morphology alignment failed')
    cuts = attachPunctuationAndQuoteEdges(cuts, text)
    cuts = cuts ∩ graphemeBoundaries outside interior(protectedSpans)
    chunks = sliceByOffsets(text, sortedUnique([0, ...cuts, text.length]))
    assert join(chunks.text) == text
    attachSourceSpans(chunks, sourceMap)
```

区間解析した場合はbase offsetを加算します。位置復元は全文indexOfではなく前回endから前進照合し、飛び越した空白等もgap spanとして残します。非空白が飛ばされた場合は要確認／fallbackとして記録します。

## 品詞ベースの連結規則

完全な文法実装ではなく、表示単位の提案です。辞書ごとの品詞体系をadapterで共通化し、IPADICの名称をSudachiへそのまま転用しません。

| 規則 | 例／注意 |
| --- | --- |
| 助詞を前の内容語へ | `私 / は`→`私は`、`東京 / から / は`→`東京からは`。語末文字だけで判定しない |
| 助動詞・活用語尾を左へ | `読み / ませ / ん / でし / た`→`読みませんでした`。原形を表示に使わない |
| 非自立・補助動詞は条件付きで左へ | `読んで / いる`→`読んでいる`。自立の「いる」「みる」を全て結合しない |
| サ変＋する、接頭辞、接尾辞・助数詞 | `勉強しています`、`お客様`、`3冊`。名詞連続を無制限に結合しない |
| 内容語前を候補境界に | `赤い / 花が`。数詞＋助数詞、ruby base、既知複合語は保護 |
| 接続助詞を前へ | `雨が / 降ったので、 / 帰った。`。「て」「と」全ての後で切らない。「という」「について」は個別方針 |
| 記号と引用助詞 | `彼は / 「明日は / 晴れる」と / 言いました。`。引用全体を一unitにしない |
| 数字・英字を保護 | `3.14`、`1,200円`、日付、TypeScript、v2.1、URLの内部を切らない。URL末尾句点を区別 |
| rubyを本文に重複させない | baseは本文、rtはannotation。独自記法は方言として仕様化 |

BudouX／TinySegmenter／Intlには品詞がありません。短い助詞文字のwhitelistで規則を代用すると誤結合するため、fallbackは確実な句読点・保護spanに絞ります。助詞連結を保証する仕様なら品詞解析の依存を明記します。

## 評価と未検証事項

8つの自作例は望ましい表示の候補です。ライブラリ実行結果・文法的gold corpus・精度の主張ではありません。

人手で境界を付け、BudouX、kuromoji規則、GiNZAの境界precision／recall／F1、助詞単独率、過長unit率、grapheme破壊、欠落・重複を比べます。境界の別解を許容し、引用・否定・固有名詞・数値・絵文字を別々に確認します。意味の曖昧さは境界精度とは分けます。

導入時に測るものは、実bundle／compressed transfer／辞書量、未キャッシュ・キャッシュ済み初期化、ピークRAM、Workerへのcopy、段落準備時間、低性能スマホでのmain-thread停止です。`.dat.gz`配信、WASM CSP／OPFS、offline時の辞書欠落も試験します。PDF読順・ルビ抽出は分割器とは別の品質として評価します。
