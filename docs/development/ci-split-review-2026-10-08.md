# CI分離の監査結果と推奨案（2026-10-08）

毎回の全件ブラウザ検査は過剰。**通常の主要経路検査＋変更に対応する追加検査＋手動full**への分離を推奨する。通常は **2.5〜3.5分を目標とする見積もり**で、未実装・未計測。共通UI・レイアウト変更は追加検査が多くなり、毎回3分以内を保証する案ではない。

対象は公開リポジトリ `ryryo/ripola`、監査SHA `28ddb922854b6adb2399ab10c26ef475d2d03406`。監査時点の変更はこの記録の追加のみ。CI・製品・テストコード、GitHub設定を変更せず、追加CI、commit、push、公開操作を行っていない。既存の利用者変更を保持した。

## 既存実行の実測

[現在のworkflow](../../.github/workflows/ci.yml)、[scripts](../../package.json)、[ブラウザ設定](../../playwright.config.ts)、テスト本文と既存Actionsログを照合した。計測用runは起動していない。

|既存run|SHA|check job|ブラウザstep|備考|
|---|---|---:|---:|---|
|[37726821897](https://github.com/ryryo/ripola/actions/runs/37726821897)|`5fc8621`|10分58秒|9分16秒|公開検証文書だけの変更でも全件実行・Pages公開|
|[37740367548](https://github.com/ryryo/ripola/actions/runs/37740367548)|`e78ceb8`|本記録では未集計|10分22秒|Pages初期本文の変更後|
|[37744337416](https://github.com/ryryo/ripola/actions/runs/37744337416)|`28ddb92`|9分47秒|7分31秒|wrappingの6ケースを並列化済み|

最新runは132件・2 worker、128 passed・4 skipped・再試行なし。ブラウザはjob時間の約77%。unitは238件、ログ内の実行時間44.351秒。stepの整数秒と詳細ログの値には丸め差がある。

|最新runのstep|実測|
|---|---:|
|Media tools（apt更新・FFmpeg依存導入）|42秒|
|依存install|6秒|
|pnpm check（型・lint・unit・local build）|55秒|
|Python環境・計算・環境契約テスト|7秒|
|Worker build / Pages build|各3秒|
|Worker / Pages最終配布audit|各1秒|
|npm pack dry-run|1秒|
|ブラウザ開始前の経過|2分11秒|
|ブラウザstep|7分31秒|

FFmpeg導入ログは4 package更新・99 package新規導入。必要な道具が最初からあると仮定して42秒を差し引けない。依存installやauditだけの最適化では数分の改善にならない。

## 過剰実行と維持する検査

- 文書のみでも実音声・長文・全フォント・全画面サイズを含む132件を回す。純粋な説明文書は軽い分類・集約jobだけでよい。
- 83の異なるソースケースを132回実行している。49ケースはdesktop/mobile双方で同じ本文を実行する。そのうち2ケースは双方skip。mobileの全反復を毎回実行する必要は薄いが、入力・配置の固有差があるためfullから削除しない。
- wrappingは6ケース・72組合せ。48 silent組合せ×1.65秒＋24 audio組合せ×2.7秒の観測だけで計144秒。並列化後のwallは約131秒、個別時間の合計は約241秒。実フレーム・音声・文字位置の検証なので、待ちを単純削除せずlayout関連変更とfullへ回す。
- guide/fontにも条件の重なりがあるが、guideの重なり・glyph位置・スクロールなど検証が異なる。完全な重複と断定しない。
- audio-presentationは両projectで隔離Worker build、AAC作成、実再生・seekを行う。音声・配布関連変更とfullで維持する。
- 200〜900msの待ちや500msのフォント遅延模擬は主因ではない。30/90/180秒のtimeoutは上限で、毎回その時間を待つわけではない。
- local/Worker/Pagesは入口、生成APIの有無、base `/` と `/ripola/` が異なる。安価な異なる配布境界として通常に残す。Vite buildは意味的な型検査を追加しないので、型検査が重複しているとは数えない。
- build-distribution内auditと別stepの最終auditには同じ実装の再実行がある。ただし約1秒ずつ。公開対象・生成API混入・音声hash・帰属などの最終境界として明示auditを維持する。
- PDF asset準備は各profile buildとdev server起動で繰り返す。二次的なIO改善候補であり、主な短縮策ではない。

## 推奨構成

|区分|条件・検査|時間の扱い|
|---|---|---|
|文書のみ|変更分類・成功集約。install/build/browser/deployなし|1分以内が目安、queue除外・未計測|
|通常|コードのPR/main push。型・lint・全unit、3 profile build、最終audit、代表12既存ケース＋完成Pages smoke2ケース案|2.5〜3.5分の見積もり|
|関連変更|通常に、変更領域に一致する検査をunion。同じproject/caseは1回だけ|共通UIでは4〜6分以上もあり得る|
|手動full|workflow_dispatch、リリース前・高リスク変更。既存132件を全保持|現状job9分47秒。Pages2件追加なら134件|
|ローカルopt-in|native VOICEVOX・保存済み公開可能音声の4 invocations|標準fullでもskip。実施状態を別記|

完成Pagesの恒常的なsmokeは現在不足している。現行E2Eの大部分はlocal dev profileを検証するため、分離実装時には `dist/distribution/pages` を `/ripola/` でserveし、以下2ケースを追加する案。**監査時点では未実装。後続の[実装記録](../validation/public-release/ci-split-implementation-2026-10-08.md)を参照。**

1. 初期plain本文のsubmitで読書でき、明示保存前に個人保存しない。
2. 直リンク・reload・seek、公開音声3サンプルのcatalogと再生入口、生成APIの404。

既存12ケースの個別時間合計は54.1秒。2 workerで30〜60秒、追加Pagesは15〜30秒程度と仮定し、現在の準備2分11秒から全件browserを置換する見積もり。cache・順序・初回負荷を保証できない。同じrunnerの2 workerを保ち、job分割でinstall/serverを大量に重複させない。

### 通常に残す既存ケース

将来の実装ではproject/titleを明示selectorまたはtagで選ぶ。曖昧な部分一致を避ける。ファイル・行・時間の全件一覧は [JSON](ci-split-review-2026-10-08.json)。

|project|file|title|最新個別時間|
|---|---|---|---:|
|desktop-chromium|`audio-alignment.spec.ts`|同一音声内のフレーズ・ruby・seek・速度・chunk越え・背景停止・位置復元|8.2秒|
|desktop-chromium|`generation.spec.ts`|有料モデルはLite既定・Flashだけ、Gatewayはサーバー未設定なら無効|2.7秒|
|desktop-chromium|`generation.spec.ts`|トップの有料生成は送信内容・費用の確認を要求し、原稿変更で古い計画を破棄|5.9秒|
|desktop-chromium|`local-security.spec.ts`|local server function rejects cross-origin, forged Host and missing browser evidence|1.3秒|
|desktop-chromium|`reader.spec.ts`|貼付・空本文・原文シーク・Unicode・ruby・外部送信なし|4.0秒|
|desktop-chromium|`reader.spec.ts`|MDファイルはcode/tableで止まり、元入力と同じ本文の位置を保つ|3.8秒|
|desktop-chromium|`reader.spec.ts`|再生連打・速度変更・戻る・設定・背景停止は単位を飛ばさない|4.7秒|
|desktop-chromium|`reader.spec.ts`|端末に明示保存、再開と削除|5.6秒|
|desktop-chromium|`reader.spec.ts`|日本語PDFの文字層とページ表示|4.4秒|
|desktop-chromium|`reader.spec.ts`|Worker起動失敗時も原文を確認できる|2.3秒|
|mobile-chromium|`creation-options.spec.ts`|音声サンプル voicevox は1クリックで開き、戻る・連打でも生成しない|8.0秒|
|mobile-chromium|`responsive.spec.ts`|スマホ 390×844: 片手操作・長句ruby・横溢れなし|3.2秒|

### 全132 invocationsの一次分類

fullには全件を含める。通常と関連の重なりは実行時にunionする。mobileのgeometry/font専用検査は関連に残し、主に同一本文の残りの反復をfullへ移す。

|file|通常|関連変更|fullで追加|ローカルopt-in|
|---|---:|---:|---:|---:|
|`aozora.spec.ts`|0|2|2|2|
|`audio-alignment.spec.ts`|1|8|7|0|
|`audio-presentation.spec.ts`|0|1|1|0|
|`creation-options.spec.ts`|1|9|6|0|
|`generation.spec.ts`|2|15|17|2|
|`guide.spec.ts`|0|2|0|0|
|`local-security.spec.ts`|1|0|0|0|
|`progress.spec.ts`|0|5|0|0|
|`reader.spec.ts`|6|10|0|0|
|`reading-options.spec.ts`|0|9|7|0|
|`responsive.spec.ts`|1|5|0|0|
|`titles.spec.ts`|0|2|2|0|
|`wrapping.spec.ts`|0|6|0|0|
|合計|12|74|42|4|

### 関連変更と文書分類

|変更領域|追加検査|
|---|---|
|取り込み・parser・segmentation・PDF asset|readerのPDF/MD/text/ruby、aozora長文、progress|
|音声player・同期・chunk・codec・media/library|audio-alignment、audio-presentation、関連progress、sample audit|
|generation UI/server・plan・保存・費用・Gateway・alignment|generation/creation-options/local-security、Python計算・環境契約。生成はmock/fixture|
|layout・CSS・font・Guide|responsive、wrapping72組合せ、guide、font、audio guideのgeometry|
|配布script・route・Vite/base・public/catalog・帰属|全profileとaudit、完成Pages smoke、Worker audio-presentation|
|setup・requirements・env example・Node/Python条件|setup関連unit、Python計算・runtime契約|
|workflow・lockfile・共通部・不明コード|保守的に広い関連群。高リスクはfullも明示|

ReaderApp/AudioReader/GuideReaderや共有styles.cssは複数領域へ影響する。小さい差分という理由だけでsmokeに限定しない。一方、Pages初期本文など狭い変更では全layout/生成/backendを回す必要はない。

文書のみの許可対象はREADME/CONTRIBUTING、docsのguides/development/research/public-release説明記録など。`docs/licenses/**`、`docs/validation/fixtures/**`、LICENSE、`.env.example`、public asset、依存定義、workflowは文書扱いにしない。

PRはbase/head、main pushはイベントbefore/afterの差分を使う。HEADの直前1commitだけでは複数commitのpushを見落とす。差分取得失敗・初回push・不明ファイル・欠落一覧は通常＋広い関連へ倒す。native path filterには300ファイルの制限があるため、NUL区切りgit diffまたはAPI paginationで分類し、途中までの一覧を文書のみと判定しない。[GitHub workflow仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

## PR・main・Pages・取消

現在のpush triggerはmainのみ。feature更新が常にPR/pushで二重実行される設定ではない。merge後のmain再検査は配布SHAの検証として維持し、全件を通常＋該当追加へ縮める。

Pagesは同じSHAの通常・関連検査・完成Pages smoke・最終auditが成功したartifactに限定する。PRでは公開しない。集約jobは常に起動し、必要jobの失敗・予期しないskipを失敗にする。workflow全体のpath skipはrequired checkをPendingにする場合がある。[GitHub workflow仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

build/deployは同じrunのartifactと依存gateで結び、Pages書込・OIDC権限はdeployに限定する。[公式Pagesガイド](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

監査時点のmainはAPIでprotected:false。merge必須チェックが設定済みとは扱わない。設定を変更していない。

現在の `ci-${{ github.ref }}` / cancel-in-progress:true は古いPRを止める一方、main pushとmain上の手動fullが互いを止め得る。通常はfast-ref、fullは別groupとcancel-in-progress:falseを推奨。fullは開始SHAを記録し、検証だけでPagesを再公開しない。Pagesは公開groupで直列化し、公開中の取消を避け、直前に最新mainか確認して古いrunをskipする。SHA確認だけを原子的な競合解決と扱わず、直列化・同SHA artifact・gateを併用する。[公式concurrencyガイド](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## リスクと検証状態

- mobile反復をfullへ回すと、IME・focus・キー操作・高度な状態遷移のmobile固有差はfullまで発見が遅れる場合がある。layout/font/長文関連検査は変更時にも自動追加する。
- 4 skippedはRSVP_TEST_VOICEVOX=1とRSVP_TEST_AOZORA_AUDIO=1のopt-inが各projectで未実行。標準fullでnative実合成まで合格したとは記録しない。個人書籍や有料生成を検査前提にしない。
- **Windows/Linuxの検証済み部分:** 別の[PR #1](https://github.com/ryryo/ripola/pull/1)でLinux x64・CPython 3.13の補正setup対応を追加し、実WSL2で初回・再利用・CPU処理・保存・cache再利用を確認済み。Linux CI上のPython計算・runtime契約検査も既存runで成功している。今回再実施はしていない。[既存検証記録](../validation/public-release/README.md)
- **未検証の実機E2E:** Windows 11/mirroredでWindows版VOICEVOXに接続し、WSL2側Nodeから生成・保存・Reader再生する全体動作は未検証。実測Windows Server 2022/NATではWSL側の接続が失敗した。Linux/WSL2の補正setup成功とこの接続経路を混同しない。[setup条件・検証範囲](../guides/setup.md)
- スマホ利用は利用者確認済み。追加の網羅実機QAを新規前提としない。Windows/Linuxの未検証実機E2Eは後回しのまま、今回のCI見直しで完了扱いにしない。
- 実装後に通常runの対象件数・時間・Pages artifactと、fullへの全132件の残存を確認する。今回の提案の効果は未計測。製品機能や定期実行は追加しない。

全132件のtitle/project/時間/提案区分と既存run履歴は [JSON記録](ci-split-review-2026-10-08.json) を参照。
