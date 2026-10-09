# CIの実行範囲

PR更新とmain pushは速度を優先します。型・lint・全unit、local/Worker/Pages buildと配布ビルド内の監査を維持し、ブラウザは主要経路14件と変更機能の代表ケースだけを実行します。2026-10-09時点では全domainでも21件です。ケース数の増加を検知する24件の予算テストを置き、機能追加時は代表を見直します。2〜3分を目標とし、runnerの開始待ちは別に扱います。

全フォント・画面幅・ルビの折り返し72組合せ、詳細な状態遷移、長文、PC/mobileの反復などは手動fullで検査します。登録済み148件は削除していません。通常で省いた組合せ・詳細回帰の検出はfullまで遅れる場合があります。

[変更分類](../../scripts/ci-scope.mjs)は許可した説明文書だけを除外します。license、fixture、env example、public assetは検査対象です。PRのmerge-base差分とpushのbefore/after差分を使い、削除・rename・複数commitも含めます。読書UI・設定保存はimport/audio/layout、共通CSS・themeはlayoutへ限定します。browserテストの変更は登録表のdomainを使い、unitテストだけの変更ではブラウザの主要経路に追加しません。

不明なpath・差分や実行基盤の変更でも、自動実行は全domainの代表検査に収めます。全件の登録照合は常に行うため、未登録・改名・欠落・重複のbrowserケースは失敗します。説明文書だけなら変更分類の軽いjobのみで、Pagesを公開しません。

Python計算・環境契約テストは補正/setupスクリプト、依存・実行基盤、不明な差分、手動fullで実行します。読書UIやTypeScriptの生成サービスの変更だけではPython環境を作りません。各配布ビルドは最終出力を監査してから確定するため、直後に同じ関数を呼ぶ二重の監査ステップはありません。

## ローカルとfull

```sh
pnpm check
pnpm build:worker
pnpm build:pages
RIPOLA_CI_MODE=normal pnpm test:ci-browser
RIPOLA_CI_MODE=normal RIPOLA_CI_DOMAINS=layout pnpm test:ci-browser
# 登録済みの全ケース・全組合せ
pnpm test:ci-browser
```

mode未指定はfullです。Windows PowerShellでは `$env:RIPOLA_CI_MODE='normal'` などで設定します。`pnpm test:e2e` もfullです。登録・選別確認は `pnpm test:ci-browser --list` でブラウザを起動せず実施できます。fullの4件はnative VOICEVOX等のopt-in条件がなければskipします。有料実合成や個人書籍は使いません。

完成Pages検査は先に `pnpm build:pages` で作った公開配布物を確認します。local serverは127.0.0.1:4173、Pages検査専用serverは127.0.0.1:4175です。既存サーバーと分ける場合は `RSVP_TEST_BASE_URL` と `RSVP_PAGES_TEST_BASE_URL` に空いているloopbackポートを指定します。隔離実行では `CI=1`、有料生成を無効、`RSVP_LIBRARY_DIR` に検査専用ディレクトリーを指定します。

## ケースの登録と公開

[登録表](../../scripts/ci-browser-cases.json)にproject、file、正確なtitle、lane、domainを記録します。主要経路14件はnormal。追加の代表はrelatedかつ `quick: true` とし、該当domainの変更時だけ実行します。その他のrelated・manual_full・local_opt_inはfullで実行します。新規browserファイルはPlaywright projectのtestMatchにも登録します。

GitHub Actionsを `workflow_dispatch` するとfullです。fullは別concurrency groupで通常の更新に巻き込まれず、公開を行いません。Pagesはmain pushの必要検査が成功した同じSHAのartifactだけを使い、公開jobを直列化します。公開直前に新しいmainがあれば古いSHAをskipします。branch protectionの設定は変更しません。

当初の[監査](ci-split-review-2026-10-08.md)と[実装記録](../validation/public-release/ci-split-implementation-2026-10-08.md)は、その時点の構成・計測結果です。
