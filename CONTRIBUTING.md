# 開発と変更の確認

コードと文書は[MIT](LICENSE)です。この資料は変更の確認手順です。

## ローカル検査

[セットアップ](.agents/skills/ripola-generate-audio/references/setup.md)を済ませ、repo rootから実行します。

```sh
pnpm check
pnpm exec playwright install chromium
pnpm build:worker
pnpm build:pages
pnpm test:ci-browser
```

通常・関連変更・手動fullの範囲とケース追加は[CIガイド](docs/development/ci.md)を参照してください。全件の登録と選別をブラウザ起動なしで確認するには `pnpm test:ci-browser --list` を使います。

保存・AAC配布の統合試験にはffmpeg／ffprobeが必要です。E2EはPlaywright Chromiumを取得する代わりに、既存ブラウザの実行ファイルを `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` で明示指定できます。新しいOSでの差異と、PC／スマホ幅エミュレーション／実機の区別を報告してください。

## 変更の入口

- 本文抽出・分割・保存形式：[取り込み](docs/development/import-pipeline.md)、[分割](docs/development/segmentation.md)、[アーキテクチャ](docs/development/architecture.md)。
- 再生・元位置・音声時計：[再生契約](docs/development/playback.md)、[区切り表示の検査](docs/development/audio-presentation-quality.md)。
- 生成・再開・キャッシュ：[ローカル生成](docs/development/local-generation.md)。有料provider試験はmockと実合成を区別し、実呼び出しは対象・送信内容・費用を先に確認します。
- 静的配布：[Cloudflare手順](docs/guides/cloudflare-deployment.md)、[配布契約](docs/development/distribution.md)。

再現ケースは自作文や権利が明確な短文を使います。本文の元範囲・ルビ・順序を保ち、表示設定や整列・圧縮の変更で完成音声を再生成しないでください。文字サイズ・ルビ・スマホ幅・再生停止、明示seekと通常前向き再生を確認します。

依存を更新した場合はlockfile、ライセンス・NOTICE、実bundle、PDF等の別配信資材を確認します。第三者ライセンスを製品ライセンスとして流用しません。

## スキルと操作手順の変更

プロジェクト用スキルは`.agents/skills/`で共有します。[4つの作業と手順書](docs/README.md#原稿から個人用配布まで)を入口にし、`SKILL.md`には適用範囲・判断・参照先、`references/`には人も直接使える操作手順を置きます。設計・調査・検証記録・ライセンスは`docs/`に残し、同じ操作手順を複製しません。アプリと共用する処理は既存の`scripts/`を使います。

文書を移動・分割するときは、README・資料一覧・開発文書・ライセンス資料・検証記録の参照元と、移動先文書内の相対リンクを更新します。ファイルの存在だけでなく見出しanchorも確認します。スキルのYAML、参照先、例のCLI引数を確認し、原稿整形・検査の依頼が合成やdeployへ広がらないことを点検してください。作者の絶対path・アカウント・私的本文を例にしません。

## 報告に含めるもの

具体的な症状、最小の再現手順、変更後の動作、実行した検査と未確認範囲を示してください。private資料・APIキー・token・`.env.local`・個人library・内部転送記録は含めません。画面資料は公開可能な自作文または帰属を示したサンプルを使います。

公開化前の履歴監査は[公開準備](docs/development/distribution.md#公開前の履歴監査)を参照してください。通常のファイル削除で過去のGit履歴が消えたとは扱いません。
