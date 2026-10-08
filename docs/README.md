# ドキュメント

Ripolaの利用・実装・第三者条件を確認するための資料です。

- [初期セットアップ](guides/setup.md)・[設定](guides/configuration.md)
- [読書](guides/reading.md)・[青空文庫](guides/aozora-and-navigation.md)
- [音声生成](guides/audio-generation.md)・[GeminiとCloudflare](guides/ai-gateway.md)・[同期補正](guides/forced-alignment.md)
- [Cloudflare配布](guides/cloudflare-deployment.md)・[個人用Worker](guides/personal-worker.md)
- [アーキテクチャ](development/architecture.md)・[取り込み](development/import-pipeline.md)・[分割](development/segmentation.md)
- [再生](development/playback.md)・[音声の検査](development/audio-presentation-quality.md)・[ローカル生成](development/local-generation.md)
- [保存と機能分担](development/local-cloud.md)・[MP3保存](development/mp3-library.md)・[静的配布](development/distribution.md)
- [日本語フォント](research/japanese-fonts.md)・[依存ライセンス](licenses/README.md)・[製品MIT](licenses/product-license.md)
- [公開版の検査結果](validation/public-release/README.md)

Windows/Linuxの初期音声セットアップQAは未検証です。公開Worker/Pagesは端末内の取り込み・RSVP生成と保存済み音声再生を提供し、音声生成APIを含めません。
