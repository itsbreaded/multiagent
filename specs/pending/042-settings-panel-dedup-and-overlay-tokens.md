# 042 — Settings Panel Dedup, Overlay Tokens, and MCP Form Fixes

Covers backlog items **26** (settings-row duplication + file split), **32** (overlay scaffolding → theme tokens), **9** (ServerForm stale args/env on edit-target switch), **42** (un-cleaned McpSection timers), and **44** (direction-inconsistent settings search) from `specs/pending/032-code-improvement-backlog.md`. All line numbers below were re-verified against the working tree on 2026-07-03; they will drift — treat the code excerpts and symbol names as the anchors, not the numbers.

Files in play:

- `src/renderer/src/components/SettingsPanel/index.tsx` (1457 lines)
- `src/renderer/src/components/SettingsPanel/McpSection.tsx` (1046 lines)
- `src/renderer/src/components/SettingsPanel/TerminalBindingsSection.tsx`
- `src/renderer/src/components/SessionBrowser/index.tsx`
- `src/renderer/src/components/CommandPalette/index.tsx`
- `src/renderer/src/styles/theme.ts`
- `src/renderer/src/store/settings.ts` (read-only dependency: `useSettingsStore`, `SettingsSection`)
- `src/renderer/src/commands/registry.ts` (read-only dependency: `settings.open.<section>` entries)

## Problem

`SettingsPanel/index.tsx` renders every Appearance and Terminal setting row twice: once in the per-section view and once, copy-pasted verbatim, inside a `SearchResults` component that receives the state through a ~30-prop interface. Any edit to a setting row must be made in two places or section view and search results silently drift — exactly the multi-mode duplication trap CLAUDE.md's UI Consistency section warns about. The same file also carries `SearchResults`, `UpdatesSection`, `HotkeyRow`, and assorted helpers inline, making it the largest component file in the renderer.

Around it, three smaller correctness bugs and one consistency debt live in the same surfaces:

1. The MCP edit form keeps the previous server's args/env text when the edit target changes, so editing server A then server B can save A-derived args/env onto B.
2. Three `setTimeout`s in `McpSection` are never cleared — they race across repeated saves/tests and fire `setState` after unmount.
3. Settings search matches in two opposite directions depending on the section, so multi-word and reordered queries fail unpredictably, and one clause is provably dead.
4. All three application overlays (Settings, Session Browser, Command Palette) hand-roll the identical modal language with raw hex literals, and four files carry a byte-identical private `SectionLabel` — despite `theme.ts` already defining the exact tokens (`ui.color.panel`, `ui.color.border`, `ui.radius.modal`, `ui.shadow.overlay`) and an established `menuStyles` fragment pattern to follow.

## Current Behavior (evidence)

### Item 26 — duplicated setting rows

The section view (`!isSearching` branch) and `SearchResults` render the same rows from two separate JSX copies. Verified duplications, line-for-line:

| Setting row | Section view (index.tsx) | SearchResults copy (index.tsx) | Notes |
|---|---|---|---|
| Git branch badges (checkbox) | 347–361 | 827–841 | byte-identical |
| Tab overflow (scroll/wrap buttons) | 362–391 | 842–871 | byte-identical |
| Optimized renderer (checkbox) | 499–513 | 925–939 | byte-identical |
| GPU acceleration (auto/on/off buttons) | 514–543 | 940–969 | byte-identical |
| Minimum contrast ratio (draft input) | 569–595 | 970–996 | byte-identical |
| Rescale overlapping glyphs (checkbox) | 596–610 | 997–1011 | byte-identical |
| Scrollback lines (draft input + presets) | 611–667 | 1012–1068 | byte-identical |
| Conflict / recording banners (hotkeys) | 423–463 | 877–902 | search copy omits the yellow `hotkeyTerminalWarning` banner — already drifted |
| Hotkey rows (`visibleHotkeys.map` → `HotkeyRow`) | 465–485 | 903–919 | same map body; only the callbacks differ (inline vs `onStartRecording`/`onResetHotkey` props) |

`SearchResults` is declared at 736 with its ~30-entry prop interface at 774–812 (`normalizedQuery`, seven `showXxxSetting` booleans, `visibleHotkeys`, `effectiveHotkeys`, `hotkeyOverrides`, `recording`, `conflictLabel`, `terminalClashLabelForHotkey`, plus paired value/setter props for every setting, plus draft-state props `contrastDraft`/`scrollbackDraft` and their commit functions, plus three callbacks). Every prop except `normalizedQuery`-derived visibility exists only to tunnel `useSettingsStore` state that the child could read itself.

Not duplicated (section-view-only, must stay that way): the GPU capabilities diagnostics readout (546–566, explicitly commented "only in section mode, never in search results"), `TerminalBindingsSection` (487–491, gated on `!normalizedQuery`), and the MCP/Providers/Updates sections, which appear in search as `SettingNavCard` link cards (1071–1091) rather than inline rows.

Also inline in the 1457-line file and extractable as siblings (the `McpSection.tsx` precedent): `SearchResults` (736), `SettingNavCard` (1096), `formatLineCount` (1139), `HotkeyRow` (1144), `KeyBadge` (1230), `SectionLabel` (1250), `EmptyMessage` (1267), `UpdatesSection` (1273, plus `updateActionStyle` at 1416), `SettingRow` (1426).

### Item 44 — search matching direction inconsistency

Two opposite matching directions in the same file:

- Inline settings, index.tsx 200–206: **keyword-string-contains-query**, e.g.
  `const showBranchSetting = !normalizedQuery || 'git branch badges tabs panes'.includes(normalizedQuery)`
  (seven of these; also `visibleHotkeys` at 210–212 uses label-contains-query).
- Nav-card sections, index.tsx 815–817: **query-contains-keyword**, e.g.
  `const hasMcp = MCP_KEYWORDS.some(k => normalizedQuery.includes(k))` against the keyword arrays at 29–31.

Consequences, verified against the actual keyword strings:

- Multi-word reordered queries fail for inline settings: `"branch badges"` matches (substring of the keyword string) but `"badges branch"` matches nothing.
- Short prefixes work for inline settings (`"scrollb"` matches) but not for nav cards (`"serv"` does not contain the full keyword `"server"`, so no MCP card).
- Long queries kill inline settings entirely (`"git branch badges in tabs"` is not a substring of the keyword string) while nav cards tolerate extra words (`"open the mcp section"` contains `"mcp"`).
- Line 817's trailing `|| normalizedQuery.includes('update')` is dead code: `UPDATE_KEYWORDS` (line 31) already begins with `'update'`, so the `.some()` covers it.

### Item 9 — ServerForm stale args/env

`McpSection.tsx`: `ServerForm` (472) seeds its local text state from props via `useState` **initializers only** (487–492):

```ts
const [argsText, setArgsText] = useState((data.args ?? []).join(' '))
const [envText, setEnvText] = useState(
  data.env && Object.keys(data.env).length ? ... : ''
)
```

It is rendered without a `key` (323–334). `openEdit(entry)` (89–95) swaps `formData`/`editingId` in the parent but React reuses the mounted `ServerForm` instance, so after `openEdit(B)` while A's form is open, the Args and Env fields still display A's text. Any keystroke in those fields then calls `handleArgsChange`/`handleEnvChange` (501–519), which recompute `data.args`/`data.env` from the stale A-derived text and commit them onto B via `onChange`; `submitForm` (116–139) saves the mixture. The same instance-reuse applies to Add→Edit and Edit→Add transitions via `openAdd` (81–87). Local per-instance state that must also reset on target switch: `envError`, `testState`, `formProbe`.

The `prevType` effect at 540–546 is vestigial dead code — it updates a ref and does nothing else (its comment claims it resets args/env on type change; it doesn't).

### Item 42 — un-cleaned timers in McpSection

- `save()` at 71–75: `setTimeout(() => setSaved(false), 2000)` — two saves within 2s cut the second banner short; fires after unmount if the section closes.
- `testServer()` at 154–160: `setTimeout(() => setTestStates(...idle...), 4000)` — re-testing within 4s lets the first timer clobber the second test's result; fires after unmount.
- `ServerForm.handleTest()` at 521–527: `setTimeout(() => setTestState('idle'), 4000)` — same pattern inside the form.

None are stored, cleared on reschedule, or cleared on unmount. (The `AbortController` timer inside `testConnection` at 930–946 is a different case — it self-limits at 4s and its firing after completion is harmless; also note `clearTimeout(timer)` there is skipped on the throw path. Optional boy-scout: move it to `finally`. Not required.)

### Item 32 — overlay scaffolding duplicated with raw hex

Three overlays hand-roll the modal language despite `theme.ts` tokens (`ui.color.panel` = `#1a1b1e` at theme.ts:6, `ui.color.border` = `#2a2b2e` at :13, `ui.radius.modal` = 10 at :29, `ui.shadow.overlay` = `'0 24px 64px rgba(0,0,0,0.6)'` at :33) and the existing `menuStyles` fragment precedent (theme.ts:190–230):

- `SettingsPanel/index.tsx` 224–252: fixed inset backdrop `rgba(0,0,0,0.8)` zIndex 60, centered; panel `#1a1b1e` / `1px solid #2a2b2e` / radius 10 / `0 24px 64px rgba(0,0,0,0.6)` / `85vw`, maxWidth 960, `75vh`. Header with "ESC to close" at 299–311.
- `SessionBrowser/index.tsx` 139–166: identical backdrop but **zIndex 50**; identical panel and dimensions. Header with "ESC to close" at 168–181.
- `CommandPalette/index.tsx` 123–149: backdrop `rgba(0,0,0,0.7)` (not 0.8) zIndex 60, **top-aligned** (`alignItems: 'flex-start'`, `paddingTop: '15vh'`); panel same color/border/radius/shadow but maxWidth 600, no fixed height, no ESC header.

These per-overlay differences (alpha 0.7 vs 0.8, z 50 vs 60, centered vs top-aligned, dimensions, header presence) are intentional current behavior and must be preserved as parameters, not flattened.

Byte-identical private `SectionLabel` in **four** files (the backlog said three; TerminalBindingsSection is the fourth): `SettingsPanel/index.tsx:1250`, `McpSection.tsx:874`, `CommandPalette/index.tsx:247`, `TerminalBindingsSection.tsx:598`. All render `padding '6px 14px 3px' / fontSize 10 / fontWeight 600 / color #4a4b4e / uppercase / letterSpacing 0.08em`.

`McpSection.tsx` is the worst raw-hex offender: 27 occurrences of `#2a2b2e`/`#4ade80`/`#141517` alone, plus pervasive `#4a4b4e`, `#6b7280`, `#d4d4d4`, `#0e0f11`, `#1e1f22`, `#3a3b3e`, `#f87171` — nearly all have existing `ui.color.*` equivalents (`border`, `accent`, `input`, `textDim`, `textMuted`, `danger`). A few have none yet (e.g. `#d4d4d4` body-strong text vs `ui.color.textStrong` = `#e2e4e6`, the `TypeBadge` hue trios at McpSection:786–790, banner tints like `#0f2a15`/`#2a1a1a`) — see Phase C rules.

## Intended Behavior

- Each Appearance/Terminal setting is one self-contained component that reads and writes `useSettingsStore` directly. The section view and the search-results view render the **same component instances-by-type**; there is no second JSX copy and no prop tunnel. `SearchResults` shrinks to visibility logic + composition.
- Settings search uses one matching helper everywhere: the query is token-split and every query token must prefix-match some keyword token. `"badges branch"`, `"serv"`, and `"open mcp"`-style queries behave consistently across inline settings, hotkeys, and nav cards.
- Editing MCP server B immediately after A shows B's args/env; add/edit transitions always start from the correct seed. The dead `prevType` effect is gone.
- The saved banner and test-state timers never fire stale updates: repeat actions reset the window, unmount cancels.
- Settings, Session Browser, and Command Palette build their backdrop/panel/header from one `overlayStyles` fragment in `theme.ts`; one shared `SectionLabel` replaces the four private copies; `McpSection` styles read from `ui.*` tokens. Rendered pixels are unchanged.

## Implementation Plan

Ordered phases; each is independently landable. Phase A first (small correctness fixes with tests), then B (the extraction), then C (tokens). Do not interleave B and C in one commit — B moves code, C rewrites styles; combined diffs are unreviewable.

### Phase A — quick fixes (items 9, 42, 44)

**A1. Key the ServerForm by edit target (item 9)**
In `McpSection.tsx` at the `ServerForm` render site (~325):

```tsx
<ServerForm
  key={editingId ?? 'new'}
  ...
/>
```

Delete the dead `prevType` ref/effect (~540–546). No other change — the `key` remount re-runs the `useState` initializers and also resets `envError`/`testState`/`formProbe`, which is the desired semantics.

**A2. Timer hygiene in McpSection (item 42)**
Introduce ref-held timer ids, cleared on reschedule and unmount:

- In `McpSection`: `savedTimerRef` for the banner (`save()`), `testTimersRef: useRef(new Map<string, ReturnType<typeof setTimeout>>())` for per-server test resets (`testServer()`), one `useEffect` cleanup clearing all on unmount.
- In `ServerForm`: `testTimerRef` for `handleTest()`, cleared on reschedule and unmount.

Behavior change is only: repeat action restarts the 2s/4s window instead of the old timer firing early; nothing fires after unmount.

**A3. One search-matching helper (item 44)**
Add `src/renderer/src/components/SettingsPanel/settingsSearch.ts`:

```ts
/** Every whitespace-token of `query` must prefix-match some token of `keywords`. */
export function matchesSettingQuery(query: string, keywords: string): boolean
```

Semantics: lowercase both; split on whitespace; empty query matches everything; each query token must be a prefix of at least one keyword token. Use it for:

- the seven `showXxxSetting` computations (keyword strings at index.tsx 200–206 become the `keywords` argument — keep the strings, they're good keyword inventories),
- hotkey label filtering (`visibleHotkeys`, 210–212) with `DEFAULT_HOTKEYS[id].label` as keywords,
- `hasMcp`/`hasProviders`/`hasUpdates` (815–817), passing `MCP_KEYWORDS.join(' ')` etc. (or change the constants to single strings). Delete the dead `|| normalizedQuery.includes('update')` clause.

This is a deliberate behavior change — document it in the PR (see Risks).

### Phase B — extract self-contained setting components (item 26)

**B1. New directory `src/renderer/src/components/SettingsPanel/settings/`**, one file per setting, each a zero-prop (or near-zero-prop) component that subscribes to `useSettingsStore` itself and renders inside the existing `SettingRow`:

| New component file | Replaces section-view lines / SearchResults lines |
|---|---|
| `settings/GitBranchBadgesSetting.tsx` | 347–361 / 827–841 |
| `settings/TabOverflowSetting.tsx` | 362–391 / 842–871 |
| `settings/OptimizedRendererSetting.tsx` | 499–513 / 925–939 |
| `settings/GpuAccelerationSetting.tsx` | 514–543 / 940–969 |
| `settings/ContrastRatioSetting.tsx` | 569–595 / 970–996 |
| `settings/RescaleGlyphsSetting.tsx` | 596–610 / 997–1011 |
| `settings/ScrollbackSetting.tsx` | 611–667 / 1012–1068 |

Draft-state note: `ContrastRatioSetting` and `ScrollbackSetting` own their draft string + commit logic locally (move `scrollbackDraft`/`contrastDraft`/`commitScrollbackDraft`/`commitContrastDraft` and the store-sync `useEffect`s at 178–196 into the components). Today the draft is shared between the two render paths through props, but the two paths are never mounted simultaneously (`!isSearching` ternary at 341/688), so per-component draft state is behavior-equivalent; an uncommitted draft is already discarded on view switch today because blur fires commit.

Shared button-group styling used by TabOverflow/GpuAcceleration/Scrollback presets (the `isActive ? ui.color.control : 'none'` pattern) may be extracted as a tiny `ChoiceButton` in `settings/` — optional, do it only if it stays pixel-identical.

**B2. Split the file.** Move to siblings of `index.tsx` (the `McpSection.tsx` precedent), keeping `index.tsx` as the shell (overlay, nav, query state, hotkey recording state):

- `SearchResults.tsx` — after B1 its props shrink to: `normalizedQuery`, the visibility booleans (or recompute them internally from the shared helper), hotkey-related props that genuinely live in the shell (`visibleHotkeys`, `effectiveHotkeys`, `hotkeyOverrides`, `recording`, `conflictLabel`, `terminalClashLabelForHotkey`, `onStartRecording`, `onResetHotkey`), and `onNavigate`. Target: ≤ 10 props, none of them settings values/setters.
- `UpdatesSection.tsx` (with `updateActionStyle`) — also stop tunneling `autoUpdateEnabled`/`setAutoUpdateEnabled` through props (index.tsx 681–686); read the store directly.
- `HotkeyRow.tsx` (with `KeyBadge`).
- `shared.tsx` (or individual files): `SettingRow`, `SettingNavCard`, `EmptyMessage`, `formatLineCount`. `SectionLabel` moves in Phase C; if B lands first, park it in `shared.tsx` and re-export.

Hotkey recording state (`recording`, `conflictLabel`, `hotkeyTerminalWarning`) stays in the shell — it is cross-cutting (the capture-phase key listener at 99–162 must outlive row renders) and is not settings-store state. The duplicated conflict/recording banners become one `HotkeyBanners` component rendered by both views; give the search view the yellow `hotkeyTerminalWarning` banner too (fixes the existing drift — call this out in the PR as the one intentional visual delta, or replicate the omission if reviewers insist on strict pixel parity).

**B3. Both views compose the same components.** Section view: `{showBranchSetting && <GitBranchBadgesSetting />}` etc. SearchResults: identical elements under its section labels. The `settingsInitialSection` deep-link behavior (index.tsx 61–65) and the "never filter the sidebar nav by query" invariant (comment at 253–256) are untouched.

### Phase C — overlay tokens and shared SectionLabel (item 32)

**C1. `overlayStyles` fragment in `theme.ts`**, following the `menuStyles` shape:

```ts
export const overlayStyles = {
  backdrop: {        // rgba(0,0,0,0.8), position fixed, inset 0, centered flex
  },
  backdropLight: {   // CommandPalette variant: rgba(0,0,0,0.7), flex-start, paddingTop 15vh
  },
  panel: {           // ui.color.panel, border.default, ui.radius.modal, ui.shadow.overlay, overflow hidden
  },
  header: {          // flex row, space-between, padding '12px 16px', borderBottom border.default, flexShrink 0
  },
  headerTitle: {     // fontSize 14, fontWeight 600, textStrong-equivalent color
  },
  headerHint: {      // fontSize 11, ui.color.textDim  ("ESC to close")
  },
} satisfies Record<string, React.CSSProperties>
```

Add `ui.z.overlay` tokens for the hardcoded zIndex values (50 for SessionBrowser, 60 for SettingsPanel/CommandPalette) rather than silently unifying them — z-ordering between overlays may be load-bearing (Session Browser must not cover Settings if both mount). Callers spread the fragment and override per-overlay dimensions (`width/maxWidth/height`) and zIndex inline: `style={{ ...overlayStyles.panel, width: '85vw', maxWidth: 960, height: '75vh' }}`. Do **not** change any current value — the fragment encodes what the three files already render, alpha differences included.

Optionally wrap as a `ModalShell` component (backdrop + panel + mouseDownOnOverlay/click-outside handling, which is also triplicated). Acceptable either way; the styles fragment is the non-negotiable part, the component is a bonus. If building `ModalShell`, preserve each overlay's exact close semantics (SettingsPanel's close also resets recording state — keep that in the caller).

**C2. One shared `SectionLabel`.** Add it to a shared location (e.g. `src/renderer/src/components/common/SectionLabel.tsx`, styled from `theme.ts` values); delete the four private copies (`SettingsPanel/index.tsx:1250` — or its Phase-B new home, `McpSection.tsx:874`, `CommandPalette/index.tsx:247`, `TerminalBindingsSection.tsx:598`) and import. Note `#4a4b4e` = `ui.color.textDim`.

**C3. McpSection token sweep.** Replace raw hex with tokens where an exact-value token exists: `#2a2b2e` → `ui.color.border`, `#4ade80` → `ui.color.accent`, `#141517` → `ui.color.input`, `#4a4b4e` → `ui.color.textDim`, `#6b7280` → `ui.color.textMuted`, `#f87171` → `ui.color.danger`, `#1a3a1a` → `ui.color.accentBg`, plus `border.default` for `1px solid #2a2b2e`. Rules:

- **Exact value match only.** `#d4d4d4` is NOT `ui.color.textStrong` (`#e2e4e6`); either add a new token for `#d4d4d4` (it appears across all these files — a candidate `ui.color.textBody` or similar) or leave it raw in this pass. Never substitute a near-match — that is a visual change.
- Values with no token and no cross-file recurrence (the `TypeBadge` hue trios, banner tints `#0f2a15`/`#1a4a25`/`#2a1a1a`/`#5a2020`, probe colors) stay local. Add tokens only for values that recur across files (per CLAUDE.md: "add new shared tokens there when a value is meant to become a convention").
- Same sweep applies opportunistically to the row styles moved in Phase B (`SettingRow`, `HotkeyRow`, `KeyBadge` are full of `#141517`/`#2a2b2e`/`#3a3b3e`) — same exact-match rule.

## Tests

Renderer project (happy-dom + RTL + real Zustand store per `__mocks__/zustand.ts` auto-reset; do not mock the settings store). Suggested files:

- `SettingsPanel/settingsSearch.test.ts` (Phase A3): unit tests for `matchesSettingQuery` — empty query matches; single-token prefix (`"scrollb"` vs `"terminal scrollback lines history memory buffer maximum"`); multi-word in order (`"branch badges"`); **reordered** (`"badges branch"` — the headline fix); non-matching token rejects the whole query (`"branch zebra"`); case insensitivity; the nav-card cases (`"serv"` matches the MCP keywords, `"open mcp"` behavior is pinned explicitly). Pin the dead-clause removal: `"update"` still surfaces the Updates card via the keyword list alone.
- `SettingsPanel/McpSection.test.tsx` (Phase A1): remount-on-target-switch test — render `McpSection` with two custom servers in the settings store, `openEdit(A)`, assert Args input shows A's args, `openEdit(B)` (click B's edit button), assert Args input now shows B's args (fails without the `key`); also Edit→Add shows empty form.
- Same file (Phase A2), with `vi.useFakeTimers()`: save twice within 2s → banner still visible until 2s after the **second** save; unmount before timers fire → no act/state-update warnings and no throw on `vi.runAllTimers()`; test-state reset timer per server does not clobber a re-test.
- Per-setting component tests (Phase B, boy-scout rule — one per extracted component): `GitBranchBadgesSetting.test.tsx` renders against the real store, asserts the checkbox reflects `showGitBranchBadges`, fires a click, asserts the store updated. Same shape for `TabOverflowSetting` (button group selection), `OptimizedRendererSetting`, `GpuAccelerationSetting`, `RescaleGlyphsSetting`; `ContrastRatioSetting` and `ScrollbackSetting` additionally cover draft commit-on-Enter/blur and normalization clamping (reuse `normalizeTerminalScrollbackLines`/`normalizeContrastRatio` expectations), and the scrollback preset buttons.
- `SettingsPanel/SearchResults` characterization (Phase B): render the panel, type a query that hits an Appearance and a Terminal setting, assert both rows appear once; toggle a setting from search results and assert the store updated (proves search results are live controls, not dead copies).
- Phase C is style-only; no new behavior tests. Existing `CommandPalette/index.test.tsx` and `SessionBrowser/index.test.tsx` must stay green, which they will only if the shells keep the same DOM structure/handlers.

`npm run typecheck` covers the test files (Vitest does not type-check).

## Risks

- **Visual regressions (Phases B and C).** Pixel-identical is the bar. Phase B moves JSX verbatim; Phase C substitutes only exact-value tokens. Two knowing exceptions require explicit sign-off in the PR: (1) adding the missing `hotkeyTerminalWarning` banner to search results (fixing existing drift), (2) nothing else. Any near-match token substitution (e.g. `#d4d4d4` → `textStrong`) is a bug, not a cleanup.
- **Settings search behavior change (Phase A3) — must be documented in the PR:**
  - *Now matches, didn't before:* reordered multi-word queries (`"badges branch"`, `"lines scrollback"`); queries with extra non-matching-order words against inline settings (`"branch badges tabs"` in any order); prefix queries against nav cards (`"serv"` → MCP, `"upgr"` → Updates); token-prefix hotkey search (`"clo tab"` → Close Tab).
  - *Matched before, won't now:* queries containing a token that prefixes nothing (`"git branch!"`, `"the mcp"` — `"the"` matches no keyword token). Previously the nav-card direction tolerated arbitrary filler words (`"open the mcp settings"` matched); under token-AND semantics it will not unless filler tokens happen to prefix keywords. If this is deemed too strict for nav cards, an acceptable variant is: nav cards pass if **any** query token prefix-matches (OR semantics) while inline settings require all (AND) — decide once, document, and pin with tests. Default recommendation: AND everywhere, for one predictable rule.
  - Cross-substring matches inside a token (`"rollback"` matching `"scrollback"`) are lost — acceptable.
- **Draft-state relocation (B1).** Moving `scrollbackDraft`/`contrastDraft` into the components resets drafts on unmount (view switch / section switch). Current behavior already commits on blur before any view switch driven by typing in the search box, so no user-visible change is expected — but verify manually (type a partial scrollback value, then search, then clear search; the field must not hold a stale uncommitted draft that later commits surprisingly).
- **ServerForm `key` remount (A1)** also discards in-progress *unsaved* edits when switching targets — that is the fix's intended semantics (previously it kept the *wrong* data), but note it: `openEdit(B)` now cleanly abandons A's unsaved form state.
- **Timer semantics (A2):** repeat-save now extends the banner window instead of truncating it. Cosmetic, but pin it in the test so the choice is deliberate.
- **z-index unification temptation (C1):** SessionBrowser is 50, the others 60. Keep them distinct via tokens; unifying is out of scope and could change stacking when overlays coexist.

## Verification Steps

1. `npm test` — all projects green, including the new tests above.
2. `npm run typecheck` — green (catches prop-interface removals and token typos in `satisfies` blocks).
3. Manual, per phase:
   - **A:** Open Settings → MCP. Add servers A (args `-y foo`, env `K=1`) and B (args `-z bar`, no env). Edit A, then without cancelling click Edit on B: form must show B's args/env. Save B; re-open B and confirm no `foo`/`K=1` leakage. Save twice quickly: banner behaves; run a Test twice quickly on an HTTP server: state resolves to the second result. Close Settings immediately after a save/test: no console errors.
   - **A44:** In Settings search, try `"badges branch"`, `"scrollb"`, `"serv"`, `"open mcp"`, `"lines scrollback"`, `"update"` — results match the documented matrix.
   - **B:** Walk every section (Appearance, Hotkeys, Terminal, MCP, Providers, Updates) and compare against a pre-change build side-by-side (or screenshots). Then search a query hitting each duplicated row and toggle each control **from the search results view**; confirm the section view reflects it. Confirm the GPU diagnostics box appears only in the Terminal section, never in search. Confirm command palette `settings.open.hotkeys` etc. still deep-link to the right section.
   - **C:** Open Settings, Session Browser (`Ctrl+Shift+O`), and Command Palette; compare each against pre-change screenshots — backdrop darkness, panel size/position (palette stays top-aligned at 15vh, others centered), borders, shadows, section-label typography. Open Session Browser and Settings paths that previously stacked, confirm ordering unchanged. Click-outside-to-close and ESC-to-close still work on all three.

## Handoff Contract

### Non-negotiables

1. **Overlay visual language unchanged.** The three overlays must render pixel-identically before/after (backdrop alphas 0.8/0.8/0.7, z-indexes 60/50/60, centered vs top-aligned layout, panel dimensions, header text). Tokens encode current values; they do not "improve" them.
2. **No VS Code-specific colors or layout treatments** introduced anywhere (CLAUDE.md UI Consistency).
3. **Command registry stays valid.** All `settings.open.<section>` entries in `src/renderer/src/commands/registry.ts` (appearance, hotkeys, mcp, providers, terminal, updates) must keep working — the `SettingsSection` union, `settingsInitialSection` deep-link read in the panel shell, and the sidebar section list must not change ids.
4. **Setting components read `useSettingsStore` directly** — zero settings values/setters tunneled through `SearchResults` props after Phase B. The residual `SearchResults` interface carries only query/visibility/hotkey-shell/navigation concerns.
5. **Do not mock the Zustand store in tests**; use the real store with the repo's auto-reset mock. Timer tests use `vi.useFakeTimers`.
6. **The section-nav "never filter by query" invariant** (index.tsx comment at 253–256) and the "diagnostics only in section mode" rule (546) survive the refactor.
7. **Exact-value token substitution only** in Phase C; near-match substitutions are rejected in review.
8. **No source-file behavior changes beyond the five items** — this spec authorizes no drive-by refactors of hotkey recording, MCP probe/test networking, or the settings store.

### Definition of Done

- [ ] `<ServerForm key={editingId ?? 'new'}>` in place; `prevType` effect deleted; remount test green.
- [ ] All three McpSection/ServerForm timers ref-held, cleared on reschedule and unmount; fake-timer tests green.
- [ ] `matchesSettingQuery` helper is the single matcher for inline settings, hotkey labels, and nav cards; dead `'update'` clause deleted; matcher unit tests (including reordered multi-word) green; behavior-change matrix documented in the PR description.
- [ ] Seven setting components exist under `SettingsPanel/settings/`, each with a render+interact test against the real store; the duplicated-rows table above has zero remaining duplicate JSX (grep for `"Git branch badges"` etc. finds exactly one render site each).
- [ ] `SearchResults.tsx`, `UpdatesSection.tsx`, `HotkeyRow.tsx` (+ shared helpers) are sibling files; `SettingsPanel/index.tsx` is under ~500 lines and contains no setting-row JSX.
- [ ] `overlayStyles` (and z tokens) in `theme.ts`; all three overlays consume it; one shared `SectionLabel`; the four private copies deleted; McpSection contains no raw `#2a2b2e`, `#4ade80`, `#141517`, `#4a4b4e`, `#6b7280`, or `#f87171` literals.
- [ ] `npm test` and `npm run typecheck` green; manual verification steps above performed and noted in the PR.

## Out of Scope

- Backlog item 20 settings-search *scope* changes (what is searchable) — only the matching *algorithm* changes here.
- Replacing `window.prompt()` rename in the command palette; any command-registry additions.
- Unifying the overlays' intentional differences (backdrop alpha, z-index, alignment, dimensions).
- Token sweeps outside `SettingsPanel/**` and the three overlay shells (e.g. Sidebar, TabBar hex literals).
- MCP probe/test/import logic, `testConnection` timeout-on-throw cleanup (optional boy-scout only), Codex/Claude preview builders.
- Backlog items 28/29/31 (handlers.ts, panes.ts, TabBar splits) and everything else in spec 032 not listed in the header.
- Any main-process or shared-types change.
