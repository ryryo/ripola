# ローカルalignment worker

`pythonAlignmentAdapter(config)`は最初の整列要求で`align_audio.py --worker`を起動します。同じadapterの連続・同時要求は一つのPythonと固定Reazon modelを共有します。既存のGenerationService/AlignmentService呼出し、`alignerVersion`、保存result、source projectionは維持します。通常アプリのprocess内service共有は既存の`service.server.ts`が担い、別CLIプロセスまでmodelを共有するdaemonは作りません。

## 呼出しと寿命

```ts
const adapter = pythonAlignmentAdapter(config);
try {
  const first = await adapter.align(request, signal);
  const second = await adapter.align(nextRequest, nextSignal);
  // first/secondは従来のAlignmentRuntimeResult。
} finally {
  await adapter.close?.();
}
```

単発Python CLIは従来どおりstdinのJSONをEOFまで読み、stdoutにbare result JSONと改行を一つ出します。`--worker`だけが新しいframingを使います。modelの標準CPU/float32/eager inference、正解本文に沿うCTC経路、採用閾値、UTF-16位置、PCM活動区間の計算は変えません。

| 状態・事象 | 動作 |
| --- | --- |
| 未起動 | 既存modelの全manifestファイルの存在・sizeと設定をNodeで確認してからspawn。Pythonは依存、audio tool、固定hash/architectureを確認しmodelを一回loadしてreadyを返す |
| ready | FIFOで一要求だけ送信。model/tokenizer/feature extractorを保持 |
| 待機 | 実行中を含む最大8要求。入力frame 2 MiB、応答frame 4 MiB、診断出力1 MiB/起動または要求。超過は明示失敗 |
| 待機中の取消し・timeout | その要求をqueueから除き、未送信のまま失敗。実行中の要求は続く |
| 実行中/起動中の取消し・timeout | workerと同じprocess groupのffmpeg等へSIGTERM、1秒後に必要ならSIGKILL。childのcloseまで待って取消し/失敗を返す。すでに待機中の要求も失敗にし、再送しない |
| crash/異常frame/ID不一致/不正result | 結果を採用せずprocess treeを終了。次の新規要求で起動できる。失敗した要求・queueを自動再試行しない |
| Pythonの既知request error | 明示errorを返し、同じmodelで次の要求を処理できる。本文の推測や成功fallbackに変換しない |
| close | queueを失敗にし、process treeの終了を待つ。以後の要求を拒否。繰り返しclose可能 |
| 親の通常終了/SIGINT/SIGTERM | process内共有registryでprocess groupを終了。idle child/pipesをunrefし、補助Node CLIの自然終了を妨げない |

5分のtimeoutはqueue待ち・起動・load・整列を含みます。要求を送ってから結果を受け取るまでの失敗では結果不明の可能性があるため、成功やcacheへ変換しません。実行中の取消しは同じworkerを待つ別jobにも影響します。新規要求は終了完了後に起動できます。OSからの親SIGKILLやOS crashではNodeのcleanupを実行できません。

## protocolと資材

stdoutはUTF-8 JSON Linesのみです。全frameは`protocolVersion: 1`を持ちます。

- ready: `type: "ready"`, `alignerVersion`, `method: "forced-alignment"`, `confidenceMeaning: "transcript-conditioned-ctc"`。
- 要求: `type: "align"`, 一意の`id`, 従来の`request`。
- 成功応答: `type: "result"`, 同じ`id`, `method`, `confidenceMeaning`, 従来の`result`。
- 失敗応答: `type: "error"`, 同じ`id`, `code: "request-failed" | "resources-changed"`。

frame分割・複数byte文字を復元し、余分な応答、未知type/protocol、途中EOF、過大frameを拒否します。本文/version/segmentを既存validatorでも確認し、音声長との照合と元WAV hashの再確認は既存AlignmentServiceが行います。Python/libraryのstdoutはfd段階でstderrへ分離し、framing用fdだけを保持します。Nodeはstderrを制限付きで消費し、生の本文・path・例外・環境を返しません。実行環境もallowlistのみを継承します。

Nodeのreadiness cacheはPython/script/model/manifest/依存lockのidentity（realpath、device/inode、size、mtime/ctime、manifest内容）と30秒のTTLに紐付きます。同じ資材のlive workerがreadyなら、確認済みの状態を使い追加のPython probeを起動しません。資材変更、worker終了、closeで無効化します。起動前に資材を再確認し、idle workerのidentityが違えば終了してから新workerを起動します。Pythonも各要求前に資材statを確認し、load時の変更やload後の変更を拒否します。modelは固定hashを確認してから`local_files_only=True`とoffline指定でloadします。起動時の取得やsetup呼出しはありません。

完成resultのdisk cacheは既存のaudio hash・正確なspokenText・alignerVersion・normalizeVersion・acoustic versionを維持します。model/algorithmの意味が変わる時はalignerVersionを更新します。同じ固定資材のworker再起動はresultの意味を変えないため、成功cacheを無効化しません。readinessやプロセス状態を、完成した音声・結果のversionと取り違えません。WAV/MP3/旧AAC、chunk ID、source span、辞書・ルビ、VOICEVOX/Gemini、Cloudflare静的再生には変更を加えません。

## 音声QAとの境界

`AlignmentRuntimeSegment.confidence`は渡した正解本文に条件付けたCTC経路上の適合です。独立ASRの正解率、CER、時刻精度の確率ではありません。workerのmethod/meaningはこの違いを明示し、ASR応答をalignmentとして受け付けません。

QA側が同じ固定modelを使う場合、`scripts/alignment_runtime.py`の`ReazonRuntime.ensure_loaded(aligner_version)`と`infer(samples)`を使えます。`infer`は16 kHz PCMからaudio-only log probabilitiesを返し、正解本文を受け取りません。QA側で`tokenizer.decode(emission.argmax(axis=-1), skip_special_tokens=True)`等の独立greedy decodeを評価できます。greedy decodeのAPI、CER・読み許容正規化、評価閾値、QA保存/画面は別担当の責務です。このPRはQA全機能を追加しません。

## 検証と性能の扱い

```sh
node --import tsx --test apps/web/tests/alignment-worker.test.ts apps/web/tests/alignment-adapter.test.ts
python -m unittest discover -s scripts -p 'test_align*.py'
```

mockでspawn/load回数、queue、取消し、timeout、crash、異常frame、process treeと親終了、次の新規要求での復旧を検証します。Pythonのfake loaderでもmodel/tokenizer/extractorが一回だけloadされることと単発CLI形式を確認します。mockの経過時間を実model性能として扱いません。

この担当環境では固定Reazon modelとalignment runtimeを確認できず、実連続alignmentの起動/反復時間は未実測です。新model、Irodori、重いASR/TTSを取得・実行していません。実測する際は共有benchmark lockを取得し、同じ自作WAV・固定資材・CPU設定で変更前/後を交互に各5回以上測り、成功件数・load件数・出力・中央値/範囲・負荷条件を残します。

設計の参考は[speech.cpp](https://github.com/nyosegawa/speech.cpp)のmodel保持です。[Irodoriの仕様](https://github.com/nyosegawa/speech.cpp/blob/main/docs/models/irodori-tts.md)にあるモデルは別のoptional TTSで、このworkerへ追加しません。記事の測定値はこのPCの保証にしません。使用中の[Reazon固定model](https://huggingface.co/reazon-research/japanese-wav2vec2-base-rs35kh)はApache-2.0です。自作mock/fixtureを使用し、第三者音声や個人libraryをPRへ含めません。
