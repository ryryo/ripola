# ルビなしPages初期文の公開検証 — 2026-10-08

公開URL: https://ryryo.github.io/ripola/ 。mainの公開コミット: `e78ceb8fd6a6ffa2ccd77edf7a05c1fa9366bafe`。

`apps/web/src/reader/pages-demo.ts` の初期抜粋を通常のテキストに変更。対応する単体テストでauto→txt、本文一致、ルビなしを確認。一般のルビ入力・音声3種・WSL2対応は保持。既存のユーザー編集をコミットに含めず保持した。

|確認|結果|
|---|---|
|ローカル型 / lint|passed|
|ローカル単体|238 passed, 0 failed|
|ローカルPagesビルド / サンプル監査|passed|
|ローカルブラウザ|11 passed|
|GitHub CI / Pages deploy|passed; run 37740367548|
|CI Python|6計算テスト + 4実行環境契約テスト passed|
|CIブラウザ|132件を2並列、128 passed / 4 skipped; 10分22秒|
|実配信のブラウザ|異なる11項目を確認済み。初回10 passed / 1待機超過、当該1項目の再確認passed|
|実配信の音声・配布物|3マニフェスト / 39音声のhash一致、HEAD 200、Range 206、生成API除外404|
|Windows/Linux/WSL2手動セットアップQA|not run; 先送り指示を維持|

初回の実配信確認では任意入力後の表示待機が5秒を超えた。製品やCIを変更せず、同じ条件を30秒の期限で当該項目だけ再確認して成功。初回ログはJSON内に保持した。

CI: https://github.com/ryryo/ripola/actions/runs/37740367548 。私的な書籍・音声や有料生成を使用せず、予算・請求設定も変更していない。公開を妨げる残課題なし。
