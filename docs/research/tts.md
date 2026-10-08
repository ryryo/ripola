# 日本語TTSをRSVPへ組み合わせる調査

確認日：**2026-10-06 UTC**。公式仕様・料金とOSS実コードの調査記録です。この調査自体では音声生成・課金・アカウント作成を行っていません。後続の実装・無料Engine試験は検証記録へ分けます。日本語の自然さ・読み誤り・同期精度・生成速度は実測しておらず、品質ランキングではありません。料金はUSD、税・保存・転送・再試行・追加alignment処理を除きます。

**採用方針（2026-10-06）：有料TTSはGemini 3.8 Flash-Lite TTSとGemini 3.8 Flash TTSの2種類だけ、Flash-Liteを既定とします。無料ローカルの初期標準はVOICEVOXデスクトップアプリ同梱のEngineで、Dockerは不要です。** 他社と旧モデルの記録は比較履歴で、採用候補・実装順には含めません。品質順位を実測した結論ではなく、プロジェクトの採用方針です。

Geminiのnativeな文字／単語timestampは確認できていません。既知の発話原稿と生成音声をalignmentへ渡し、精度が不足する範囲は文単位へ落とす設計を中心にします。現在の黙読RSVPとは別の「音声に合わせて読む」モードとし、音声の再生位置を表示の時計にします。生成済み音声・原稿・対応表をGit外のローカルフォルダーへ永続保存する[生成・配布戦略](../README.md)も参照してください。

## 採用する有料モデル

| モデル | 役割と公式model ID | 同期・上限 |
| --- | --- | --- |
| [Gemini 3.8 Flash-Lite TTS](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts) | **既定**。`gemini-3.8-flash-lite-tts` | 日本語対応。native timestampは未確認。Gemini API入力8,192／出力16,384 token |
| [Gemini 3.8 Flash TTS](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts) | 明示的に選ぶ選択肢。`gemini-3.8-flash-tts` | 同じschemaで切替可能。上限と同期の扱いはLite同様 |

Gemini API 3.8は本文を逐語原稿として扱うため、持続する読み方の指定を本文へ混ぜず`speech_metadata`へ分けます。通常返却のWAVに再びWAV headerを付けません。API endpoint・model ID・出力形式を固定し、旧2.5／3.1用の実装を流用しません。公式schema上の逐語扱いも、脱落・読み誤りがないという実測保証ではありません。

## モデル選択とAPI経路を分ける

**採用は2モデルに限定します。現ローカルcoreはDeveloper APIのDirectを基準に実装し、有料生成は未実測です。Enterpriseは別adapterの候補で、契約・認証を混同しません。** 料金ページの掲載だけでCloud Text-to-Speech APIの対応を判断しません。3.8の`Preview`はCloud側の提供段階で、model IDへ`-preview`を加える意味ではありません。

| Googleのサービス | 採用3.8の対応 | 認証・経路と判断 |
| --- | --- | --- |
| Cloud Text-to-Speech API | **非対応**。料金表には3.8が載るが、このAPIでは呼べない | 旧2.5等のCloud Speech endpointを採用3.8へ流用しない。[Cloud側の対応説明](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts) |
| Gemini Enterprise Agent Platform | 2モデルともPreviewとして対応 | Cloud project、billing、API有効化、IAM権限とOAuth／ADC。Cloud契約を使う場合の候補。[生成仕様](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/overview)、[認証・開始手順](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start) |
| Gemini Developer API | 2モデルとも対応 | API keyとInteractions API。**現ローカル実装の基準はDirect**だが、利用目的・年齢・地域・料金枠・データ条件への適合が前提で、有料実測は未実施。[3.8生成仕様](https://ai.google.dev/gemini-api/docs/speech-generation) |

Enterprise RESTは`https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models/MODEL_ID:generateContent`、streamは`:streamGenerateContent`です。現仕様は`global`のみで、日本所在への限定を意味しません。REST bodyの`speechMetadata`とSDKのsnake_caseを混同しません。Developerの現RESTは`https://generativelanguage.googleapis.com/v1beta/interactions`へ`x-goog-api-key`を渡します。旧`generateContent`ガイドを3.8のInteractions実装へ混ぜず、採用経路ごとにadapterを固定します。秘密はPC側に置き、QR・蔵書manifest・`VITE_*`へ入れません。

[Developer API規約](https://ai.google.dev/gemini-api/terms)はprofessional／business用途の開発者向けとし、consumer用途を対象にしない条件、年齢・地域条件を含みます。有料／無料の区別はAPI keyがあるかではなくbilling等の条件で決まり、有料入力・出力は製品改善に使わない一方、安全目的の限定ログ等の条件があります。無料枠へ有料枠のデータ条件を移しません。Cloud Text-to-Speechの[ログ方針](https://docs.cloud.google.com/text-to-speech/docs/data-logging)も、別サービスの3.8へ適用しません。Enterpriseを選ぶ場合は当該Cloud契約とPreview条件を確認します。

この公式調査ではAPIの実行確認をしていません。利用可能quota、Previewの利用可否、実際の音声品質・請求・credit適用・データ保持は未確認です。経路の選定で、確定したLite既定／Flash選択肢を別モデルへ置き換えません。API直接／Cloudflare AI Gatewayは別の接続方式とし、まずDirectを検証します。GatewayのGoogle provider対応だけで指定3.8 Interactions音声の成功を保証せず、Enterprise globalとGatewayの制約は[接続調査](#directとai-gatewayの対応)、実装側の設定は[音声生成ガイド](../guides/audio-generation.md)へ分けます。

## 採用する無料ローカルと比較記録

| 候補 | 日本語・同期材料 | 長文・費用・条件 |
| --- | --- | --- |
| **採用：[VOICEVOX Engine](https://github.com/VOICEVOX/voicevox_engine)** | 日本語。`audio_query`のaccent phrase／mora／音素長を使えるが、本文文字のtimestampではない | デスクトップアプリ同梱EngineをMacのローカルサーバーから利用、操作はブラウザUI。補助CLIも共通処理。Docker不要、Google key不要、API利用料0。EngineはLGPLv3または別契約、CoreはMIT、音声モデル・キャラクターの規約は別 |
| 比較記録：[Web Speech API](https://webaudio.github.io/web-speech-api/) | OS／ブラウザに日本語voiceがあれば使える。`boundary.charIndex`は実装差があり、精密同期の保証にできない | 手軽な試用向き。音声ファイル書き出しと任意時刻seekの標準APIなし。voiceがリモートの場合もある。初期の保存用engineではない |
| 比較記録：[Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) | 標準APIだけで文字alignmentを得る前提にしない | 初期標準には含めない。コードAGPLv3、一部LGPLv3、JVNVモデルCC BY-SA 4.0など条件を分ける。API既定の100文字制限は設定可能だが、長文品質の保証ではない |

初期運用はVOICEVOXデスクトップアプリを起動し、[同じMacの開発サーバーをブラウザで操作](../development/local-generation.md)します。サーバーが`http://127.0.0.1:50021`へ接続し、補助CLIも同じサービスを使います。[公式Engine README](https://github.com/VOICEVOX/voicevox_engine/blob/master/README.md#api-ドキュメント)はEngineまたはeditorの起動中に`http://127.0.0.1:50021/docs`でAPI仕様を確認できると説明しています。公式仕様の根拠であり、アプリ自身の実行試験の結果ではありません。

デスクトップアプリは現在の初期標準で、唯一の起動方式として固定しません。GUIを使わない**native Engine単体**も[公式のダウンロード案内](https://github.com/VOICEVOX/voicevox_engine/blob/master/README.md#ダウンロード)から選べる方式として残します。実装はHTTP APIを境界とし、起動方式を音声artifactへ固定しません。

原稿・音声・対応表の保存が終わればアプリを閉じてよく、スマホで配布済み音声を再生する時にEngineは不要です。remote Workerの`127.0.0.1`はMacを指しません。Macのローカルサーバーで生成し、R2なしのStatic Assetsへ事前生成物を配布する構成を維持します。PCの計算資源と選んだvoiceのクレジット等の条件は必要です。

VOICEVOXの[音声利用規約](https://voicevox.hiroshiba.jp/term/)・[QA](https://voicevox.hiroshiba.jp/qa/)、[Core LICENSE](https://github.com/VOICEVOX/voicevox_core/blob/main/LICENSE)、Style-Bert-VITS2の[モデル利用条件](https://github.com/litagin02/Style-Bert-VITS2/blob/master/docs/TERMS_OF_USE.md)を個別に確認します。これらを本repoの製品ライセンスへ流用しません。

Web Speechでは[getVoices](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices)と`voiceschanged`を扱い、声一覧が初めは空でも待ちます。ローカル処理を選ぶ場合は`localService`を確認します。[boundaryイベント](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/boundary_event)が使えない環境では文単位へ落とし、`charIndex`の0や近似値を検出します。[textの上限32,767文字](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/text)は、その長さを安定して一括再生できる保証ではありません。

## 比較履歴：採用外のAPI・旧仕様

この節のElevenLabs・Chirp・OpenAI・Cartesiaは採用対象外です。Geminiの採用仕様は上の2モデルとAPI経路の節を参照し、旧2.5の記録とは区別します。

| 候補・確認対象 | 日本語／表示同期 | 1リクエストと長文処理 |
| --- | --- | --- |
| [Eleven v4／v4 Turbo](https://elevenlabs.io/docs/overview/models) | v4は90以上の言語に日本語を含む。文字alignmentを返すAPIがある。原文とnormalized alignmentを区別 | v4のモデル上限10,000文字。[Dialogue timestamps API](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps)は信頼性のため2,000文字以下を推奨。モデル上限とAPI推奨を混同しない |
| [Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd) | 日本語・無料枠を使った比較候補。単語timestampやSSML mark対応を一般のGoogle TTSから類推しない | 通常の[入力上限5,000 byte](https://docs.cloud.google.com/text-to-speech/quotas)。日本語約1,666文字という換算は概算で、UTF-8実byteを測る。双方向streamもある |
| [OpenAI gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) | 日本語音声出力の候補。会話向けなので逐語朗読・省略なしを検証。transcriptの到着時刻を発話時刻とみなさない | context 128k、最大出力32k tokenでも本全体の一括朗読保証ではない。文・短段落で処理し、不要な会話履歴の再入力を避ける |
| [Cartesia Sonic 3.6](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest) | 日本語を含む44言語。SSEに単語・音素timestampの選択肢。日本語での単位・正規化の確認が必要 | 固定snapshot `sonic-3.6-2026-08-27`を比較候補にする。[SSE仕様](https://docs.cartesia.ai/api-reference/tts/sse)から無制限長文を仮定しない。SSEにはcontinuationなし |

[Eleven TTS timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)では返却された文字配列と本文の対応を検査します。v4で使う実際のendpoint・voice・短い日本語入力での返り値確認が必要です。旧モデルはv3 5,000、Multilingual v2 10,000、Flash v2.5 40,000文字であり、v4へ流用しません。

[Google Cloud Gemini TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts)の2.5系は本文・promptそれぞれ4,000 byte、合計8,000 byte、音声は約655秒で切れる可能性があります。Gemini APIのtoken上限とCloud APIのbyte上限は別仕様です。[speech generation](https://ai.google.dev/gemini-api/docs/speech-generation)も参照し、採用endpointを固定します。

OpenAIの`tts-1`・`tts-1-hd`・`gpt-4o-mini-tts`系は[2026-10-01に非推奨化、2027-01-06に停止予定](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models)です。公式移行先はRealtime 2.1 mini。旧mini-TTSの入力2,000 tokenや[Speech endpoint](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)の4,096文字制限・旧価格を新規採用の基準にしません。

## 10万・20万文字の音声の長さ

比較用の表示文字数を`N`、APIへ実際に送って課金される文字数を`C`、実際の入力token数を`T`とします。比較用`N`は句読点を含む本文の文字数です。現アプリのCPM字数は空白・句読点を除く書記素数なので、そのまま同じ値にはなりません。ルビの読み、数字の展開、SSML、空白・改行で`C`は変わります。UTF-8 byte、JSのUTF-16 offset、code point、tokenも別の単位です。

音声は**休止込みの実効400文字/分**を仮定します。これは試算条件で、日本語モデルの実測値ではありません。

| 本文 | 400文字/分 | 300〜500文字/分の感度 |
| --- | --- | --- |
| 100,000文字 | 250分＝4時間10分 | 200〜333.33分＝3時間20分〜約5時間33分 |
| 200,000文字 | 500分＝8時間20分 | 400〜666.67分＝6時間40分〜約11時間7分 |

これは**再生時間**で、音声が完成するまでの待ち時間ではありません。生成済み音声を倍速再生しても、既に生成した音声の料金は減りません。視覚RSVP 1,500字/分を音声400文字/分に合わせるなら約3.75倍速、300〜500なら3〜5倍速であり、理解できるとは仮定しません。

## 比較履歴の料金：文字課金（採用外）

以下では比較のため`C=N`、無料枠は別に扱います。[Eleven API価格](https://elevenlabs.io/pricing/api)の通常単価と2026-10-12までの期間限定単価を分けました。

| API | 通常単価 | 10万文字 | 20万文字 | 10/12までの試算 |
| --- | --- | --- | --- | --- |
| Eleven v4 | $0.08/1,000文字 | $8.00 | $16.00 | $0.022/1,000文字 → $2.20／$4.40 |
| Eleven v4 Turbo／Flash系 | $0.04/1,000文字 | $4.00 | $8.00 | v4 Turboの$0.011 → $1.10／$2.20 |
| Google Chirp 3 HD | $30/100万文字 | $3.00 | $6.00 | 月100万文字無料枠が残っていれば$0 |

Elevenの[月額プラン](https://elevenlabs.io/pricing)はStarter $6／Creator $22／Pro $99等で、初月割引を恒常価格にしません。[PAYG](https://elevenlabs.io/docs/overview/administration/pay-as-you-go)には月額最低料金がなくても最低入金$5、残高有効期限12か月等があります。例えば消費$2.20と初回支払い$5は別です。Creative Web／mobileのv4 bonusもAPI期間限定単価と区別します。

Chirpの[無料枠・料金](https://cloud.google.com/text-to-speech/pricing)はbilling accountの有効化が必要で、超過分は課金されます。新規顧客の$300 creditは毎月の無料枠ではありません。Googleでは空白・改行・mark以外のSSML tagも課金文字に含まれます。

Cartesiaは[月額credit制](https://www.cartesia.ai/pricing)で、1文字＝1 creditです。Free 20,000/月、Pro $5で100,000/月、Startup $49で1,250,000/月、Scale $299で8,000,000/月。Proに他の消費がなければ10万文字は月$5内、20万文字は超過ON時に追加10万credit×$65/100万＝$6.50で**月合計$11.50**の例です。超過OFFなら枠を使い切った時点で止まります。Startupなら両方とも月$49内。月額を按分した消費額と請求額を混ぜず、サイト掲載の750〜800文字/分を日本語の再生時間へ流用しません。

## 料金試算：採用Geminiと比較履歴

Googleは[25 audio token/秒](https://ai.google.dev/gemini-api/docs/pricing)、OpenAI Realtimeのassistant音声は[約20 token/秒](https://developers.openai.com/api/docs/guides/voice-latency-cost?voice-api=realtime)を使います。400文字/分なら10万文字はGoogle 375,000／OpenAI 300,000 audio token、20万文字はその2倍です。以下の音声出力額に**実際の入力token代**等を足します。`T=N`とは仮定しません。

| API・単価（100万tokenあたり） | 10万文字の音声出力 | 20万文字の音声出力 | 追加する入力本文代 |
| --- | --- | --- | --- |
| Gemini 3.8 Flash：2026年末まで output $9／input $0.50 | $3.375 | $6.75 | `$0.50 × T / 1,000,000` |
| 同：2027年から output $18／input $1 | $6.75 | $13.50 | `$1 × T / 1,000,000` |
| Gemini 3.8 Flash-Lite：2026年末まで output $6／input $0.50 | $2.25 | $4.50 | `$0.50 × T / 1,000,000` |
| 同：2027年から output $12／input $1 | $4.50 | $9.00 | `$1 × T / 1,000,000` |
| Gemini 2.5 Flash：output $10／input $0.50 | $3.75 | $7.50 | `$0.50 × T / 1,000,000` |
| Gemini 2.5 Pro：output $20／input $1 | $7.50 | $15.00 | `$1 × T / 1,000,000` |
| Realtime 2.1 mini：audio output $20／text input $0.60 | $6.00 | $12.00 | `$0.60 × T / 1,000,000` |
| Realtime 2.1：audio output $64／text input $4 | $19.20 | $38.40 | `$4 × T / 1,000,000` |

上の3.8単価は[Gemini Developer API価格](https://ai.google.dev/gemini-api/docs/pricing)の**Standard有料単価**による計算です。[Enterprise価格](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)も同じ2026／2027の表示単価ですが、2026年分には**同モデルのnet spendへの50% credit還元**という注記があります。Enterpriseについて表の2026年額は掲載された実効的なプロモーション単価の算術であり、即時の半額請求や実際の支払額を確認したものではありません。credit前の請求額・適用時期・対象契約は未確認なので、予算上限から未確認creditを先に引きません。

[Cloud Text-to-Speech価格](https://cloud.google.com/text-to-speech/pricing)の掲載も、このAPIで3.8を利用できる根拠にはしません。Developer Standardの無料枠、Enterprise Preview、旧Cloud Speechの無料枠は別条件です。表から無料quotaは引いておらず、10万／20万文字を無料で完走できるとは仮定しません。API context cachingは返却音声のローカル永続cacheを代替しません。DeveloperのBatch／Flexは別料金・別実行条件なのでStandard試算へ混ぜません。

2.5・Realtimeの行は採用外の比較履歴です。出典：[OpenAI API価格](https://developers.openai.com/api/docs/pricing)。Realtimeはtext出力もmini $2.40／通常$24、audio入力mini $10／通常$32 /100万token。履歴の再入力やaudio特殊token等の小差も見込みます。

100,000文字、300〜500文字/分なら、3.8 Flash-Lite 2026の音声出力は$1.80〜$3.00、Flashは$2.70〜$4.50。20万文字は各2倍です。上と同じ有料単価／実効単価の区別が必要です。比較履歴のRealtime miniは$4.80〜$8.00。文字課金にはこの再生速度の感度はありません。再生成10%なら概ね1.1倍。実測入力`T=100,000 token`なら$0.50/100万の入力代は$0.05ですが、10万文字が10万tokenという意味ではありません。

## 完成までの時間と保存容量

生成時間は未測定です。初回音声までの公称latency（Eleven Turbo約100 ms／Flash v2.5約75 ms、[Cartesia](https://www.cartesia.ai/sonic)90 ms未満等）は、本1冊の完成時間ではありません。計算には`RTF = 生成秒 / 音声秒`を測り、`再生時間 × RTF / 実効並列数 + モデルload・待ち行列・再試行・結合・alignment時間`を使います。400文字/分、並列1でRTF 0.1なら10万／20万文字は25／50分、RTF 0.5なら125／250分という**算術例**で、製品性能の測定値ではありません。

ローカルのAPI代は0でも、PC・電力・待ち時間・空き容量は必要です。クラウドで自前実行するなら時間単価と保存・転送も別途加算します。24 kHz／16 bit／mono PCMは48,000 byte/秒なので10万文字250分で約720 MB、20万で1.44 GB。64 kbps圧縮なら約120／240 MB、全編をfloat32でdecodeすると約1.44／2.88 GBです（decimal）。全編AudioBufferを常時保持せず、圧縮chunkを保存して現在位置の近傍だけdecodeします。

## 同期を成立させる実装方針

現在の実装は文timelineに加え、保存済みWAVと確定`spokenText`を日本語CTCモデルへ渡す任意のknown-transcript整列です。採用モデルは固定Reazon Wav2Vec2ForCTC 1種類です。[セットアップ・実装状況](../guides/forced-alignment.md)を参照してください。ルビ/辞書/NFKCのUTF-16対応が一致し、score 0.75以上のcueだけをBudouXフレーズへ戻し、弱い読み表記・未知字・無音/gapは文表示を保ちます。TTSとASRによる再文字起こしは呼びません。20 ms frameやCTC scoreは時刻精度の保証ではなく、人手goldによる誤差分位は未測定です。Geminiのnative timestamp、有料実音声での整列精度は未確認です。

以下の複数文chunk・VOICEVOX音素からの対応等は調査時の設計候補で、現CTC実装の検証済み機能とは分けます。

文字の読みと音声の時間は別の対応表が必要です。**原文 → 表示本文 → 発話用本文 → 読み／音素 → 音声時刻**をmany-to-manyで記録します。ルビの基底「図書館」を「としょかん」へ置換して読ませる場合、表示offsetへ逆変換します。2026年の読み展開、括弧・英字・結合文字も同様です。返却された文字配列のindexをJSのUTF-16 offsetへ直結しません。

1. 1〜3文・短い段落（試案100〜300文字）ごとに生成し、文脈を保つ。BudouXの各フレーズごとのAPI呼び出しは抑揚を切るので避ける。engineのbyte／token／文字上限を実測して短くする。
2. 採用Geminiではnative alignmentを前提にせず、既知の発話原稿と完成音声からforced alignmentを作り、信頼できない箇所を文単位へ落とす。alignmentだけ再計算する場合は保存済み音声を使い、有料TTSを呼ばない。VOICEVOXではmora／音素とsurface文字の対応を別に作る。
3. 音声と時刻表を同時に確定・保存し、`HTMLMediaElement.currentTime`を唯一の再生時計にする。時刻表を二分探索して現在のReadingUnitを決める。RSVPのCPMタイマーを同時に動かさない。
4. pauseは音声と表示を同じ位置で止める。seekはchunkをloadして対象時刻へ移動し、再生可能になるまで待つ。`playbackRate`はmedia clockに反映済みなので壁時計へ二重乗算しない。合成速度変更は音声と時刻表の作り直しになる。
5. buffering中は表示も止める。句読点の間が音声に入っていればRSVP側で追加しない。chunk境界の無音・切れを確認し、不用意なcrossfadeで時刻を変えない。

[currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime)、[playbackRate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate)が時計の根拠です。具体的な型・現コードへの接続・VOICEVOXの計算上の注意は[同期設計の補足](../development/playback.md)に記載します。

生成はPCのローカルjobとして少数chunkずつ処理します。並列2〜5は設計試案で、実際には採用Geminiのアカウントquotaに合わせます。取消・再試行・進捗・chunk別cacheを持ちます。音声cacheは発話本文、辞書／正規化version、upstream API経路／model／voice、合成設定を含め、通信経路・alignment・表示unitのcacheを分けます。本文・音声・mapを一致させ、秘密API keyをブラウザbundleへ入れません。配布先から本を開くだけで有料APIを呼ぶ構成にはしません。初期は圧縮した5〜10分程度の配信用chunkをStatic Assetsへ同梱し、短いAPI生成単位と区別します。

ローカル処理を選んだ利用者の本文を、失敗時に黙ってクラウドへ送る設計にはしません。有料開始前にブラウザで送信本文・provider・model・接続先・対象・費用を確認します。初期のEngine接続は同じMacのローカルサーバーからです。ブラウザはそのサーバーへ同originの型付き操作を送り、公開Webやremote WorkerからMacへ接続する機能は入れません。Host／Origin・CSRF・ファイル・秘密・jobの境界は[生成UI設計](../development/local-generation.md)を参照してください。

## 評価で確認する項目

自作文または利用権のある2,000〜5,000文字を使い、同じ本文・voice・設定でcold／warmを分けて試します。初回再生可能時刻、last byte、音声時間、RTF、失敗／retry、CPU／GPU／memory／容量を記録します。漢字・人名・数字・英字・ルビの読み、脱落・重複、段落の抑揚を人が確認します。

20〜30箇所の同期点で誤差の中央値・最大値・未対応範囲を測ります。例えば200 ms以内は評価目標案で、現状の保証ではありません。停止／再開、前後seek、速度変更、buffering、タブ非表示、offline、cache失効、削除、長文での容量を、採用2モデルの実装前に検証します。

無料ローカルは採用済みのデスクトップ同梱VOICEVOX Engine＋文単位fallbackから検証します。有料は**Gemini 3.8 Flash-Liteを既定**に、短い自作文の生成・ローカル保存・既知原稿alignment・文単位fallbackを先に検証し、必要な場合だけ**3.8 Flash**へ明示的に切り替えます。他社APIの導入は実装順に含めません。TTS採用はPDF／MD抽出やBudouX分割を変更する前提ではありません。

## DirectとCloudflare直接実行の対応（2026-10-07追補）

採用経路はGoogle Interactions直結（Googleキー・Google課金）と、Cloudflare remote AI binding（既存Wrangler認証・AI Gateway設定に従う課金）の2つです。公式[Lite](https://developers.cloudflare.com/ai/models/google/gemini-3.8-flash-lite-tts/)・[Flash](https://developers.cloudflare.com/ai/models/google/gemini-3.8-flash-tts/)ページが`google/`付きモデル名と`text`・`voice`入力を掲載しています。モデルは既定Lite／明示Flashを維持します。Cloudflare経路は独立したstyle指示が公開schemaにないため未対応と明示します。

旧調査のCustom ProviderによるGoogleキー中継は今回の実装で置き換えました。CloudflareへGoogleキーは送りません。[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)のBYOK優先はセットアップ注記に留め、Googleのdefault BYOKがあればそちらが使われます。Gateway設定の管理API参照は通常生成に組み込みません。EnterpriseやCloud Text-to-Speechをこの経路と混同しません。詳細・制限・料金計算・実測案は[2経路ガイド](../guides/ai-gateway.md)が正本です。

mockでは認証・入力・WAV形式・最小receipt・エラー・再送防止を検証します。実資源・残高・自然さ・請求・上流保持・音声URL hostは未確認です。完成音声は通信経路を変えても再利用し、結果不明の有料requestは直結へ変えても自動再送しません。経路比較には別々の一時libraryで同条件の短文を明示生成する案を使い、既存キャッシュを消しません。ログ・cache・retryの無効化ヘッダーは指定しますが、実サービスでの適用は有料検証段階の確認事項です。


## Wrangler既存ログインへの移行（2026-10-07）

通常CF経路は公式`getPlatformProxy`のremote AI bindingへ変更しました。手動tokenは必須ではありません。以前のRESTは明示opt-in互換経路です。Gateway ID指定と既存Wranglerログインで通常実行する実装です。管理API Readや確認済みフラグは不要です。2026-10-07の承認試験でCloudflare Liteの13文実生成が完了しました。実請求額・音声品質の人手評価は未確認です。[現行設定と制約](../guides/ai-gateway.md)を正本としてください。Node保存・VOICEVOX・直Geminiは維持します。
