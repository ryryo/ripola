---
name: ripola-generate-audio
description: Ripolaで原稿をVOICEVOXまたはGeminiの音声にし、試聴用生成・全体生成・停止と再開・保存音声の同期補正と圧縮を進める。保存音声の検査のみ、原稿整形のみ、配布のみの依頼には使わない。
---

# Ripolaで音声を生成・保存する

ローカルPCで生成し、本文・発話原稿・音声・時刻対応を既存の生成coreへ保存する。公開Worker/Pagesで合成しない。

## 進め方と参照先

1. 原稿、声、対象範囲、指定provider/経路、既存book/revision/jobを確認する。[共通の操作手順](references/audio-generation.md)を読む。未指定の方式を決める際は利用者の目的と既存設定を使い、有料送信の承認を設定の存在から推定しない。
2. 初回や準備不足なら[セットアップ](references/setup.md)、保存先や互換設定の問題なら[設定と優先順位](references/configuration.md)を読む。OS・CPU・実行環境を確認し、既存envと保存先を保つ。通常のVOICEVOXにGoogleキーやGatewayを求めない。
3. 指定経路に応じて次の資料だけを読む。

| 選択 | 手順 |
| --- | --- |
| VOICEVOX | [ローカルEngine接続と生成](references/voicevox.md) |
| Gemini / Google直結 | [Direct設定](references/gemini-direct.md) |
| Gemini / Cloudflare経由 | [Gateway設定](references/gemini-cloudflare.md) |
| 明示された実験用Irodori | [有効化と利用条件](references/irodori.md) |

4. 新しい声や未確認の読みでは短い代表範囲を試聴する。既に試聴済みの設定や、明示された全体生成を不要な再確認で止めない。送信本文・範囲・声・経路・再利用/新規件数・有料時の概算を具体化し、依頼で承認された範囲を実行する。
5. UIまたはrepo rootの既存CLIを使い、完了・失敗・未完了と再利用を確認する。CLI入力は[共有DTO](../../../apps/web/src/generation/contracts.ts)に従い、Markdown文字列だけを`plan`へ渡さない。私的な入力JSONと計画はGit対象外へ置く。
6. 同期時刻の追加・回復には[保存音声の整列](references/forced-alignment.md)を使う。補正・圧縮の失敗は保存済み音声から回復し、TTSを再送しない。

## 実行境界

- 同じ発話原稿・声・合成条件の完成音声は既存cacheから再利用する。表示、整列、圧縮、配布先の変更だけで合成し直さない。
- 別provider/model/送信経路へ自動fallbackしない。結果不明の有料requestを再起動だけで再送しない。秘密は表示・ログ・成果物へ含めない。
- このスキルの存在は課金設定変更・クレジット購入・デプロイの許可ではない。必要な操作の既存承認は引き継ぎ、未承認部分だけを具体化して確認する。

## 完了時に伝えること

book ID/revision/job、保存先、生成/再利用/未完了件数、補正・圧縮状態、試聴結果と未確認範囲を伝える。保存やbuildの成功を発音・同期精度の保証にしない。検査だけを続ける場合は[検査スキル](../ripola-check-audio/SKILL.md)へ渡す。
