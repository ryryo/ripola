# 既存本棚への取り込み

collect成功後、同じ入力hashの`ready-for-import`を確認する。`review-required`は検査根拠と対象を確認する工程。スクリプトはそのまま自動回収・適用しない。判断結果を残し、完了JSONだけを手で書き換えて通さない。

```sh
node --import tsx .codex/skills/ripola-remote-voicevox/scripts/import-library.mts --config local-inputs/JOB/job.json
node --import tsx scripts/audit-audio-presentation.ts --library local-inputs/JOB/import-work/candidate-library
```

`import-work/plan.json`へ計画を保存する。本ID/revision、完了チャンク数、表示の構造、MP3 hash/size、cacheと表示時計を検証する。候補へlive job/owner/lockを引き継がない。

同じspeechKeyは検証済み既存MP3/cacheを正本にする。波形または時計が異なれば外部alignmentを除き、**影響する本だけ**をTTS無効coreで再構成する。他の本は検証済みmanifestを保持する。候補を既存の構造監査CLIでも確認する。

差し替えた既存音声は計画の`canonicalQaRequired`から対象を取り、[保存音声QA](../../../../.agents/skills/ripola-check-audio/references/saved-audio.md)の既存inspect CLIで軽量検査し、hash・warning・判定不能と内容未検査を私的記録へ残す。ASRや生成を起動しない。

```sh
node --import tsx .codex/skills/ripola-remote-voicevox/scripts/import-library.mts --config local-inputs/JOB/job.json --apply
```

適用は既存ファイルを上書きせず、音声/cache/原稿/計画を先に、本manifestを最後に追加する。speechと本参照のlock、journal、原子的hard linkで中断時の所有権を残す。candidateと本棚は同じfilesystemに置く。別volumeなら`--work`で本棚と同じvolumeの私的作業場所を指定する（本棚内へは置かない）。

`result.json`で追加数・TTS 0件・完了を確認する。元からある本のmanifestもhashを照合する。再実行は完成済みの同じ本を保持して追加0件になる。失敗時は今回追加した本だけを非公開rollbackへ戻し、共有音声/cacheを残す。

```sh
node --import tsx .codex/skills/ripola-remote-voicevox/scripts/import-library.mts --config local-inputs/JOB/job.json --rollback
```

同じ作業場所を別ジョブへ使い回さない。計画後に既存canonical cacheが変われば止めて再検討する。生成やWorkerへのdeployを取り込みに混ぜない。
