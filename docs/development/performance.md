# 全体パフォーマンス確認（2026-10-16）

対象は起動・遷移、本棚、取り込み、保存復元、音声準備と生成、黙読／音声の各表示、継続利用です。表示の速さだけでなく、原文・保存位置・同期・中断復帰が保たれることを条件にしました。

## 処理と寿命の境界

- Localの読取APIは`ReadingLibrary`を使い、provider設定、Wrangler初期化、生成jobの復旧を開始しません。生成操作／CLIの`GenerationService`は従来どおり復旧完了を待ちます。どちらもloopback originの検査と音声の整合性検査を維持します。
- 一覧の目録はmanifestを正本とする派生cacheです。識別子・size・更新時刻を検査し、直接編集・置換・削除を反映します。旧目録の移行は最大16冊並列、cache書込失敗でも読取を継続します。
- 読書中のpollは本・改名・各speech keyの音声metadata/cacheのfile versionと、小さなjob summaryを確認します。変更がないと本文を読まず転送もしません。同じgeneration sequenceのcue補正・MP3差替えも変更として扱います。speech key数に応じたstatは残ります。初回と変更時には本文の独立検査を行います。
- `ReadingLibrary`が保持するのは最大32冊のstamp/keyと最大32jobの小さなsummaryです。本文や音声bytesをプロセスcacheに保持しません。クライアントのepoch/abortとmanifest採用条件も維持します。
- 音声準備は同じimmutable book snapshotの検査とsegment生成を一度に行います。音声時計の索引はsegmentをkeyにしたWeakMapへ置き、Reactの本文・ルビ・計測用Rangeは表示set／layoutの寿命で再利用します。音声の唯一の時計は引き続きmediaのcurrentTimeです。
- PDF原文drawerは開いている間だけ1つのdocument/Workerを保持します。ページ変更とresizeで再openせず、renderは取消を待って直列化し、close／入力変更で破棄します。取り込みの一時PDFは処理完了後に破棄します。
- ホームの音声設定は最初に開いた時だけ読み込み、その後は閉じても設定値を保持します。切替時の原稿・形式の展開状態・キーボードfocusも維持します。

## 同一ホストでの比較

製品buildとNode上のsynthetic fixtureによる参考値です。実機・実provider・実CDNの応答時間を保証する値ではありません。前半は`b53eaff`、追加分は前半実装`a0a33d3`を比較基準にし、mainの`7c7ce92`を統合しています。時間にはホスト負荷のばらつきがあります。

| 対象／条件 | 変更前 | 変更後 |
| --- | --- | --- |
| 本棚1000冊×4k文字、warm payload読取 | 12,559,780 bytes | 0 bytes（statは実施） |
| 同本棚warm所要時間 | 81.6–84.5 ms | 41.2–49.5 ms |
| 同本棚cold移行 | 125.5 ms | 164.6 ms |
| 小さい本3冊、warm | 約0.6 ms | 約2.9 ms |
| 復元10万文字・3万unitsのWorker request JSON量 | 8,746,935 bytes | 600,264 bytes |
| 未変更poll、91k文字・28k units・140個の異なるspeech key | 9,312,001 bytes／143 reads、203–297 ms | 0 payload bytes／0 reads、34–70 ms（metadata statを含む） |
| 同規模の最初のsource-clock構築、2回のfixture比較の範囲 | 1.48–2.31秒 | 8.7–23.7 ms |
| PDF段組検出、5000行のgap fixture | 257–338 ms | 17–32 ms |
| 保存済み圧縮音声の補正再利用、50chunks／10k units | 6064 ms | 1065 ms |
| Wrangler設定＋完了job200件がある読取初期化 | 1156 ms／11,887,490 bytes読取 | 114 ms／0 payload bytes読取 |
| Localホームcold JSのencodedBodySize | 326,465 bytes | 301,474 bytes |
| モバイル相当・5倍音声4秒のResizeObserver生成／破棄 | 189回 | 66回 |

最後の音声比較は前後とも241採取frameでマーカー欠落0でした。音声準備のwarm user CPUも約240–290→150–190 msに減りました。PDFの探索は不要候補を除く方式で、最悪計算量が常に線形になるという主張ではありません。整列再利用・読取初期化は注入したfake adapter/configを使用し、有料合成やモデル実行時間を含みません。

## 項目別の結論

| 範囲 | 対応と判断 |
| --- | --- |
| 起動・遷移 | 音声設定を遅延読込、読取初期化を生成から分離。直接openは一覧を待たず、履歴／focusを回帰確認。 |
| ホーム・本棚 | 目録、同時取得の共有、保存位置の共有購読、変更本だけの更新。移行／小規模での追加コストも上表に記載。 |
| 入力・解析 | 大きい本文のWorker処理を維持。復元時に再生成するunitsを送らず、PDFのgap候補探索を絞る。暗黙の原文省略はしない。 |
| 保存・復元 | 原文・ルビ・anchorを維持。戻る操作に必要な未保存本文を、性能対策として勝手に破棄しない。 |
| 音声準備・poll | 重複検査を統合、未変更の本文再読取／転送を除去。cue補正・音声差替え・取消・再開を検証。hash／duration検査は維持。 |
| 各読書モード | source-clockの線形探索、全sliceの再描画、Range／observerの再作成を減らす。黙読／音声、phrase／複数行／全文、縦横／通常全画面を確認。横長の全画面で設定行数が収まらない既存問題も修正。 |
| PDFの寿命 | ページ間でdocumentを再利用。browser試験でページ変更時のWorker増加なし、drawer終了時の破棄を確認。 |
| 生成・補正 | 同じ保存済みbookの検査を各chunkで繰り返さない。新規補正は最新manifestとのmerge・検査・chunkごとの原子的保存を維持し、復旧可能なcheckpointを減らさない。モデルpool／常駐化は実モデル測定なしに導入しない。 |
| 継続利用 | 下記の10分比較と先読み解放試験を実施。履歴の保持をリークと混同して削除しない。 |

## 回帰と継続利用

`pnpm typecheck`、`pnpm lint`、unit全462件、Local／Pages／Worker buildと配布監査を実施しました。browserでは本棚・進行度・sort/filter・同一／別タブ・保存拒否、履歴、10万文字clipboard、PDF／テキスト復元、音声生成の確認と取消、生成hole、同sequence補正、音声差替え、5倍マーカー、ルビ、手動seek、全画面、設定量と配置を確認しました。実providerが必要な2件は未実行です。CIのbrowser登録336件との一致は確認しましたが、全336件を手元で実行したという意味ではありません。

追加の10分比較ではmobile viewport 390×844で60秒のnative音声を10回再生し、3表示モード・縦横・通常全画面を切り替えました。GC後heapは前が8.97–10.11 MB、後が9.00–10.18 MB。終了してホームへ戻った時は9.16→9.12 MB、listenerは前後391、audio elementと生存object URLは0、JS errorも0でした。この試験の音声は1chunkで、複数chunkのblob保持／解放は別の先読みbrowser試験で確認しています。長時間比較のbuild後に追加した変更は初回音声設定のfocus保持と横長全画面の配置で、別途browser回帰確認しています。

これは10分間のエミュレーション結果であり、数時間の実スマホ利用やあらゆるPDFのメモリ安全性を証明するものではありません。実モデル・有料API・CDNと物理端末の測定は、利用可能な対象を用意した際の追加検証です。
