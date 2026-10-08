# ローカルセットアップ

macOS Apple SiliconとLinux x64（WSL2 Ubuntuを含む）では、最初に `pnpm setup:audio` を実行すると新規音声の保存後に自動補正を使えます。通常読書と同梱の3音声サンプルは、補正環境や音声サービスがなくても使えます。

## 最初の起動

Node.js 22.13.0以上、pnpm 12.3.4を用意します。音声補正にはPython 3.13とffmpeg／ffprobeをPATHに置きます。Homebrew導入済みなら、[Python公式formula](https://formulae.brew.sh/formula/python@3.13)と[ffmpeg公式formula](https://formulae.brew.sh/formula/ffmpeg)に従って `brew install python@3.13 ffmpeg` を自分で実行できます。セットアップからOSやグローバルのパッケージを自動導入しません。

```sh
npm install --global pnpm@12.3.4
git clone https://github.com/ryryo/ripola.git
cd ripola
pnpm install --frozen-lockfile
pnpm setup:audio
pnpm dev
```

clone後、http://127.0.0.1:4173/ を開きます。`setup:audio` はpnpm自身の組み込み `setup` と別のコマンドです。自動導入対象は **macOS ARM64／Linux x64・CPython 3.13** です。Linux wheelにはglibc 2.28以上が必要です。Windows native・Linux ARM64・Intel Macは依存導入前に拒否します。

## WSL2 Ubuntu / Linux x64の前提準備

WindowsではNode/pnpm/Pythonを**実WSL2のLinux filesystem**（例: `~/ripola`）に置きます。Windows native Python/NodeやGit Bashを代用しません。Node 22.13.0以上（検証26.8.1）とpnpm 12.3.4もWSL内で用意します。

Ubuntu 24.04の標準Pythonは3.12であり、このruntimeには使えません。`python3.13`として起動できるCPython 3.13とvenv/ensurepipが必要です。信頼できるPython管理ツール、または[Python公式source](https://www.python.org/downloads/source/)で準備します。以下は公式3.13.13を専用prefixへbuildする例です。Ubuntu package導入は利用者が実行する前提準備で、`setup:audio`がOSへ自動導入する処理ではありません。

```sh
sudo apt-get update
sudo apt-get install build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev liblzma-dev ffmpeg
mkdir -p "$HOME/python-build"
cd "$HOME/python-build"
curl --fail --location -O https://www.python.org/ftp/python/3.13.13/Python-3.13.13.tar.xz
tar -xf Python-3.13.13.tar.xz
cd Python-3.13.13
./configure --prefix="$HOME/.local/cpython-3.13" --with-ensurepip=install
make -j2
make install
export PATH="$HOME/.local/cpython-3.13/bin:$PATH"
python3.13 -c 'import sys,platform,ssl;print(sys.version);print(platform.machine());print(ssl.OPENSSL_VERSION)'
ffmpeg -version
ffprobe -version
cd "$HOME/ripola"
pnpm install --frozen-lockfile
pnpm setup:audio
```

以後も専用PythonのbinをPATHへ置きます。`/usr/bin/python3`の置換やOSのPython変更は不要です。セットアップはCPython 3.13と`Linux/x86_64`を確認し、別version/architectureの既存venvには依存を追加しません。

## WindowsのVOICEVOX接続条件（補正セットアップとは別）

公式Windows VOICEVOXデスクトップアプリをWindowsで起動し、CPUモードと既定`127.0.0.1:50021`のまま使います。ブラウザではなくWSL側Nodeがこの固定URLへfetchします。接続envは追加しません。

Windows 11 22H2以降で[Microsoftのmirrored networking条件](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)を確認します。PowerShellで `wsl --version` / `wsl --list --verbose` を確認し、`notepad "$env:USERPROFILE\.wslconfig"` で既存設定を保ち、`[wsl2]`に以下を設定します。

```ini
[wsl2]
networkingMode=mirrored
```

Windows側のVOICEVOXを維持し、PowerShellで `wsl --shutdown` 後にUbuntuを起動します。WSL内で実modeと両APIを確認します。fallback/NAT警告を無視して成功と扱いません。

```sh
wslinfo --networking-mode  # mirroredを確認
curl --fail http://127.0.0.1:50021/version
curl --fail http://127.0.0.1:50021/speakers
node --input-type=module -e 'for (const p of ["version","speakers"]) { const r=await fetch(`http://127.0.0.1:50021/${p}`,{signal:AbortSignal.timeout(3000)}); if(!r.ok) throw Error(String(r.status)); console.log(p,r.status,await r.json()); }'
pnpm dev
```

Windowsブラウザで http://127.0.0.1:4173/ を開き、声認識・明示生成・保存・Reader再生を確認します。`hostAddressLoopback`は127.0.0.1に不要です。公開bind・portproxy・firewall全無効化・remote URL追加で回避しません。

実測したWindows Server 2022 21H2/WSL2 NATではWindows APIはHTTP 200でしたが、WSLのcurlはexit 7、Node fetchは`ECONNREFUSED`でした。ServerをWindows 11適合済みと扱いません。**Windows 11/mirroredでの音声生成・保存・Reader再生E2Eは未検証**です。Linux CPUセットアップ／保存音声の補正検証は、この接続経路の成功とは別です。

## 音声補正の準備

専用venv、25種類の固定wheel、7ファイルの固定モデルを検証し、`alignment-runtime/setup.json` に設定を保存します。venvは[Pythonの独立環境](https://docs.python.org/3.13/library/venv.html)を新規作成し、既存のグローバルPythonへ依存を追加しません。設定フォルダーはGit除外です。`.env.local` の作成・手編集は不要です。

取得前にモデル約386.9 MB、依存Mac約110.0 MB／Linux約234.1 MBを表示します。専用環境・モデル・一時cache用にMac 1 GB以上／Linux 2 GB以上の空きを見込み、展開やcacheのため余裕を用意してください。公式PyPIの固定wheelと、LinuxのtorchのみPyTorch公式CPU wheelの固定URL/hashを検査します。無制限extra indexや未固定fallbackは使いません。モデルは固定Hugging Face revisionと全ファイルのsize／SHA-256を検査します。既存環境・cacheを検証して再利用し、不足ファイルだけ取得します。中断した場合は同じコマンドを再実行します。並行セットアップは拒否し、異常終了で残ったlockは回復します。

不足したPython／ffmpeg、依存導入やモデル検証の失敗では理由と再試行方法を表示します。無補正の成功として完了しません。起動後に音声生成を開くと「音声補正：利用可能／セットアップが必要／準備の確認に失敗」を表示します。起動中にセットアップした場合は `pnpm dev` を再起動してください。

準備できた後の新規生成は、音声保存→ローカル補正→対応表保存まで同じサービスで進みます。補正が利用不可・失敗なら音声を保持し、jobで補正状態を表示します。TTS再送は行いません。補正時刻には推定が残り、発話境界の精度を保証しません。[方式・容量・保存WAVの操作](forced-alignment.md)と隔離初回検証を参照してください。

## 通常読書と音声経路

文字だけ読む場合は `pnpm setup:audio` を省略できます。貼り付け／TXT／MD／対応PDFは本文を確認してから読書を開始します。取り込みはブラウザ内です。PDF.js資材を同梱し、解析時にCDNを使いません。

トップの「音声と一緒に」はVOICEVOX／Gemini（男）／Gemini（女）を1枠で選べます。同梱AACの再生はAPIキー・Engine・Pythonが不要です。

自分の原稿に音声を付ける場合、VOICEVOXは同じPCの[公式アプリ](https://voicevox.hiroshiba.jp/)を起動します。標準URLとずんだもんが既定で、envは不要です。Gemini Directは `.env.local` に `GEMINI_API_KEY` の1項目だけ追加します。Cloudflareは[Wranglerの既存ログインとGateway選択](ai-gateway.md)を使います。モデルはLiteが既定です。キー設定だけで送信せず、生成ごとに本文・声・対象・送信先・概算を確認し、明示開始します。

既存 `.env.local` をコピーで上書きしないでください。process環境、既存env、自動セットアップ、コード既定値の順に優先します。旧有料停止指定を含む互換設定と、特殊な保存先は[最小設定の設計](configuration.md)に記載します。実キーをGitや `VITE_*` へ置かず、設定編集後は再起動します。

ローカル音声の保存先は `~/Documents/rsvp-reader-library`、ブラウザの明示保存はoriginごとのIndexedDBです。端末間同期はありません。通常ビルドは `pnpm build` → `pnpm preview`、URLは http://127.0.0.1:4174/ です。公開版は黙読と保存サンプルを提供し、ローカル音声生成APIを含めません。

## 困った時

| 症状 | 対処 |
| --- | --- |
| Python／ffmpeg不足 | 表示した公式導入手順で用意し、`pnpm setup:audio` を再実行 |
| 依存・モデル取得を中断 | 同じコマンドを再実行。完成ファイルとpip cacheを再利用 |
| 旧モデル／Python指定が検証に失敗 | 外部環境は書き換えず停止する。既存設定のpath・固定versionを確認 |
| 「音声補正：セットアップが必要」 | リポジトリ直下でセットアップ後、ローカルサーバーを再起動 |
| 4173／4174が使用中 | 自分の起動済みサーバーを確認。strictPortで勝手に別portへ移動しない |
| VOICEVOX未接続 | 同じPCの公式アプリと `http://127.0.0.1:50021/docs` を確認し、「接続を再確認」 |
| Gemini／Gatewayを選べない | キーまたはWranglerのGateway選択と再起動を確認。既存の有料停止指定も確認 |
| 画像PDFから本文がない | OCR未対応。テキスト層付き1段横書きPDF／TXT／MDを利用 |
| 別ブラウザで読書位置がない | 保存はorigin・ブラウザ別。クラウド同期は未実装 |

不具合の報告にはOS・Node/pnpm・ブラウザ版・手順・短い自作例を添えます。秘密キー、生のenv、私的本文は添付しないでください。
