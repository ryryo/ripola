# Pagesの初期デモ文 — ローカル候補

2026-10-08、base `34481f069cb004f7bf76bd3653f98295693ddcda`。この変更はローカルの未commit候補です。公開先 https://ryryo.github.io/ripola/ は上記baseのままで、**新しい猫冒頭の初期入力は未反映**です。[既に公開済みの確認](github-pages-2026-10-08.md)とは区別します。

Pagesの最初の入力に、同梱の青空文庫『吾輩は猫である』から約140字をルビ付きで入れました。通常のsubmitだけで黙読RSVPを開始できます。任意タイトルと形式自動判定を保ち、冒頭の出典を短く表示します。音声の自動生成や保存は行いません。local／workerは空入力のままです。

入力の消去・書き換え・フォーム復帰でデモ文を再注入しません。音声ページからブラウザの「戻る」を使った場合も、編集した本文・任意タイトル・形式を同じ履歴entryから復元します。初回の戻る検査で初期値へ戻る問題を発見して修正しました。本文をURL・IndexedDBの本棚・サーバーへ保存せず、初期デモ自体は履歴へ自動保存しません。

| 最終検査 | 結果 |
| --- | --- |
| 型・lint | passed |
| 全unit | 227 passed、0 failed。Aozora本文・ruby一致、profile限定、空欄と形式の復元を追加検査 |
| Pages build / 配布監査 | passed、1029ファイル・44,037,448 bytes、公開3冊valid、生成APIなし |
| Worker build / 配布監査 | passed、1030ファイル・44,039,665 bytes、公開3冊valid、生成APIなし |
| npm pack dry-run | passed、223ファイル、LICENSEあり、env／dist／jobs／sources／cache混入なし |
| 初期入力済み→submit→ruby表示→再生、非自動保存 | passed |
| 空欄→自作文／任意タイトル、空欄のままフォーム復帰 | passed |
| 音声へ移動→ブラウザ戻るで利用者入力・タイトル保持 | passed |
| 既存の全文・text/TXT/MD/PDF・3書体・3音声・直リンク／reload／seek | passed |
| ローカルブラウザ合計 | 11 passed、0 failed。外部request／pageerror 0 |
| 新候補のpublic commit/push・GitHub CI・Pagesデプロイ／公開URL確認 | not run、下記承認ブロッカー |
| Windows／Linux音声初期セットアップ・新実機検査・有料生成・個人転送 | not run、対象外／後回し |

入力と音声は既存の公開サンプルと自作fixtureだけを使いました。全39音声の実公開ハッシュ／HTTP検査は初回公開記録に保持し、候補でも公開3音声を配布監査と実再生で再確認しています。個人の本文・音声・library・資格情報を参照／転送していません。

[機械可読のローカル結果](pages-default-draft-2026-10-08.json)を保存しています。公開側へのcommit/pushは自動承認レビューが拒否しました。理由は、初期の「push対象外」を適用し、後続の承認引用を信頼できる直接ユーザー承認として確認できないためです。承認証拠を提示した同一操作の再審査も拒否され、別API・親の代理push・別repoなどの迂回は行っていません。直接の明示承認を確認できるまでpublicの更新は保留です。
