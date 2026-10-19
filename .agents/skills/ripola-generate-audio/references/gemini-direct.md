# GeminiをGoogleへ直接接続して生成する

## ローカル設定

通常読書やVOICEVOXでは設定不要です。Geminiを使う段階で、repo rootの `.env.local` に次の行を追加します。実際のキーはこのファイルへ直接入力し、既存のalignment設定は保持してください。

```dotenv
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

変更後はローカルサーバーを再起動します。[Google公式のキー管理](https://ai.google.dev/gemini-api/docs/api-key)と[TTS仕様](https://ai.google.dev/gemini-api/docs/speech-generation)で利用条件・billing・quotaを確認してください。アプリの概算は請求上限ではありません。キー設定だけでは送信しません。生成ごとの明示確認を必要とし、旧envの有料停止指定も尊重します。

[生成前の確認事項](audio-generation.md#有料geminiの開始前に確認する)を確認し、[共通の生成手順](audio-generation.md)へ進みます。Cloudflare経由を指定された場合は[別の接続手順](gemini-cloudflare.md)を使います。
