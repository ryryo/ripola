# URLから作品をテキストで読む

ローカルPCの既存のURL欄から、カクヨム・青空文庫の作品とnoteの無料公開記事をテキスト本として本棚へ保存します。カクヨムは章・節ごと、青空文庫も最上位の見出しが複数ある作品は章ごとに保存します。短い作品とnoteの記事は1冊です。音声合成や配布は行いません。[取得元の規約とnoteの調査結果](../research/web-source-policy.md)も参照してください。

## 取り込みフォームのURL欄から読む

通常の取り込みフォームに、本文用の「読む文章」とURL用の欄があります。URL欄の近くに対応先を表示します。カクヨムの作品トップURL、青空文庫の図書カード・本文HTML、noteの記事URLに対応しています。

noteは`https://note.com/<著者>/n/<記事キー>`を入れて「URLから読み込む」を押すと、本棚へ保存して読書画面を開きます。個人で読むために、ログインなしで無料の全文を読める単一記事を取り込みます。シェア用のquery・fragmentは取り除きます。有料・会員限定・下書き・プレビュー・年齢確認が必要な記事は対象外です。公開状態・価格・閲覧可否・未取得本文の残数を検証し、プレビューを全文として保存しません。著者ページの巡回やマガジンの一括取得はしません。

本文の段落・見出し・箇条書き・引用・単純なルビと著者・出典URLを保持します。コードと表は静止表示、画像・音声・動画は取得せず、文字のキャプションを保持します。ブログ全般の任意URL取得には未対応です。

青空文庫は、例えば`https://www.aozora.gr.jp/cards/000081/card45630.html`をURL欄へ入れ、「URLから読み込む」を押します。図書カードから本文を取得して本棚へ保存した後、1冊なら読書画面を開き、複数の章がある場合は同じフォーム内に各章の「テキストで読む」を表示します。例えば『吾輩は猫である』は11冊です。見出し前の序文がある場合も「はじめに」として残します。本文HTMLのURLを指定する場合も図書カードとの対応を確認します。公式ホスト`www.aozora.gr.jp`の作品だけに対応し、`http`とホストの`www`なしは`https://www.aozora.gr.jp`へ正規化します。ZIP・PDF・外部サイトは取得しません。著作権が存続する作品の利用は私的使用の範囲にとどめ、再配布は権利者の条件を確認してください。

カクヨムは次の手順です。

1. ローカル版を起動し、`http://127.0.0.1:4173/` を開きます。
2. 「URL」欄に作品トップURL（`https://kakuyomu.jp/works/<19または20桁>`）を貼ります。
3. URL欄の「URLから読み込む」を押します。未対応のURLは欄にエラーを表示します。
4. 同じフォーム内に作品情報と「取り込む章・節」（話数・最初と最後の話）が表示されます。取り込む範囲を選びます。章の中に節がある作品は節ごとに1冊になります。
5. 「この範囲を取り込む」を押すと、1話ずつ順に取得し、進捗と現在の話を表示します。
6. 完了した章・節だけがテキスト本として本棚へ追加されます。失敗した本は追加されません。同じ選択で再試行すると、取得済みデータを使います。

カクヨムの取り込み中にページを再読込しても、進行中のジョブはURL欄に再接続します。完了後や失敗後は、保存済みの本を本棚から開くか、表示された再試行操作を使えます。

本文とURLの入力値・操作は独立しています。「読む文章」にURLだけを貼っても、通常の文章として読み、ページを取得しません。音声の設定と生成対象は本文欄の文章で、URL欄の文字列を音声合成へ送りません。ファイル、サンプル、読書操作もそのまま使えます。本棚は音声とテキストの一覧で、テキスト本は既存の読書画面でルビ・全文を読み直せます。

取得はローカルのNode側だけで行います。カクヨムでは`https://kakuyomu.jp/works/<19または20桁>`と、その作品の目次に属する`/episodes/<19または20桁>`だけを許可します。青空文庫では公式の`/cards/<作家ID>/card<作品ID>.html`と、そのカードに掲載された同じ作品のHTMLだけを許可します。noteは指定記事のキーに対応するブラウザ向けJSONエンドポイントを使用し、応答中の記事キー・著者・記事URLを照合します。これは公開仕様として保証された公式APIではありません。リダイレクトは拒否し、認証情報やCookieを送らず、各サイトへの取得を1.2秒以上の間隔で逐次実行します。timeoutは30秒、ページ上限はカクヨム3 MB・青空文庫とnoteは4 MBです。

## 保存先とcache

保存先は既存の`RSVP_LIBRARY_DIR`（未設定時は`~/Documents/rsvp-reader-library`）です。

| 保存物 | 場所 | 内容 |
| --- | --- | --- |
| テキスト本 | `text-books/<id>_<revision>.json` | 本文・ルビを含む`ReadingDocument`、作品・話の出典、取得時のhash |
| 原本対応記録 | `text-source-maps/<id>_<revision>.json` | 段落と原本HTMLの対応、除外範囲、本文hash |
| 取得cache | `kakuyomu-cache/<workId>/` | 目次・各話の取得原本byte、`ledger.json` |
| ロック | `locks/` | 取り込みの多重実行を防ぐ一時ロック |

青空文庫も同じ`text-books/`に保存します。文書に本文HTMLと原本対応範囲、書誌・入力者注を保持し、取得元にはカード・本文のURLと取得byteのSHA-256・容量・日時を記録します。青空文庫では別の原本cacheは作らず、URLから再取り込みすると再取得します。本棚からの再読には通信しません。

noteも`text-books/`へ保存します。文書の`format: html`は、本文HTMLにタイトル・著者・出典を含むメタデータを付けた、スクリプトを実行しない読書用コピーです。本文範囲とルビはこのHTMLへ対応します。取得元に本文HTML・読書用HTML・JSON応答それぞれのSHA-256を記録し、JSON全体や著者プロフィールは保存しません。同じ記事の本文・メタデータが同じなら保存済みの版を再利用します。

`ledger.json`は作品ID・作品URL・話ID・取得URL・保存ファイル名・byte数・SHA-256・取得時刻・canonicalを記録します。cacheを読むたびに、原本byteのhashと容量、URLと作品/話の関係、DOMで解析したcanonicalを照合します。改変・切れ・別話・別作品を検出した場合は、黙って再取得せず停止します。cacheの書込みは一時ファイルからatomicに確定します。

同じ章・節・同じ内容の再取り込みでは、保存済みのテキスト本を上書きせず再利用します。同じID・版で異なる内容になろうとした場合は衝突として停止します。失敗した章・節は本棚へ出しません。

### 既存の数値cacheを使う

CLIの`--cache`に旧形式の`index.html`と`001.html`…がある場合、canonicalとURLを確認したうえで、その時点のhashを台帳へ記録して移行できます。取得当初から無改変だったことを遡って保証するものではありません。移行後の読込みは台帳のhashで検証します。

## CLIで取り込む

```sh
pnpm import:kakuyomu https://kakuyomu.jp/works/WORK_ID --output local-inputs/my-novel
```

`--parts 1,2`で章・節番号を選べます。`--offline`では検証済みcacheだけを使い、通信しません。出力先が同じで内容が異なる既存ファイルは上書きしません。改稿を取り直す場合は新しい出力先を使います。

出力は章・節ごとのMarkdown、Ripola用文書JSON、原本対応記録、取り込み結果です。作品は`local-inputs/`かリポジトリ外へ保存し、Gitへ追加しません。403、ログイン要求、未知の本文構造、話数の不一致、ルビの範囲を保持できないHTMLでは停止します。内部API、認証、CAPTCHAを回避する処理はありません。

## 個人用Workerへ追加する

本棚に保存したテキスト本は、そのまま配布用の入力にできます。`documentFile`には`text-books/`のJSONを指定します。CLIの`.document.json`を使う場合は、再stageで同じbytesになるよう`updatedAt`を明示してください。省略時は元ファイルのmtimeを使い、stage時刻は使いません。

```json
{
  "target": "worker",
  "audience": "personal",
  "existing": "/path/to/previous-personal-distribution",
  "books": [{
    "id": "text-kakuyomu-WORK_ID-01",
    "revision": "DOCUMENT_CONTENT_HASH",
    "documentFile": "/path/to/RSVP_LIBRARY_DIR/text-books/text-kakuyomu-WORK_ID-01_REVISION.json",
    "rightsConfirmed": true,
    "attribution": "著者・作品名・出典URL・自分の利用条件"
  }]
}
```

```sh
python3 ~/.codex/storage-maintenance/guard.py check --path "$PWD" --needed-gib 2
node scripts/prepare-distribution.mjs --kind text --config local-inputs/my-text-allowlist.json
```

stageは既存catalogと全assetのhashを検証し、音声を再生成せず保持します。テキスト本は`kind: text`、音声chunkなし、音声時間0を明示します。壊れた音声本をテキスト本として扱いません。同じID・版が既存catalogにある場合は、そのmanifest bytesをそのまま再利用します。同じID・版で異なるbytesになろうとした場合は拒否します。

すべてのmanifestをserializeした実byte数で25 MiB以下を事前確認し、専用の一時directoryで作成して最終監査後にatomicに確定します。容量超過や監査失敗時は完成先directoryを残さず、同じ出力先で再試行できます。複数の本が同じ音声assetを参照する場合は、同一bytesなら再利用し、異なるbytesなら衝突として停止します。

既存の個人用catalogと各assetのhashを検証し、全蔵書に選択したテキスト本を追加します。Workerの設定と新しい配布物を確認してから、[個人用配布手順](../../.agents/skills/ripola-publish-personal/references/personal-worker.md)に従って配布します。

## 対応範囲と制約

- 対応する本文構造は、カクヨムの`widget-episodeBody`直下の段落と、段落内の既知の装飾・単純なルビです。画像、未知のwrapper、未知の要素、複数の読み、読みの後に親文字が続くルビは停止します。
- 空白だけの段落はMarkdownの段落間隔へ変換し、対応記録に除外として残します。ルビの読みの前後に空白がある場合は、原文のまま保持できないため停止します。
- 目次の未知level、章のない節、空の見出し、話数の不一致は停止します。節の見出しは章を変えるまで状態として保持し、見出しが変わらない連続レコードは同じ章・節の1冊へまとめます。
- 作品の本文・ルビの利用条件は、ソフトウェアのMITライセンスとは別です。取得・保存・配布できる範囲は作品と配布先の条件に合わせてください。
- 取得した本文・原本HTML・個人設定・cacheをGitや公開成果物へ含めません。

## 先行実装の取り込み方

目次の参照をたどって話を順番に列挙する処理は、[ayati/novel_downloader](https://github.com/ayati/novel_downloader)の`kky_get_episode_urls`を参考に、TypeScriptへ移植しました。参照revisionは`011a3c8d60fad25909839498b8e2694e62ca2cc8`です。元の実装が使う`tableOfContents`に加え、現在の`tableOfContentsV2`に対応しています。

CLI全体やPython実行環境の組み込みは避け、Ripolaに必要な取得・章分割・本文とルビの保持をローカルの入口に実装しています。EPUB出力、GUI、他サイトへの取得機能は組み込んでいません。Web側に本文を取得する公開APIは配置せず、ローカルprofileのserver functionだけがNode側の取得処理を呼びます。

先行実装の[MIT全文](../licenses/upstream/novel-downloader-LICENSE)と著作権表示を保持しています。ソフトウェアのMITライセンスは、取得する小説本文の利用許諾とは別です。本文の利用・配布は作品と配布先の条件に合わせます。
