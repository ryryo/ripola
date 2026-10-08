# 既存RSVP実装のコード分析（参考）

本資料は既存実装の設計を参照するための記録です。rsvp-readerの初期分割器はBudouXに決定しており、以下の実装との比較や移植をMVPの必須工程にはしません。[現在の方針](../README.md)と[構成](../development/architecture.md)を優先します。

調査日：2026-10-05。公開リポジトリの実コードとLICENSEを読んだ静的調査です。アプリ起動、実機試験、既存テストの実行はしていません。推奨は設計判断で、既存製品の性能実証ではありません。固定commit・更新日・ライセンスの一覧は[OSS比較](oss-libraries.md)にあります。

英語向けRSVPのUIや責務分離は参考になりますが、Unicodeの日本語文字を表示できることと、文節を正しく区切れることは別です。読み取った例の多くは空白／改行を区切りにしています。

## 1. Glance-Bookmarklet（旧OpenSpritz）

[repo](https://github.com/Miserlou/Glance-Bookmarklet)／[MIT](https://github.com/Miserlou/Glance-Bookmarklet/blob/27db9046e2bb363a86de34f4ea1a6e829bc47133/LICENSE)。旧OpenSpritz URLはこのrepoへ転送されます。実読コードは[spritz.js](https://github.com/Miserlou/Glance-Bookmarklet/blob/27db9046e2bb363a86de34f4ea1a6e829bc47133/spritz.js)、blob=`b5a8ebb3a18439178efc92f58bc061ef710dfc10`。

入力は選択テキストまたはURL記事抽出です。URL抽出は外部APIを呼び、この経路をブラウザ内完結とは扱えません。PDF／MD専用パーサーではありません。

spritzifyは空白split。長語やコンマを含む語を配列へ重複挿入し、文末は空白要素を入れ、`setInterval(60000/wpm)`で送ります。ORPは文字列長別の固定位置です。

最小の逐次表示と文末の間は参考になります。新アプリでは休止をtoken重複で表さずduration metadataにします。全timer IDを走査して解除するclearTimeoutsも同居する他機能を止める危険があるので採用せず、自分のtimerだけを管理します。日本語無空白文・句点・grapheme対応は別途必要です。

## 2. thomaskolmans/rsvp-reading

[repo](https://github.com/thomaskolmans/rsvp-reading)／[MIT](https://github.com/thomaskolmans/rsvp-reading/blob/14ad25c12b0150bb98d793260cb3ed08ccd6ead4/LICENSE)。実読コード：[rsvp-utils.js](https://github.com/thomaskolmans/rsvp-reading/blob/14ad25c12b0150bb98d793260cb3ed08ccd6ead4/src/lib/rsvp-utils.js)、[file-parsers.js](https://github.com/thomaskolmans/rsvp-reading/blob/14ad25c12b0150bb98d793260cb3ed08ccd6ead4/src/lib/file-parsers.js)、[App.svelte](https://github.com/thomaskolmans/rsvp-reading/blob/14ad25c12b0150bb98d793260cb3ed08ccd6ead4/src/App.svelte)。blobは順に`9f3993d591a531b33215e5b264c35958a14bcbac`／`5eaa85a97f1f6eafe79eff59ebc0ebac2a954449`／`bc4674032f787747050c3af047ef41e74ace6108`。

貼り付け・PDF・EPUBが入口です。PDF.jsの各ページitemsからstrを空白で結合し、全whitespaceをさらに空白に正規化するため、座標・段落・ページとの対応が消えます。workerはunpkgの外部URL指定です。

空白分割で、ORPのUnicode対応だけでは日本語の語分割になりません。文末はASCII`[.!?;:]`、コンマは1.5倍。複数語表示は現在位置周辺の窓であり、統語的phrase segmentationではありません。再生は再帰setTimeout、戻る・保存はword indexベースです。小さな関数分離と保存／再開の導線は参考になります。

静的に注意した箇所は、定期休止後にindexを進めず同じ境界で再休止する可能性と、最終語で次timerを張らないため終了状態へ進まない可能性です。どちらも**実行未検証**で、確定不具合とはしません。新実装の境界テスト項目にします。

## 3. kevinsslin/obsidian-rsvp-reader

[repo](https://github.com/kevinsslin/obsidian-rsvp-reader)／[MIT](https://github.com/kevinsslin/obsidian-rsvp-reader/blob/3bc0289c431254a1d40fb37adb620bb5f98dfd70/LICENSE)。以下は固定commitの参照ファイルとblobです。

- [tokenizer.ts](https://github.com/kevinsslin/obsidian-rsvp-reader/blob/3bc0289c431254a1d40fb37adb620bb5f98dfd70/src/core/tokenizer.ts)：`b6cab7b5800b5a378d7435bb5e4c9cba5444b890`
- [scheduler.ts](https://github.com/kevinsslin/obsidian-rsvp-reader/blob/3bc0289c431254a1d40fb37adb620bb5f98dfd70/src/core/scheduler.ts)：`a93066311a3b260e855a72fd28b8a25d1b3c016c`
- [align.ts](https://github.com/kevinsslin/obsidian-rsvp-reader/blob/3bc0289c431254a1d40fb37adb620bb5f98dfd70/src/core/align.ts)：`0701c3e8ce014633a7129a60b440386c7769399b`
- [checkpoints.ts](https://github.com/kevinsslin/obsidian-rsvp-reader/blob/3bc0289c431254a1d40fb37adb620bb5f98dfd70/src/checkpoints.ts)：`778c33ea9c4524e2e8e4782497da6ca9b8eb571a`

入力はObsidianノート／選択テキストで、PDF等を除外します。MDを正規表現で簡略化し、段落→空白単語へ分割。frontmatter／fenced code除外、wiki link alias、inline code、link、強調処理がありますが、完全CommonMarkパーサーではありません。

schedulerはtokenと時間を分け、絶対開始時刻・durationを作り、節／文／段落の倍率は最大値を採用します。二分探索で時刻からindexを引く設計が参考になります。数値設定は日本語最適値の根拠とは扱いません。

本文同期は前進`source.indexOf(key, cursor)`。checkpointsはindexに加えsourceOffsetと前後tokenを保存し、編集後復帰の参考になります。一方、除外code／frontmatterに同じ語がある場合や正規化で本文が変わる場合の誤対応があり得ます。新規開発ならAST巡回時からsource mappingを持ちます。

## 4. SplashReader

[repo](https://github.com/rattrayalex/splashreader)／[GPL v2](https://github.com/rattrayalex/splashreader/blob/5ca29d2e49edea2134bc435b4163c11a27eb8680/LICENSE)。実読コード：[splash.js](https://github.com/rattrayalex/splashreader/blob/5ca29d2e49edea2134bc435b4163c11a27eb8680/src/lib/splash.js)、[ranges.js](https://github.com/rattrayalex/splashreader/blob/5ca29d2e49edea2134bc435b4163c11a27eb8680/src/lib/ranges.js)、[rsvp.js](https://github.com/rattrayalex/splashreader/blob/5ca29d2e49edea2134bc435b4163c11a27eb8680/src/lib/rsvp.js)、[constants.js](https://github.com/rattrayalex/splashreader/blob/5ca29d2e49edea2134bc435b4163c11a27eb8680/src/constants.js)。

Webページ上の選択範囲をRangyで移動し、原文選択とRSVPを同期します。段落移行時は通常本文へ戻して1秒の間を入れ、停止位置を本文へスクロールします。通常読みとRSVPを往復するUXが特に参考になります。

空白・dashで単語を区切り、長語・数字・非ASCII・文末で時間を増やします。日本語が非a-zA-Zとして一律に扱われるため、その時間補正は流用しません。PDF／MDのimport基盤ではありません。GPLコードはコピーせず設計の参考とし、実コードの再利用は配布条件を個別確認します。

## 5. LetoReader

[repo](https://github.com/Axym-Labs/LetoReader)／[GPL v3](https://github.com/Axym-Labs/LetoReader/blob/fcf27ed9c69b196996b237a97f8986f84f5f4e3e/LICENSE)。実読コード：[FileImporter.cs](https://github.com/Axym-Labs/LetoReader/blob/fcf27ed9c69b196996b237a97f8986f84f5f4e3e/Reader/Modules/Product/FileImporter.cs)、[TextHelper.cs](https://github.com/Axym-Labs/LetoReader/blob/fcf27ed9c69b196996b237a97f8986f84f5f4e3e/Reader/Modules/TextHelper.cs)、[ReaderManager.cs](https://github.com/Axym-Labs/LetoReader/blob/fcf27ed9c69b196996b237a97f8986f84f5f4e3e/Reader/Modules/Reading/ReaderManager.cs)、[PositionInfo.cs](https://github.com/Axym-Labs/LetoReader/blob/fcf27ed9c69b196996b237a97f8986f84f5f4e3e/Reader/Data/Reading/PositionInfo.cs)。

PDF／MD／TXT／HTML／EPUBをimporterで分岐します。PDFはPdfPig ContentOrderTextExtractor.GetText、MDはMarked→HTML→InnerTextで、原文位置mapは返しません。空白・改行で分割し、長いpieceを設定文字数で再切断します。固定`60 / ReadingSpeed`待機で、読んだループには句読点別休止がありません。PositionInfoのCharIndexは未実装例外です。

複数形式の入口と周辺文脈表示は参考になります。日本語tokenizer・原文同期を流用する用途ではありません。セルフホスト・ローカル保存という説明から、処理が全てブラウザ内であると推定しません。

## 6. Obsidian Speed Reader（追加比較）

[repo](https://github.com/madhusudan-kulkarni/obsidian-speed-reader)／[0BSD](https://github.com/madhusudan-kulkarni/obsidian-speed-reader/blob/5676e254468d989fcd6027cae1ec5ffb532d75bb/LICENSE)。[rsvpEngine.ts](https://github.com/madhusudan-kulkarni/obsidian-speed-reader/blob/5676e254468d989fcd6027cae1ec5ffb532d75bb/src/engine/rsvpEngine.ts)、[textParser.ts](https://github.com/madhusudan-kulkarni/obsidian-speed-reader/blob/5676e254468d989fcd6027cae1ec5ffb532d75bb/src/services/textParser.ts)、[blockParser.ts](https://github.com/madhusudan-kulkarni/obsidian-speed-reader/blob/5676e254468d989fcd6027cae1ec5ffb532d75bb/src/services/blockParser.ts)、[micropauseService.ts](https://github.com/madhusudan-kulkarni/obsidian-speed-reader/blob/5676e254468d989fcd6027cae1ec5ffb532d75bb/src/services/micropauseService.ts)を読みました。

code／math／tableをsentinelで置換して別blockにし、再生時にそこで止まるengine、見出し移動、context表示、micropauseのmodule分離が参考になります。

ただしMD処理はregex、tokenizeは`/\S+/g`、句読点休止はASCII中心です。tokenのstart/endは加工後の文字列に対する位置で、元Markdown位置へそのまま足せません。残り時間を状態通知ごとに全残存chunkから算出するため、長文では累積時間等に変える設計を検討します。これは静的に読んだ計算量の指摘で、実機性能の測定ではありません。

## 新規アプリで採用する共通方針

入力の構造・元位置、分割、duration計算、再生状態を分離します。休止のための偽tokenを入れず、戻る／停止／原文再開を先に作ります。再分割後は古いindexではなく原文anchorから引き直します。英語の空白splitやASCII休止を「日本語対応」と扱いません。
