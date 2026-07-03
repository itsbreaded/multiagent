# 043 — Panes Store and TabBar Structural Extraction

Covers items **29, 31, 35, 48, 49** from `specs/pending/032-code-improvement-backlog.md`. All items are behavior-preserving structural work except one deliberate, tiny behavior fix called out in Phase B (adding the missing `window.ipc` guard to `resumeAgentPane`). Every line number below was verified against the current tree; they will drift — re-verify anchors before editing.

## Problem

`src/renderer/src/store/panes.ts` is 2283 lines. It mixes three separable concerns: the Zustand store definition, a ~360-line module-level IPC wiring block (23 `window.ipc.on` listeners + 3 document-level drag listeners), and module-scope mutable focus-arming state shared between store actions and one of those listeners. Inside it, the agent session-resume sequence (`session:resume` invoke → re-find pane → set `ptyId` → `resumeError` on failure → `markTabHydrated`) is hand-rolled **four times with drifting guards** — one copy is missing the `window.ipc` existence guard entirely, and the copies disagree on whether they re-check the pane before applying the result. Two of the IPC listeners hand-roll a leaf-by-ptyId tree walk and one of them reimplements the `setSessionId` action's `setState` inline.

Separately, `TabBar/index.tsx` duplicates its four-button chrome cluster and `leftChromeWidth` math between the `LeftChrome` component and the non-wrap render branch, and `App.tsx` re-declares `TAB_DRAG_MIME` and re-implements TabBar's cross-window absorb/rollback and pane-transfer drop logic — transfer-critical code (spec 024 territory) that now exists in two copies that can drift independently.

Plus three trivial cleanups: a dead hook file, two lint-hostile pseudo-deps in Terminal effects, and a stale-closure-fragile effect in TabSections.

The repo precedent for this work is `src/shared/paneTree.ts` and `src/shared/cwdRepair.ts`: extract pure/isolated logic into a sibling module so it can be tested without `vi.mock` hacks, with zero behavior change.

## Current Behavior (evidence)

### Item 29a — module-level IPC wiring block (`panes.ts:1920-2282`)

Wired once at module load, guarded by `if (typeof window !== 'undefined' && window.ipc)`. Registrations, in source order:

| # | Channel / listener | Notes |
|---|---|---|
| 1 | `git:branch-updated` | patches `cwdGitBranches` |
| 2 | `pty:cwd` | → `setPaneCwd` |
| 3 | `pty:exit` | → `markPtyExited` |
| 4 | `session:detected` | hand-rolled leaf-by-ptyId walk + **inline `setState` duplicating `setSessionId`** (see 29b) |
| 5 | `session:detection-failed` | hand-rolled leaf-by-ptyId walk → `updatePane` |
| 6 | `layout:cwd-repaired` | → `applyCwdRepair` |
| 7 | `tab:release` | two-phase absorb handshake: with `releaseId`, ack-only and defer removal to `tab:absorb-committed` |
| 8 | `tab:absorb-committed` | finalizes the deferred release |
| 9 | `tab:return` | `returnTab` + re-adopt PTYs via `tab:adopt` |
| 10 | `pane:focus-remote` | `focusPaneInTab` + double-rAF ack `pane:focus-remote-applied` |
| 11 | `tab:spawn-in-project-remote` | `spawnInTab` + success-boolean ack |
| 12 | `pane:focus-changed` | primary-only merge of detached focus |
| 13 | `window:became-active` | **reads/writes module-scope focus-arming state** (`skipNextActivationDisarm`, `localRearmTimer`, `pendingRemoteFocusWindowId`) |
| 14 | `window:focus-state-request` | → `reportCurrentFocusTarget()` |
| 15 | `focus:target-changed` | version-gated confirmed-focus merge |
| 16 | `tab:state-sync` | primary-only `syncDetachedTabs` |
| 17 | `pane:received` | `addPaneToTab`, **acks only if the store action returned `true`** (spec 024) |
| 18 | `pane:remove-remote` | `removePaneKeepTab` |
| 19 | `pane:transfer-rolledback` | `removePaneKeepTab` |
| 20 | `pane:move-remote` | `movePaneToTab` |
| — | `window.addEventListener('dragover'/'drop'/'dragend', …, true)` ×3 | `paneDragActive` tracking; interleaved here in source order, between #20 and #21 |
| 21 | `renderer:remove-pane` | `removePaneById` |
| 22 | `renderer:insert-at-split` | `insertPaneAtSplit`, ack-on-`true`-only |
| 23 | `renderer:replace-pane` | `replacePaneById`, ack-on-`true`-only |

Registration-order check: each channel has exactly one listener, so cross-channel registration order has no delivery semantics — but preserve the order anyway (it costs nothing and keeps diffs reviewable). The three DOM drag listeners must stay capture-phase.

**HMR check (verified):** there is no `import.meta.hot` handling anywhere in `src/renderer`. `panes.ts` is a non-component `.ts` module, so `@vitejs/plugin-react` creates no HMR boundary for it — an edit propagates to the entry and triggers a **full page reload**, which is why module-level wiring cannot double-register today. The extracted module inherits this for free as long as it also declares no `import.meta.hot.accept`. Add an idempotence guard anyway (see Intended Behavior).

**Test-environment note:** `tests/setup.renderer.ts` calls `installMockIpc()` **before** test modules import, so the wiring block already runs against the no-op mock in every renderer test today. The header comment in `panes.test.ts` ("window.ipc is intentionally absent here") is stale — correct it while in the area.

### Item 29b — hand-rolled walkers and inline `setSessionId` (`panes.ts:1945-1983`)

- `session:detected` (1945-1964): loops tabs, `collectLeaves(tab.rootNode).find((l) => l.ptyId === ptyId)`, then an inline `setState` whose patch (`sessionId`, `sessionDetectionState: 'detected'`, `sessionDetectionError: undefined`, `resumeError: undefined`) is **byte-identical** to the `setSessionId` action at `panes.ts:1160-1170`. Replacing the inline block with `usePanesStore.getState().setSessionId(pane.id, sessionId)` is a pure deduplication.
- `session:detection-failed` (1966-1983): same walk pattern plus an `agentKind` match check, then `updatePane`.
- `paneTree.ts` already has `findLeafBySessionId`; there is no `findLeafByPtyId`.

### Item 29c — four drifting copies of the resume sequence

| Site | Location | `window.ipc` guard | `sessions:validate` first | Re-find guard before applying result | Requires `!current.ptyId` | `markTabHydrated` | Failure patch |
|---|---|---|---|---|---|---|---|
| `hydrateTabRuntime` | `panes.ts:118-204` (invoke at 148/164) | yes (125) | **yes** (148) — sets `resumeError: 'Session not found …'` on miss, no spawn | yes: paneType + agentKind + sessionId | **yes** | via `markReadyAfterRuntime` | `resumeError` via `agentIpcErrorMessage` |
| `resumeSession` | `panes.ts:1223-1262` (invoke at 1249) | yes (1247), with `markTabHydrated` in the else-branch | no | **no** — calls `setPtyId(leaf.id, …)` unconditionally (leaf is freshly created, so safe today) | n/a | `finally` (1257) | `resumeError` via `agentIpcErrorMessage` |
| `resumeSessionInNewTab` | `panes.ts:1264-1287` (invoke at 1276) | yes (1274), same shape | no | **no** — same as above | n/a | `finally` (1282) | same |
| `resumeAgentPane` | `panes.ts:1289-1326` (invoke at 1304) | **NO — the only unguarded copy**; throws in an ipc-less environment | no | yes: paneType + agentKind + sessionId + `result?.ptyId` | **no** (drifted) | none (pane lives in an already-hydrated tab) | `resumeError` + restores prior `agentDisconnected` |

The sibling helper `runNewAgentSession` (`panes.ts:405-434`) is the pattern to mirror: a module-scope `async function` taking `get`, the pane id, and an `extraFailurePatch`, already used by `spawnPaneCore` and `startNewAgentInPane`.

### Item 29d — focus-arming module state (`panes.ts:13-31`)

Five module-scope mutable bindings (`pendingRemoteFocusWindowId`, `pendingRemoteFocusTimer`, `localRearmTimer`, `skipNextActivationDisarm`, `skipDisarmClearTimer`) plus constants `LOCAL_REARM_MS`/`SKIP_DISARM_TTL_MS`. Written by store actions `focusLocalPaneFromSidebar` (1000-1005) and `focusDetachedPaneOptimistically` (1010-1016), and read/written by the `window:became-active` listener (2088-2141) and `clearPendingRemoteFocus` (36-44). **This shared state is why 29a cannot move the focus listeners out of `panes.ts` without first giving the state a home both files can import** — a minimal slice of 29d is therefore a Phase C prerequisite, not purely optional.

### Item 31 — TabBar/App duplication (transfer-critical)

- `TAB_DRAG_MIME = 'application/x-multiagent-tab'` declared independently at `TabBar/index.tsx:23` and `App.tsx:79`. (`PANE_DRAG_MIME` already lives in `utils/paneDrag.ts:3`.)
- Four-button cluster (sidebar toggle / session browser / palette / settings, each a `BarButton` + icon + hotkey title + `active` flag): `LeftChrome` at `TabBar/index.tsx:417-443` vs the non-wrap branch at `TabBar/index.tsx:733-779` (near-identical container styles; the non-wrap copy uses `chromeContentHeight` and renders only when `!isDetachedWindow && tabOverflowMode !== 'wrap'`).
- `leftChromePadding`/`controlClusterWidth`/`leftChromeWidth` computed twice: `TabBar/index.tsx:391-393` (LeftChrome) and `:481-483` (TabBar).
- Cross-window tab absorb: `TabBar` `handleCrossWindowDrop` (674-696) — decode `TAB_DRAG_MIME`, same-window bail, `receiveTab(tab, dropIndex)`, `invoke('tab:absorb', JSON.stringify(tab), ptyIds, sourceWindowId ?? -1)`, **rollback `removeTabLocally(tab.id)` when the invoke resolves `false`**. `App.tsx` root `onDrop` (242-269, tab branch 254-269) re-implements the identical sequence minus `dropIndex` (appends at end).
- Pane transfer drop: `TabBar` `handlePaneDrop` (698-710) — decode payload, same-window → `movePaneToTab`, else `invoke('pane:transfer', { ...payload, targetTabId, targetWindowId })`. `App.tsx:243-253` re-implements it with `targetTabId = activeTabId` (and no `clearPaneDragHover`, which is TabBar-local hover state — correctly not shared).

### Item 35 — dead `usePanes` hook

`src/renderer/src/hooks/usePanes.ts` (25 lines). Verified zero consumers: a repo-wide grep for `usePanes\b|hooks/usePanes` matches only the definition itself. It is also the repo's only whole-store subscription (`usePanesStore()` with no selector).

### Item 48 — pseudo-deps in Terminal effects

`src/renderer/src/components/Terminal/index.tsx` — both dep arrays end with the inline expression `status === 'mounting' ? 'mounting' : 'ready'`:
- Effect 2 (shell PTY creation), dep array at **line 425**.
- Effect 3 (PTY connect), dep array at **line 586**, under an `eslint-disable-next-line react-hooks/exhaustive-deps` at 585.

The expression is a hand-built two-valued dep (re-run only when crossing the mounting boundary, not on `connecting → ready`). Semantics are correct; the form defeats the exhaustive-deps lint and reads as a bug.

### Item 49 — TabSections pending-rename effect

`src/renderer/src/components/Sidebar/TabSections.tsx:108-113`:

```tsx
useEffect(() => {
  if (pendingRenameTabId && tabs.some((t) => t.id === pendingRenameTabId)) {
    startRename(pendingRenameTabId)
    setPendingRenameTabId(null)
  }
}, [pendingRenameTabId])
```

Deps omit `tabs` and `startRename`. It works today by ordering luck (the tab is in `tabs` by the time `pendingRenameTabId` is set). If the tab lands in `tabs` on a later render, the effect never re-fires and the pending rename is silently dropped — and the `tabs`/`startRename` closures are stale on any re-fire.

## Intended Behavior

1. `panes.ts` shrinks by roughly 400+ lines: IPC wiring lives in `src/renderer/src/store/panesIpc.ts`; focus-arming state lives in `src/renderer/src/store/focusArming.ts`; the four resume sites call one shared `resumeIntoPane()` helper; the two detection listeners use `findLeafByPtyId` from `paneTree.ts` and the `setSessionId` action.
2. IPC listeners are still wired **at module load, exactly once**, in the same source order, with the same runtime guards and ack semantics — byte-identical handler bodies wherever possible.
3. `resumeAgentPane` gains the `window.ipc` existence guard (the one intentional behavior fix). All four sites converge on the strictest correct re-find guard (see Phase B).
4. One button-cluster component and one `leftChromeWidth` computation serve both chrome variants; one `TAB_DRAG_MIME` constant and one absorb/transfer implementation serve both drop sites, preserving rollback-on-`false` exactly.
5. `hooks/usePanes.ts` is deleted; the two Terminal dep arrays use a hoisted boolean; the TabSections effect has honest deps.

## Implementation Plan

### Phase A — trivial, independent (items 35, 48, 49)

1. **35**: re-verify zero imports (`grep -r "hooks/usePanes"` and `usePanes\b` across `src/`), then delete `src/renderer/src/hooks/usePanes.ts`.
2. **48**: in `Terminal/index.tsx`, hoist `const isMounting = status === 'mounting'` (component scope, above Effect 2) and replace the inline ternary in both dep arrays (425, 586) with `isMounting`. Booleans are equality-stable exactly like the two-string trick — identical re-run semantics. Do not otherwise touch the eslint-disable at 585 (the arrays are still deliberately non-exhaustive for other members).
3. **49**: in `TabSections.tsx:108-113`, add `tabs` and `startRename` to the dep array. The `pendingRenameTabId && …` guard plus the immediate `setPendingRenameTabId(null)` makes extra re-runs no-ops, and re-firing when `tabs` later contains the pending tab is a strict improvement. (If `startRename` is not referentially stable across renders, snapshotting inside the effect via `usePanesStore.getState()` is the fallback — but prefer honest deps.)

### Phase B — resume/detection dedup (items 29b, 29c)

4. **29b — `findLeafByPtyId`**: add to `src/shared/paneTree.ts`, mirroring `findLeafBySessionId`:

   ```ts
   /** Find a leaf by its live ptyId */
   export function findLeafByPtyId(node: PaneNode, ptyId: string): PaneLeaf | null {
     if (node.type === 'leaf') return node.ptyId === ptyId ? node : null
     return findLeafByPtyId(node.first, ptyId) ?? findLeafByPtyId(node.second, ptyId)
   }
   ```

   Rewrite the `session:detected` listener to walk tabs with `findLeafByPtyId` and call `usePanesStore.getState().setSessionId(pane.id, sessionId)` — the inline patch is verified byte-identical to the action, so this is pure dedup. Rewrite `session:detection-failed` to use `findLeafByPtyId` too (keep its extra `pane.agentKind !== agentKind` check and its exact `updatePane` patch, including the `mode === 'resume'` branch).

5. **29c — `resumeIntoPane()`**: add a module-scope helper next to `runNewAgentSession` (same shape and placement):

   ```ts
   async function resumeIntoPane(
     get: PanesGet,
     paneId: string,
     agentKind: AgentKind,
     sessionId: string,
     cwd: string,
     opts: {
       validateFirst?: boolean            // hydrateTabRuntime only
       onSettled?: () => void             // markTabHydrated hooks
       extraFailurePatch?: Partial<PaneLeaf>  // resumeAgentPane's agentDisconnected restore
     } = {},
   ): Promise<void>
   ```

   Sequence: (1) `window.ipc` guard — if absent, call `onSettled` and return (this is the **added** guard for `resumeAgentPane`; the other three already behave this way); (2) if `validateFirst`, invoke `sessions:validate` and on `!found` set `resumeError: 'Session not found — the transcript may have been deleted'` behind the re-find guard, then settle; (3) invoke `session:resume`; (4) apply the result **behind the unified strictest guard**; (5) on catch, `updatePane(paneId, { resumeError: agentIpcErrorMessage(err, 'Session resume failed'), ...extraFailurePatch })`; (6) `finally` → `onSettled`.

   **Guard-unification decision (spelled out).** The four sites disagree; the shared helper keeps the strictest correct form: re-find the pane via `findPaneInAnyTab(paneId)` and apply the resume result only when `current?.paneType === 'agent' && current.agentKind === agentKind && current.sessionId === sessionId && !current.ptyId && result?.ptyId`. Rationale per site:
   - `hydrateTabRuntime` already does exactly this — no change.
   - `resumeAgentPane` gains `!current.ptyId` (it cleared `ptyId` up front, so the check only bites if something else attached a pty mid-flight — in which case overwriting it would leak a process; the stricter guard is the correct behavior) **and** gains the `window.ipc` guard.
   - `resumeSession` / `resumeSessionInNewTab` gain the re-find guard where they previously had none. The leaf is freshly created in the same call, so under today's flows the guard always passes; it only changes behavior if the user closes the pane before the invoke resolves, where silently dropping the result is correct (matching `hydrateTabRuntime`). Note: the pane-gone case means the resumed pty is unowned — that pre-existing leak is item 15/backlog territory, not this spec.
   - `sessions:validate` stays **opt-in** (`validateFirst: true` only from `hydrateTabRuntime`). Adding validation to the interactive paths would be a behavior change beyond this spec's mandate.
   - Success patch: use the existing `setPtyId` action for the `ptyId` apply where the previous code did (`resumeSession`/`resumeSessionInNewTab`), or `updatePane` with the site's exact prior patch (`resumeAgentPane` also clears `agentDisconnected`/`sessionDetectionError`). If unifying on one patch, use the superset `{ ptyId, agentDisconnected: undefined, resumeError: undefined, sessionDetectionError: undefined }` — this matches `setPtyId` + `resumeAgentPane` and is a no-op-or-cleanup for the other sites. Document the choice in the code.

   Rewire all four sites onto the helper. Preserve `hydrateTabRuntime`'s `hydratingPaneSessions` dedup map and its per-leaf promise collection around the helper call (that orchestration is hydration-specific and stays put). Preserve each site's `markTabHydrated` timing via `onSettled` (`resumeSession`/`resumeSessionInNewTab`: always, including the no-ipc branch; `resumeAgentPane`: none; `hydrateTabRuntime`: unchanged outer mechanism).

### Phase C — IPC wiring extraction (item 29a, plus the 29d state-home slice)

6. **Focus-arming state home** (prerequisite): create `src/renderer/src/store/focusArming.ts` holding the five mutable bindings, the two constants, and small named operations that both writers use — e.g. `markLocalSidebarClick()` (the `skipNextActivationDisarm` + TTL timer block from `focusLocalPaneFromSidebar`), `beginPendingRemoteFocus(windowId, onTimeout)`, `clearPendingRemoteFocus()`, `getPendingRemoteFocusWindowId()`, `consumeSkipActivationDisarm(winId, localWindowId)`, `scheduleLocalRearm(onRearm)`. Move code, do not rewrite the state machine: each function body is the existing block verbatim. `panes.ts` actions and the extracted listener both import from here. No Zustand state moves — `localFocusArmed` etc. stay in the store.
7. **`store/panesIpc.ts`**: move the entire `panes.ts:1920-2282` block into `export function wirePanesIpc(): void`, preserving:
   - the outer `if (typeof window === 'undefined' || !window.ipc) return` guard;
   - source order of all 26 registrations (23 ipc + 3 capture-phase DOM drag listeners);
   - handler bodies byte-identical except: (a) the 29b rewrites from Phase B, (b) focus-arming state access now goes through `focusArming.ts` functions.
   - an idempotence latch: `let wired = false; if (wired) return; wired = true` at the top. Today nothing can call it twice (full-reload HMR, single import), but the latch makes the exactly-once invariant structural and testable.

   The module imports `usePanesStore` (and `normalizeCwdKey` stays in `panes.ts`; the wiring block doesn't use it — verify at implementation time which of `collectLeaves`, `isSpawnInTabPayload`, `reportCurrentFocusTarget`, `PANE_DRAG_MIME`, `findLeafByPtyId` each listener needs and import them; export `isSpawnInTabPayload` and `reportCurrentFocusTarget` from `panes.ts` or move them if they have no other in-file callers).
8. **Call site**: at the bottom of `panes.ts`, replace the removed block with `wirePanesIpc()`. This preserves "wired at module load" with zero entry-point changes. The import cycle (`panesIpc` → `panes` for the store; `panes` → `panesIpc` for the function) is safe under ESM live bindings because `panesIpc.ts` must not touch `usePanesStore` at its own top level — only inside `wirePanesIpc()` and listener bodies, which run after `panes.ts` finishes initializing the store. **Enforce this with a comment in `panesIpc.ts`.** If the implementer prefers to avoid the cycle outright, the alternative is calling `wirePanesIpc()` from a shared entry imported by both windows — but there is no single such module today (`main.tsx` imports only `App`), so the cycle-with-comment is the recommended shape.
9. Fix the stale "window.ipc is intentionally absent" comment in `panes.test.ts` (it is installed by `tests/setup.renderer.ts`).

### Phase D — TabBar/App dedup (item 31, transfer-critical)

10. **MIME + helpers into `utils/paneDrag.ts`**: add `export const TAB_DRAG_MIME = 'application/x-multiagent-tab'`; delete the local declarations in `TabBar/index.tsx:23` and `App.tsx:79`. Add the two shared helpers **with parameter injection, not store imports** — `panes.ts` already imports `PANE_DRAG_MIME` from `paneDrag.ts` (line 10), so `paneDrag.ts` importing `usePanesStore` would create a new cycle; keep it store-free:

    ```ts
    export function absorbDroppedTab(
      e: React.DragEvent,
      windowId: number | null,
      deps: { receiveTab: (tab: Tab, atIndex?: number) => void; removeTabLocally: (tabId: string) => void },
      dropIndex?: number,
    ): boolean
    export function transferDroppedPane(
      e: React.DragEvent,
      targetTabId: string,
      windowId: number | null,
      deps: { movePaneToTab: (paneId: string, tabId: string) => void },
    ): boolean
    ```

    Bodies are TabBar's current `handleCrossWindowDrop`/`handlePaneDrop` verbatim, including: the same-window bail-outs, `e.preventDefault()`/`e.stopPropagation()` placement, `JSON.stringify(tab)` + `sourceWindowId ?? -1` invoke shape, and **the `.then((ok) => { if (!ok) removeTabLocally(tab.id) })` rollback**. `App.tsx` gains `dropIndex` pass-through capability but keeps passing `undefined` (append) — do not change App's drop-index behavior in this spec. TabBar-local concerns (`clearPaneDragHover`) stay at the TabBar call site, invoked after the helper returns `true`.
11. **One button cluster**: extract a `ChromeButtonCluster` component (in `TabBar/index.tsx` next to `BarButton`, no new file needed) rendering the four `BarButton`s from the same store selectors; parameterize the container by `height` and `withBorderBottom`. `LeftChrome` and the non-wrap branch both render it. Hoist `leftChromePadding`/`controlClusterWidth`/`leftChromeWidth` into a single shared helper (e.g. `computeLeftChromeWidth(sidebarOpen, sidebarWidth, isMac)`) used by both (391-393 and 481-483 are already identical).
12. **Optional follow-up (flagged, not in scope of this spec's DoD)**: extracting `TabItem` and a `useTabDrag` hook from TabBar's ~1200 lines. This is heavy drag-and-drop surface requiring extensive manual testing (reorder, tear-off, cross-window, hover-activate); defer to its own spec.

### Optional — item 29d full extraction

13. If Phase C's `focusArming.ts` slice lands cleanly, optionally promote it to a fully testable state machine: inject a clock (or use `vi.useFakeTimers` in tests), export a `_resetForTests()` and cover: click-then-activate does not disarm; TTL expiry clears the skip flag; cross-window activation disarms then re-arms after `LOCAL_REARM_MS`; pending-remote-focus timeout clears `pendingFocusTarget`. Pure bonus; the move in Phase C must not depend on this.

## Tests

- **`paneTree.test.ts` — `findLeafByPtyId`**: found in nested split; `null` when absent; leaves with `ptyId: undefined` never match; returns the first match in `first`-before-`second` tree order.
- **`resumeIntoPane` store tests** (extend `src/renderer/src/store/panes.test.ts`, real store, fresh `installMockIpc()` per test per the CLAUDE.md no-store-mocking rule):
  - validate-fail path: `sessions:validate` resolves `{ found: false }` → pane gets the "Session not found" `resumeError`, `session:resume` is **never** invoked, `onSettled`/`markTabHydrated` still fires (this pins the CLAUDE.md `hydrateTabRuntime` no-doomed-spawn invariant).
  - success path: resume resolves `{ ptyId }` → pane gains `ptyId`, `resumeError`/`agentDisconnected` cleared.
  - reject path: resume rejects with a `Working directory …` error → `resumeError` contains the repaired-directory hint (exercises `agentIpcErrorMessage`), `extraFailurePatch` applied.
  - strict-guard paths: pane closed before resolve → no state write; pane already has a `ptyId` → result dropped.
  - no-ipc path (`clearMockIpc()`): all four public entry points (`resumeSession`, `resumeSessionInNewTab`, `resumeAgentPane`, `hydrateTabRuntime` via `hydrateTab`) return without throwing — this is the regression test for the added `resumeAgentPane` guard.
- **`wirePanesIpc` characterization test** (new `src/renderer/src/store/panesIpc.test.ts`): with a fresh mock ipc, `vi.resetModules()` + dynamic-import the module, call `wirePanesIpc()` twice; assert `ipc.on` was called **exactly 23 times**, and snapshot the ordered channel-name list (the table above). Assert the second call added zero registrations. Assert `session:detected` delivery routes through `setSessionId` (spy on the action or assert the resulting pane state).
- **`paneDrag.test.ts` — transfer helpers**: `absorbDroppedTab` with a same-window payload returns `false` and calls nothing; cross-window payload calls `receiveTab` then `tab:absorb`; **invoke resolving `false` calls `removeTabLocally` with the tab id** (rollback pin); malformed JSON returns `false`. `transferDroppedPane`: same-window → `movePaneToTab`; cross-window → `pane:transfer` invoke with `targetTabId`/`targetWindowId`; `windowId === null` → `false`.
- Boy-scout: `TabSections.tsx` gains a test that a pending rename fires `startRename` even when the tab appears in `tabs` a render later (item 49's latent fix).

## Risks

- **Item 31 touches transfer-critical code (spec 024 zone).** The single shared implementation must preserve rollback-on-`false` (`tab:absorb` → `removeTabLocally`) and the exact invoke argument shapes; a helper that swallows the `.then(ok)` or changes `sourceWindowId ?? -1` loses tabs on failed absorbs. The helper-body-verbatim rule plus the rollback unit test plus the e2e `tab:absorb` test are the mitigations.
- **Moving the IPC wiring must not double-register.** Today's safety comes from full-reload HMR semantics for non-component modules (verified: no `import.meta.hot` anywhere). The extraction preserves that (new module is also non-component, reached via the same import graph), and the `wired` latch + characterization test make it structural. Do **not** add an `import.meta.hot.accept` to either module.
- **Import cycle `panes.ts ⇄ panesIpc.ts`.** Safe only while `panesIpc.ts` defers all store access to function bodies. A future top-level `usePanesStore.getState()` in `panesIpc.ts` would throw at startup in one import order and not the other. Comment guards this; the e2e cold-start test catches it.
- **Guard unification changes micro-behavior** in races (pane closed / pty attached mid-resume). All changes are in the safe direction (drop the result instead of clobbering), but reviewers should check the Phase B table rather than assuming pure-move.
- **`window:became-active` is the most intricate listener** (focus arming + pending-remote-focus interplay). It moves in Phase C only after its state has a shared home; move it verbatim and rely on the multi-window manual pass below.
- Ack semantics (`ack only when the store action returned true`, double-rAF timing) must not change — they are load-bearing for main's timeout/rollback (spec 024, CLAUDE.md Multi-Window State Invariants).

## Verification Steps

1. `npm test` — all projects green, including the new `paneTree`, `panesIpc`, `paneDrag`, and resume-path tests.
2. `npm run typecheck` — green (test files included).
3. `npm run test:e2e` — cold layout restore, `tab:absorb`, and deferred Claude spawn all pass (these exercise the moved wiring end-to-end).
4. Manual, after Phase C and again after Phase D:
   - Cross-window **tab** drag: primary → detached tab bar, detached → primary tab bar, detached → primary **content area** (App root drop), and a drop that targets a just-closed window (expect rollback, tab survives in source).
   - Cross-window **pane** drag: pane onto another window's tab header and onto the content area; self-drop onto its own tab (expect no-op, pane survives).
   - Focus arming: two windows, click a sidebar pane row in the primary while the detached window has OS focus — highlight must not flash the stale pane; plain alt-tab back re-arms after the grace timer.
5. Manual, after Phase B: resume an agent from Recent (Session Browser), resume into a new tab, click reconnect on a disconnected agent pane, and cold-start with a saved agent layout; delete a transcript file and cold-start to confirm the `resumeError` placeholder (no spawn loop).
6. Manual, after Phase D: verify the four chrome buttons render and act identically in scroll mode, wrap mode, and a detached window (cluster hidden), and that window-drag regions still work on the chrome background.

## Handoff Contract

### Non-negotiables

- IPC listeners remain wired **at module level, exactly once** — no component-mounted wiring, no conditional deferral, no HMR accept handlers.
- Cross-window ack semantics unchanged: ack only when the destination store action returned `true`; double-rAF ack timing preserved; `tab:release` two-phase handshake preserved verbatim.
- `setSessionId` behavior unchanged — the `session:detected` listener routes through the existing action; its patch is not modified.
- No behavior change to resume flows **except** adding the missing `window.ipc` guard to `resumeAgentPane` and converging on the strictest re-find guard as specified in Phase B. `sessions:validate` remains exclusive to the hydration path.
- No PATH rewrites, no pty flow control, no changes to spawn/defer behavior — untouched territory, listed because `panesIpc.ts` sits next to `pty:*` channels.
- `paneDrag.ts` stays store-import-free (cycle guard).
- Absorb rollback (`tab:absorb` resolves `false` → `removeTabLocally`) preserved in the shared helper and covered by a unit test.

### Definition of Done

- Phases A-D landed (29d full extraction optional); each phase is independently shippable and was verified per the steps above before the next began.
- `panes.ts` no longer contains the wiring block, the four inline resume sequences, or the hand-rolled ptyId walkers; `TabBar/index.tsx` and `App.tsx` contain one copy each of nothing listed in item 31.
- New tests from the Tests section exist and pass; the `wirePanesIpc` characterization test pins listener count and order.
- `npm test`, `npm run typecheck`, `npm run test:e2e` green; the manual multi-window pass (steps 4-6) completed on Windows.
- CLAUDE.md updated only if a durable lesson emerged (e.g. the `panes ⇄ panesIpc` cycle rule); no doc updates for mechanics already covered here.

## Out of Scope

- **Render-perf selector work** (PaneContainer/PaneHeader/TabBar/Sidebar selector and memo fixes — backlog items 6/16/17/18): spec 037.
- **Identity-preserving `updateLeaf`/`patchExited`** (backlog item 10): spec 038. Phase B deliberately keeps `setPtyId`/`updatePane` calling today's non-identity-preserving `updateLeaf`.
- Larger TabBar decomposition (`TabItem`, `useTabDrag`) — flagged in Phase D step 12 as a separate heavy-manual-testing spec.
- `handlers.ts` split and main-side ack consolidation (backlog item 28), sender-ownership guards (item 30), tab-close pty teardown (item 2).
- Any change to drop-index behavior of the App root drop target (today: append; stays append).
