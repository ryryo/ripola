# SSHとAPI

どちらも同じ入力hash・export manifestを使う。転送速度の問題を前提にせず、接続可能な方式を選ぶ。

|方式|設定|
|---|---|
|SSH|`ssh.host`に既存alias。`configFile`と`port`も指定可能。ホスト鍵検証を有効にし、既存認証を使う。binary stdoutで回収する。|
|CLI/API|`api.execArgv`に認証済みexec CLIのargv prefix。末尾にPOSIX shell commandを1引数として渡し、stdoutをそのまま受け取る契約。JSON envelopeやHTTP認証が必要なら、その契約を満たすローカルCLIを用意する。|

Instaboxの例は`["instabox", "exec", "MACHINE_NAME", "--"]`。既存CLI認証を使い、秘密をJSONへ埋めない。別のサービスへprefixをそのまま流用せず、まずprobeの小さなJSON応答で確認する。

```sh
python3 .codex/skills/ripola-remote-voicevox/scripts/monitor.py --config local-inputs/JOB/job.json --transport api
python3 .codex/skills/ripola-remote-voicevox/scripts/collect.py --config local-inputs/JOB/job.json --transport ssh
python3 .codex/skills/ripola-remote-voicevox/scripts/collect.py --config local-inputs/JOB/job.json --transport api
```

スクリプトの回収は8MiB単位でhashを検証し、途中の`.part`も両方式で共用する。APIの範囲は既定256KiB・設定上限512KiB。base64とJSONで増えるため、サービスの出力上限が小さければ`apiRangeBytes`を下げる。SSHは`sshRangeBytes`で調整できる。アップロードはPOSIX argv制限を避ける48KiB単位で、速度障害を前提にした値ではない。

`workers`は既定2・上限8、`attempts`は既定3・上限5。回収の接続失敗・不足応答だけを上限付きで再試行する。生成・機の作成を再送する仕組みではない。hash不一致は停止し、破損を無条件に捨てて進めない。

`transfer-progress.json`はhash照合済みbytes基準。全体hash検証後に新規private領域へ展開し、絶対path・親参照・link・特殊fileを拒否する。`incoming/`とreceiptを上書きしない。途中の展開は検証済みarchiveから復元できる。

プロバイダーのファイル取得APIやSFTP/rsyncを使う場合も、同じmanifestのサイズ・全体hashを照合してから安全に展開する。公開HTTPサーバーや公開ポートを回収のために作らない。認証設定は手元へ保持し、本文入りargvをログへ出さない。
