# 通常本文から音声合成chunkを計画する

`core/chunk-planner.ts`は本文とpolicyだけからUTF-16の連続範囲を返す純粋ロジックです。ルビ・読み辞書・TTS・ASRは不要です。BudouXは表示フレーズ、音声plannerは合成要求を所有します。画面幅やRSVPのまとめ表示から合成境界を作りません。表示の分割や整列だけの変更で完成音声を再合成しません。

## 呼び出しと責務

```ts
const plan = planSpeechChunks({ blockId: 'paragraph-1', text }, policy);
// plan.chunks: start/end, exact source text, estimatedSeconds, boundary
// plan.version/settingsHash/hash: deterministic planning identity
```

本文をtrim・NFKC変換せず、各chunkの`text`を連結すると入力に完全一致します。境界は`Intl.Segmenter('ja', { granularity: 'grapheme' })`のUTF-16位置です。code point数、UTF-8 bytes、UTF-16 offsetは別々に保持します。同じblock IDと範囲から同じIDを作り、同じ本文・policy・planner版では同じplanを返します。Node/ICUの版は比較記録に残します。異なるUnicode境界実装まで同一結果を保証するものではありません。

ブロック間の意味を保つため、呼び出し側は見出し・段落・引用を別に計画します。静的code/tableの除外は生成coreの責務です。plannerは音声bytesや保存manifestへ触れません。既存ルビがある場合だけ`protectedRanges`で親文字を保護できます。保護範囲がhard limitより長ければ明示エラーにし、読みを途中で失わせません。

`automatic-chunk-planner.ts`はfoundationの`GenerationChunkPlanningInput/Result`へ接続します。普通の本文は直接計画します。既存のルビ・読み指定がある場合は`prepareSpeech`の確定発話本文を計画し、sourceSpansから元本文へ射影します。読み置換全体と編集注記の親文字を保護し、providerの上限は実際に送る発話本文へ適用します。

全文を読み変換する接続では20万文字の本文で既存の配列引数展開がスタック上限を超えました。共有`generation/speech-source.ts`はpushとmin/maxの引数展開だけをループ・集約へ置き換え、読み変換とsource mappingの仕様を維持します。28万文字で途中のルビ・長い末尾を持つ本文と、大きな読み置換を回帰検査します。sourceが読みより長くなる場合も保存coreの3000 UTF-16上限で再分割し、1個の保護範囲自体が上限を超えれば明示エラーにします。

この保存上限の再分割では、親の発話全体がprovider budgetに収まることを既に確認しています。元文字数を発話時間としてsoft targetへ当てはめず、source全体の推定値をtarget/preferredへ置いて保存範囲を均衡させます。4800文字が80個の短い読みに縮むfixtureは2区間となり、不要な細切れを避けます。この方針をprovider policyの`budget-v2`へ固定します。

通常の新規生成は`GenerationApp.prepare`で`chunking: { mode: 'auto' }`を明示し、serverの`planChunks`へ接続します。CLIも同じhookを使えます。mode省略・`sentence`は従来経路です。旧jobの`getJobPlan/resumeJob`は保存されたspan/key/planを読むため、新plannerを呼びません。

planner版・budget・provider版は`chunkPlan`と本のrevisionへ固定します。音声keyはfoundationの`speech-v1`を維持し、確定発話本文・声・合成条件・provider版が同じなら完成音声を再利用します。planner版だけが変わって同じ発話範囲になった場合にもcacheを失わせません。境界変更で送る発話本文が変われば別keyになります。表示版やDirect/Gatewayの経路だけでは音声keyを変えません。

## 構造の選択

| 案 | 本文への動作 | 判断 |
| --- | --- | --- |
| 固定文字数のgreedy | 短文をまとめやすいが引用・節の途中を切り、言語ごとの発話長を扱いにくい | 不採用 |
| 文ごと1要求（従来） | 自然な文末を使えるが短文が多数の要求になり、長い1文は拒否する | 互換経路として維持 |
| 自然境界とfallback上のDP | 要求数と不自然な中断、推奨長超過を同じ目的関数で比較できる | 採用 |

候補は文末、節の句読点、閉じ括弧、改行、英文の空白から作ります。括弧の内側には追加罰点を置き、閉じ括弧を前の文へ付けます。数値・日付・時刻・英文word・identifier・URL/emailは、単体でhard limitに収まる限り内部を保護します。長すぎるtokenは保護を外し、書記素fallbackへ戻します。語彙辞書や文法解析の完全性を主張しません。

長い無句読点にも候補を置くため、原則8書記素ごとにfallbackを追加します。hard budgetがそれより小さければ、その上限を超える直前にも候補を入れます。必要な保護範囲と字の最小単位が上限内なら、隣接候補を辿る経路が必ずあります。複数の表層保護が重なるときはunionが収まる場合だけ保護し、過大なunionによってfallbackを塞ぎません。

## 目的関数とhard/softの違い

範囲`i..j`の推定秒数を`d`、targetを`t`、minimumを`m`、preferred maximumを`p`とすると、辺のcostは次です。

```text
requestCost + boundaryPenalty(j)
  + 4 × max(0, (m - d) / m)²
  + 30 × max(0, (d - p) / p)²
  + 1.5 × ((d - t) / t)²
```

境界の基本罰点は文末/終端0、改行0.25、節2、括弧3、空白5、fallback18。括弧深度に3ずつ（最大4段）、開き括弧の直後や閉じ括弧の直前に24を足します。hardの文字数・bytes・token上界・推定秒数を超える辺は採用しません。softの推奨長を超える辺は採用可能で、より自然な終端や少ない要求と比較します。段落全体が短い場合にminimumを満たすため本文を複製することはありません。

最短pathを前から計算し、同costでは要求数が少ない経路、同件数では前の候補を選びます。乱数・時計・保存cacheの状態は境界を変えません。計算量は候補数×hard budget内の候補数、メモリは書記素数+候補数です。全文の全範囲を列挙する二乗DPを避けます。

時間推定は書記素ごとの加算です。日本語等170ms、Latin80ms、数字250ms、文末350ms、節180ms、空白20ms、改行350ms、括弧0ms、その他の記号100msを仮定します。漢字の読み、数値の読み、話速、休止には誤差があります。これはplanner用の表層推定で、音声cacheの実durationやalignmentの時刻を置き換えません。実providerのduration予測や送信前検査が別に必要です。

## provider仕様の扱い

2026-10-12に[speech.cppのIrodori仕様](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/docs/models/irodori-tts.md)を確認しました。1要求30秒、本文256 tokens。約18秒・100文字付近から品質が落ちたという上流の観察はsoftの推奨長を考える根拠であり、全providerに100文字の絶対上限を追加する根拠ではありません。表層durationの推定が30秒以下でもモデルの予測durationが30秒を超える可能性は残ります。

tokenizerを取得せず保守的に256 tokensを守る場合、raw/NFKC展開後のUTF-8 bytesの大きい方を書記素ごとに加算し、ASCII空白のU+2581化、点から三点リーダへの変換、BOS 1個を含めたbyte fallback上界を使います。語彙token数の正確な推定ではありません。上流の[tokenizer](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/src/families/irodori-tts/tokenizer.cpp)と[正規化](https://github.com/nyosegawa/speech.cpp/blob/60a8e1ec068280e5e803ee5d7079e90886c323cb/src/families/irodori-tts/text-normalizer.cpp)を参照しました。Unicodeや長い読みでは厳しめに分割される欠点を受け入れます。

Gemini/VOICEVOXへIrodoriの上限を流用しません。[Gemini現行TTS仕様](https://ai.google.dev/gemini-api/docs/speech-generation)とadapterが公開する上限に従います。plannerの運用budgetはproviderの公式最大値とは別に明記します。

現在の運用budgetはVOICEVOX/Geminiで推定45秒・3000文字以内です。保存coreの従来上限に合わせてUTF-16でも3000以内にします。VOICEVOXのsoftはtarget12秒/preferred18秒、Geminiは18秒/28秒です。Irodoriはproviderの30秒に20%の推定余裕を置き、設定したspeedを反映します。softは12秒/16秒、adapterのrecommendedMaxCharactersがあれば170ms/字で換算した推奨長も使います。これらは実測で校正済みの値ではなく、version付きの初期運用policyです。

speech.cpp本体はMIT、Irodori重みはMITとモデルカードの倫理条件、codecの基盤はApache-2.0です。参照音声の同意等は[GGUFモデルカード](https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF#license-and-ethical-restrictions)を確認します。本PRは重み・音声・tokenizer語彙を配布せず、通常起動・音声セットアップ・静的スマホ再生にモデル取得を追加しません。上流のM5等の測定値を、このPCの速度保証にしません。

## 検証と比較

自作fixtureとseed固定の混合本文で、全文coverage、順序、Unicode境界、hard budget、短文batch、長文fallback、過大な保護範囲の失敗、settings/IDの決定性を検査します。

```sh
node --import tsx --test apps/web/tests/speech-chunk-planner.test.ts
node --import tsx scripts/compare-speech-chunks.ts
```

比較scriptはplanner CPUのみを測ります。service/cache/実TTS/ASRを呼びません。従来と新方式をwarmup後に5回ずつAB/BA交互に実行し、中央値・範囲、実行環境、source coverage、結果hashを残します。合成時間欄は共通の表層発話推定に、1要求0.5秒・RTF=1という仮想条件を足した算術です。実測の合成時間・課金・品質・初音声待ち時間ではありません。従来の3000 UTF-16制限で拒否されるfixtureは拒否として報告し、速く終わった合成と数えません。従来が飛ばす空白だけのsentence範囲も記録します。

[比較記録](../validation/fixtures/speech-chunk-comparison.json)は自作8fixtureの結果です。並行検査中の高負荷環境で測ったCPU時間なので速度の順位や性能保証には使いません。`--cpu-prof`ではplanner本体・境界評価・GCがsampleに現れました。入出力・cache・providerは測定経路に含めません。実TTS/ASR、有料API、声の品質、人手の発話境界時刻、実機スマホは未確認です。
