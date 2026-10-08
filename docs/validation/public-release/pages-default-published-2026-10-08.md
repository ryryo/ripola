# Pages初期デモ文 — 公開URLの最終検証

2026-10-08 03:42 UTC時点。https://ryryo.github.io/ripola/ の猫冒頭の初期入力を実URLで検証しました。検証時のremote `main`・CI・Pages deploymentのSHAはすべて `2d8788ff69a1289c7aad2f972881f0097bcfac14` です。以下の結果はこのrevisionに対する検証記録です。

[CI 37722846037](https://github.com/ryryo/ripola/actions/runs/37722846037) のcheckとdeploy-pagesはsuccess。Pages deployment `6926619261` は03:38:32 UTCにsuccessとなりました。

| 最終検査 | 結果 |
| --- | --- |
| CI 型・lint、ローカルbuild | passed |
| CI 全unit / Python計算unit | 227 / 6 passed、0 failed |
| CI ブラウザ | 128 passed、4 skipped、0 failed（8.7分） |
| Pages build / 全配布ツリー監査 | passed、1029ファイル・44,037,448 bytes、公開3音声valid、生成APIなし |
| Worker build / 全配布ツリー監査 | passed、1030ファイル・44,039,665 bytes、公開3音声valid、生成APIなし |
| npm pack dry-run | passed、223ファイル・展開16.7 MB。npmへのpublishなし |
| 公開URLの猫初期入力→submit→ruby→RSVP再生 / 非自動保存 | passed |
| 公開URLの消去→自作文・任意タイトル / フォーム復帰 | passed。消去済みの空欄も維持 |
| 音声ページ→ブラウザ戻る | passed。変更済み本文・タイトルと、空にした本文・タイトルの両方を維持 |
| 全文サンプル / TXT・MD・日本語PDFテキスト層 / ruby・3書体 | passed |
| VOICEVOX / Gemini Puck / Gemini Kore | passed。直リンク・reload・実再生・seek・再開・トップ復帰 |
| 公開URLブラウザ合計 | 11 passed、0 failed。pageerror・HTTPエラー・外部originへのHTTP requestは各0 |
| 公開3manifest・39音声のSHA-256 / byte数 | 全一致。各音声のHEAD 200・Range 206もpassed |
| 公開配布の境界 | 追加library 0冊、公開サンプル3冊。生成API・local audio・server function・missing audioは404 |
| Windows/Linux/Intel Macの音声初期セットアップQA | not run、後回し |
| 網羅的な実機検査 | not run、今回の検証対象外 |
| 有料生成・私的データ転送 | not run、今回の検証対象外 |

既存の公開青空文庫音声と自作fixtureだけを使用しました。実公開トップの見た目も確認済みです。CIでは配布対象の全ツリーを走査し、env・個人library/source/cache・サーバー/生成コード・資格情報・未参照音声の混入を拒否しています。その検査済みPagesディレクトリだけが公開artifactとなっています。私的な本文・音声・運用設定・資格情報への操作はありません。

この検査範囲の失敗・保留事項はありません。GitHubのNode 20 action廃止予告は非阻害のannotationで、対象actionはNode 24で実行され両jobが成功しました。

[機械可読の結果](pages-default-published-2026-10-08.json)に、各ブラウザ検査・公開HTTP/hash・CI/Pages deploymentの証拠を保存しています。[以前のローカル候補記録](pages-default-draft-2026-10-08.md)は公開前のローカル検査結果です。
