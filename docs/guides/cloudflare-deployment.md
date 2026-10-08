# Cloudflareへ閲覧用Readerを配布する

端末内のテキスト取り込み・RSVP生成と、選択した保存音声を配布します。公開OSSデモと、本人のアカウントの個人用Workerを別の用途として扱います。個人利用の手順は[個人用Worker](personal-worker.md)を参照してください。WorkerでVOICEVOX・Gemini生成、Python整列、音声の永続保存を行う機能はありません。R2・D1・APIキーは不要です。[詳細な配布契約](../development/distribution.md)と[機能分担](../development/local-cloud.md)を参照してください。

## 同梱サンプルだけの最小ビルド

リポジトリ直下で実行します。

```sh
pnpm build:worker
pnpm audit:audio --distribution dist/distribution/worker
```

`dist/distribution/worker` にReader、PDF資材、青空文庫サンプル、空の追加音声catalogを作ります。許可済みの同梱3音声デモは含み、個人のローカルlibraryは読み込みません。ビルドだけではデプロイしません。

## 自分の配布先を確認する

専用アカウント／専用Worker名を使い、既存の別サービスの設定を流用しないでください。次は利用者自身が初回に行うログインです。

```sh
pnpm --filter @ripola/web exec wrangler login
pnpm --filter @ripola/web exec wrangler whoami
cp deployment/cloudflare.example.wrangler.jsonc deployment/cloudflare.wrangler.jsonc
```

コピーしたローカル設定で `name` を自分用の一意な名前へ変更します。複数アカウントがある場合は、`whoami`で確認した配布用アカウントの `account_id` をこのローカル設定へ追加します。exampleには個人のアカウントIDや認証値を置きません。`.env.local` にCloudflareのトークンを書き足す手順ではありません。

この例は `workers_dev: true` なので、デプロイするとサンプルと選択した本文・音声がインターネットから閲覧可能になります。個人用は[別のWorkerと配布入力](personal-worker.md)を使います。閲覧認証を希望する場合だけAccessを追加します。

```sh
pnpm --filter @ripola/web exec wrangler deploy --dry-run --config deployment/cloudflare.wrangler.jsonc
pnpm --filter @ripola/web exec wrangler deploy --config deployment/cloudflare.wrangler.jsonc
```

出力されたURLでトップ、`/books/`、対応PDFを確認します。音声を含む時は本文manifestへの直リンク、reload、HEAD／Range、seek、倍速、停止・再開も確認します。新しい利用者のアカウントでの初回ログイン・デプロイは未検証です。

設定の `main` は選択済み公開音声のRangeを補うscript、`ASSETS` は静的ファイルです。`assets.directory`は検査済み出力だけを指します。設定ファイル・Git・library・元WAV・envをその中へコピーしません。Worker実行を含むため料金・制限は[Cloudflare公式](https://developers.cloudflare.com/workers/platform/pricing/)で確認してください。

## 保存音声を含める場合だけ

`ffmpeg`／`ffprobe` が必要です。Git外へallowlist JSONを用意し、配布できるbook ID・revisionを個別に指定します。以下は**値を埋める例**で、そのまま実行できるデータではありません。

```json
{
  "target": "worker",
  "audience": "demo",
  "libraryDir": "/absolute/path/to/private-library",
  "books": [{
    "id": "YOUR_BOOK_ID",
    "revision": "YOUR_REVISION_HASH",
    "rightsConfirmed": true,
    "publicDemo": true,
    "attribution": "原稿と音声の出典・利用条件・必要なクレジット"
  }]
}
```

権利確認flagを付けるだけで利用許諾が得られるわけではありません。公開する本文全体と選択した声の再配布条件を確認します。配布DTOの `rawText` に原文が含まれるため、元PDF/MDを配らなくても本文は公開されます。

```sh
pnpm stage --config /absolute/path/to/allowlist.json --output staging-public/release
pnpm build:worker --staging staging-public/release
pnpm audit:audio --distribution dist/distribution/worker
```

staging出力は新規directoryを使います。同じ名前が既存なら別のrelease名を選びます。必要な本文・manifest・対応表・AACだけを抽出し、元WAV・全library・job・query・envは含めません。検査後に同じデプロイ手順で更新します。stage/build/upload失敗ではTTSを再生成しません。

## 個人利用と閲覧範囲

上の設定例は公開サンプル向けです。個人の本は[個人用Workerの手順](personal-worker.md)で本人の別Workerへ選択配布します。個人用という名称やGitHubのprivate設定だけではHTTP非公開になりません。認証なしならURLを知る人が本文・音声・manifestを閲覧できます。閲覧を制限する場合は[Cloudflare AccessのWorker保護](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)を自分のアカウントで別途設定し、HTMLだけでなく本文JSON・manifest・音声、workers.dev／custom domain等の全入口が保護されることを確認します。Accessの初回設定・個人配布はこのプロジェクトでは未検証です。

QR・noindex・推測しにくいURLは閲覧認証の代わりになりません。認証した通常HTTPS URLを使い、token・キー・私的本文をQRへ入れません。PCのブラウザ保存がスマホへ転送される機能もありません。GitHub repoのprivate設定とWorkerの公開範囲は別です。

静的版の本の追加・更新は再stage/build/deployが必要です。配信コピーはlocal正本のバックアップではありません。将来のクラウド生成・同期案は[別の設計資料](../development/local-cloud.md)で扱います。
