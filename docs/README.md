# ドキュメント

Ripolaの利用・実装・第三者条件を確認するための資料です。

## 原稿から個人用配布まで

操作手順の正本は、リポジトリ同梱スキルの`references/`にあります。以下の手順書はCodexなしでも直接読んで使えます。`SKILL.md`はエージェントが作業範囲と参照先を判断するための入口です。

| 作業 | 人が読む手順書 | Codexのスキル |
| --- | --- | --- |
| 原稿の読み上げ用コピーを作る | [整形](../.agents/skills/ripola-prepare-manuscript/references/cleanup.md)・[分割と対応記録](../.agents/skills/ripola-prepare-manuscript/references/splitting.md) | [ripola-prepare-manuscript](../.agents/skills/ripola-prepare-manuscript/SKILL.md) |
| ローカルで音声を生成する | [共通手順](../.agents/skills/ripola-generate-audio/references/audio-generation.md)・[VOICEVOX](../.agents/skills/ripola-generate-audio/references/voicevox.md)・[Gemini直結](../.agents/skills/ripola-generate-audio/references/gemini-direct.md)・[Cloudflare経由](../.agents/skills/ripola-generate-audio/references/gemini-cloudflare.md) | [ripola-generate-audio](../.agents/skills/ripola-generate-audio/SKILL.md) |
| 保存音声・配布物を検査する | [音声QA](../.agents/skills/ripola-check-audio/references/saved-audio.md)・[構造監査](../.agents/skills/ripola-check-audio/references/presentation-audit.md) | [ripola-check-audio](../.agents/skills/ripola-check-audio/SKILL.md) |
| 自分のWorkerへ追加・更新する | [個人用配布](../.agents/skills/ripola-publish-personal/references/personal-worker.md) | [ripola-publish-personal](../.agents/skills/ripola-publish-personal/SKILL.md) |

clone後、このリポジトリをCodexで開いて利用します。たとえば`$ripola-prepare-manuscript`で整形、`$ripola-generate-audio`で音声化を指定できます。対応する依頼からの自動選択も使えます。スキルを個人のグローバルdirectoryへコピーする必要はありません。[Codexのスキル配置仕様](https://developers.openai.com/codex/skills/#where-to-save-skills)

スキルは公開可能な手順だけを共有します。利用者の原稿・音声・対応記録・allowlist・キー・アカウント設定はGit対象外に保存します。「個人用」は作者専用ではなく、各利用者自身の蔵書と配布先を意味します。

## 利用と開発の資料

- [初期セットアップ](../.agents/skills/ripola-generate-audio/references/setup.md)・[設定](../.agents/skills/ripola-generate-audio/references/configuration.md)
- [読書](guides/reading.md)・[青空文庫](guides/aozora-and-navigation.md)
- [音声生成](../.agents/skills/ripola-generate-audio/references/audio-generation.md)・[GeminiとCloudflare](../.agents/skills/ripola-generate-audio/references/gemini-cloudflare.md)・[同期補正](../.agents/skills/ripola-generate-audio/references/forced-alignment.md)
- [Irodoriの任意追加](../.agents/skills/ripola-generate-audio/references/irodori.md)・[Irodoriの実装境界](development/irodori.md)・[第三者条件](licenses/irodori.md)
- [Cloudflare配布](guides/cloudflare-deployment.md)・[個人用Worker](../.agents/skills/ripola-publish-personal/references/personal-worker.md)
- [アーキテクチャ](development/architecture.md)・[取り込み](development/import-pipeline.md)・[分割](development/segmentation.md)
- [再生](development/playback.md)・[表示検査の実装契約](development/audio-presentation-quality.md)・[音声QAの実装契約](development/audio-quality.md)・[ローカル生成](development/local-generation.md)
- [保存と機能分担](development/local-cloud.md)・[MP3保存](development/mp3-library.md)・[静的配布](development/distribution.md)
- [日本語フォント](research/japanese-fonts.md)・[依存ライセンス](licenses/README.md)・[製品MIT](licenses/product-license.md)
- [公開版の検査結果](validation/public-release/README.md)

音声補正セットアップはmacOS ARM64とLinux x64・CPython 3.13が対象です。実WSL2 Ubuntu 24.04で初回・再利用・CPU runtimeを検証しました。[WSL2のPython準備とWindowsの接続条件](../.agents/skills/ripola-generate-audio/references/setup.md)を参照してください。Windows 11/mirroredの音声生成E2Eは未検証で、Windows Server 2022/NATでは固定loopback接続に失敗しました。公開Worker/Pagesは端末内の取り込み・RSVP生成と保存済み音声再生を提供し、音声生成APIを含めません。

公開デモの配布は[GitHub Pages](guides/github-pages.md)を参照してください。
