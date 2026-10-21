# Reader height and consistent PC fullscreen controls — design QA

Date: 2026-10-21 (Asia/Tokyo)

## Visual reference and capture

- Selected source: `docs/validation/fullscreen-pc/concept-source.png` (user-selected image, 1586 × 992 pixels).
- Implementation: `docs/validation/fullscreen-pc/desktop-fulltext-final.png`, captured in the Codex in-app browser at 1470 × 923 CSS pixels, density 1.
- State: PC fullscreen, vertical full text, paused at 0:00, the same book (平和と愚かさ 17 おわりに).
- Full-view comparison: `docs/validation/fullscreen-pc/comparison.png`. Source proportionally normalized to 1470 × 919; implementation remains at its original 1470 × 923. No stretching or content substitution.
- Focused footer comparison: `docs/validation/fullscreen-pc/controls-comparison.png`.
- Reading viewport: x=24, y=64, width=1422, height=731. The text uses the remaining height between toolbar and transport; panels do not reserve additional rows.

## Findings

No outstanding P0/P1/P2 layout or interaction findings in the selected surface.

- Typography: existing Japanese Mincho reading stack and sans-serif controls are retained. Actual text uses the saved 20 CSS px setting. The generated reference's apparent glyph scale and invented line wrapping are not used to override that setting or the original book. Paragraphs, ruby and vertical numbers use the existing renderer.
- Layout: mode controls remain centered above the text. Search, follow and overflow share the upper-right row. Progress is above the lower row, with speed left of the centered play control, orientation and size to its right, settings at the left edge and fullscreen exit at the right edge. All persistent controls fit inside the viewport.
- Tokens: white panel, slate ink, blue controls, pale-blue paragraph/follow state and yellow active phrase use existing product tokens. No new decorative assets or visual system.
- Assets: the screen requires no raster assets. Existing native/Mantine controls and fullscreen icon are retained. Minor generic icon differences from the generated concept are P3 polish; visible labels and accessible names remain available.
- Content: original book text and real 17:28 duration are displayed. The actual saved rate (2.5×) is retained instead of replacing it with the concept's illustrative 4×.

## Comparison history

1. Initial implementation: the full-text viewport expanded and the controls occupied one lower row. Review found the legacy `.guide-toolbar button` background rule overriding the follow button's selected appearance, and an unstyled silent-speed number field.
2. Fixed the selected follow appearance and number-field border/radius using scoped desktop-guide rules. Captured the same book again. The full-view and footer comparisons above show the final state; no further P0/P1/P2 visual fixes were identified.

## Interaction verification

- Desktop browser tests cover search autofocus, no-match feedback, successful search jump, Escape/focus restoration, follow toggle, copy dialog, display settings, constant viewport/play-control bounds, playback transitions, vertical/horizontal direction, and persisted font size.
- The existing fullscreen suite also checks native/fallback fullscreen, focus isolation, progress visibility, saved settings, wake-lock behavior and phone bottom-sheet layout.
- Audio coverage checks the shared layout, speed/direction/font changes, visible seek position and return to normal controls.
- In-app browser inspection confirmed the same book and paused frame. Captured browser warning/error log was empty. Test-server request-abort logs during page teardown are recorded separately from browser console errors.
- Typecheck and ESLint passed. Across the fullscreen suite and focused reruns, all 22 applicable desktop/phone cases passed (the two desktop-only cases are skipped in the phone project). Reruns used a dedicated output directory, port, empty test library and disabled paid generation. Initial shared-output/server conflicts and two test assertions (Mantine display value and the exact integer-second seek boundary) were resolved before acceptance.

## Implementation checklist

- [x] Share the PC fullscreen toolbar and transport across phrase, multiline and full text at widths of at least 951px.
- [x] Preserve reading, timing and preference behavior across modes; retain phone fullscreen presentation rules.
- [x] Use the existing reading, seek and preference logic.
- [x] Overlay search/copy/settings instead of resizing the reading surface.
- [x] Retain minimum 44px control targets, field labels and focus restoration.
- [x] Update the reading guide.

## Follow-up polish

P3 only: optional library icons beside search/settings/follow labels could more closely resemble the generated concept. Current labels provide the complete functionality without new dependencies.

## PC mode consistency follow-up

- Final paused phrase capture: `docs/validation/fullscreen-pc/desktop-phrase-shared-controls-final.png`.
- Final paused full-text capture: `docs/validation/fullscreen-pc/desktop-fulltext-shared-controls-final.png`.
- Compared both images at 1470 × 923, density 1, same book and 0:00 position, against the selected concept's toolbar/transport hierarchy. Mode controls, settings, speed, centered play, direction, size and exit occupy the same coordinates. Full text retains its specific search/follow/copy tools. The phrase uses its real saved 96px size; full text uses its separately saved 20px size.
- The common reading area starts at y=64 and ends at y=795 in both modes. PC phrase playback uses the bottom button. Existing narrow-screen central-play behavior is retained.
- Corrected a legacy phrase-padding specificity conflict; extracted fullscreen context to its own module to avoid stale context during hot reload. Final captures were made after reload.
- Verification: fullscreen suite 22 passed, 2 desktop-only cases skipped on phone. Three focused desktop cases passed after the final specificity/context changes. Mode transitions retain footer/play positions and independent font sizes, including audio.

## Normal full-text height follow-up

- Cause: the prior fullscreen changes left the normal guide viewport at the legacy fixed 330px (300px on phone). This was an unaddressed part of the original request.
- Full text now shares `--reader-document-height` with existing vertical multiline presentation: 74dvh, bounded at 460–840px. At a 900px viewport, the normal full-text body grows from 330px to 666px. Audio/text and vertical/horizontal full text share this rule; fullscreen retains its remaining-space sizing.
- The page continues to scroll naturally to the playback controls below the reading card. No sticky header or additional toolbar was introduced.
- Live same-book capture: `docs/validation/fullscreen-pc/normal-fulltext-live.png`; measured height 555.73px at a 751px viewport, with complete text columns and status/copy/exit outside the reading area. Compared with the user's initial normal-view screenshot to confirm the fixed short body is removed.
- Desktop full-page fixture capture: `docs/validation/fullscreen-pc/normal-height-capture/reading-options-Guide-reve-9c072-ual-row-after-a-search-jump-desktop-chromium/normal-fulltext-height.png` (exact generated path recorded by the test output directory).
- Regression verification: six desktop/phone cases passed, covering increased height, resizing between short/tall viewports, search visibility, manual scrolling/following, audio position, fullscreen transitions and restored normal height. Typecheck and ESLint passed.
- Final desktop capture exposed a pre-existing overlap between the silent reader status and search field. Changed the normal guide status to flow above the toolbar and added an overlap assertion; the recaptured desktop image has a distinct status row.
- No outstanding P0/P1/P2 visual or interaction findings in the changed surfaces.

## Normal toolbar spacing follow-up (latest)

- Source problem image: `/var/folders/wv/txwxnyzs6vz5zc9p3yssjhmh0000gn/T/codex-clipboard-d99b0cad-35d9-4040-81e8-f4518092f72e.png` (1644 × 286 pixels; source crop/density unspecified). Reviewed for hierarchy and excessive vertical space, not pixel-exact reproduction.
- User correction: preserve visible actions; organize positions and widths rather than moving normal-reader actions into an overflow menu or popover.
- Final same-book browser capture: `docs/validation/fullscreen-pc/normal-visible-tools-final.png`, 836 × 751 CSS/pixel viewport at density 1, vertical audio reader paused at 0:00. Focused header crop: `docs/validation/fullscreen-pc/normal-visible-tools-header-final.png` (789 × 145), taken from this capture without rescaling. Both full view and focused region inspected.
- Layout: from 761px width upward, status at left and the persistent search label/field/search action/follow action at right share a single header. At the captured width the field is 200.63px wide, status is 44px tall, and toolbar is 52px including its 8px lower gap. Search is bounded to 140–320px rather than stretching across the card. Smaller screens retain the stacked layout; the normal input remains visible.
- Discoverability: normal search input, search button, follow button and the direct static-text/copy disclosure remain visible. No new overflow menu or search popover in normal presentation. The attempted normal overflow implementation was removed following the user's correction. Accepted fullscreen behavior remains separate.
- Typography: retained existing 11px toolbar/status text, existing button text and Japanese reading-font stack; labels stay visible. Colors, borders and radius use existing product tokens. No image assets, generated imagery or new icons are introduced. Copy and book content are unchanged.
- Visual result: the full-text viewport retains the prior responsive height, while the header no longer consumes separate status and label rows. No action overlap or horizontal overflow observed in the live capture.
- Final scoped automated checks cover toolbar height/alignment, bounded input width, visible search/follow/copy, no normal overflow trigger, responsive height, and search-preview anchoring without moving reading position.
- Concurrent search work changed GuideReader during verification (live matching, result navigation and preview semantics). Its logic was retained; the normal field is rendered directly in the toolbar, with result controls using the existing new panel. Earlier broad regression runs against the prior search workflow failed and are not acceptance evidence for this final layout; fullscreen autofocus and legacy search-jump expectations belong to that concurrent change.
- Final scoped verification: two desktop/phone cases passed; typecheck, ESLint and whitespace checks passed.
- Typography/copy reflect the current shared component: normal input uses its search-field style and the action label is 検索. No new menu hides the normal actions.

## Shared normal-reading height (latest)

- User requested that phrase presentation reserve the same height as full text. Normal PC phrase, multiline and full text now share `--reader-normal-stage-height`, derived from the existing responsive document height plus its normal tool/status space. At 1280 × 900 the common outer stage is 810px tall. This keeps the transport's page position unchanged across mode switches; phrase text remains centered in the larger area.
- Applies at widths of at least 761px with height above 520px, or widths of at least 951px. Existing phone portrait and short phone landscape height rules remain intact. Fullscreen sizing is unchanged. Expanding the static-copy text can still grow its document card naturally.
- Compared the same fixture, stopped position and viewport (1280 × 900, density 1) in full-page captures: `docs/validation/fullscreen-pc/shared-normal-height-final/reading-options-Guide-reve-9c072-ual-row-after-a-search-jump-desktop-chromium/normal-phrase-shared-height.png` and the same directory's `normal-fulltext-height.png`. Both show the same outer card and transport geometry. The existing fonts, 56px phrase size, 20px document size, colors, labels, guides and icons are retained. No image assets added.
- The normal PC search field remains persistent in its header; the concurrent search implementation's preview/result behavior is retained. The inline-field rule and test assertion explicitly preserve the user's discoverability requirement.
- Verification: earlier focused run passed seven of eight cases, including PC stage/transport equality for silent and audio readers, mobile phrase/audio fit and audio/fullscreen transitions. One mobile search visibility assertion was stale after concurrent search changes. The final desktop/phone rerun passed both cases, with explicit phrase/multiline/full-text height equality and unchanged reading position during search preview. Typecheck, ESLint and whitespace checks passed.
- No P0/P1/P2 visual issue found in the dedicated browser captures for this height change. Earlier concurrent search-related regression findings are separate from this scoped validation.
- Live preview limitation: port 4173 serves the page and client-entry source, but the existing in-app tab remained in the SSR preparation state after reload and a Vite config-watch restart. A fresh temporary tab showed the same state and was closed. Final visual acceptance is based on the dedicated browser captures, not a claim that the existing preview loaded successfully.

## Normal reader viewport budget (latest)

- Latest requirement: keep the normal PC display area, seek row and primary play controls within the viewport height. This supersedes the earlier document-height-plus-chrome calculation.
- Implementation: `useNormalReaderHeight` measures the card's document position, the seek/transport stack and its gap, reserves 16px at the viewport bottom, and assigns the remainder as the common stage height. ResizeObserver, window/visual-viewport resize and font completion update the budget. Page scrolling does not change the document-position budget. Fullscreen and phone presentation keep their own sizing. A 160px card minimum permits normal page scrolling at extreme zoom/short viewport sizes.
- Secondary speed/display settings remain below primary transport. No controls are moved into new menus. Search result controls overlay the budgeted card rather than consuming its already-limited document height; the result panel can scroll when space is short. Static-copy expansion retains its existing natural document growth.
- Live capture accepted: `docs/validation/fullscreen-pc/normal-viewport-budget-live.png`, same user book, paused at 1:22, saved 42px horizontal phrase / 2.5x settings, viewport 836 × 751 at density 1. Measured card top 250.09px, card height 331px, primary-transport bottom 734.48px (inside 751px). The previous live-preview preparation issue is resolved; this capture is from the user's current app.
- Matched PC mode comparison: `docs/validation/fullscreen-pc/viewport-budget-final/reading-options-Guide-reve-9c072-ual-row-after-a-search-jump-desktop-chromium/normal-phrase-shared-height.png` and the same directory's `normal-fulltext-height.png`. Both are 1280 × 900 viewport captures at density 1, same fixture/paused position, with identical card and transport geometry. Reviewed the full views and the persistent play/seek area; the primary controls are fully visible with lower breathing room.
- Typography/colors/content: no font-family, font-size preference, palette, book text, icon or image asset changes. This iteration changes height allocation. Existing heading and toolbar layout changes from concurrent work are measured, not duplicated as constants.
- Regression history: an initial resize assertion ran before the next animation frame; it now waits for the layout to settle. A reduced viewport exposed an in-flow search panel squeezing the text; the scoped overlay rule preserves text bounds and the search target is visible again.
- Verification: final focused desktop mode/resize/search test passed; audio vertical/timing/fullscreen and both phone counterparts passed. Two additional desktop/phone cases passed for 24–96px vertical phrases, ruby, guides, reload and fullscreen restoration. Typecheck, ESLint and whitespace checks passed. Tests cover 600/900/1200px viewport heights, horizontal/vertical multiline, unchanged stage/transport geometry, and primary controls remaining within the viewport.
- No outstanding P0/P1/P2 issue in the changed viewport-budget behavior.

final result: passed

## Preserve the established normal text height (current correction)

- The preceding viewport-budget acceptance was incorrect: it let page headings reduce the card to 331px and the text to roughly 180px. The user's original height requirement takes priority. This section supersedes that acceptance and its 160px card minimum.
- Normal PC full text now keeps the established `clamp(460px, 74dvh, 840px)` body height as a floor. Phrase, multiline and full text share the same outer height. The measured viewport budget covers the reading card, seek row and primary transport together; the page header/title sit before that group and are never subtracted from text height. When the minimum group exceeds a short viewport, natural page scrolling preserves the text floor.
- Compact normal chrome uses a 44px toolbar, 44px status/copy footer and 12px vertical padding, plus the card border. Status and the existing copy disclosure share one row. Seek/transport gaps are reduced and primary buttons retain 44px targets. No new overflow menu or hidden action was introduced by this correction. Concurrent search behavior remains unchanged.
- Actual same-book verification: `docs/validation/fullscreen-pc/preserve-text-height-live.png`, 836 × 751 at density 1, paused at the user's existing 1:22 position, vertical full text at the saved 20px and 2.5× settings. Measured text height 555.73px, card height 657.73px, and card/seek/transport group height 750.73px. Inspected the complete group aligned at the top of the viewport: complete vertical columns, direct status/copy/fullscreen actions and play/seek controls fit without overlap. The page title remains above and is reachable by scrolling.
- Matched normal PC fixture captures at 1280 × 900, density 1: `docs/validation/fullscreen-pc/preserve-text-height-tests/reading-options-Guide-reve-9c072-ual-row-after-a-search-jump-desktop-chromium/normal-phrase-shared-height.png` and the same directory's `normal-fulltext-height.png`. Both full images were inspected; card bounds and transport position match across modes. Existing reading fonts, saved sizes, colors, book content and icons are retained; no assets added.
- Verification: typecheck and scoped ESLint passed. Four desktop/phone browser cases passed, covering text-height preservation at 600/900/1200px, common phrase/multiline/full-text card geometry, horizontal/vertical layout, search not reducing the reading surface, audio position, fullscreen transitions and phone height behavior. Assertions now check the original text floor explicitly, so fitting the transport cannot silently shrink the body again.
- No outstanding P0/P1/P2 issue in this height correction. The deliberate limitation is that page headings plus the preserved reading group can require normal page scrolling.

final result: passed
