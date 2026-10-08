# CIの実行範囲

PR更新とmain pushでは、型・lint・全unit、local/Worker/Pages build、配布物audit、代表12ケースと完成Pages2ケースを検査します。音声・PDF・生成・layoutなどを変更すると対応するブラウザ検査も追加します。説明文書だけなら変更分類の軽いjobのみで、Pagesを公開しません。

[変更分類](../../scripts/ci-scope.mjs)は許可した説明文書だけを除外します。license、検査fixture、env example、public assetは検査対象です。PRのmerge-base差分とpushのbefore/after差分を使い、削除・rename・複数commitも含めます。不明なpathや取得できない差分はfull、workflow・lockfile・共通UIは全関連領域へ寄せます。

## ローカルでの検査

```sh
pnpm check
pnpm build:worker
pnpm build:pages
# Playwright Chromiumを導入済み、または実行ファイルを環境変数で指定
RIPOLA_CI_MODE=normal pnpm test:ci-browser
RIPOLA_CI_MODE=normal RIPOLA_CI_DOMAINS=layout pnpm test:ci-browser
pnpm test:ci-browser
```

mode未指定はfullです。Windows PowerShellでは同じ変数を `$env:RIPOLA_CI_MODE='normal'` などで設定します。既存132件は削除せず、完成Pages2件を加えてfullは134件、追加領域のない通常は14件、全関連領域を含む通常は88件です。fullの4件はnative VOICEVOX等のopt-in条件がなければskipします。有料実合成や個人書籍は使いません。

完成Pages検査は先に `pnpm build:pages` で作った公開配布物を確認します。既定のlocal serverは127.0.0.1:4173、Pages検査専用serverは127.0.0.1:4175です。別のサーバーを使っている場合は `RSVP_TEST_BASE_URL` と `RSVP_PAGES_TEST_BASE_URL` に空いているloopbackポートを指定してください。隔離して実行する場合は `CI=1`、有料生成を無効、`RSVP_LIBRARY_DIR` に検査専用ディレクトリーを指定します。既存の私的libraryを検査へ持ち込みません。

`pnpm test:e2e` はPlaywrightを直接実行するfull検査です。CIと同じ登録漏れ・選別確認を行うには `pnpm test:ci-browser` を使います。`--list` を付ければブラウザを起動せず全件と選別の照合だけを行います。

## ケースを追加・変更するとき

[登録表](../../scripts/ci-browser-cases.json)にproject、file、正確なtitle、lane、対応domainを記録します。既存12ケースとPages2ケースはnormal、変更領域に対応するケースはrelated、主にmobileの反復はmanual_full、native環境の任意検査はlocal_opt_inです。fullではlaneに関係なくすべて実行します。

CIはまず実際のPlaywright全件一覧と登録表を照合し、次に選別一覧を照合します。新規・改名・欠落・重複があると失敗します。登録表の削除だけで検査が黙ってなくなることもありません。新たなbrowserファイルはPlaywright projectのtestMatchにも登録してください。

## fullと公開

GitHub ActionsのCIを `workflow_dispatch` するとfullです。通常の古いPR/push検査はcancelできますが、fullは別groupで、通常の更新に巻き込まれません。fullは公開を行いません。

Pagesはmain pushで同じSHAの必要な検査がすべて成功したartifactだけを使います。公開jobは直列化し、公開中に通常検査のcancelが伝播しないようにしています。公開直前に新しいmainがあれば古いSHAの公開をskipします。branch protectionの設定はこの変更の対象ではありません。

短縮の[監査根拠](ci-split-review-2026-10-08.md)と[実装・検証結果](../validation/public-release/ci-split-implementation-2026-10-08.md)を参照してください。
