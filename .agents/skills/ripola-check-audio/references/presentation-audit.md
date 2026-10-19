# 保存音声と配布物の構造を監査する

元原稿の区切りが欠落・重複・逆転せず、音声の有限な時刻内に表示されるかを検査します。発音内容の正しさや同期時刻の人手精度を認定する検査ではありません。

## 対象を選ぶ

repo rootから、目的に合う既存コマンドを実行します。pathは利用者の値へ置き換えます。

```sh
# ローカルの保存原稿と表示計画
pnpm audit:audio --library /absolute/path/to/private-library

# stage/build後の、実際に配布するdirectory
pnpm audit:audio --distribution /absolute/path/to/upload-directory
```

個人用の標準build出力を監査する場合は`--distribution dist/personal-worker`です。`--library`と`--distribution`は別々の実行で使います。

library監査は保存された本ごとに元位置と表示計画を確認します。旧形式の検査記録がなくても、データを上書きせずメモリー上で再計算します。空のlibrary・検査不能・破損は非0終了です。

配布物監査はさらにcatalogのmanifest hash/size/identity/duration、音声のhash/size、参照先、未選択assetの混入と保存検査記録の整合性を確認します。明示的に音声なしの静的配布物は有効ですが、必要な本が含まれるかは別途catalogと照合します。

## 結果と回復

- 成功は全元区切りの構造・表示計画が検査を通ったことを示します。声、読み、端末上の音、実機seekや聴感は別に確認します。
- 欠落・重複・順序・interval等のエラーは対象book/chunkと元範囲を調べます。検査不能を「本がない」や合格として扱いません。
- 音声の無音・音割れ・長さには[保存音声QA](saved-audio.md)、保存音声の時刻追加には[整列手順](../../ripola-generate-audio/references/forced-alignment.md)を使います。検査だけの依頼から修正を実行しません。
- 配布物が失敗した場合はstage入力・元音声・manifest・圧縮の検証を調べ、TTSを再生成せず原因を切り分けます。

出力には私的な書名・元位置・path等が含まれ得ます。公開IssueやGitへ生の結果を貼らず、再現用には公開可能な短文を使います。仕組みと開発時の回帰検査は[表示品質の開発契約](../../../../docs/development/audio-presentation-quality.md)にあります。
