# 038 — Identity-Preserving Pane Tree Updates

Covers items **10** (core), **39**, and **40** from `specs/pending/032-code-improvement-backlog.md`. All claims below were re-verified against the working tree on 2026-07-03; line numbers are current.

## Problem

Any single-pane metadata patch (a pty id arriving, a session id detected, a rename, an agent exit) rebuilds the object identity of **every node in every tab**, because `updateLeaf` in `src/shared/paneTree.ts` clones unconditionally and its store callers map over all tabs producing new `Tab` objects even when a tab was untouched. Since the renderer's persistence and cross-window sync are both keyed on the `tabs` array reference, each of these patches re-fires the debounced `layout:save` effect, re-fires the detached-window 300ms `tab:state-sync` (a full JSON serialize of every tab over IPC), and re-renders every component subscribed to `tabs` — for state that, JSON-wise, may not have changed at all.

Two small adjacent cleanups ride along because they live in the same file and the same test suite:

- `collectLeaves` (returns `PaneLeaf[]`) lives in `src/renderer/src/utils/tabLabels.ts` while its trivial derivative `collectLeafIds` lives in `src/shared/paneTree.ts` — a layering inversion that forces the panes store to import a tree primitive from a label-formatting util (item 39).
- `removeLeaf` has a redundant dead disjunct and, as written, silently removes **split** children by id, which its doc comment does not promise (item 40).

## Current Behavior

### `updateLeaf` clones every node unconditionally

`src/shared/paneTree.ts:114-123`:

```ts
/** Update a field on the leaf with the given id */
export function updateLeaf(node: PaneNode, leafId: string, patch: Partial<PaneLeaf>): PaneNode {
  if (node.type === 'leaf') {
    return node.id === leafId ? { ...node, ...patch } : node
  }
  return {
    ...node,
    first: updateLeaf(node.first, leafId, patch),
    second: updateLeaf(node.second, leafId, patch),
  }
}
```

Leaves keep identity when they don't match, but **every split node** on every path is cloned, so the returned root is always a new object — even when `leafId` exists nowhere in the tree.

### Complete list of `updateLeaf` call sites

All in `src/renderer/src/store/panes.ts` unless noted (plus the internal recursion at `paneTree.ts:120-121` and the unit test at `paneTree.test.ts:123`):

| Caller | Location | Maps over |
|---|---|---|
| `setPtyId` | `panes.ts:1118-1127` (call at `:1121`) | all tabs |
| `setPaneCustomName` | `panes.ts:1151-1158` (call at `:1154`) | all tabs |
| `setSessionId` | `panes.ts:1160-1170` (call at `:1163`) | all tabs |
| `updatePane` | `panes.ts:1172-1176` (call at `:1174`) | all tabs |
| inline `session:detected` IPC listener | `panes.ts:1953-1960` (call at `:1954`) | all tabs |

Note the fifth call site — the inline `setState` inside the module-level `session:detected` listener — is **not** listed in backlog item 10; it duplicates `setSessionId`'s patch shape and must be updated too (or, per backlog item 29b, replaced with a `setSessionId` call — see Out of Scope).

Every one of these has the shape:

```ts
tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, {...}) } : t)
```

so a patch targeting one pane in one tab produces a new `Tab` object for every tab that has a `rootNode`, and always returns a new `{ tabs }` state — Zustand notifies all subscribers unconditionally.

### `markPtyExited` / `patchExited` — same problem, inline helper

`src/renderer/src/store/panes.ts:1178-1201`. The inner `patchExited` (`:1183-1194`) returns the same leaf when `ptyId`/`paneType` don't match, but clones every split (`:1193`) and the caller clones every tab (`:1195`) and always returns `{ tabs }`. A shell pane exiting, or an exit event for a ptyId not present in this window (common in multi-window setups, where `pty:exit` at `panes.ts:1939-1943` fires in every renderer), still churns every tab identity.

### The correct pattern already exists in the same file

`setPaneCwd`'s `patchCwd`, `panes.ts:1129-1149`:

```ts
function patchCwd(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    if (node.ptyId !== ptyId || node.cwd === cwd) return node   // value comparison, not just id match
    changed = true
    return { ...node, cwd }
  }
  const first = patchCwd(node.first)
  const second = patchCwd(node.second)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
const rootNode = patchCwd(t.rootNode)
return rootNode === t.rootNode ? t : { ...t, rootNode }
// ...
return changed ? { tabs } : s
```

Same node when untouched; same tab when root unchanged; same **state object** when nothing changed (Zustand skips notification entirely). `updateCwdsInTree` (`paneTree.ts:130-150`) and `applyCwdRepair` (`panes.ts:1203-1219`) follow the same discipline.

### Amplification chain

1. **Debounced `layout:save`** — `src/renderer/src/App.tsx:216-224`: effect depends on `tabs`; every no-op-adjacent patch resets/re-arms the 1000ms timer and eventually invokes `layout:save` (which serializes and writes `layout.json`) for byte-identical content.
2. **Detached-window `tab:state-sync`** — `App.tsx:165-177`: effect depends on `tabs`; each patch re-arms the 300ms timer and sends the **entire tab list** (structured-clone/JSON over IPC) to main, which merges it into the primary's state. On a detached window, every `pty:exit` broadcast for panes it doesn't even own triggers a full sync.
3. **Renderer re-renders** — every component with a selector that returns `tabs`, a `tab` object, or anything derived without memoization re-renders: `TabBar/index.tsx` (recomputes `computeLabels` and per-tab `hasAgentPane`/`collectLeaves`, `:486`, `:638`), `Sidebar/TabSections.tsx` (`:95`, `:150`, `:467`), `PaneGrid`, etc. Backlog items 6/16/17/18 fix the subscriber side; this spec fixes the producer side so unchanged selectors get Object.is-stable inputs.

### `collectLeaves` layering inversion (item 39)

Definition: `src/renderer/src/utils/tabLabels.ts:14-17`. Its derivative `collectLeafIds` is independently implemented at `src/shared/paneTree.ts:153-156`. The store (`panes.ts:8`) imports a tree primitive from a label util.

Complete list of `collectLeaves` call sites:

- `src/renderer/src/utils/tabLabels.ts:14` — definition
- `src/renderer/src/store/panes.ts:8` (import), `:137` (`hydrateTabRuntime`), `:396`, `:1950` (`session:detected`), `:1974` (`session:detection-failed`), `:2040` (`tab:return`)
- `src/renderer/src/components/Sidebar/TabSections.tsx:6` (import), `:95`, `:150`, `:467`, `:594`
- `src/renderer/src/components/TabBar/index.tsx:6` (import), `:55`, `:638`
- `src/renderer/src/utils/tabLabels.test.ts:5` (import), `:43-45` (test)

### `removeLeaf` dead disjunct and undocumented split removal (item 40)

`src/shared/paneTree.ts:65-81`:

```ts
export function removeLeaf(node: PaneNode, removeId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === removeId ? null : node
  }
  // It's a split
  if (node.first.id === removeId || (node.first.type === 'leaf' && node.first.id === removeId)) {
    return node.second
  }
  if (node.second.id === removeId || (node.second.type === 'leaf' && node.second.id === removeId)) {
    return node.first
  }
  const newFirst = removeLeaf(node.first, removeId)
  const newSecond = removeLeaf(node.second, removeId)
  if (newFirst === null) return newSecond
  if (newSecond === null) return newFirst
  return { ...node, first: newFirst, second: newSecond }
}
```

Two defects:

1. The second disjunct of each condition (`node.first.type === 'leaf' && node.first.id === removeId`) is dead — it is strictly implied by the first disjunct.
2. The first disjunct matches **any** child id, including split ids, so passing a split's id removes the entire split subtree. The doc promises only "Remove the leaf with `removeId`". Every production call site (`panes.ts:725`, `:1085`, `:1518`, `:1574`, `:1637`, `:1651`, `:1795`) passes a pane (leaf) id, so the split-removal behavior is unexercised and untested — a trap, not a feature.

Also: the recursion tail always clones (`{ ...node, first: newFirst, second: newSecond }`) even when nothing was removed, so `removeLeaf(tree, 'missing')` returns a structurally-equal but identity-fresh tree. The existing test at `paneTree.test.ts:87-90` only asserts `toEqual` (and contains a stray `?.` after `expect(...)` — fix that while there).

## Intended Behavior

- A patch that does not change any leaf (id not found in a tree, or every patch value already equal) returns the **same** root node reference; the caller keeps the same `Tab` object; and if no tab changed, the store action returns the same state object so Zustand does not notify.
- A patch that does change a leaf rebuilds **only the path** from root to that leaf; untouched siblings/subtrees keep their identity.
- Consequently, `layout:save` and `tab:state-sync` timers re-arm only when tab content actually changed, and `tabs`-derived selectors stay Object.is-stable across no-op patches.
- `collectLeaves` lives in `paneTree.ts`; `collectLeafIds` is implemented in terms of it; `tabLabels.ts` contains only label logic.
- `removeLeaf` removes leaves only, with the dead disjunct gone, identity preserved on no-match, and the chosen behavior pinned by tests.
- Persisted layout **content** is unchanged; only the frequency of no-op saves/syncs drops.

## Implementation Plan

### Phase 1 — `paneTree.ts`: identity-preserving primitives

**1a. New `updateLeaf` contract.** Same signature, `(node, leafId, patch) => PaneNode`, with reference semantics:

- Returns the **same** node reference when no leaf with `leafId` exists in the subtree.
- Returns the **same** node reference when the leaf is found but the patch is a no-op (see decision below).
- Otherwise rebuilds only the root→leaf path; the untouched sibling at every split keeps identity.

**Decision — identical-value patches are NOT a change.** When the matched leaf already holds every patch value, `updateLeaf` returns the same node. Equality is **shallow per key using `Object.is`** — no deep equality. Document this in the doc comment. Rationale and consequences:

- The entire point of this spec is suppressing downstream no-op work; a repeated `setPtyId(paneId, sameId)` or a re-delivered `session:detected` must not re-fire `layout:save`/`tab:state-sync`. `setPaneCwd` already established value-comparison semantics (`node.cwd === cwd` at `panes.ts:1136`).
- `Object.is` per key means `patch.agentDisconnected: undefined` vs. an absent/`undefined` field compares equal (safe: `{ ...node, ...patch }` with an `undefined` value is JSON-identical to the field being absent, so persisted content never differed either).
- Object-valued patch fields (e.g. a fresh `agentDisconnected: { exitCode, signal, at }`) always compare unequal — conservatively treated as a change. That is correct: those patches only occur when a real event happened.

Implementation shape (mirrors `patchCwd`):

```ts
export function updateLeaf(node: PaneNode, leafId: string, patch: Partial<PaneLeaf>): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== leafId) return node
    const keys = Object.keys(patch) as (keyof PaneLeaf)[]
    if (keys.every((k) => Object.is(node[k], patch[k]))) return node
    return { ...node, ...patch }
  }
  const first = updateLeaf(node.first, leafId, patch)
  const second = updateLeaf(node.second, leafId, patch)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
```

**1b. Extract `patchExited` into `paneTree.ts`.** The inline closure at `panes.ts:1183-1194` matches by `ptyId` (not leaf id) and needs to report whether the exited leaf had a `sessionId`. Export a pure function that returns the leaf it changed:

```ts
/**
 * Mark the agent leaf owning `ptyId` as exited: clears ptyId and sets
 * `agentDisconnected`. Identity-preserving: returns the same node when no
 * agent leaf owns `ptyId`. Returns the pre-patch leaf so callers can inspect
 * sessionId etc. Shell leaves are never touched.
 */
export function markLeafExitedByPtyId(
  node: PaneNode,
  ptyId: string,
  disconnected: { exitCode: number | null; signal?: number; at: number },
): { node: PaneNode; exitedLeaf: PaneLeaf | null }
```

Recursive shape identical to `updateCwdsInTree` (short-circuit clone only on changed paths). Use the exact `agentDisconnected` field type from `PaneLeaf` in `src/shared/types.ts` rather than the inline shape above.

**1c. Simplify `removeLeaf` (item 40).** Replace the direct-child checks entirely with the pure recursive form — it subsumes them, drops the dead disjuncts, restricts matching to leaves, and gains identity preservation for free:

```ts
export function removeLeaf(node: PaneNode, removeId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === removeId ? null : node
  const first = removeLeaf(node.first, removeId)
  const second = removeLeaf(node.second, removeId)
  if (first === null) return second
  if (second === null) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
```

Pinned behavior decision: **`removeLeaf` removes leaves only.** Passing a split id is a no-op returning the same tree (previously it removed the whole subtree — undocumented and unused; all seven production call sites pass pane ids). Update the doc comment to say so and pin it with a test.

**1d. Move `collectLeaves` (item 39).** Move the function bodily from `tabLabels.ts:14-17` into `paneTree.ts` (it is already pure and Electron-free). Reimplement `collectLeafIds`:

```ts
export function collectLeafIds(node: PaneNode): string[] {
  return collectLeaves(node).map((l) => l.id)
}
```

Update importers: `panes.ts:8` (merge into the existing `../../../shared/paneTree` import at `panes.ts:4-5`), `Sidebar/TabSections.tsx:6`, `TabBar/index.tsx:6`. Move the `collectLeaves` test from `tabLabels.test.ts:43-45` into `paneTree.test.ts` and drop it from the tabLabels import list. `tabLabels.ts` keeps `findLeafById`/`firstLeaf` for now (see Out of Scope) but no longer exports `collectLeaves` — re-exporting from `tabLabels.ts` for compatibility is NOT wanted; fix the importers.

### Phase 2 — `panes.ts` caller updates

Apply the `patchCwd` caller pattern to all five `updateLeaf` call sites and to `markPtyExited`:

- **`setPtyId` (`:1118`), `setPaneCustomName` (`:1151`), `setSessionId` (`:1160`), `updatePane` (`:1172`), and the inline `session:detected` setState (`:1953`)** — each becomes:

  ```ts
  set((s) => {
    let changed = false
    const tabs = s.tabs.map((t) => {
      if (!t.rootNode) return t
      const rootNode = updateLeaf(t.rootNode, paneId, { ... })
      if (rootNode === t.rootNode) return t
      changed = true
      return { ...t, rootNode }
    })
    return changed ? { tabs } : s
  })
  ```

  A small local helper inside `panes.ts` (e.g. `patchLeafInTabs(tabs, paneId, patch): { tabs, changed }`) is encouraged to avoid writing this five times — keep it private to the store, not in `paneTree.ts` (it deals in `Tab[]`, not `PaneNode`).

  Note `setPaneCustomName` computes its patch value (`name.trim() || undefined`) before comparison — the no-op case "rename to the same name" then falls out of the `Object.is` check naturally.

- **`markPtyExited` (`:1178`)** — replace the inline `patchExited` with `markLeafExitedByPtyId`; derive `shouldRefreshSessions` from `exitedLeaf?.sessionId`; keep the same tab/changed short-circuits; preserve the existing post-`set` `sessions:refresh` invoke (`:1198-1200`) exactly, including that it fires only when an agent leaf with a sessionId actually exited. `disconnected.at = Date.now()` is computed once per action call as today.

Do not touch `setPaneCwd`, `applyCwdRepair`, or `updatePaneRatio` (the latter is not identity-preserving inside the active tab but already returns other tabs untouched; out of scope).

## Tests

All in existing test files; no new test infrastructure. Use the deterministic `L(id, overrides)` builder already in `src/shared/paneTree.test.ts:19-21`.

### `src/shared/paneTree.test.ts` — extend

1. **`updateLeaf` identity preservation:**
   - Same root reference when `leafId` is not in the tree: `expect(updateLeaf(tree, 'missing', { customName: 'x' })).toBe(tree)`.
   - Same root reference when the patch values already equal the leaf's values (including a key set to `undefined` on a leaf that lacks the field): `expect(updateLeaf(tree, 'L1', { cwd: 'C:\\proj', ptyId: undefined })).toBe(tree)`.
   - Changed path rebuilt, untouched sibling keeps identity: for `tree = makeSplit('vertical', L('L1'), makeSplit('horizontal', L('L2'), L('L3')))`, patching `L3` yields `next !== tree`, `next.second !== tree.second`, but `next.first === tree.first` and `(next.second as PaneSplit).first === (tree.second as PaneSplit).first`.
   - Existing behavior test at `:121-125` keeps passing (patch applied).
2. **`markLeafExitedByPtyId`:**
   - Marks the agent leaf owning the ptyId: `ptyId` cleared, `agentDisconnected` set, returns the exited leaf; sibling identity preserved.
   - Same node + `exitedLeaf: null` when no leaf owns the ptyId, and when the owning leaf is a shell pane.
3. **`removeLeaf` (item 40 pinning):**
   - Strengthen `:87-90` from `toEqual` to `toBe` (identity on no-match) and remove the stray `?.` after `expect(...)`.
   - New: removing by a **split** id is a no-op returning the same tree (pin the leaves-only decision): build the `((L1)(L2 L3))` tree, call `removeLeaf(tree, innerSplit.id)`, expect `toBe(tree)` and all three leaves still present.
   - All existing removeLeaf tests (`:72-91`) keep passing unchanged.
4. **`collectLeaves`:** moved test asserting tree-order `PaneLeaf[]`; plus `collectLeafIds(tree)` still equals `['L1','L2','L3']` (existing test at `:129-132` keeps passing against the derived implementation).

### `src/renderer/src/store/panes.test.ts` — extend

Store-level identity assertions (the file already builds multi-tab states — see the helpers around `:20-30`):

- **`setPtyId` on a pane in tab A leaves tab B's object identity intact:** capture `tabB = getState().tabs[1]` before, call `setPtyId(paneInTabA, 'pty-1')`, assert `getState().tabs[1] === tabB` and `getState().tabs[0] !== tabAbefore`.
- **No-op patch returns the same state:** call `setPtyId(paneInTabA, 'pty-1')` twice; after the second call, `getState().tabs === tabsAfterFirstCall` (same array reference — proves the `changed ? { tabs } : s` branch and therefore no `layout:save`/`tab:state-sync` re-fire).
- **Unknown-target patch is a full no-op:** `setPtyId('no-such-pane', 'x')` leaves `getState().tabs` reference-equal.
- **`markPtyExited`:** shell-pane ptyId and unknown ptyId leave `tabs` reference-equal; agent-pane ptyId with a sessionId changes only its tab. (The `sessions:refresh` invoke is behind the `window.ipc` guard at `:1198`; in happy-dom without `window.ipc` it is skipped — no mock needed, consistent with existing tests.)

Per the boy-scout rule, `tabLabels.test.ts` and any touched component files keep/gain their tests, but no component tests are required by this spec.

## Risks

**Primary risk: code that relied on new identities to force a re-render or effect.** Identity preservation only suppresses updates when *nothing changed*, so the only true hazard is a consumer that depends on being notified for a **no-op** write. Checked:

- **`App.tsx` `layout:save` (`:216-224`) and `tab:state-sync` (`:165-177`) effects** — keyed on `tabs`; they exist to persist *changes*. A no-op patch producing no save/sync is the desired behavior; persisted content for real changes is byte-identical because the patch spread is unchanged. The detached sync `version` counter (`detachedSyncVersionRef`, `:168`) increments per send, and main's generation check only requires monotonicity — fewer sends are fine.
- **`App.tsx` shutdown collectors (`:187-213`)** — read `getState()` on demand, not identity-driven. Unaffected.
- **Zustand subscribers** — all selectors in `TabBar/index.tsx`, `Sidebar/TabSections.tsx`, `PaneGrid`/`PaneContainer`, `PaneHeader` select state and re-render on change; none uses `subscribe` with a no-op-write dependency. Returning `s` from `set` (skipping notification) is an established pattern in this store (`setPaneCwd:1147`, `applyCwdRepair:1219`).
- **`panes.ts` internal reads** — all post-write reads (`session:detected` at `:1948`, `tab:return` at `:2038`, `hydrateTabRuntime` at `:129`) go through `getState()` fresh; none caches by identity.
- **`markPtyExited`'s `sessions:refresh`** — driven by the returned `exitedLeaf`, not by state identity; behavior preserved.
- **`panes.test.ts` / `paneTree.test.ts` existing assertions** — all structural (`toEqual`, id lists); none asserts that an untouched node/tab received a *new* identity. `paneTree.test.ts:89`'s `toEqual` becomes strictly stronger as `toBe`.
- **`removeLeaf` split-id removal** — grep found zero call sites passing a split id (all seven pass pane ids from leaves or drag payloads). If an undiscovered caller existed, the new behavior is a visible no-op (pane not removed), not corruption; the pinning test documents the contract.
- **`Object.is` on object-valued fields** — `agentDisconnected`, and any future object field, always registers as changed when a fresh object is passed. Conservative: worst case is today's behavior, never a missed update.

**Secondary risk:** the `session:detected` inline call site (`:1954`) is easy to miss because backlog item 10 doesn't list it. This spec lists it; the shared `patchLeafInTabs` helper makes divergence structurally impossible.

## Verification Steps

1. `npm test` — all existing `paneTree.test.ts`, `panes.test.ts`, `tabLabels.test.ts`, `cwdRepair.test.ts` suites green plus the new identity assertions.
2. `npm run typecheck` — green (import moves touch `tsconfig.web.json`/`tsconfig.node.json` include boundaries: `paneTree.ts` is already in the shared/main include and imported by renderer code, so no config change expected; verify).
3. `npm run test:e2e` — startup spec still passes (layout restore and `tab:absorb` exercise `removeLeaf`/tab identity paths end-to-end).
4. Manual smoke (dev build):
   - Open two tabs; rename a pane in tab A to the **same** name twice — with a `console.log` temporarily in the `layout:save` effect (or a breakpoint), confirm the save does not re-fire on the second rename; then confirm it does fire when the name actually changes.
   - Detach a tab to a second window; exit a shell in the primary window; confirm the detached window does not emit `tab:state-sync` (temporary log in the `:165` effect).
   - Close a pane in a 3-pane split; confirm the layout collapses correctly and restores after restart (removeLeaf behavior unchanged).
   - Kill an agent process externally; confirm the pane shows the disconnected banner and the session appears in Recent (markPtyExited + sessions:refresh path).

## Handoff Contract

### Non-negotiables

1. **`src/shared/paneTree.ts` stays a pure, Electron-free module** — no imports beyond `./types`, no `window`/`process`/store access. `markLeafExitedByPtyId` and `collectLeaves` must respect this (they do by construction).
2. **Every existing `paneTree.test.ts` and `panes.test.ts` assertion keeps passing** (the single allowed edit is strengthening `paneTree.test.ts:89` from `toEqual` to `toBe` and removing its stray `?.`).
3. **No behavior change to layout persistence content — only to when it fires.** The JSON written by `layout:save` for any real state change must be byte-identical to today's. Do not alter the 1000ms/300ms debounce values, the `tab:state-sync` message shape, or the `version` counter semantics in `App.tsx`.
4. **Patch semantics unchanged for real changes.** Every field a call site sets today (`agentDisconnected: undefined`, `resumeError: undefined` clears, etc.) is still set; only the identical-value case short-circuits.
5. `markPtyExited` still triggers `sessions:refresh` exactly when an agent pane with a known `sessionId` exits (CLAUDE.md session-indexing invariant), and still guards on `window.ipc`.
6. No changes to `src/main/**`, IPC channel signatures, or `src/shared/types.ts`.
7. `removeLeaf`'s pinned contract (leaves only; identity-preserving on no-match) is documented in its doc comment and covered by tests.

### Definition of Done

- `updateLeaf`, `markLeafExitedByPtyId`, `removeLeaf`, and `collectLeaves`/`collectLeafIds` in `paneTree.ts` are identity-preserving per the contracts above, with doc comments stating the reference semantics and the shallow-`Object.is` no-op rule.
- All six producer call sites in `panes.ts` (`setPtyId`, `setPaneCustomName`, `setSessionId`, `updatePane`, the `session:detected` inline setState, `markPtyExited`) keep the same tab object when a root is unchanged and return the same state when no tab changed.
- `collectLeaves` is exported from `paneTree.ts`, `collectLeafIds` derives from it, `tabLabels.ts` no longer defines or exports it, and all importers (`panes.ts`, `TabSections.tsx`, `TabBar/index.tsx`, tests) compile against the new location.
- New tests from the Tests section exist and pass; `npm test`, `npm run typecheck`, `npm run test:e2e` green.
- Manual smoke steps 4a-4d verified once on Windows.
- `specs/pending/032-code-improvement-backlog.md` items 10, 39, 40 marked done (or removed) in the same PR.

## Out of Scope

- Subscriber-side memoization fixes: backlog items 6 (`PaneContainer` focus selector), 16 (`PaneHeader` sessions subscription), 17 (`TabBar` `computeLabels` memo), 18 (`TabSections` re-walks). This spec makes those fixes more effective but does not implement them.
- Backlog item 29 (`panes.ts` split, `findLeafByPtyId` extraction, replacing the `session:detected` inline setState with a `setSessionId` call, shared `resumeIntoPane`). If 29b lands first, the inline call site in Phase 2 disappears — coordinate, don't duplicate.
- Deduplicating `tabLabels.findLeafById`/`firstLeaf` against `paneTree.findLeaf` (verbatim duplicate at `tabLabels.ts:4-7`) — a cheap follow-up under item 39's spirit, but not required to keep `tabLabels.ts` label-only for this spec's purposes.
- `updateRatioInTree` identity preservation (only touches the active tab during a drag; drag-time saves are real changes).
- Making `swapLeaves`/`replaceNode` identity-preserving (their callers always perform real changes).
- Any debounce-value tuning, IPC batching, or flow control (CLAUDE.md: no flow control in the pty/render pipeline).
