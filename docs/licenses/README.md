# 導入依存と第三者ライセンス

確認日：2026-10-08。Ripola自身のコードと文書は[MIT](../../LICENSE)です。[適用範囲](product-license.md)を参照してください。以下は採用した第三者packageのversion・宣言ライセンス・元LICENSE／NOTICEの保存です。各第三者の条件は製品MITと別に保持します。比較候補だけのkuromoji・GiNZA・OCR等は導入していません。

## 直接依存

| package | 固定version | package宣言 |
| --- | --- | --- |
| React／react-dom | 19.2.8 | MIT |
| @mantine/core／hooks | 9.6.2 | MIT |
| @tanstack/react-start | 1.168.49 | MIT |
| @tanstack/react-router | 1.170.32 | MIT |
| budoux | 0.9.3 | Apache-2.0 |
| pdfjs-dist | 6.4.299 | Apache-2.0。本体以外のfont／CMap／WASM／ICCは各notice |
| unified | 11.0.5 | MIT |
| remark-parse | 11.0.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| remark-frontmatter | 5.0.0 | MIT |
| decode-named-character-reference | 1.2.0 | MIT |
| parse5 | 8.0.0 | MIT |
| wrangler（Node専用、browser/公開staticに含めない） | 4.148.0 | MIT OR Apache-2.0 |
| @fontsource/noto-sans-jp／noto-serif-jp／biz-udpgothic | 各5.3.0 | SIL OFL-1.1。normal400、同一origin配信 |

開発依存を含むmanifestは[root](../../package.json)と[web](../../apps/web/package.json)、完全な依存解決・integrityは[pnpm-lock.yaml](../../pnpm-lock.yaml)です。

## 保存範囲

[catalog.json](catalog.json)にはmacOS arm64でインストールした**377 package**のversion、宣言ライセンス、repo、noticeのパス・サイズ・SHA-256を保存しています。[packages](packages/)には配布物内の元LICENSE／NOTICEをそのまま保存しました。別OSのoptional binaryはこのホストにインストールされていないため、元noticeの保存対象に含めていません。lockfileにはその解決も残ります。

27 packageは配布物に独立したnoticeファイルがなく、catalogの`noticeStatus`に明示しています。BudouXには別途、v0.9.3タグの固定commit `25946bbbb271dc8a53bb5b04082c6859abc5c847`から[上流LICENSE](upstream/budoux-0.9.3-LICENSE)を保存しました。[一次資料](https://github.com/google/budoux/blob/25946bbbb271dc8a53bb5b04082c6859abc5c847/LICENSE)です。独立したファイルがないpackageを、宣言だけで全文照合済みと扱っていません。

Viteの通知ではBudouX、`format@0.2.2`、`react-remove-scroll-bar@2.3.8`の項目に全文が付かないため、Worker／Pages配布物に上流の全文を`LICENSE.budoux.txt`、`LICENSE.format.txt`、`LICENSE.react-remove-scroll-bar.txt`として追加します。

後者2件は公式npmの公開metadataにあるversion・MIT宣言・repository・gitHeadを照合しました。ただし、そのgitHeadのLICENSE取得は404のため、公開上流の固定revisionから変更せず本文を保存しています。`format`の公開元は`0094c51372790ca342da4b90c519edd3380deee1`、`react-remove-scroll-bar`は`8ca9ba5ea52de03308fe8ced94f7b159a44d28ff`です。[取得元とSHA-256](upstream/supplemental-notices.json)、[format原文](upstream/format-0.2.2-LICENSE)、[react-remove-scroll-bar原文](upstream/react-remove-scroll-bar-2.3.8-LICENSE)を保存しました。`format`はインストール済み0.2.2のJS headerとReadmeにある元の著作権表示も[NOTICE](upstream/format-0.2.2-NOTICE)に保持し、`NOTICE.format.txt`として同梱します。release commitの原文を取得できたという意味ではありません。

実際のビルドに入るライセンス通知はViteで生成し、[client](bundles/client.md)と[server](bundles/server.md)へ保存しました。PDF.jsが別ファイルとして配信する資材のlicenseも、CMap・standard_fonts・wasm・iccsごとにpackages内へ保存しています。生成bundleの一覧だけで配布物全体を一括判定していません。

## BudouXモデル

モデルはnpm `budoux@0.9.3`の`jaModel`です。`JSON.stringify(jaModel)`のSHA-256は`580db00a5e3e4a5b99b72cdea0db7ea70dac79599ce9d356d16bfdf0d92e7798`。文書のversionsにもruntimeで計算したfingerprintを保存します。parserは`budoux@0.9.3`、モデルは`ja@budoux-0.9.3`、境界規則は`rsvp-boundaries@1`です。独立した辞書downloadや別の日本語解析器を使いません。

再生成する場合は`pnpm build`後に`node scripts/collect-third-party-notices.mjs`を実行してください。`upstream`へ追加保存した全文・NOTICE・取得記録は保持します。依存を変更して公開・配布する場合は、新しい配布物とnoticeを改めて確認してください。

## QRコード生成のvendored source

[Project Nayuki QR Code generator](https://github.com/nayuki/QR-Code-generator)のTypeScript版を固定commit [`3c6d0b3cefb4e049dc337e82237c9644399716a8`](https://github.com/nayuki/QR-Code-generator/commit/3c6d0b3cefb4e049dc337e82237c9644399716a8)から同梱しています。MIT、Copyright (c) Project Nayukiです。[同梱ソース](../../apps/web/src/sharing/vendor/qrcodegen.ts)の著作権・許諾headerと[LICENSE原文](../../apps/web/src/sharing/vendor/LICENSE.qrcodegen.txt)を保持しました。ESM exportを追加し、生成アルゴリズムは変更していません。npm packageのcatalogとは別の第三者ソースです。

このMIT通知はQRライブラリに適用され、その著作権者表記を保持します。

## 任意の日本語CTC整列runtimeとモデル

[reazon-research/japanese-wav2vec2-base-rs35kh](https://huggingface.co/reazon-research/japanese-wav2vec2-base-rs35kh/blob/46afc596052b612293c8db256b3a69447a2f57dc/README.md)を固定commit `46afc596052b612293c8db256b3a69447a2f57dc`で使用します。公開元model cardの宣言はApache-2.0、著者のcitationはYuta Sasaki (2024)です。モデルweightはrepo/公開assetへ同梱せず、[明示download script](../../scripts/download_alignment_model.py)が[固定manifest](../../scripts/alignment-model.json)の7ファイルだけをsize/SHA-256照合して取得します。モデル本体386,749,964 bytes、JSONを含む合計386,888,750 bytesです。

任意のCPU runtimeの直接依存はtorch 2.8.0、transformers 4.57.6、numpy 2.3.5、safetensors 0.6.2です。入力は[requirements.in](../../scripts/alignment-requirements.in)、CPython 3.13用25依存wheel hash lockは[macOS ARM64用](../../scripts/alignment-requirements.txt)と[Linux x64用](../../scripts/alignment-requirements-linux-x64.txt)です。Linuxのtorchは[公式CPU wheel](https://download.pytorch.org/whl/cpu/torch-2.8.0%2Bcpu-cp313-cp313-manylinux_2_28_x86_64.whl)の2.8.0+cpuを固定し、CUDA/NVIDIA package・torchaudio・librosaは導入しません。上流の条件は[PyTorch LICENSE](https://github.com/pytorch/pytorch/blob/v2.8.0/LICENSE)、[Transformers LICENSE](https://github.com/huggingface/transformers/blob/v4.57.6/LICENSE)と、各インストールwheelのLICENSE/NOTICE/metadataで扱います。npm catalogの377 packageへPython runtimeが含まれるという意味ではありません。

Linuxの実wheelでもtorchの`dist-info/licenses/LICENSE`（BSD-3-Clauseと第三者条項）・`NOTICE`、requestsのLICENSE/NOTICE、NumPyのLICENSE.txtを保持します。NumPyはBSD本体だけでなく、同梱OpenBLAS/LAPACKのBSD、GCC runtimeのGPL-3.0-or-later WITH GCC-exception-3.1、libquadmathのLGPL-2.1-or-later等を含みます。「CPU版だから全てMIT/BSD」ではありません。setuptoolsのvendored依存やpackagingの複数licenseもwheel内通知を保持します。

残る固定依存にはApache-2.0、MIT、BSD、MPL-2.0（certifi／tqdm）、PSF-2.0（typing-extensions）、Apache-2.0 AND CNRI-Python（regex）等があります。tokenizers 0.22.2のLinux wheelはApache classifierがありますが独立したLICENSE/NOTICEを含まないため、再配布時には[固定版の上流LICENSE](https://github.com/huggingface/tokenizers/blob/v0.22.2/LICENSE)も確認・保存してください。実venvの通知を削除せず、別配布物へruntimeを同梱する際は上流licenseと同梱binaryの条件を改めて照合します。この変更ではPython wheel/runtimeをrepoや公開出力へ再配布しません。

Python runtime・モデル・個人のWAV/原稿を公開Pages/Worker出力へ入れません。利用者が独立したvenvへ明示installし、推移的依存のnoticeを保持する構成です。runtimeやモデルを別の配布物へ同梱する場合は、その配布物の全依存/noticeを改めて棚卸しする必要があります。モデルのApache-2.0を製品LICENSEとして採用するものではありません。[セットアップ手順](../guides/forced-alignment.md)を参照してください。

## 選択式の日本語フォント

3familyのFontsource packageを5.3.0に固定し、元400.cssとWOFF2を使用します。[NOTICE](../../apps/web/public/fonts/NOTICE.md)と各familyのpackage LICENSE・上流OFL原文・inventoryをlocal／Worker／Pagesに含めます。font binary・name・metadataは改変せず、著作権者とreserved namesを保持します。これらのOFLは製品の利用許諾や特許判断とは別です。[選定と実装](../research/japanese-fonts.md)を参照してください。

## 同梱の本文・音声サンプル

夏目漱石『吾輩は猫である』の青空文庫本文、VOICEVOX:ずんだもん、Google Gemini Puck／Koreの保存音声を使います。[サンプルNOTICE](../../apps/web/public/samples/audio/NOTICE.md)をlocal／Worker／Pagesに同梱し、catalog・manifest・音声Readerの帰属も保持します。VOICEVOXの再利用・再配布ではクレジットと音源利用条件を引き継いでください。Engineやキャラクター画像は配布していません。
