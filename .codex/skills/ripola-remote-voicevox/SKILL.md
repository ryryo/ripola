---
name: ripola-remote-voicevox
description: Ripolaの下処理済み原稿を外部LinuxのVOICEVOXで生成し、独立ジョブの監視・中断再開・SSH/APIでの回収・既存ローカル本棚への取り込みを行う。原稿整形、保存音声の検査だけ、Workerへの配布は別の作業。
---

# 外部LinuxへVOICEVOX処理を任せる

下処理済み原稿を外部Linuxへ渡し、生成・同期補正・MP3圧縮・軽量QA・不要WAV整理を接続から独立して実行する。検証後に手元の本棚へ追加する。生成の仕様は既存の[音声生成スキル](../../../.agents/skills/ripola-generate-audio/SKILL.md)と同じRipola coreを使う。

## 実行

1. 原稿、読み辞書、声の数値style ID、Engine/coreの版、利用するLinux機と本棚を特定する。完了済みの別の本を対象にしない。本名・件数・ホスト・ユーザー名をスキルに固定しない。
2. [Linuxジョブ](references/linux-job.md)に従い、非公開の作業フォルダへ設定と入力manifestを作る。原稿は下処理済み表記を保持してhashで固定する。Linuxへ固定repo、依存、Engine、ffmpeg/ffprobe、Python、systemd、flockを準備する。セットアップは既存生成スキル、Instaboxでは利用可能なInstaboxスキルと現行公式資料を使う。
3. [接続と転送](references/transport.md)からSSHまたは認証済みCLI/APIを選ぶ。`remote.py stage`で入力と最小ランタイムを転送し、`install`で今回専用のsystemdサービスを登録、`start`で開始する。repoや認証ストアを丸ごと転送しない。
4. `monitor.py`で保存job/cache、工程、完了数、空き容量、サービス、ログを確認する。Codex heartbeatは確認・通知用で、外部処理の存続に使わない。通知頻度と毎回報告するかは利用者の指定を保存する。生成・回収・取り込みの進捗を分け、報告後に`remote.py notified`で前回値を保存する。
5. 切断後は同じ設定で状態を読む。機の休止はプロバイダーの状態・operationを確認して復帰し、その後`resume`する。稼働中も同じsystemd unitを使う。起動制限を無条件にresetしない。15分以上の停滞は工程を含めて調べ、容量不足・同じ失敗の反復では停止して理由を報告する。
6. `ready-for-import`になったら`collect.py`で回収し、[本棚取り込み](references/library-import.md)の計画・監査・適用へ進む。`review-required`、fatal、hash不一致、判定不能を合格扱いしない。軽量QAと内容・聴感の未検査を区別する。
7. 取り込み検証後に今回のサービスを`stop`で停止・無効化する。今回専用の機なら依頼された終了方針で休止する。作成した監視も停止し、設定と検証記録を残す。

Python操作スクリプトと取り込みは手元、`runner.mts`と生成coreはLinuxで動く。引数・設定例は各referenceにある。`scripts/test_remote.py`と`scripts/test_workflow.mts`は外部機・既存本棚を使わない検証用。

## 保持する条件

- 完成音声は保存job/cacheから再利用する。同期・圧縮・回収の都合でTTSを再送しない。入力・声・Engine/coreの版が変わるときは新しいjob IDと保存先を使う。
- Engineはloopbackだけで待ち受ける。このcoreのVOICEVOX音素照合先は`127.0.0.1:50021`。同じポートの別サービスを停止して置き換えない。
- ASR/CTCモデルや有料APIを自動追加しない。保存queryで検証できない範囲は表示用推定時計として記録する。軽量検査成功を読み・同期精度の保証にしない。
- 取り込み中はTTSを無効にし、既存本・音声を上書きしない。異なる既存波形を使う本だけ、候補libraryのcoreで時計を再構成する。
- 公開ポートやWorkerへの配布は含めない。プロバイダーの作成・課金・休止操作はその依頼で指定された範囲を引き継ぐ。

## 完了報告

本・チャンク数、生成/再利用/未完了、回収と取り込み、音素時計と推定時計、QAと未確認範囲、WAV整理量と保持理由、既存本の保持、機と監視の終了状態を短く伝える。ID・hash・詳細は非公開の記録へリンクする。
