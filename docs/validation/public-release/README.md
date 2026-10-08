# 公開版の検査

2026-10-08、macOS Apple Silicon / Node.js 26.8.1 / pnpm 12.3.4で検査しました。

| 検査 | 結果 |
| --- | --- |
| 型・lint | passed |
| unit | passed、224件 |
| Python同期補正のunit | passed、6件 |
| ローカル・Worker・Pagesビルド | passed |
| Worker・Pagesの音声／manifest監査 | passed、各3冊の公開サンプル |
| ブラウザ | passed、128件。任意の実行条件による4件はskip |
| npm packの内容検査 | passed、221ファイル。LICENSE同梱、env／dist混入なし |
| 公開ソース・配布物の秘密値／個人ファイル監査 | passed |
| 第三者ライセンス原文の保存 | passed、366ファイルのハッシュ照合 |
| GitHub CI | 最新commitの実行結果はリポジトリのActionsで確認 |
| Windows／Linuxの音声初期セットアップ | not run、後回し |
| 有料生成・個人本文／音声の転送 | not run、今回の対象外 |

ブラウザ検査は全体132件の実行と、検査出力先を自動作成する修正後の進捗5件の再実行を合わせた結果です。初回の進捗1件は、計測ファイルの保存先が新規checkoutに存在しないため失敗しました。再実行は5件成功しました。改行表示6件も成功しています。スマホでの利用は利用者確認済みで、新しい実機網羅検査は行っていません。

クリーンなNode環境で再現できるよう、推奨版の`.node-version`と最小版のengine制約を追加しました。設定unitは親プロセスのAPIキー・有料生成設定から隔離し、通信をモックしています。Worker／Pages配布物に生成APIを含めない境界検査も成功しました。

初回CIは、ジョブのenvで使えない`runner.temp`を参照した構文エラーによりジョブ開始前に失敗しました。fixtureの保存先をGit除外済みのworkspace内へ修正しています。

個人のenv・本文・音声・運用設定・旧リポジトリの履歴は同梱していません。公開可能な青空文庫・VOICEVOX・Geminiサンプルの出典と条件はサンプルNOTICEに保持しています。ローカルで生成するファイルはGitとnpm配布の除外対象です。

この検査とCIはビルド・サンプル検査のみです。GitHub PagesとCloudflareへの新規デプロイは行っていません。READMEの公開デモは従来の配布版です。音声生成後の同期補正環境はmacOS Apple Silicon向けで、Windows／Linux・Intel Macの初期セットアップは未検証です。
