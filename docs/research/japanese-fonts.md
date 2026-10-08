# Ripola Japanese font switching research

確認日：2026-10-06 UTC。選定・配信・OFLの調査と、承認された3familyの実装結果をまとめます。端末標準は既定のまま、選択されたfamilyだけを同一originから取得します。

## Recommendation and scope

Keep the system font as the default. Offer Noto Sans JP, Noto Serif JP and BIZ UDPGothic as opt-in families for a focused first release. Defer BIZ UDPMincho until demand and layout testing justify the extra choice. This adds familiar sans/serif and a proportional universal-design alternative without downloading every Japanese face on the first visit.

Pin the exact Fontsource package version, self-host its font assets on the app's own origin, and load only the selected family's normal weight 400 on demand. Do not preload all families or turn font selection into a mandatory network dependency. A font's design intent does not establish a speed, comprehension or dyslexia benefit for this application.

## Candidate families and actual metadata

| Family | Published styles/weights | First-release use |
| --- | --- | --- |
| Noto Sans JP | Variable 100–900 | Opt-in sans, normal 400 |
| Noto Serif JP | Variable 200–900 | Opt-in serif, normal 400 |
| BIZ UDPGothic | Static normal 400 and 700 | Opt-in proportional UD Gothic, normal 400 |
| BIZ UDPMincho | Static normal 400 and 700 | Deferred proportional UD Mincho |

Metadata sources: [Noto Sans JP](https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/METADATA.pb), [Noto Serif JP](https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifjp/METADATA.pb), [BIZ UDPGothic](https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpgothic/METADATA.pb), [BIZ UDPMincho](https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpmincho/METADATA.pb). These are current upstream metadata, not proof that every package version ships identical files. Pin and inspect the actual package before integration.

The “P” in the BIZ UDP families denotes proportional character widths for Latin letters and kana, as described in [Morisawa FAQ 3839](https://www.morisawa.co.jp/support/faq/3839). [Morisawa's explanation](https://www.morisawa.co.jp/fonts/udfont/) describes UD typography, but suitability and reading results depend on the user and layout. Do not market a measured improvement without an appropriate study.

## Hosting options

| Route | Benefits | Costs and constraints |
| --- | --- | --- |
| Google Fonts CSS at runtime | Easy setup and automatic language slicing | Third-party requests and extra CSP origins; downloaded CSS/files may change; network and privacy dependencies |
| Direct self-hosted WOFF2 | Own origin, explicit versions, deterministic notices and caching | Own CSS/unicode-range pipeline, copying and notice preservation |
| Version-pinned Fontsource packages | Convenient Vite integration and packaged subset CSS/assets | Verify package inventory, asynchronous CSS behavior and emitted license notices |

Fontsource self-hosting is the balanced default. The Google Fonts [CSS2 API](https://developers.google.com/fonts/docs/css2), [technical considerations](https://developers.google.com/fonts/docs/technical_considerations), [getting started](https://developers.google.com/fonts/docs/getting_started) and [FAQ](https://fonts.google.com/faq) explain the hosted alternative. [Fontsource installation](https://fontsource.org/docs/getting-started/install), [subsets](https://fontsource.org/docs/getting-started/subsets) and [introduction](https://fontsource.org/docs/getting-started/introduction) explain the package route.

**Never put privately imported document text into a Google Fonts `text=` URL.** The optimization sends that text in an external request URL. A local `document.fonts.load(font, text)` call instead chooses relevant locally declared faces; it is not the Google `text=` query. Same-origin asset requests may still appear in server logs. Do not claim that self-hosting removes all metadata or logging, and do not invent Google cookie or retention guarantees from a font-loading mechanism.

## Measured size inventory

The prior research enumerated Fontsource **5.3.0** normal weight 400 split WOFF2 files. Each listed family has 124 split files. The totals exclude alternate monolithic Japanese WOFF2 files to avoid double counting.

| Package | Sum of split WOFF2 bytes | Approx. MiB |
| --- | ---: | ---: |
| `@fontsource/noto-sans-jp@5.3.0` | 2,793,024 | 2.66 |
| `@fontsource/noto-serif-jp@5.3.0` | 3,719,216 | 3.55 |
| `@fontsource/biz-udpgothic@5.3.0` | 2,845,612 | 2.71 |
| `@fontsource/biz-udpmincho@5.3.0` | 3,702,228 | 3.53 |

Inventory sources: [Noto Sans flat inventory](https://data.jsdelivr.com/v1/package/npm/@fontsource/noto-sans-jp@5.3.0/flat), [Noto Serif](https://data.jsdelivr.com/v1/package/npm/@fontsource/noto-serif-jp@5.3.0/flat), [BIZ UDPGothic](https://data.jsdelivr.com/v1/package/npm/@fontsource/biz-udpgothic@5.3.0/flat), [BIZ UDPMincho](https://data.jsdelivr.com/v1/package/npm/@fontsource/biz-udpmincho@5.3.0/flat).

These are inventory totals, **not** a typical initial transfer, npm tarball size or total application bundle increase. They exclude CSS, HTTP overhead, WOFF alternatives, other styles and weights. Browser transfer follows the selected family's unicode-range declarations and the characters actually used. A rare or long document can require many slices.

The parent cross-checked the CSS of three families. The BIZ UDPGothic CSS fetch did not complete, so that entry's byte sum relies on inventory and does not claim an independently checked CSS map. A variable-font measurement also failed; no variable size estimate is supplied. Reproduce and record the exact inventory and transfer before choosing fixed or variable packages.

A UI size label must state what it measures: complete downloadable pack, selected subsets or actual session transfer. Avoid presenting the 2.66 MiB inventory as a guaranteed download for every Noto Sans selection.

## OFL 1.1 and notices

All four candidate upstream families use the SIL Open Font License 1.1. It permits use and embedding in applications subject to its conditions; it does not automatically select the application's product license. Preserve the exact pinned distribution's license, copyright and embedded font metadata, along with upstream/version attribution. Do not replace these with a generic “Google fonts” notice.

Sources: [Noto Sans OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/OFL.txt), [Noto Serif OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifjp/OFL.txt), [BIZ UDPGothic OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpgothic/OFL.txt), [BIZ UDPMincho OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpmincho/OFL.txt), [OFL usage guidance](https://openfontlicense.org/how-to-use-ofl-fonts/), [OFL FAQ](https://openfontlicense.org/ofl-faq/).

The font notices must reach the actual deployed artifact, not just remain in `node_modules`. Record actual assets, upstream, copyright holders and version in the project's font notice inventory. Fonts cannot be sold by themselves under the OFL, and original names or authors cannot be used to imply endorsement. The app's license is still a separate project decision.

Reserved Font Names must be read from each exact distribution. The inspected Noto Sans license declared “Source” as a Reserved Font Name. The inspected Noto Serif and BIZ headers did not declare one. This is not a rule for all Noto fonts or future package versions. [Reserved Font Names guidance](https://openfontlicense.org/ofl-reserved-font-names/) explains the conditions.

Subsetting is a modification. A filename change alone is not sufficient to satisfy a required internal rename. [Modification guidance](https://openfontlicense.org/how-to-modify-ofl-fonts/) and the FAQ describe conditions including format/compression exceptions when required metadata remains intact. Inspect actual name tables and licenses before building a custom subset or recompressing files; do not assume that every WOFF conversion is equivalent to modifying no font.

The earlier review found generic Google Inc. licensing in some Fontsource Noto package notices, while Google source distributions carry other holders. Preserve all applicable notices and embedded metadata rather than silently choosing one copyright line. An upstream link in the Google BIZ Gothic OFL also appeared inconsistent; preserve the supplied license text and record the discrepancy instead of editing the legal notice as an unreviewed correction.

## Implementation plan

Introduce a small reading-font registry with a stable ID, user label, CSS stack, available weights and an asynchronous loader. Font choice should affect the reading content, not unintentionally restyle every app control. Keep a reliable system stack for UI and failure recovery.

For the first version, declare literal dynamic imports for each chosen family's normal `400.css`, so Vite can emit separate assets. Do not import all families into the application entry file. Confirm the emitted graph and initial network path rather than assuming a dynamic import guarantees lazy behavior in every configuration. [Vite CSS splitting](https://vite.dev/guide/features.html#css-code-splitting) is the primary integration reference.

The state model needs a versioned, validated font ID and migration of previously saved settings. New labels and IDs must not be arbitrary remote CSS URLs. The browser can choose among predeclared bundled families; no server proxy, key or paid service is required.

### Switching state machine

1. Pause reading, retain the current source/token anchor and record the latest selection generation.
2. Start loading only the selected family's CSS and required normal-weight faces.
3. Call `document.fonts.load` with the selected family and relevant text, including **the entire current document and ruby text**. Ensure the returned faces correspond to the requested family.
4. Ignore stale completions if the user selected another family or returned to the system default. Handle timeouts and load failures without applying a late result.
5. Apply the selected stack, wait for React's layout commit, and remeasure the real text/ruby geometry before showing it as ready.
6. Persist a successful selection while retaining the same reading anchor. Leave reading paused; let the user resume explicitly.

`document.fonts.check` alone does not prove that the selected font covers every glyph. `fonts.load` confirms loading of matching faces, not a guarantee that rare kanji, emoji or every ruby glyph will avoid fallback. [CSS Font Loading specification](https://www.w3.org/TR/css-font-loading-3/#font-face-set-load), [FontFaceSet.load](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/load) and [Document.fonts](https://developer.mozilla.org/en-US/docs/Web/API/Document/fonts) are the relevant contracts.

Loading against the whole manuscript may load many ranges; account for that cost in the UI. Loading only the currently shown phrase risks later font swaps during playback. If a lighter strategy is adopted, preflight the exact future range and define a fallback policy before resuming. Do not make a loaded bold weight appear halfway through an otherwise normal-weight playback.

### Measurement, ruby and guides

Measure rendered phrases and ruby together, using grapheme-safe text and actual element/range rectangles. UTF-16 string length, `ch` units or assumed monospace character widths do not represent Japanese ruby geometry. Canvas measurement may help base text fitting but cannot fully represent browser ruby layout.

Remeasure when family, size, weight, letter spacing, viewport, zoom or ruby settings change. Use layout effects and `ResizeObserver` where appropriate. Preserve a stable guide container and a full-phrase center rather than letting ruby width or text width move surrounding controls. [CSS Ruby specification](https://www.w3.org/TR/css-ruby-1/) should inform tests.

This implementation does **not** introduce an ORP index, colored fixation character or new character-position anchoring algorithm. Font fit and full-phrase alignment are separate from selecting a particular letter. Patent-sensitive display changes belong in the separate patent review, with exact claim comparison.

### Hosting, CSP and offline behavior

Serve WOFF2 with the correct `font/woff2` content type. Hash-named font assets can have immutable caching; HTML and references must remain updateable. A self-hosted setup can use `font-src 'self'` without Google-hosted stylesheet/font origins. Preserve deployment notices in both Worker and Pages distributions.

[Pages `_headers`](https://developers.cloudflare.com/pages/configuration/headers/) and [Workers Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/) are applicable to static assets. A Worker-generated `Response` does not inherit every static `_headers` rule automatically; inspect the final served response, especially the app's audio range worker.

Self-hosting is not an offline application. Cached slices may work after a previous selection, while an uncached rare character or a fresh family still requires a network response. On load failure, recover to the system stack and leave reading paused. An optional future offline font pack would require explicit download, size disclosure and completeness tests; it does not justify an unrelated PWA rewrite now.

### Accessibility

The font selector must work from the keyboard, preserve focus and give a short loading/error status without announcing every rapidly changing phrase. Retain user-controlled pause, a static full-text alternative, support for 200% zoom and text-spacing overrides. Fonts do not replace semantic text and accessibility controls.

References: [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html), [Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html), [Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html). Validate real browsers and ruby rather than relying on a desktop screenshot.

## 検証項目

- Fresh system-font mode downloads no optional Japanese web font.
- Selecting one family loads only that family and required weight; other families remain absent from the initial path.
- Font changes retain the same source anchor. Slow loading, failure or timeout leaves the app paused with an understandable status.
- Rapid A→B→system selections ignore stale completion and cannot overwrite the final choice.
- Resuming after readiness does not cause unplanned font or bold swaps as later phrases appear.
- Ruby, rare kanji, combining text and emoji keep correct ranges and have a tested glyph fallback policy.
- Guides do not intersect base characters or ruby at 24/72px, small viewports and zoom/text-spacing settings.
- Cold online, cached offline and new uncached-character cases are tested separately.
- Both normal and audio reader honor the selected content family while UI controls remain legible.
- Exact license/copyright notices, pinned version, font content type and CSP survive Worker and Pages packaging.
- Actual transfer is measured for representative manuscripts and distinguished from the inventory totals above.
- Chrome, Firefox, Safari and intended mobile devices get rendering checks; desktop emulation is not a real-device claim.

ChromeのPC/mobile幅で実施した結果と未検証範囲は検証記録に分けます。Firefox・Safari・実機全般・完全offlineを検証済みとはしません。

## 採用した実装

`@fontsource/noto-sans-jp`、`@fontsource/noto-serif-jp`、`@fontsource/biz-udpgothic`を**5.3.0固定**で導入しました。systemは `'Yu Mincho', 'Hiragino Mincho ProN', serif`、読書本文のweightはnormal400です。BIZ UDPMinchoは未導入です。packageの400.cssを動的importし、元font binary・name・metadataを変更しません。

`useReadingFont`は停止→本文全体とrubyを`document.fonts.load`へ渡す→最新選択のみ適用→実DOM再測定→手動再開の順です。25秒timeoutや失敗は端末標準へ戻し、停止を維持します。取得URLに本文を含めません。rare漢字・emoji等のglyph coverage保証ではなく、必要に応じて端末fallbackを使います。

共通`PhraseDisplay`は本文とrubyのDOM Rangeを測定し、サイズだけをfitします。句全体を中央に置き、ORP文字・比率位置を作りません。normal/audioの両方で採用し、Guideも同じfamilyを使います。設定version 2をvalidationし、旧データはsystemへ移行します。音声位置の復元はfont準備の停止処理より先に行い、保存位置を0へ上書きしません。

配布するNOTICEは[font notice](../../apps/web/public/fonts/NOTICE.md)、元package LICENSEと上流OFLは同ディレクトリのfamily別ファイルです。OFLの著作権者・reserved namesを保持し、製品LICENSEとは分けます。local/Worker/Pagesの出力へ同じnoticeを含めます。

上の容量表は全splitの在庫サイズで、毎回その全量を転送する意味ではありません。文書に含まれる文字で必要rangeが変わり、全本文の事前loadは小さい現在phraseだけのloadより増えることがあります。検証記録では実response bytesと初回取得数を区別します。

code：[registry/load](../../apps/web/src/reader/reading-fonts.ts)、[停止・load状態](../../apps/web/src/reader/ui/ReadingOptions.tsx)、[実DOM fit](../../apps/web/src/reader/ui/PhraseDisplay.tsx)、[音声表示](../../apps/web/src/reader/ui/AudioReader.tsx)、[設定](../../apps/web/src/reader/model.ts)、[保存validation](../../apps/web/src/reader/storage.ts)。

最終配布の既存構成にはCSP headerがありません。今回外部font originを追加せず、同一originからのみ取得することをHTTPで検査します。`font-src`制限の新設や全browserのoffline対応を検証済みとはしません。
