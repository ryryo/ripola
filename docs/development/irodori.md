# Irodoriの任意導入とnative境界

Irodoriは共通生成サービスへ追加adapterとして接続します。初期setupやGenerationServiceのconstructor、configuration取得、通常閲覧でdownloadやnative起動を行いません。専用storeとcontrollerは`.reader-data/irodori/`だけを管理し、既存alignment runtimeやlibraryの責務を引き取りません。

| 案 | 境界と検証 | 判断 |
| --- | --- | --- |
| 所有`serve` process + HTTP | 完成WAV/stop headerを検証し、AbortSignalでdisconnect。外部endpointは受け付けない。起動ログからOS割当loopback portを読む | 採用。既存WAV保存との変換境界が小さい |
| 所有`worker` process + JSON Lines v3 | `ready`/seq/base64 PCM/terminalの状態管理とWAV組立、cancel idの管理が必要。`count_tokens`が利用できる | 不採用。token計数の利点はあるが、今回のWAV経路には状態管理が増える |

HTTP仕様とworker仕様はspeech.cpp `60a8e1ec068280e5e803ee5d7079e90886c323cb`で確認しました。モデル名ではなく固定revision/checksumで検証した絶対pathをprocessに渡します。`--port 0`と公式起動ログで所有processのendpointを特定し、未起動の任意サーバーへ黙って接続しません。stderrをUIへ返しません。child環境にAPI keyを渡しません。

呼び出し側は`await getIrodoriController()`から`irodoriAdapter(controller)`を作り、共通`providers.irodori`へ注入します。factoryはモデルを取得・起動しません。`options.irodori`を正規化してfingerprintを作り、合成時に`request.providerVersion`と照合します。native endpoint、PID、私的voice pathはcache fingerprintの入力にしません。実行ファイルのhash、固定モデルのhash、voiceのhash、nativeモデル情報（版、device等）、合成条件を含めます。

モデルstoreは取得の排他をdisk lockで取り、同じrevisionの`.part`だけを再開します。UIとCLIは共通cancel markerで取消します。取消し・通信断・短い応答では完成manifestを作りません。容量/checksum検証→rename→manifestで完成を確定します。process停止中のsetup状態を「中断」として読めるようにします。既存の完成モデルを変更した場合もreadyと表示しません。

固定voiceは明示同意・取得元・条件・帰属が記録された既存GGUFだけを受け付け、checksumの変化を拒否します。録音・学習・speaker inversion・任意のvoice生成は入口に含めません。通常版の既定男女声は、受付オーディションの合成音声から事前に作った同梱GGUF固定参照です。storeが固定SHAを検証し、runtimeが二つの参照を名前付きで登録、adapterが選択した名前と参照SHAを全区間で使用します。参照の欠落・破損・起動時との不一致は失敗とし、`none`へはfallbackしません。男女それぞれの指示文・steps・seed・速度を独立した設定ファイルに保持します。nativeのCFG条件もfingerprintに含めます。指示文とseedが同じでも声の連続性を保証するとは説明しません。通常版では既存のMF固定voiceを読み込まず、男女の固定参照を公開します。通常版のfingerprint v3は参照SHAとspeaker CFGを含め、以前の参照なしv2のcacheを再利用しません。MF固定voiceの資材と旧設定ファイルは保管し、旧モデルの契約・完成音声は維持します。

通常版の上流上限256 tokens/30秒に対し、この接続では90文字・保守的なUTF-8 byte-fallback token上界256・速度を考慮した推定24秒をplannerと送信前検査の共通上限にします。`recommendedMaxCharacters`は境界選択の目安、`maxCharacters`は送信前にも守る上限です。token上界と秒数は表層推定であり、native tokenizerや音声の実時間を正確に予測するものではありません。nativeの長さ拒否・途中完了header・30秒超の出力も失敗として扱います。元source span・chunk ID・旧book・既存WAV/MP3/旧AACを独自形式へ移しません。保存以降は共通alignment・MP3・静的配布処理が所有します。

分担の先行条件は一次資料・共通契約の固定、独立範囲は専用module・UI・script・tests・guideです。共有可変状態は導入disk lock/cancel markerと所有childで、既存library排他は共通serviceが管理します。担当枠が1つなので主担当が実装し、同じ固定base/headへcorrectnessとcode-qualityを分けて確認します。独立レビューとは記録しません。

受入試験は実adapterからloopback mock native endpointへ送信し、共通serviceのWAV保存・cache再利用・条件変更・途中取消しを確認します。専用storeの取得は小さいfixtureだけで行い、大容量モデルを取得しません。同じ参照を送ることの検証は、聴感・話者一致の検証とは別です。短い参照の限界と声質の揺れは実音声の比較で確認します。
