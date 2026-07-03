# 037 — Renderer Render-Performance Sweep

Covers backlog items **6, 16, 17, 18, 22** from `specs/pending/032-code-improvement-backlog.md` (Phase 2 render fixes). Scope is selector/memoization changes only — no structural extraction, no behavior changes, no new IPC.

## Problem

The renderer re-renders far more components, far more often, than the UI actually changes. Two systemic amplifiers:

1. **The 5-second sessions push.** Main polls session transcripts every 5s and pushes `sessions:updated`; `useSessionsStore` replaces the entire `sessions` array on every push, even when nothing meaningful changed for a given consumer. Every component that subscribes to the raw array (`(s) => s.sessions`) re-renders every 5 seconds, forever, while the app is open.
2. **Hydrated inactive tabs stay mounted** (a deliberate CLAUDE.md invariant — scrollback and live PTY state must survive tab switches). So "every mounted pane" is not "panes in the active tab"; it is every pane in every tab that has ever been focused this session. A whole-app-scoped selector mistake is multiplied by the total mounted pane count, not the visible pane count.

Concretely: with 2 hydrated tabs of 4 panes each, a single focus change re-renders 8 `PaneContainer`s, 8 unmemoized `PaneHeader`s, and 8 unmemoized 906-line `Terminal`s; every 5s tick re-renders all 8 `PaneHeader`s plus the TabBar and Sidebar, which each re-walk every pane tree and rebuild label Maps. On top of that, every keydown in a terminal rebuilds the full terminal-keybinding lookup Map (and, for Ctrl/Meta keydowns, the full hotkey table).

None of this is a correctness bug. All of it is avoidable render/CPU waste on the hottest interactive paths (typing, focusing, tab switching), and it grows linearly with tab/pane count.

## Current Behavior (verified 2026-07-03; line numbers corrected against actual code)

### Item 6 — PaneContainer focus selector re-renders every mounted pane

`src/renderer/src/components/PaneGrid/PaneContainer.tsx:13-16`:

```tsx
const focusedPaneId = usePanesStore((s) => {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return tab?.focusedPaneId ?? ''
})
```

The selector returns the active tab's `focusedPaneId` **string**. Zustand re-renders a subscriber when the selected value fails `Object.is`; since every mounted `PaneContainer` (across all hydrated tabs) selects the same string, **every** one of them re-renders on:

- every focus change (the string changes for all of them), and
- every tab switch (`activeTabId` changes which tab's `focusedPaneId` is read).

Each re-render also re-renders its children, because neither is memoized:

- `PaneHeader` — `src/renderer/src/components/PaneHeader/index.tsx:28`: `export function PaneHeader(...)`, plain function, no `React.memo`.
- `Terminal` — `src/renderer/src/components/Terminal/index.tsx:63`: `export function Terminal(...)`, plain function, no `React.memo`, 906 lines with several `useEffect`s whose dep checks all re-run.

Only the pane losing focus and the pane gaining focus actually need to re-render (their `isFocused` / header styling changes).

### Item 16 — PaneHeader subscribes to the full sessions array

`src/renderer/src/components/PaneHeader/index.tsx:41`:

```tsx
const sessions = useSessionsStore((s) => s.sessions)
```

The array identity changes on every 5s push, so **every mounted PaneHeader re-renders every 5 seconds**, multiplied by hydrated-tab pane count. The array is then used only to derive two values:

- `:143` — `const label = paneLabelText(pane, sessions)` (a string)
- `:146-148` — linear `sessions.find(...)` for the pane's session, used at `:150-152` solely for `session?.gitBranch` (a string, and only when `showGitBranchBadges` is on and the local `useGitBranch(pane.cwd, ...)` probe returned `undefined`)

Both derived values are strings — `Object.is`-stable across pushes that don't change them. Selecting the strings instead of the array skips the re-render for unchanged headers.

### Item 17 — TabBar recomputes labels and agent flags every render

`src/renderer/src/components/TabBar/index.tsx`:

- `:477` — `const sessions = useSessionsStore((s) => s.sessions)` → TabBar re-renders every 5s push.
- `:486` — `const labels = computeLabels(tabs, sessions)` — plain call in the render body. `computeLabels` (`src/renderer/src/utils/tabLabels.ts:51-81`) walks every tab's pane tree and allocates a **new Map every render**.
- `:625-629` — `startRename` is `useCallback(..., [labels])`; because `labels` is a fresh Map each render, the callback is recreated every render, defeating the memo and cascading into anything that receives it.
- `:636-639` — `hasAgentPane(tab)` calls `collectLeaves(tab.rootNode)` (fresh array per call), and `:827-830` calls it once per non-detached tab inside the tab-strip `.map()`, so every TabBar render re-walks every tree.

TabBar renders on tab/pane/focus/drag/settings changes *and* on the 5s tick — each render pays full tree walks and Map allocation.

### Item 18 — Sidebar re-walks pane trees per render; SessionBrowser search defeats its memo

`src/renderer/src/components/Sidebar/TabSections.tsx`:

- `:27` — subscribes to raw `sessions`; `:54` — `const tabLabels = computeLabels(tabs, sessions)` unmemoized in the render body (same fresh-Map-per-render problem as TabBar).
- `:150` — inside `tabs.map(...)`: `const leaves = tab.rootNode ? collectLeaves(tab.rootNode) : []` — every tree re-walked per render.
- `:467` — inside `PaneRow` (rendered once per pane): `const isOnlyPane = !tab.rootNode || collectLeaves(tab.rootNode).length <= 1` — the **same tab's tree is re-collected once per pane row**, i.e. O(panes²) walks per tab per render, even though the parent at `:150` already has the leaves.

`src/renderer/src/components/SessionBrowser/index.tsx:89-90`:

```tsx
const summarySessions = query ? search(query) : sessions
const summaryGrouped = useMemo(() => groupByProject(summarySessions), [summarySessions])
```

`search` comes from `useSessions()` (`src/renderer/src/hooks/useSessions.ts:45-55`), which creates a **new closure returning a new filtered array on every render**. So whenever a query is active, `summarySessions` has fresh identity every render and the `summaryGrouped` memo recomputes every render (keystrokes, deep-search state changes, the 5s push — everything). The memo is effectively dead code while typing.

### Item 22 — Per-keystroke rebuild of the terminal key map and hotkey table

`src/renderer/src/components/Terminal/index.tsx`, inside `attachCustomKeyEventHandler`:

- `:271` — `buildTerminalKeyMap(useSettingsStore.getState().terminalKeyBindings).get(bindingEventKey(e))` — the full two-pass lookup Map (`src/renderer/src/utils/terminalKeyBindings.ts:201-221`) is rebuilt **on every keydown, in every pane**.
- `:310` — for Ctrl/Meta keydowns, `buildHotkeys(useSettingsStore.getState().hotkeyOverrides)` rebuilds the full hotkey record (`src/renderer/src/utils/hotkeys.ts:40-51`) plus a fresh `dispatch` object.

The `getState()`-at-event-time pattern is **intentional and documented in the handler comment** (`:264-270`): bindings are read from settings at event time so rebinds apply immediately without re-attaching the handler or remounting the pane. The fix must keep that property. The waste is only the rebuild when the input hasn't changed: the settings store replaces the `terminalKeyBindings` array (and `hotkeyOverrides` object) on rebind, so the array/object **reference** is a correct and sufficient cache key.

### Amplification summary

| Trigger | Frequency | Today re-renders / recomputes |
|---|---|---|
| `sessions:updated` push | every 5s, always | every mounted PaneHeader (item 16), TabBar full render + tree walks + Map alloc (17), TabSections full render + O(panes²) walks (18), SessionBrowser regroup when open with query (18) |
| Focus change / tab switch | per user click/hotkey | every mounted PaneContainer + PaneHeader + 906-line Terminal across all hydrated tabs (6) |
| Keydown in any terminal | per keystroke | full `buildTerminalKeyMap`; plus `buildHotkeys` + dispatch object when Ctrl/Meta held (22) |

These multiply: the 5s push re-renders TabBar/TabSections, whose renders re-walk every tree of every mounted tab, which exist because hydrated tabs stay mounted by design.

## Intended Behavior

- A focus change re-renders exactly the two affected `PaneContainer`s (and their headers); `Terminal` and `PaneHeader` skip re-render when their props/selected values are unchanged.
- A 5s sessions push that doesn't change a pane's label or git branch does not re-render that `PaneHeader`.
- TabBar and TabSections compute `computeLabels` / per-tab leaves at most once per `[tabs, sessions]` change, not once per render; `startRename`'s `useCallback` is stable while labels are unchanged.
- `PaneRow` no longer re-collects its tab's leaves; the parent passes down what it already computed.
- SessionBrowser's `summaryGrouped` memo actually holds: `summarySessions` identity changes only when `query` or the underlying session list changes.
- Keydown handling reuses the previously built key map / hotkey table when the bindings array / overrides object reference is unchanged, while rebinds still apply on the very next keystroke with no remount or re-attach.

## Implementation Plan

Work item-by-item; each is independently landable. Suggested order: 22 → 6 → 16 → 17 → 18 (pure-utility change first, then the highest-win component, then the sweep).

### Item 22 — one-slot memos in the pure utility modules

In `src/renderer/src/utils/terminalKeyBindings.ts`, wrap the existing builder without touching its logic:

```ts
let lastBindings: TerminalKeyBinding[] | null = null
let lastMap: Map<string, ResolvedEntry> | null = null

/** One-slot memo keyed on the bindings array REFERENCE. The settings store
 * replaces the array on any rebind, so reference identity is a sound cache key.
 * Same-reference calls return the SAME Map instance. */
export function getTerminalKeyMap(bindings: TerminalKeyBinding[]): Map<string, ResolvedEntry> {
  if (bindings !== lastBindings || lastMap === null) {
    lastBindings = bindings
    lastMap = buildTerminalKeyMap(bindings)
  }
  return lastMap
}
```

Keep `buildTerminalKeyMap` exported (tests and any cold-path callers keep using it). Add the mirror-image `getHotkeys(overrides)` one-slot memo in `src/renderer/src/utils/hotkeys.ts` around `buildHotkeys` (keyed on the `overrides` object reference).

In `src/renderer/src/components/Terminal/index.tsx`:

- `:271` → `getTerminalKeyMap(useSettingsStore.getState().terminalKeyBindings).get(bindingEventKey(e))`
- `:310` → `const hotkeys = getHotkeys(useSettingsStore.getState().hotkeyOverrides)`

**Non-negotiable:** the `useSettingsStore.getState()` call stays *inside* the event handler. Do not hoist bindings into component state, a ref, or the closure — that is exactly the read-at-event-time semantics the handler comment documents. Optionally also memoize the `:311-321` `dispatch` object keyed on the `hotkeys` result identity (now stable), but only if it stays a pure lookup.

Before wiring: verify the settings store really replaces (not mutates) `terminalKeyBindings` / `hotkeyOverrides` on every rebind path in `src/renderer/src/store/settings.ts` (including `mergeBindings` on load, reset-to-default, and macro add/remove). If any path mutates in place, fix it to replace — otherwise the memo would serve a stale map.

Also audit other callers: `registry.ts` calls `buildHotkeys(hotkeyOverrides)` in `shortcut` functions per render (documented as by-design — **do not change the registry's evaluation model**; it may simply call `getHotkeys` and get the memo for free). Settings UI callers of `buildTerminalKeyMap` may remain on the raw builder.

### Item 6 — boolean focus selector + memoized children

`src/renderer/src/components/PaneGrid/PaneContainer.tsx` — replace the string selector (`:13-16`) with a boolean:

```tsx
const isFocused = usePanesStore((s) => {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return tab?.focusedPaneId === pane.id
})
```

Delete the `focusedPaneId` local and the old `isFocused` derivation at `:19`. Now the selected value flips only for the pane gaining focus and the pane losing it; all other mounted panes select `false` before and after and skip.

Note the semantics change on tab switch: previously "focused" was computed against the active tab, so a background tab's focused pane already rendered `isFocused === true` styling incorrectly? No — verify: the old code reads the *active* tab's `focusedPaneId`, so background-tab panes compare against the active tab's id and render unfocused. The new selector must preserve that: `tab` here is still the **active** tab, so a background tab's focused pane still gets `false`. Keep it exactly as written above (active-tab lookup, not "the pane's own tab").

Then memoize the children so an unavoidable parent render doesn't cascade:

- `PaneHeader/index.tsx` — export `React.memo`-wrapped component (`export const PaneHeader = React.memo(function PaneHeader(...) {...})`). Props are `{ pane, isFocused }`; `pane` is a `PaneLeaf` object whose identity changes when the pane changes (store updates rebuild leaves — see backlog item 10), so default shallow compare is correct. Do **not** write a custom comparator that deep-compares `pane` — that would mask real updates (cwd, sessionId, customName).
- `Terminal/index.tsx` — same `React.memo` wrap for `{ pane, layoutKey }`. `layoutKey` is a string. No custom comparator.

`React.memo` here is belt-and-braces (the boolean selector already removes most parent renders) but protects against future `PaneContainer` subscriptions.

### Item 16 — PaneHeader selects derived strings, not the array

In `src/renderer/src/components/PaneHeader/index.tsx`, remove `:41` (`const sessions = useSessionsStore((s) => s.sessions)`) and replace the two consumers:

```tsx
const label = useSessionsStore((s) => paneLabelText(pane, s.sessions))
const sessionGitBranch = useSessionsStore((s) =>
  pane.agentKind && pane.sessionId
    ? s.sessions.find((x) => x.agentKind === pane.agentKind && x.sessionId === pane.sessionId)?.gitBranch
    : undefined
)
```

Both return strings/undefined, so `Object.is` skips the re-render when a push doesn't change this pane's label or branch. Update `:150-152` to use `sessionGitBranch` in place of `session?.gitBranch`. The `session` local (`:146-148`) is used only for `gitBranch` — delete it.

Selectors run per push (cheap: one `find` + one label format per header) but re-renders stop. Keep `paneLabelText` pure (it is — `tabLabels.ts:20-35`).

Note: the selectors close over `pane`, which is fine — when `pane` identity changes the component re-renders anyway and the new closure is installed by `useSyncExternalStore` on that render.

### Item 17 — TabBar memoizes labels and agent flags

In `src/renderer/src/components/TabBar/index.tsx`:

- `:486` → `const labels = useMemo(() => computeLabels(tabs, sessions), [tabs, sessions])`. This immediately stabilizes `startRename` (`:625-629`, `useCallback` dep `[labels]`) across renders where tabs/sessions are unchanged.
- `:636-639` — replace the `hasAgentPane` function + per-tab `collectLeaves` calls at `:827-830` with one memo:

```tsx
const agentTabIds = useMemo(() => {
  const set = new Set<string>()
  for (const t of tabs) if (t.rootNode && collectLeaves(t.rootNode).some((l) => l.paneType === 'agent')) set.add(t.id)
  return set
}, [tabs])
```

and at `:830` use `const live = agentTabIds.has(tab.id)`.

TabBar still re-renders on the 5s push (it subscribes to `sessions` because labels genuinely depend on session project names) — that is correct; the win is skipping the tree walks and Map/callback churn when identities are unchanged, and recomputing once (not per tab) when they change. If profiling later shows label-only dependence, a `sessions`-derived label-input projection could narrow it, but that is out of scope here.

### Item 18 — TabSections memos + leaves passed down; SessionBrowser search memo

`src/renderer/src/components/Sidebar/TabSections.tsx`:

- `:54` → `const tabLabels = useMemo(() => computeLabels(tabs, sessions), [tabs, sessions])`.
- `:150` — the per-tab `collectLeaves` inside `tabs.map` cannot use a hook (inside a loop). Hoist one memo above the return: `const leavesByTab = useMemo(() => new Map(tabs.map((t) => [t.id, t.rootNode ? collectLeaves(t.rootNode) : []])), [tabs])`, then `const leaves = leavesByTab.get(tab.id) ?? []` at `:150` (and reuse it anywhere else the same walk happens in this component, e.g. the detached-tab branch if it collects leaves too — check both render paths).
- `:467` — `PaneRow` re-collects the tree per row for `isOnlyPane`. Add an `isOnlyPane: boolean` prop to `PaneRow` (`:420-436` props) and compute it at the call sites from the parent's `leaves` (`leaves.length <= 1`). Delete the `collectLeaves` call inside `PaneRow`. Grep for **all** `<PaneRow` call sites (local and detached-tab branches) and pass the prop in each.
- Optional, same pattern as item 16: `PaneRow` also receives the full `sessions` array as a prop (`:425`, `:433`) and does its own `find` at `:460-462`. Passing derived strings (or keeping the array prop but wrapping `PaneRow` in `React.memo` won't help — the array identity changes every push) is a worthwhile follow-on; if done, mirror the item-16 selector approach inside `PaneRow` and drop the `sessions` prop. Mark clearly in the PR if deferred.

`src/renderer/src/components/SessionBrowser/index.tsx:89`:

```tsx
const summarySessions = useMemo(() => (query ? search(query) : sessions), [query, sessions, search])
```

But note `search` itself has fresh identity per render (`useSessions.ts:45`), which would defeat this memo. Fix at the source: in `src/renderer/src/hooks/useSessions.ts`, wrap `search` in `useCallback` keyed on `[withLive]` (and `resumable` in `useMemo` keyed on `[withLive, liveIds]` while there — same fresh-array-per-render issue). Then the SessionBrowser memo above holds and `summaryGrouped` (`:90`) stops recomputing on unrelated state changes (deep-search spinner ticks, detail-panel opens).

## Tests

All in the **renderer Vitest project** (happy-dom + React Testing Library), real Zustand stores via the auto-reset mock (`__mocks__/zustand.ts`, activated by `vi.mock('zustand')` in `tests/setup.renderer.ts`). Do not mock the stores' behavior — set state with the real actions / `setState`. Co-locate tests beside source per the boy-scout rule.

### Render-count probe pattern

Use a module-scoped counter bumped in the component body via a thin wrapper, or spy-count with a probe child:

```tsx
const renderCounts = new Map<string, number>()
function CountingProbe({ id }: { id: string }): null {
  renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1)
  return null
}
```

For counting `PaneContainer` renders without editing production code, render `PaneContainer` for several panes and assert via `React.Profiler` `onRender` callbacks (id per pane), which is the least invasive probe.

### Item 6 — `PaneContainer.test.tsx`

- Seed `usePanesStore` with one tab, four leaf panes (build a real `PaneSplit` tree via the store's own split actions or a hand-built `rootNode` + `setState`), `focusedPaneId = pane0`.
- Render all four `PaneContainer`s inside `React.Profiler`s. Mock nothing except stubbing `Terminal`/`PaneHeader` heaviness is NOT allowed to invalidate the test — but xterm cannot mount in happy-dom, so stub the `xtermRegistry` module (`vi.mock('../../utils/xtermRegistry')`) rather than the store; alternatively assert on `PaneContainer`'s own profiler commits with children replaced via `vi.mock` of the `Terminal` module (acceptable: the unit under test is the selector, not Terminal).
- Act: `usePanesStore.getState().focusPane(pane1.id)` (or `focusPaneInTab`). Assert: profiler commit counts increment **only** for pane0 and pane1; pane2/pane3 commit counts unchanged.
- Second assertion: add a second tab, switch `activeTabId`; panes in the non-active tab render unfocused (`outline: 'none'` / boolean false) — guards the "active-tab lookup, not own-tab lookup" semantics.

### Item 16 — `PaneHeader.test.tsx`

- Render `PaneHeader` for an agent pane with `sessionId`; seed `useSessionsStore` with a sessions array containing its session.
- Act: `useSessionsStore.setState({ sessions: [...same data, new array + new object identities] })` (simulating the 5s push with unchanged content). Assert render count does **not** increase (profiler or probe).
- Act: push again with a changed `projectName` (label input) — assert re-render and new label text in the DOM.
- Act: push with changed `gitBranch` and `showGitBranchBadges` enabled — assert the branch text updates (stale-UI guard).

### Item 17/18 — `TabBar.test.tsx` / `TabSections.test.tsx`

- Spy on the labels path: `vi.spyOn(tabLabelsModule, 'computeLabels')` (import-namespace spy; `computeLabels` is a plain export). Render, note call count; force a re-render that changes neither `tabs` nor `sessions` (e.g. toggle an unrelated store field the component subscribes to, like `commandPaletteOpen` for TabBar); assert `computeLabels` was not called again. Then replace `tabs` (rename a tab via the real `renameTab` action) and assert exactly one more call and the new label in the DOM.
- `startRename` stability: capture the callback identity across an unrelated re-render (expose via a ref or assert indirectly: the rename input pre-fills correctly after a sessions push — behavioral guard).
- TabSections: assert `collectLeaves` call count per render is O(tabs) not O(tabs + panes) — spy on it; and that `PaneRow` renders correctly with the new `isOnlyPane` prop: single-pane tab hides the close-forbidden affordance exactly as before (assert on whatever `isOnlyPane` gates in the row's DOM).
- SessionBrowser: seed sessions, type a query, capture `summaryGrouped`-derived DOM; trigger an unrelated state change (e.g. `setDeepSearching` path via mode toggle and back) and assert `groupByProject` (spy) was not re-invoked for an unchanged `[query, sessions]`.

### Item 22 — `terminalKeyBindings.test.ts` (extend existing) / `hotkeys.test.ts`

- **Same-reference → same Map:** `const b = defaultTerminalKeyBindings(); expect(getTerminalKeyMap(b)).toBe(getTerminalKeyMap(b))` — strict instance equality, not deep equality.
- **New reference → new Map with new behavior:** rebind one entry into a *new array* (spread + replaced element, as the settings store does); assert `getTerminalKeyMap(newArr)` is a different instance, resolves the new trigger, and contains the vacated-default `suppress` entry (reuse the existing `buildTerminalKeyMap` suppress assertions against the memoized entry point).
- **Read-at-event-time integration guard:** in the Terminal keydown path this is hard to drive in happy-dom (xterm); instead assert at the utility level plus one store-level test: set `useSettingsStore` bindings to A, call `getTerminalKeyMap(useSettingsStore.getState().terminalKeyBindings)`, rebind via the real settings action, call again — the second call must reflect the rebind (this fails if the store ever mutates in place, which is the real regression risk).
- Mirror the same three tests for `getHotkeys` (same instance for same overrides reference; rebind via real settings action → new table with new key).

Determinism notes: no timers/uuids involved except store defaults — no `vi.setSystemTime` needed. Do not assert on Map iteration order beyond what existing tests already pin.

## Risks

Selector/memo changes trade "always fresh because always recomputed" for "fresh only when the dependency key changes." Each new selector/memo must still react to everything the old code reacted to:

- **Item 6 boolean selector** must still react to: focus changes within the active tab (both panes), `activeTabId` changes (a background tab's previously-focused pane must show focused when its tab becomes active — the selector reads the active tab, so this works, but the test above pins it), and tab removal (find returns undefined → `false`; no crash).
- **Item 6 `React.memo` on PaneHeader/Terminal** must not swallow pane updates. Safe only because store updates replace leaf objects (`updateLeaf` rebuilds nodes). **If backlog item 10 (identity-preserving `updateLeaf`) lands, it preserves identity for *untouched* leaves only — changed leaves still get new identity — so memo remains correct; but coordinate: do not let item 10 be implemented as in-place mutation.** No custom comparators.
- **Item 16 derived-string selectors** must still react to: session `projectName` changes (label), `customName`/`cwd` changes (arrive via `pane` prop, not the selector — unaffected), `gitBranch` changes, and the session appearing for the first time after Codex detection (find goes from miss to hit → label string changes → re-render). The gitBranch selector returns `undefined` both for "no session" and "session without branch" — acceptable, same rendered output.
- **Item 17/18 `useMemo([tabs, sessions])`** is only correct while the stores replace `tabs`/`sessions` arrays on change (they do — Zustand immutability convention; `setPaneCwd` etc. return new arrays). Any future in-place mutation would show stale labels; the tests above catch the label path.
- **Item 18 `isOnlyPane` prop**: must be passed at every `PaneRow` call site including the detached-tab render branch — a missed site changes close-button behavior. Grep for `<PaneRow` and count.
- **Item 22 one-slot memo**: single-slot means two alternating bindings arrays would thrash — cannot happen (one settings store instance per renderer process). The real risk is **in-place mutation in the settings store** serving a stale map: audit and test as specified. Also: the memoized Map is shared — no caller may mutate the returned Map (current callers only `.get`; keep it that way, or return it typed as `ReadonlyMap`).
- **Registry per-render evaluation** (CLAUDE.md invariant): `shortcut`/`enabled` functions must keep being *called* per render. Memoizing `buildHotkeys` inside `getHotkeys` does not change when the registry calls it — verify no change to `registry.ts` call sites' evaluation timing.

## Verification Steps

1. `npm test` — all existing suites plus the new tests above green.
2. `npm run typecheck` — green (new props, memo wrappers, hook signature changes are type-visible).
3. Manual, dev build (`npm run dev`):
   - Open 2 tabs × 4 panes each; focus each tab once so both are hydrated. Open React DevTools Profiler, start recording, click between panes: only the two affected `PaneContainer`s (and their headers) commit; Terminals do not re-render. Switch tabs: no full-app commit storm.
   - Leave the profiler recording ~15s idle (3 session pushes): PaneHeaders do not commit; TabBar/TabSections commit at most on real label changes.
   - Type rapidly in a shell pane with the Performance panel: no per-keystroke `buildTerminalKeyMap` cost (verify via a temporary `console.count` in the builder or the profiler flame chart).
   - **Rebind check (critical):** Settings → Terminal key bindings, rebind "Send interrupt" to a new combo; without closing or refocusing the pane, press the new combo (must fire) and the old default (must be suppressed) on the very next keystrokes. Rebind an app hotkey (e.g. zoom pane) and confirm it applies immediately in an existing pane.
   - Rename a tab, rename a pane, let a Codex session get detected (session id appears): labels update everywhere (tab bar, sidebar, pane header) without reload — stale-UI sweep.
   - Session Browser: type in Summary mode — filtering live per keystroke; toggle git-branch badges on and confirm branches still appear/update.

## Handoff Contract

### Non-negotiables

1. **No flow control.** Nothing in this spec touches `pty:data`, acks, coalescing, pause/resume, or the direct synchronous `terminal.write` path. If a change drifts toward the terminal data pipeline, stop.
2. **Hydrated tabs stay mounted.** Do not "fix" re-render volume by unmounting inactive tabs' panes or gating `Terminal` mounts on tab visibility. Scrollback and live PTY state surviving tab switches is a documented invariant.
3. **Keybinding rebinds apply immediately, no remount.** `useSettingsStore.getState()` stays inside the keydown handler; the memo layer is reference-keyed caching *behind* that read, never a snapshot captured at mount/attach time. The rebind manual check in Verification is mandatory before merge.
4. **Command-registry `shortcut`/`enabled` functions keep per-render evaluation.** Sharing the `getHotkeys` memo is fine; changing when/whether the registry calls them is not.
5. **No behavior changes.** This is a pure render-performance PR: identical DOM output, identical interactions, identical labels/badges/focus visuals. Any observable difference is a bug in the PR.
6. **No source-code changes outside the files named in the Implementation Plan** (plus their new/extended test files). In particular: no store restructuring, no `panes.ts`/`TabBar` extraction, no changes to `computeLabels`/`collectLeaves`/`buildTerminalKeyMap` internals — only wrapping/memoizing/call-site changes.

### Definition of Done

- All five items implemented as specified (item 18's `PaneRow` sessions-prop follow-on may be deferred if explicitly noted in the PR description).
- New tests from the Tests section exist and pass; `npm test` and `npm run typecheck` green.
- Manual verification steps 3.x performed and reported in the PR description (especially the rebind check and the 2×4-pane profiler check with commit screenshots or a summary).
- Line-number references in backlog spec 032 items 6/16/17/18/22 marked done or removed from that file in the same PR.
- No changes to `src/main/**`, `src/preload/**`, or `src/shared/**`.

## Out of Scope

- **Structural extraction of `TabBar/index.tsx` (1200 lines) and `store/panes.ts` (2283 lines)** — backlog items 29 and 31 / Phase 4 of spec 032.
- **Identity-preserving `updateLeaf`** (backlog item 10) — multiplies the value of this spec but is a separate, riskier change with its own identity tests. Coordinate ordering only (see Risks).
- **Sessions push diffing in main** (backlog items 3/25) — reducing push frequency/content is a main-process concern; this spec makes the renderer indifferent to redundant pushes instead.
- SettingsPanel/SearchResults duplication (item 26), overlay theming (item 32), dead `usePanes()` hook removal (item 35) — separate PRs.
- Any `virtualization`/windowing of tabs or panes.
