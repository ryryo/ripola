# 配布・検証用データ

- 通常配布は `scripts/prepare-distribution.mjs --config <allowlist>` をNodeで直接実行する。先に `python3 ~/.codex/storage-maintenance/guard.py check --path "$PWD" --needed-gib 2` を実行し、大きい場合は実際の見積もりを使う。
- 詳細は [配布物と検証データの保存期間](docs/development/distribution-storage.md)。stage・一時検証は共通guardのscratch内で行い、通常のbuildは固定既定outputを再利用する。
- 日付付きoutput、release directory、`personal-worker-before-*` へ本・音声・画像・フォントを丸ごと積み増さない。記録はhash・件数・監査結果・小さい差分を残す。過去版全体の保存には明示的な必要性を確認する。
- 原本library・元音声・生成済み個人データ・モデル・配信中資産・運用設定は整理しない。他のworktreeや運用repoのvendorへ未採用ソースをコピーしない。既存のdirty差分を保持する。
