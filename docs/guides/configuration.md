# 設定一覧と優先順位

通常の `.env.example` はDirect用の `GEMINI_API_KEY` 1項目だけです。通常読書・サンプル再生・VOICEVOX・自動補正はenv入力0、Directだけ秘密キー1です。Cloudflareは既存WranglerログインとプロジェクトのGateway選択1件を使います。

単なる一覧の移動ではなく、専用venv／モデルのpathはセットアップが保存し、version・標準URL・保存先・声・Liteモデルは既定値で解決します。通常利用で有料許可envと画面確認の二重設定を求めません。本文・接続先・概算を確認する開始／再開操作、保存計画の整合性検査、結果不明の有料送信を自動再試行しない処理は維持します。

## 特殊な設定と互換性

[Node設定読込](../../apps/web/src/generation/core/config.ts)、[セットアップ](../../scripts/setup-alignment.mjs)、[provider](../../apps/web/src/generation/core/providers.ts)、CLI・Vite・検証スクリプトのenv参照を棚卸ししました。

| 既存候補 | 新規利用での扱い／互換読込を残す理由 |
| --- | --- |
| `GEMINI_API_KEY` | Directの利用者固有の秘密。通常例に残す唯一の項目 |
| `RSVP_ENABLE_PAID_GENERATION` | 新規設定不要。開始ごとの確認へ統合。既存`false`など停止指定は尊重し、無断解除しない |
| `RSVP_ALIGNMENT_PYTHON` | `setup.json`で専用venvを自動指定。既に用意した外部環境の参照だけ互換維持 |
| `RSVP_ALIGNMENT_MODEL_DIR` | 固定モデルを自動取得／検証して設定。既存の検証済み外部cacheを再利用する互換指定だけ維持 |
| `RSVP_ALIGNMENT_VERSION` | repository-owned manifestで固定。旧指定を読み、固定版と異なれば準備に失敗して停止する |
| `RSVP_LIBRARY_DIR` | ホームのDocuments配下が既定。容量・複数利用者などで保存先変更が必要な場合だけ残す |
| `RSVP_LOCAL_ORIGIN` | 4173 loopbackが既定。previewスクリプトが4174を指定。隔離テスト／別portだけ互換override |
| `RSVP_AI_GATEWAY_ID` | 通常はWranglerプロジェクト設定に集約。既存envによる明示選択を壊さないため読込維持 |
| `RSVP_AI_GATEWAY_ACCOUNT_ID` | 通常はWrangler認証／プロジェクト設定を利用。旧REST互換専用で、新規設定には不要 |
| `RSVP_AI_GATEWAY_TOKEN` | 手動tokenは通常不要。既存REST利用の互換だけ維持し、Wranglerからtokenを抽出しない |
| `RSVP_AI_GATEWAY_TRANSPORT` | Wranglerが既定。既存の明示REST選択だけ互換維持。自動切替しない |
| `RSVP_AI_GATEWAY_PROVIDER_SLUG` | 読まない未使用の旧項目。通常例から言及を削除 |
| `VITE_RSVP_PROFILE`／Viteの`BASE_URL` | buildコマンドとViteが管理する公開／local構成。利用者の秘密設定にしない |
| `RSVP_TEST_BASE_URL`・`RSVP_EVIDENCE_PREFIX`・`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`・`RSVP_TEST_AOZORA_AUDIO`・`RSVP_TEST_VOICEVOX`・`CI` | テスト・証跡取得用。通常起動には不要で、製品設定に含めない |
| `OMP_NUM_THREADS`・`VECLIB_MAXIMUM_THREADS` | 既に指定されたCPU実行環境だけ子プロセスへ継承。通常設定不要 |
| 子プロセスのoffline／pip設定 | サーバーとsetupコードが設定。利用者へ別の許可flagを求めない |

設定優先順位は **process環境 → 既存 `.env.local` → 自動 `alignment-runtime/setup.json` → コード既定値**です。既存env・キー・利用者のpathを削除／書換えません。`pnpm setup:audio` は既存の外部runtime／モデルをまず検証し、不一致なら外部環境を変更せず停止します。互換変数を新規利用のために全件コピーする必要はありません。

## 特殊な保存先だけ変える場合

標準の保存先が適さない場合だけ `.env.local` に `RSVP_LIBRARY_DIR=/absolute/path/to/private-library` を追加します。Git外の絶対pathを指定し、既存envを保持して再起動してください。音声・原稿を公開assetsへコピーする設定ではありません。外部runtimeや旧RESTから移行する場合も既存指定の有効性を検証してから変更し、秘密を表示しません。

生成経路の利用条件・quota・請求は別です。アプリの費用表示は見積もりで、APIキーの配置だけで生成を開始しません。[音声生成](audio-generation.md)・[Cloudflare通常経路](ai-gateway.md)・セットアップ検証を参照してください。
