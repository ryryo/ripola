# 設定とLinuxジョブ

手元からrepo rootで実行する。手元はPython 3.12以上、Nodeはrepoの指定版とtsxを使う。LinuxはPython 3.9以上、固定したrepoと依存、Engine、ffmpeg/ffprobe、systemd・flock・非対話sudoを準備する。スクリプトは機・Engine・モデルのインストーラーではない。

## ジョブ設定

以下を実値に置き換えて`local-inputs/JOB/job.json`へ保存する。相対ローカルpathはこのJSONのフォルダ基準。`sourceCommit`は`git rev-parse HEAD`の実値。両repoの関連coreファイルの未コミット変更も確認する。

```json
{
  "schemaVersion": 1,
  "jobId": "book-voicevox-20261021",
  "repo": "../..",
  "workDir": ".",
  "inputFile": "input.json",
  "inputDir": "inputs",
  "localLibrary": "/absolute/path/to/local-library",
  "sourceCommit": "FULL_COMMIT_HASH",
  "engineVersion": "0.25.2",
  "minFreeBytes": 1073741824,
  "remote": {
    "root": "/data/ripola-jobs/book-voicevox-20261021",
    "repo": "/data/ripola",
    "engineRun": "/data/voicevox/linux-cpu-x64/run",
    "node": "/usr/local/bin/node",
    "user": "linux-user",
    "threads": 4
  },
  "transport": {
    "mode": "ssh",
    "ssh": {"host": "existing-ssh-alias"},
    "api": {"execArgv": ["instabox", "exec", "MACHINE_NAME", "--"]}
  },
  "machine": {"statusArgv": ["instabox", "get", "MACHINE_NAME", "--json"]},
  "transfer": {"workers": 2, "apiRangeBytes": 262144},
  "monitoring": {"intervalMinutes": 10, "reportEveryRun": true}
}
```

`monitoring`はCodexが監視を作るときの希望。スクリプト自体はスケジューラーを作らない。定期確認が依頼されている場合、アプリのautomation toolでこのチャットのheartbeatを作る。毎回報告の指定がなければ、意味のある変化・失敗・要判断・完了時に通知する。プロバイダーのtimeoutや休止設定は現行資料で確認する。

`machine`は任意。Instabox例はread-onlyの状態照会で、休止中やoperation進行中ならexecを送らない。別プロバイダーなら`state`と任意の`operationId`を返すCLIを設定し、必要なら`runningStates`を指定する。通常のSSH機で管理APIがなければこの項目を省く。復帰・休止そのものは自動実行せず、プロバイダーの既存操作を使う。

入力manifestの例。`order`は正の整数で一意、`file`は`inputDir`内の相対path、hashは原稿のbytesから計算する。原稿はMarkdownとして読み込む。

```json
{
  "schemaVersion": 1,
  "voice": "3",
  "readings": [{"text": "対象語", "reading": "たいしょうご"}],
  "unresolvedOcrCount": 0,
  "parts": [{"order": 1, "title": "対象の章", "file": "01.md", "sha256": "FILE_SHA256"}]
}
```

## 操作

```sh
python3 .codex/skills/ripola-remote-voicevox/scripts/remote.py --config local-inputs/JOB/job.json probe
python3 .codex/skills/ripola-remote-voicevox/scripts/remote.py --config local-inputs/JOB/job.json stage
python3 .codex/skills/ripola-remote-voicevox/scripts/remote.py --config local-inputs/JOB/job.json install
python3 .codex/skills/ripola-remote-voicevox/scripts/remote.py --config local-inputs/JOB/job.json start
python3 .codex/skills/ripola-remote-voicevox/scripts/monitor.py --config local-inputs/JOB/job.json
```

stageは原稿hash・両repoのcommitを照合し、input/runtimeを固定する。既存と異なるファイルへ上書きしない。runtimeも変更するときは新しいjobとrootを使う。unitは`ripola-<jobId>.service`と`ripola-<jobId>-engine.service`。systemd用のpath/userは空白なしにする。同じjob IDで別rootを登録しない。installは登録だけで、startが起動する。

batchはflockで排他し、異常終了後30秒、30分で3回まで。Engineは10秒、10分で3回まで。保存operation IDとcacheから未完了だけ再開する。verifiedパートも保存音声を検証してからスキップする。生成→軽量QA→保存queryの時刻照合→WAV整理の結果は各パートへ保存する。現coreの音素照合が対応していないEngine版は推定時計と必要なWAVを保持し、その理由を記録する。

## 監視と再開

`monitor-state.json`に進捗、サービス、空き、ログ末尾、通知からの増分、停滞時間を保存する。生成の率と、存在する場合の`transfer`・`import`を分けて報告する。報告後は`remote.py ... notified`を実行する。更新時刻だけで進捗ありと判断しない。

休止している機はプロバイダーの状態とoperationを確認し、復帰・timeout延長の完了後に`remote.py ... resume`を使う。resumeは同じunitへ起動を要求する。完成記録があれば再起動を拒否する。起動制限を自動resetしない。原因修復後に対象unitだけ手動でresetする。

回収・取り込み後は`remote.py ... stop`で今回のunitを停止・無効化する。機の休止とheartbeat停止はプロバイダー/アプリtoolで実行し、結果を私的`closeout.json`へ保存する。共有機を推測で休止しない。

## スクリプトの検証

```sh
python3 .codex/skills/ripola-remote-voicevox/scripts/test_remote.py -v
node --import tsx .codex/skills/ripola-remote-voicevox/scripts/test_workflow.mts
```

前者はSSH/exec APIのローカル代替で転送・再開・破損拒否とsystemd操作の境界を確認する。後者は空きloopbackポートのEngine代替と自作PCMを使い、実coreで生成・圧縮復旧・取り込み・既存保持・取り消しを検証する。ffmpeg/ffprobeとrepo依存が必要。外部機・既存本棚・モデルを使わず、終了時に一時データを削除する。新しいLinux機でのsystemd導入や実VOICEVOXの聴感をこの試験だけで検証済みにしない。
