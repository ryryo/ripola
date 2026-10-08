# CI分離の実装・検証（2026-10-08）

通常の主要経路、変更領域に対応する追加検査、手動fullを分離した。説明文書のみでは軽い分類jobだけを実行し、Pagesを公開しない。[運用手順](../../development/ci.md)、[監査根拠](../../development/ci-split-review-2026-10-08.md)を参照。

## 実装した制御

- 通常14件（既存12＋完成Pages2）、全関連領域を含む通常88件、full134件（既存132＋Pages2）。fullには元の132件の識別子をすべて保持。
- 全件・選別の実際のPlaywright一覧と登録表を照合し、新規/改名/欠落/重複は失敗。未知のpath・取得できないdiffはfull。共通基盤・workflow・lockfileは全関連領域。
- PRのmerge-baseとpushのbefore/after全commitを比較し、rename/deleteも含める。純粋な説明文書だけを除外し、license/fixture/env example/public assetを除外しない。
- 手動fullと通常checkを別concurrencyにし、通常checkのcancelをPages公開へ伝播させない。Pagesは同じSHAの必要検査とaudit成功後のartifactのみ。公開jobを直列化し、古いmain SHAは公開直前にskip。手動fullは公開しない。

## ローカル検証

|検査|結果|
|---|---|
|型 / lint / local build|passed|
|全unit|242 passed（既存238＋CI選別4）|
|Worker / Pages build|passed|
|最終配布物audit|passed、各3公開音声サンプル、生成APIなし|
|npm pack dry-run|passed、225 files。検査用cacheを使用|
|通常browser|14 passed、27.4秒、2 worker。隔離ポートとfixture library|
|fullの元132件の識別子同等性|passed、ケース本文は変更なし|
|全関連88件 / full134件の選別一覧|passed|
|workflow YAML parse / diff whitespace|passed|
|full全件の再実行|not run、既存の全件成功記録を使用。実装による選別を照合|

既存の個人用サーバー、私的書籍、有料生成、課金設定は触れていない。npm packの初回は作業ディレクトリー指定を修正し、次はユーザーcacheへの書込権限問題のため検査専用/tmp cacheで成功した。製品の失敗ではない。

## CI実測

[実CI run 37752882901](https://github.com/ryryo/ripola/actions/runs/37752882901) は成功し、同SHA `55d9f38` の検査済みartifactをPagesへ公開した。条件はCI基盤変更に対応する全関連88件。88 passed、再試行なし。追加領域なしの14件だけの通常とは区別する。

|実測条件|check job|browser step|
|---|---:|---:|
|従来132件（run 37744337416）|9分47秒|7分31秒|
|通常＋全関連88件|8分24秒|6分33秒|
|差|1分23秒短縮|0分58秒短縮|

通常14件のみのGitHub job時間は未計測。隔離ローカルでは14件27.4秒。通常job2.5〜3.5分という監査時の値は見積もりのまま。分類不能はfullへ寄せるため、その条件の時間は通常smokeと異なる。

実装中の旧runは新SHAへの切替でcancelされた。うちrun 37751765865はFFmpeg依存のUbuntuミラー取得が約10分停滞したため、導入に3分のstep上限・通信timeout・再試行上限・no-install-recommendsを追加した。成功runの導入時間は0分23秒。音声検査を削除して回避していない。

詳細は [実測JSON](ci-split-implementation-2026-10-08.json)。記録追記は文書のみのpush。後続のActions runでは軽い判定・公開skipの条件になる。

## 検証範囲

手動fullのnative VOICEVOX/保存済み音声4 invocationsはopt-in条件がなければskip。Windows/Linuxは別PRでLinux x64/CPython 3.13の補正setupと実WSL2の初回・再利用・CPU処理・保存・cache再利用を確認済み。Windows 11/mirrored経由のWindows VOICEVOX生成・保存・Reader再生実機E2Eは未検証。Linux補正setup成功をこの経路の成功と扱わない。[既存記録](README.md)、[setup条件](../../guides/setup.md)を参照。

mobile反復の一部をfullへ移したため、mobile固有のIME/focus等はfullまで発見が遅れる可能性がある。layout/font/長文関連変更では対応検査を自動追加する。
