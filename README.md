# Ripola

日本語の文章を、区切りを順に読むRSVPリーダーです。Markdown・TXT・青空文庫形式・テキスト層付きPDFを取り込み、読む速度を変えたり、止まって原文に戻ったりできます。

**[ブラウザでデモを試す](https://ripola-preview-20261006.ryomini13.workers.dev/)** · [読書ガイド](docs/guides/reading.md) · [セットアップ](docs/guides/setup.md) · [資料一覧](docs/README.md)

## できること

- BudouXによる表示用フレーズ、ルビ、句読点での休止、文字サイズ・明暗・フォントの調整。
- Flashのまとめ表示と停止時の前後文脈、現在位置を追うGuide全文表示。
- 再生・停止、キーボード操作、文・フレーズ・音声5秒の移動、原文の確認。
- 文章・読書位置の端末内への明示保存、任意タイトルと後からの名前変更。
- ローカルPCでの音声生成・保存・同期補正、生成済み音声の再利用。

同梱サンプルには青空文庫『吾輩は猫である』全文の黙読と、冒頭の3音声（VOICEVOX／Gemini Puck／Kore）があります。保存済み音声の再生にはキー・Engine・Pythonは不要です。**VOICEVOX:ずんだもん**。[サンプルの出典・利用条件](apps/web/public/samples/audio/NOTICE.md)を参照してください。公開デモは以前の配布版のため、最新コードの3音声選択は未反映です。

分割は表示用の推定です。PDFは**横書き1段・テキスト層あり**が対象で、OCR・段組・縦書き・PDFルビの復元は未対応です。端末間同期・PWA・クラウド側の音声生成は未実装です。読む速度や理解度の向上を保証しません。

## 最初の起動

Node.js **22.13.0以上**（検証版は26.8.1）、pnpm **12.3.4**を使います。

```sh
npm install --global pnpm@12.3.4
git clone https://github.com/ryryo/ripola.git
cd ripola
pnpm install --frozen-lockfile
pnpm dev
```

http://127.0.0.1:4173/ を開きます。通常読書とサンプル再生に `.env.local` は不要です。ビルド確認は `pnpm build` → `pnpm preview`（http://127.0.0.1:4174/）。

音声生成後の同期補正を使う場合は、Python **3.13**とffmpeg／ffprobeを用意し、**`pnpm setup:audio`** を実行します。専用Python環境・固定依存・固定モデル・設定を準備し、既存ファイルは検証して再利用します。初回はモデル約387 MB＋依存約110 MB、導入後約1 GBです。自動セットアップの対象はmacOS Apple Siliconです。**Windows／Linuxの初期セットアップQAは後回しで未検証**、Intel Macも未検証です。[要件と対処](docs/guides/setup.md)を参照してください。

## 自分の文章に音声を付ける

音声生成はローカルPCで使います。GeminiはLiteモデルが既定です。

| 経路 | 設定 | 発話本文の送信先 |
| --- | --- | --- |
| 無料VOICEVOX | 同じPCの[公式アプリ](https://voicevox.hiroshiba.jp/)を起動。キー不要 | 同じPCのEngine |
| Gemini Direct | `.env.local` に `GEMINI_API_KEY` の1項目 | Google |
| Cloudflare | Wranglerログイン＋[ローカル設定のGateway選択](docs/guides/ai-gateway.md) | Cloudflare（Gateway設定に応じてGoogleモデルを利用） |

[.env.example](.env.example) は日本語コメント付きの最小1キーです。既存 `.env.local` を上書きせず、必要な設定だけ追加してサーバーを再起動します。生成前に本文・声・対象・送信先・費用目安を確認し、明示的に開始します。保存済み音声の再生・補正・配布ではTTSを再送しません。[音声生成ガイド](docs/guides/audio-generation.md)と[特殊な設定](docs/guides/configuration.md)へ。

## 保存と配布

通常の取り込み・本文抽出・RSVP生成はブラウザ内で処理します。明示保存した文章・位置は、そのoriginのIndexedDBに保存します。ローカル生成の原稿・音声・対応表・ジョブは、既定で `~/Documents/rsvp-reader-library` に保存します。

```sh
pnpm build:worker
# Pages向けは pnpm build:pages
```

個人libraryを読まず、同梱サンプル付きの閲覧用配布物を準備します。**ビルドだけではデプロイしません。** Worker／Pagesは端末内の取り込み・RSVP生成と保存音声の再生に対応し、生成API・秘密キー・Python環境を含めません。

公開デモと、各利用者が自分のアカウントに配布する個人用Workerは分離します。音声付きの本は配布できるものを明示選択します。配布した本文JSON・音声は取得可能です。閲覧認証は任意で、制限したい場合は本文・音声を含めAccess等を設定します。[Cloudflare配布](docs/guides/cloudflare-deployment.md)・[個人用Worker](docs/guides/personal-worker.md)へ。

## 開発・ライセンス

検査は `pnpm check` と `pnpm test:e2e`。[CONTRIBUTING.md](CONTRIBUTING.md)に再現方法と報告手順があります。

Ripolaのコードと文書は[MIT License](LICENSE)です。[適用範囲](docs/licenses/product-license.md)、[第三者LICENSE・NOTICE](docs/licenses/README.md)、[リリース前チェック結果](docs/validation/public-release/README.md)を参照してください。依存・フォント・モデル・サンプル本文と音声には、それぞれの利用条件を保持します。
