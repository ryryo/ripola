---
name: ripola-publish-personal
description: Ripolaで各利用者自身の個人用Cloudflare Workerへ、ローカル生成済みの本・音声を追加・更新する。allowlist、stage、build、監査、配布を扱い、公開デモへの掲載や新規音声生成は対象外。
---

# Ripolaの本を利用者自身のWorkerへ配布する

「個人用」は各利用者の蔵書・アカウントを指す。作者のWorker、認証情報、allowlist、絶対pathを共有手順の既定にしない。

## 進め方

1. [個人用配布手順](references/personal-worker.md)を読む。保存元library、対象book/revision、既存allowlistと配布catalog、配布先のWorker設定を確認する。
2. 本の追加は既存の選択を保持してallowlistへ統合する。削除・旧版置換を依頼されていなければ、追加分だけで既存catalogを置き換えない。既存蔵書や設定が不明なままデプロイしない。
3. `audience: personal`、`target: worker`、対象の帰属と閲覧範囲を確認する。個人原稿・allowlist・stageはGit外または既存のGit対象外領域へ置き、公開デモと混ぜない。
4. 新規stage directoryを使い、既存CLIでstage、個人用build、配布物監査を行う。必要時だけ[構造監査の手順](../ripola-check-audio/references/presentation-audit.md)を読む。失敗をTTS再生成で回避しない。
5. 利用者の既存Worker設定を保持し、配布先アカウント・Worker名・asset出力・選択した全蔵書を照合する。必要ならdry-runし、設定・配布物・閲覧範囲をレビュー可能にする。
6. 配布が承認された依頼なら既存承認に従ってdeployする。準備のみの依頼ならここで成果物を示す。閲覧制限を依頼された場合は本文JSON/manifest/音声を含む全入口を対象にする。
7. 配布後は通常HTTPS URL、蔵書一覧、直リンク/reload、音声のHEAD/Range、seek・倍速・停止/再開を確認する。実機未確認の項目は区別する。

個人用という名称やaudienceはHTTP認証ではない。既存のAccessやcache設定を保ち、作者の公開デモ用設定を流用しない。選択した本文の`rawText`も配布される。未配布のlocalhost本はQRだけでは移らない。

## 完了時に伝えること

追加/保持/置換したbook/revision、allowlist・stage・buildの場所、監査結果、deployの実施有無、実施時のURLと確認結果を伝える。ローカル正本を保持し、秘密・生成cache・job・runtimeを配布しない。
