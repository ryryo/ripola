# GitHub Pages の公開デモ

https://ryryo.github.io/ripola/ で、TXT・Markdown・テキスト層付きPDFの取り込み、端末内のRSVP生成、青空文庫『吾輩は猫である』の黙読と冒頭3音声（VOICEVOX:ずんだもん／Gemini Puck／Kore）を利用できます。OCRは対象外です。最初の入力欄には公開サンプルの冒頭抜粋が入り、「テキストのみ生成して読む」を押すだけで試せます。消去・書き換えた本文や任意タイトルは再入力せず、そのまま利用できます。デモ文は自動保存しません。編集した入力は音声サンプルからブラウザの「戻る」で戻れるよう、そのページの履歴entryだけで保持します。本文をURL・本棚・サーバーへ自動保存しません。

入力した文章・PDF・読書位置はブラウザ内で処理します。明示保存はそのoriginのIndexedDBです。ローカル版の保存とは別になります。公開サイトで音声を生成する機能や生成APIはありません。[サンプルの帰属と条件](../../apps/web/public/samples/audio/NOTICE.md)を確認してください。

## 配布と更新

GitHub Pages の Source は **GitHub Actions** です。`main` のCIが型・lint・unit・ブラウザ検査、Worker／Pagesビルド、配布監査をすべて完了してから、`dist/distribution/pages` だけを配布します。Pull Requestではデプロイしません。ActionsのCIを手動実行しても同じ検査を通します。個人library、stage、秘密キー、生成サービス、Node serverは配布しません。

ViteとRouterのbaseは `/ripola/`。トップと `/ripola/demo/` は静的HTMLを用意し、3音声への `demo/?sample=...` 直リンク・再読み込みに対応します。未知のpathやmissing audioにSPA fallbackを返しません。公開サンプル以外の音声は、各利用者の個人Workerへ別途配布してください。

ローカルで配布物を準備する場合は `pnpm build:pages`、音声監査は `pnpm audit:audio --distribution dist/distribution/pages` です。これらのコマンドはビルドと検査だけで、デプロイやTTSの再生成を行いません。

[GitHub公式のPages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)に沿い、Actionsは固定SHA、通常検査は読み取り権限、デプロイjobだけPages/OIDC書き込み権限を使用します。追加のAPIキーは不要です。
