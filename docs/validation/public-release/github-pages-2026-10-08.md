# GitHub Pages 公開確認 — 2026-10-08

公開URL: https://ryryo.github.io/ripola/ 。配布commitは `34481f069cb004f7bf76bd3653f98295693ddcda`。[CIとPagesデプロイ](https://github.com/ryryo/ripola/actions/runs/37719178698)はともにsuccessです。

| 検査 | 最終結果 |
| --- | --- |
| CI 型・lint・通常build | passed |
| CI unit / Python計算 | passed、224件 / 6件 |
| CI Worker・Pages build / 音声・manifest監査 / npm配布検査 | passed |
| CI ブラウザ | 128 passed、4 skipped |
| Pages配布物 | passed、demo、1,029ファイル・44,035,967 bytes、追加library 0冊、生成APIなし |
| 公開トップの3音声リンク・青空文庫全文サンプル | passed |
| 公開URLのテキスト・TXT・MD・日本語PDF取り込み→RSVP | passed。PDFテキスト層抽出とcanvas描画を確認 |
| 公開URLのルビ・3書体 | passed、Noto Sans JP / Noto Serif JP / BIZ UDPGothic |
| VOICEVOX:ずんだもん / Gemini Puck / Kore | passed、各直リンク・reload・実再生・累積10秒seek・トップ復帰 |
| 公開manifest / 全音声ハッシュ | passed、3 / 39ファイル、ID・revision・byte数も一致 |
| 公開音声HTTP | passed、各声の先頭chunkでHEAD 200・Content-Length一致、Range 206・Content-Range一致、audio/mp4 |
| 生成API・local audio API・server function・未知音声 | 404、SPAの成功応答へfallbackしない |
| 公開URLでの外部request・pageerror | 0件 |
| Windows／Linux音声初期セットアップQA | not run、後回し |
| 新しい実機網羅検査・有料生成・個人転送・Cloudflareデプロイ | not run、今回の対象外 |

公開URLのブラウザ検査は8 passed / 0 failed（desktop Chrome 154.0.8037.99）。ローカルPages配布物でも取り込み・ruby/font・3音声の7ケースが通っています。音声seekは累積位置と選択chunk内のcurrentTimeを照合しました。検証コード初回の時刻比較と取得引数の誤りを訂正して再実行し、製品コードの変更は必要ありませんでした。

入力は既存の公開3音声、青空文庫サンプル、自作テキスト、リポジトリの自作MD／日本語PDF fixtureだけです。個人libraryやstageを指定せず、公開catalogは既存サンプルとbyte単位で一致。有料API・TTS Engineを呼ばず、ブラウザ入力を外部へ送信していません。

変更はPages設定、CIの配布job、READMEと[Pagesガイド](../../guides/github-pages.md)。main全CIが成功した配布物だけをuploadし、Pages/OIDC書き込み権限はdeploy jobに限定します。Pull Requestは配布しません。既存project base `/ripola/`・Router・静的HTMLは実公開でも機能し、404 rewrite・追加APIは不要でした。

[機械可読の結果とHTTP証跡](github-pages-2026-10-08.json)を保存しています。記録のpublic commit/pushは承認レビューで保留されており、このファイルはローカル保存です。
