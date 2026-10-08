# 自分のWorkerで、ローカル生成した本をスマホから読む

公開OSSのコード・公開デモと、利用者が自分のCloudflareアカウントで使う個人用Workerは別の配布先です。個人用の原稿をOSSや公開デモへ入れる必要はありません。PCで生成した本文・音声・フレーズ時刻を選んで、本人のWorkerへ一方向に配布できます。R2・D1・新しい環境変数は不要です。

公開デモ・個人用Workerとも、閲覧端末内のTXT/MD/対応PDF取り込みとRSVP生成、配布済み音声の再生に対応します。Gemini・VOICEVOX・整列のサーバー処理はローカルPCだけです。個人用Workerにも音声生成API、AI binding、Google keyを配置しません。

## 配布入力を分ける

| 用途 | stageのaudience | 個別本の条件 | 原稿・allowlist・stage | ビルド出力 | 配布先設定 |
| --- | --- | --- | --- | --- | --- |
| 公開OSSデモ | demo（省略時もdemo） | 全てpublicDemo=true | 公開許可済みサンプルの専用入力・staging-public | dist/distribution/worker | 公開デモ専用Worker |
| 本人の個人利用 | personalを明示 | 本人の用途・閲覧範囲の権利を確認 | Git外library、Git外allowlist、staging-private（またはrepo外） | dist/personal-worker | Git対象外deployment/personal.wrangler.jsoncで本人の別Worker |

個人用stageを通常のデモbuildへ渡すと拒否します。個人用buildも個人用stageが必須です。manifestとdistribution.jsonに用途を記録し、用途の違う既存出力の上書きも拒否します。既存デモcatalogの用途省略は全てpublicDemo=trueの場合に限ってデモ配布へ使えます。個人用のGit内stageはstaging-privateへ、Git内ビルドはignoredのdistへ限定します。ライブラリ全体をコピーせず、指定book/revisionに必要な本文・manifest・対応表・AACだけを抽出します。

これらは誤混入を防ぐガードです。audienceや個人用Workerの名前はHTTP認証ではありません。認証なしなら、本人のWorkerでもURLを知る人が本文・rawText・音声・manifestへアクセスできます。

## 1. ローカルで完成させる

ローカルPC版で本文を取り込み、声・読み・費用を確認して音声を保存します。音声生成・精密な時刻補正はPCで済ませます。保存済みbook IDとrevisionを本棚から確認し、配布する版を選びます。圧縮済み音声、生成設定、job、cache、鍵はローカル正本に残します。新規生成の不要WAVは検証後に自動整理します。

個人用allowlistはGit外かstaging-private/allowlist.jsonへ置きます。下は自分の値に置き換える例です。実際の原稿やキーは例に入れません。

```json
{
  "target": "worker",
  "audience": "personal",
  "libraryDir": "/absolute/path/to/your-library",
  "books": [{
    "id": "YOUR_BOOK_ID",
    "revision": "YOUR_REVISION_HASH",
    "rightsConfirmed": true,
    "publicDemo": false,
    "attribution": "原稿と声の帰属・自分の利用条件"
  }]
}
```

rightsConfirmedは本人の利用と配布先の閲覧範囲について確認するflagです。公開OSSデモへの掲載許可を意味しません。選択本文を配布する権利や閲覧制限は利用者が確認します。

## 2. 個人用の配布物を準備する

新規生成で検証済みの圧縮音声はそのまま配布します。旧WAVだけの音声はffmpeg/ffprobeでAACへ変換します。TTSは呼び直しません。

```sh
pnpm stage --config staging-private/allowlist.json --output staging-private/release-001
pnpm build:worker --audience personal --staging staging-private/release-001
pnpm audit:audio --distribution dist/personal-worker
cp deployment/personal.example.wrangler.jsonc deployment/personal.wrangler.jsonc
```

stageは新しいdirectoryを指定します。個人用の出力は公開デモ出力とは別です。設定のnameを自分の一意なWorker名にし、既存Wranglerログインのアカウントが本人の配布先であることを確認します。公開プレビュー用の設定やWorker名を流用しません。既存ログインを使える場合、新しいtokenやenv項目は不要です。

準備だけなら次のdry-runで確認できます。

```sh
pnpm --filter @ripola/web exec wrangler deploy --dry-run --config ../../deployment/personal.wrangler.jsonc
```

## 3. 本人のWorkerへ配布する

認証なしで使えます。必要な利用者だけ[Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)を追加してください。個人用という名前はHTTP認証ではなく、認証なしならURLから本文・音声・manifestを閲覧できます。Accessを使う場合はWorkerの全トラフィック・本文・音声も保護します。有料生成の防止は、認証とは別に、生成APIとAI設定を配布しない実装で行います。

配布する時だけ、本人が設定・配布物・閲覧範囲を確認した上で実行します。

```sh
pnpm --filter @ripola/web exec wrangler deploy --config ../../deployment/personal.wrangler.jsonc
```

今回の修正では本人の原稿のアップロード、個人用Workerのデプロイ、Access設定は実行していません。

## 4. スマホで読む

本人のWorkerの /books/ から選択した本を開くか、その本の通常HTTPS URLをQRで開きます。必要ならスマホ自身でAccess認証します。本文・ルビ・対応表・フレーズ時刻・圧縮音声を読み、再生・倍速・文移動を使えます。追加や更新はPCで再stage/build/deployします。圧縮・配布の失敗だけでGeminiを再生成しません。

配布される同期データは、本文と音声・フレーズ時刻を対応させる情報です。PCとスマホの読書位置やIndexedDBを自動で同期する機能はありません。読書位置は端末とoriginごとに保存されます。元PDF自体は配布しないため、PDF原画面の再表示が必要なら閲覧端末で元PDFを別に取り込みます。ローカルlibraryは正本として保持します。
