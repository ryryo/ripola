# 配布物と検証データの保存期間

通常配布は既定の `dist/personal-worker` または `dist/distribution/<profile>` を再利用します。日付・試行番号付きの `--output` や `personal-worker-before-*` に配布物全体を保存する運用は、同じ本・画像・フォントを更新のたびに複製します。明示的な保存理由がある過去版以外は、hash・件数・監査結果・差分だけを記録します。元library・生成音声・モデル・運用設定は整理の対象にしません。

## 通常の準備

このMacでは、package managerを呼ぶ前にPythonを直接実行して容量を確認します。続く入口もNodeを直接実行します。共通guardがなければ停止し、自動で依存物を導入しません。

```sh
python3 ~/.codex/storage-maintenance/guard.py check --path "$PWD" --needed-gib 2
node scripts/prepare-distribution.mjs --config staging-private/allowlist.json
```

`prepare-distribution.mjs` も容量を確認し、共通 `guard.py scratch` が所有する新規directoryへstageを作ります。既存のstage CLIとbuild CLIを順に使い、buildの `--output` を指定しません。build内の最終監査が成功した配布物だけを固定先へ採用し、成功・失敗後にstageを回収します。通常のstage CLIは既存先の上書きを引き続き拒否します。原本libraryは変更しません。

既定の音声stageでは、`books` に保持する既存本と追加本の **全選択** を含めます。音声stageは `existing` によるcatalog統合を実装していないため、そのフィールドがあれば準備入口と音声stage CLIで明確に拒否します。追加本だけで既存配布物を置き換えないよう、配布前にbook/revision一覧も照合します。

テキストstage CLIを含む版では、テキスト本の追加に `--kind text` を付けます。この容量対策commitには別作業の `stage-text-library.ts` を含めず、対応版の導入までは利用できません。`existing` が既存catalogを含む配布物、`books` が追加対象となるのは、このテキストstageの契約です。既存clientでビルドを省く小規模検証には `--client /absolute/path/to/client` を指定できます。

`--needed-gib` はstage・変換作業中音声・候補配布物・client buildを含む追加容量の見積もりです。省略時は2 GiB、必要量が大きければ増やします。guardの場所を変える場合だけ `RIPOLA_STORAGE_GUARD` へ指定します。検証の標準出力や必要な小さい記録はscratchの外へ保存してください。scratchは調査結果の永続保存先ではありません。

## 置換・中断・同時実行

`build-distribution.mjs` が従来から持つmanaged出力の置換を、`distribution-transaction.mjs` に分けました。候補と直前の配布物は出力先の親にある出力専用lock内へ置き、同じfilesystem内でrenameします。最終監査前には採用先を変更しません。正常終了時に候補・退避コピー・lockを回収するため、反復実行で過去版を積み増しません。コピーは独立したファイルで、mutableなhardlinkやsymlinkを作りません。

同じ出力の書き込みは排他です。所有プロセスが生きていれば後続を拒否します。直接のpostprocessが強制終了した場合、同じhostで所有PIDの終了を確認できた次回実行が復旧します。旧出力の退避直後なら旧出力を戻し、新出力の採用直後なら記録したinodeとdeviceの一致を確認して新出力を保持します。managed確認した旧出力のdevice/inodeをjournalへ記録し、退避したpreviousの実体も採用後の削除前に照合します。別処理が差し替えた未知のtreeや、所有権・出力の一致を確認できないtreeは残して停止します。ownerはschema・canonical output・UUID token・型を検査し、不完全な旧形式やsymlinkの記録は保持します。年齢でlockを奪いません。

CLIでViteを実行する間もprofileごとに排他にします。直子の失敗・シグナル終了を受けてCLI自身が終了処理できる場合も、孫の不在を証明できないためcompile lockを保持します。Viteの子プロセスが残る可能性があるため、このlockを強制終了後に自動で奪うことはしません。`dist/.rsvp-distribution-.client-<profile>.lock` の所有情報と子プロセスを確認してから、当該lockだけを扱ってください。owner作成途中や復旧処理自体を強制終了した場合も、証拠を残して停止します。共通guardも子プロセスが生きているscratchは保持します。SIGKILLや電源断後に、残ったデータを件数・古さだけで一括削除しません。電源断時の永続性を保証するfsync処理は今回の検証範囲外です。

## 小規模検証

```sh
node --experimental-vm-modules --test scripts/distribution-storage-memory.test.mjs
python3 ~/.codex/storage-maintenance/guard.py scratch -- node --test scripts/distribution-storage.test.mjs
python3 ~/.codex/storage-maintenance/guard.py scratch -- env TMPDIR={scratch} node --import tsx --test apps/web/tests/distribution.test.ts
```

メモリ版はディスクや子processを作らず、実コードへ仮想filesystemを渡して、未知previous・token不正の保持、compile失敗後の排他、正常置換・3段階のjournal復旧とA＋Bの入力契約を確認します。OSの実競合・シグナルを検証した結果とは区別します。

専用テストは、2回の置換で残存先が増えないこと、監査失敗時の保持、同時書き込みの拒否と再試行、原本と出力のinode分離、3つのrename段階のSIGKILL後の復旧を確認します。実音声・蔵書全体・モデルの複製は使いません。

## 運用repoへの反映範囲

`ripola-deploy/scripts/verify.mjs` は次回の直接実行から、QA library・QA設定・Wranglerログ・dry-run出力を共通guardのscratchへ置きます。GitHub Actions上ではユーザー別guardがないため、runner所有の `RUNNER_TEMP` を使い終了時に回収します。CIでも成功時に所有process groupとscratch参照processの不在を確認し、異常終了や確認不能ならpathを記録して保持します。通常のclientと既定配布出力は固定先に残します。

運用repoでは `python3 scripts/prepare-personal.py --config <統合allowlist>` も追加しました。pinの既存stageと既存置換APIを使って、scratch内のstageから固定 `.local/personal-worker` を直接更新します。OS lockと旧出力のinode記録はwrapper側にあるため、pin変更なしで次回から効きます。旧pinで強制終了した未確定候補の自動回収はできず、採用結果が不明なら両出力を保持して停止します。

本体の変更はこのcheckoutにだけ反映されています。他のworktreeや `ripola-deploy/vendor/ripola` の固定版へ自動コピーしません。運用repoの `upstream.json` をこの変更を含む版へ更新するまでは、vendor側のbuildには新しい排他・復旧処理がありません。今回pin更新・deploy・既存snapshot整理は行いません。容量対策だけを分離してcommitし、他作業の変更は含めません。
