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

push後の実際のCI・Pages結果を追記する。初回はCI設定/共通基盤変更なので全関連88件の条件であり、追加領域なしの14件だけの通常と混同しない。従来基準はjob9分47秒、browser7分31秒。

## 検証範囲

手動fullのnative VOICEVOX/保存済み音声4 invocationsはopt-in条件がなければskip。Windows/Linuxは別PRでLinux x64/CPython 3.13の補正setupと実WSL2の初回・再利用・CPU処理・保存・cache再利用を確認済み。Windows 11/mirrored経由のWindows VOICEVOX生成・保存・Reader再生実機E2Eは未検証。Linux補正setup成功をこの経路の成功と扱わない。[既存記録](README.md)、[setup条件](../../guides/setup.md)を参照。

mobile反復の一部をfullへ移したため、mobile固有のIME/focus等はfullまで発見が遅れる可能性がある。layout/font/長文関連変更では対応検査を自動追加する。
