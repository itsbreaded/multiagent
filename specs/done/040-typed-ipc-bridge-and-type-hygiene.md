# 040 — Typed IPC Bridge and Type Hygiene

Covers items **20, 27, 21, 36, 43, 46** from `specs/pending/032-code-improvement-backlog.md`. All line numbers below were verified against the code as of this writing; they will drift — re-verify with the greps given per item before editing.

## Problem

CLAUDE.md declares `src/shared/types.ts` the single source of truth for IPC channel names and signatures. Today that claim is only half true: 13 channels exist solely as string-union members with no `IPCChannels` signature entry, and the `IpcBridge` interface erases all signatures anyway (`invoke(channel, ...args: unknown[]): Promise<unknown>`), so every call site casts results and drift compiles silently. Around this core problem sit four smaller hygiene gaps: config files (`vitest.config.ts`, `__mocks__/zustand.ts`) that `npm run typecheck` never sees; two unused runtime dependencies shipped in every installer; a store (`updater.ts`) whose module-level IPC wiring throws in renderer tests; and a dead `as any` fallback restore path in `App.tsx` that also flips the `layoutReady` gate too early — the exact save-overwrite hazard the gate exists to prevent.

## Current Behavior

### Item 20 — Channels missing from `IPCChannels` (verified list)

`src/shared/types.ts` defines the `IPCChannels` map (lines ~269-460) and three string unions: `InvokeChannels` (~464-518), `EventChannels` (~520-554), `SendChannels` (~556-574). Cross-referencing every union member against the map keys, the following **13 channels appear in a union but have no `IPCChannels` entry**:

**Invoke (renderer → main, returns a promise):**

| Channel | Evidence for signature |
|---|---|
| `window:focus-for-tab` | `handlers.ts:602` `ipcMain.handle('window:focus-for-tab', (_e, tabId: string) => windowManager.focusWindowForTab(tabId))`; `WindowManager.focusWindowForTab(tabId: string): boolean` (`WindowManager.ts:177`). Caller: `Sidebar/TabSections.tsx:165`. |

**Event (main → renderer):**

| Channel | Evidence for signature |
|---|---|
| `git:branch-updated` | `handlers.ts:61-63` broadcasts `(cwdKeys, branch)` from `GitBranchWatcher`'s `BranchUpdate = (cwdKeys: string[], branch: string \| null) => void` (`GitBranchWatcher.ts:5`). Listener: `panes.ts:1922`. |
| `tab:return` | `(tabId: string)` — sent at `WindowManager.ts:65`, `handlers.ts:903`, `:918`; listener `panes.ts:2033`. |
| `pane:focus-changed` | `(windowId: number, tabId: string, paneId: string)` — relayed at `handlers.ts:607-611`; listener `panes.ts:2077`. **Not listed in backlog item 20 but verified missing.** Appears in *both* `EventChannels` and `SendChannels` (it is a renderer→main send that main rebroadcasts to other renderers) — one map entry covers both. |
| `window:became-active` | `(windowId: number)` — broadcast at `handlers.ts:142`; listener `panes.ts:2088`. **Also not in the backlog list but verified missing.** |

**Send (renderer → main, fire-and-forget; mostly transfer acks):**

| Channel | Evidence for signature |
|---|---|
| `tab:detached-ready` | `(tabId: string)` — `handlers.ts:719`; sender `panes.ts:523`. |
| `tab:release-applied` | `(releaseId: string)` — ack listener `handlers.ts:941-949`; sender `panes.ts:2009`. |
| `focus:target-report` | `(tabId: string, paneId: string)` — `handlers.ts:613-622`; sender `panes.ts:89`. |
| `pane:received-applied` | `(transferId: string)` — `handlers.ts:775-783`; sender `panes.ts:2199`. |
| `pane:focus-remote-applied` | `(requestId: string)` — `handlers.ts:646-653`; sender `panes.ts:2057`. |
| `tab:spawn-in-project-applied` | `(requestId: string, ok: boolean)` — `handlers.ts:696-703` reads a second `ok` arg (`finish(ok !== false)`); senders `panes.ts:2067` (`, true`), `:2071` (`, false`). **The only two-arg ack.** |
| `renderer:insert-at-split-applied` | `(transferId: string)` — via `waitForAck` `handlers.ts:834`; sender `panes.ts:2259`. |
| `renderer:replace-pane-applied` | `(transferId: string)` — via `waitForAck` `handlers.ts:866-869`; sender `panes.ts:2277`. |

**Correction to backlog item 20:** it lists `layout:state-response` as missing, but `IPCChannels` already has entries for both `layout:state-response` and `layout:detached-state-response` (`types.ts:364-365`, typed `(requestId: string, state/snapshot: unknown) => void`). Do not re-add them. Conversely, `pane:focus-changed` and `window:became-active` are missing but were not in the backlog's list. The table above is the authoritative inventory; re-verify it before editing with:

```
grep -oE "'[a-z-]+:[a-z0-9-]+'" src/shared/types.ts  # then diff union members vs map keys
```

Nothing prevents this drift structurally: the unions are free-standing string literals, so a channel can be added to a union (making it callable through the bridge) without ever getting a signature.

### Item 27 — Untyped `IpcBridge`

`types.ts:576-580`:

```ts
export interface IpcBridge {
  invoke(channel: InvokeChannels, ...args: unknown[]): Promise<unknown>
  on(channel: EventChannels, handler: (...args: unknown[]) => void): () => void
  send(channel: SendChannels, ...args: unknown[]): void
}
```

`src/preload/index.ts:27-48` implements exactly this shape (plus e2e tracing), and `src/shared/window.d.ts` declares `window.ipc: IpcBridge`. Consequences, all verified:

- Every `invoke` result is cast at the call site. Non-exhaustive examples: `sessions.ts:23` (`as Session[]`), `:47` (`as SessionRepairCwdResult`); `panes.ts:149`, `:164`, `:408`, `:1249`, `:1276`, `:1304` (session:new/resume/validate result casts); `SessionBrowser/index.tsx:69` (`as SessionSearchResult[]`); `App.tsx:110` (`as boolean`), `:119`, `:138-139`, `:147`, `:155`.
- Argument arity/type drift compiles silently — nothing checks that `invoke('session:resume', ...)` passes `(AgentKind, string, string)`.

### Item 21 — Config files type-checked by nothing

- Root `tsconfig.json` is `{ "files": [], "references": [tsconfig.node.json, tsconfig.web.json] }` — solution-style, checks nothing itself.
- `tsconfig.node.json` `include`: `electron.vite.config.*`, `playwright.config.ts`, `e2e/**/*`, `src/main/**/*`, `src/preload/**/*`, `src/shared/**/*`. **No `vitest.config.ts`.**
- `tsconfig.web.json` `include`: `src/renderer/**/*`, `src/shared/**/*`, `tests/**/*`. **No `__mocks__/**/*`** — yet repo-root `__mocks__/zustand.ts` exists and is mandatory for every renderer test (activated by `vi.mock('zustand')` in `tests/setup.renderer.ts` per CLAUDE.md).

So `npm run typecheck` (`tsc -b --noEmit`) never sees `vitest.config.ts` or the zustand auto-reset mock; either can rot silently.

### Item 36 — Unused runtime deps

`package.json` `dependencies` include `"clsx": "^2.1.1"` (line 64) and `"tailwind-merge": "^3.6.0"` (line 69). Verified zero imports: a grep for `clsx|tailwind-merge` across the repo hits only `package.json`, `package-lock.json`, and the backlog spec — nothing under `src/`. They ship in the installer asar for nothing. Tailwind itself **is** wired (via `main.css` / `electron.vite.config.ts`) and is not touched by this item.

### Item 43 — `updater.ts` unguarded module-level IPC wiring

`src/renderer/src/store/updater.ts:22-26`:

```ts
window.ipc.on('updater:status', (s: unknown) => {
  const status = s as UpdaterStatus
  ...
})
```

Two defects: (a) no `typeof window !== 'undefined' && window.ipc` guard — happy-dom provides `window` but not `window.ipc`, so merely importing this module in a renderer test throws (`sessions.ts:67` and `panes.ts` show the established guard pattern); (b) the payload is blind-cast with no shape check.

### Item 46 — `App.tsx` dead fallback restore with `as any` and a broken `layoutReady` gate

`App.tsx:133-162`: the primary restore path (`.then` branch, lines 146-151) invokes `layout:load`, casts to the full typed shape, and **returns** the chained promise so the outer `.finally(() => setLayoutReady(true))` (line 161) waits for it. The `.catch` branch (lines 152-160) — reachable only if `window:get-init-data` itself rejects — duplicates the restore with a narrower cast plus `applyLayout(data as any)` (with an eslint-disable), and critically does **not return** its inner promise. The `.catch` callback therefore resolves immediately, `.finally` fires, and `layoutReady` flips to `true` before the fallback's `layout:load` has even resolved — while `layoutReady` is exactly the gate that prevents layout saving from overwriting a saved layout with empty initial state (per CLAUDE.md). The fallback is also effectively dead: `window:get-init-data` is a plain `ipcMain.handle` returning cached init data; it has no realistic rejection path in production.

## Intended Behavior

1. Every channel name that appears in any of the three unions has a signature entry in `IPCChannels`, and the unions are structurally incapable of drifting from the map (a union member without a map entry is a compile error).
2. `window.ipc.invoke` and `window.ipc.send` are fully typed from `IPCChannels`: wrong channel name, wrong argument list, or wrong assumed result type is a compile error. `on` stays loose — event payloads cross a process boundary and deserve runtime guards, not compile-time trust.
3. All now-redundant `as` casts on `window.ipc.invoke` results are removed; latent argument mismatches surfaced by the typed bridge are fixed at the call site, never by loosening types.
4. `npm run typecheck` covers `vitest.config.ts` and `__mocks__/zustand.ts`.
5. `clsx` and `tailwind-merge` are gone from `dependencies`.
6. Importing `store/updater.ts` in a renderer test without `window.ipc` is safe, and the updater payload gets a minimal shape check before entering the store.
7. `App.tsx` has a single typed restore path; `layoutReady` flips only after restore work has completed (or the fallback is deleted with justification — see plan).

No runtime behavior changes except the updater guard/shape-check and the App.tsx fallback fix. Everything else is compile-time only.

## Implementation Plan

Ordered: **Step 1 (item 20) → Step 2 (item 27) → Step 3 (items 43, 46)**. Steps 4 (item 21) and 5 (item 36) are independent and can land any time, but Step 4 is best done early so any type errors it reveals are fixed in the same PR.

### Step 1 — Add missing `IPCChannels` signatures and make the unions drift-proof (item 20)

In `src/shared/types.ts`, add to `IPCChannels` (grouped with their neighbors; comments per existing style):

```ts
// --- Git (push) ---
// Main pushes branch changes for all cwd keys sharing a repository
'git:branch-updated': (cwdKeys: string[], branch: string | null) => void

// --- Multi-window ---
// Renderer asks main to focus whichever window owns a tab
'window:focus-for-tab': (tabId: string) => boolean
// Main tells a window a tab is coming back to it (bring-home / reattach / detached-window close)
'tab:return': (tabId: string) => void
// Renderer → main immediate focus notification; main rebroadcasts to all other windows
// (same shape both directions — bypasses the debounced tab:state-sync)
'pane:focus-changed': (windowId: number, tabId: string, paneId: string) => void
// Broadcast by main whenever a BrowserWindow gains OS focus
'window:became-active': (windowId: number) => void

// --- Renderer → main acks (fire-and-forget sends) ---
'tab:detached-ready': (tabId: string) => void
'tab:release-applied': (releaseId: string) => void
'focus:target-report': (tabId: string, paneId: string) => void
'pane:received-applied': (transferId: string) => void
'pane:focus-remote-applied': (requestId: string) => void
'tab:spawn-in-project-applied': (requestId: string, ok: boolean) => void
'renderer:insert-at-split-applied': (transferId: string) => void
'renderer:replace-pane-applied': (transferId: string) => void
```

Do **not** add `layout:state-response` / `layout:detached-state-response` — they already exist at `types.ts:364-365`.

Then make drift impossible by constraining the unions to map keys. Replace the three free-standing unions with:

```ts
// Constrains a channel-name union to keys that exist in IPCChannels.
// Adding a name to a union below without a signature entry is a compile error.
type ChannelSubset<K extends keyof IPCChannels> = K

export type InvokeChannels = ChannelSubset<
  | 'sessions:search'
  | 'sessions:search-deep'
  // ... (keep the existing member lists verbatim)
>
export type EventChannels = ChannelSubset< /* existing members */ >
export type SendChannels = ChannelSubset< /* existing members */ >
```

Keep the member lists and their comments exactly as they are — only the wrapper is new. Verify each union member compiles (this is the mechanical proof that the inventory above is complete: any still-missing channel now errors).

### Step 2 — Typed `IpcBridge` (item 27; depends on Step 1)

In `types.ts`, replace `IpcBridge`:

```ts
export interface IpcBridge {
  invoke<C extends InvokeChannels>(
    channel: C,
    ...args: Parameters<IPCChannels[C]>
  ): Promise<ReturnType<IPCChannels[C]>>
  // `on` stays deliberately loose: event payloads cross the process boundary
  // and must be runtime-guarded at each listener, not compile-time trusted.
  on(channel: EventChannels, handler: (...args: unknown[]) => void): () => void
  send<C extends SendChannels>(channel: C, ...args: Parameters<IPCChannels[C]>): void
}
```

`src/preload/index.ts` (~line 27): the `contextBridge.exposeInMainWorld('ipc', {...})` object should satisfy the new interface. The implementation bodies may keep `unknown[]` internally (they just forward to `ipcRenderer`), but type the object literal against `IpcBridge` (e.g. `const bridge: IpcBridge = { invoke(channel, ...args) { ... } }` with generic method signatures matching the interface) so the compiler checks the exposure. `src/shared/window.d.ts` needs no change — it already declares `window.ipc: IpcBridge`.

Then fix the fallout:

1. Run `npm run typecheck`. Every call site that passed wrong args or assumed a wrong result shape now errors. **Fix each at the site; never widen a signature in `IPCChannels` to make an error go away unless the main-process handler genuinely accepts that shape** (in which case types.ts was wrong and the fix is a corrected signature with a comment).
2. Inventory and remove now-redundant result casts. Find them with:
   ```
   grep -rnE "window\.ipc\.invoke\(.*\)\s*(\)|as )" src/renderer --include=*.ts --include=*.tsx
   grep -rn "as " src/renderer | grep "ipc.invoke"
   ```
   Known instances to clean: `sessions.ts:23`, `:47`; `panes.ts:149`, `:164`, `:408`, `:1249`, `:1276`, `:1304`; `SessionBrowser/index.tsx:69`; `App.tsx:110`, `:119`, `:127-128`, `:138-139`, `:147`. A cast that *narrows differently* from the declared return type (e.g. `panes.ts:164` casts `session:resume` to `{ ptyId?: string } | null` while the map says `{ ptyId: string }`) is a latent-mismatch flag: determine which side is right by reading the main handler, then align.
3. `zustand`/store test files or any test doubles that stub `window.ipc` may need their stubs updated to satisfy the generic signatures — prefer `IpcBridge`-typed fakes over `as unknown as IpcBridge` where practical.

### Step 3a — `updater.ts` guard + shape check (item 43)

`src/renderer/src/store/updater.ts` — replace lines 21-26 with the guarded pattern used by `sessions.ts:67`, plus a minimal state-string check (the runtime guard `on` deliberately requires):

```ts
const UPDATER_STATES = new Set(['available', 'preparing', 'downloading', 'ready', 'up-to-date', 'error'])

if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('updater:status', (s: unknown) => {
    if (!s || typeof s !== 'object') return
    const state = (s as { state?: unknown }).state
    if (typeof state !== 'string' || !UPDATER_STATES.has(state)) return
    useUpdaterStore.getState().setStatus(s as UpdaterStatus)
  })
}
```

Keep it minimal — this is a guard, not a full validator.

### Step 3b — `App.tsx` restore fallback (item 46)

Recommended: **delete the `.catch` fallback** (lines 152-160) and justify in the commit message: `window:get-init-data` is a synchronous-cached `ipcMain.handle` with no production rejection path; the fallback duplicates the typed restore with an `as any` and flips `layoutReady` before its `applyLayout` runs, which is precisely the overwrite hazard the gate prevents — a broken fallback is worse than none. Keep a `.catch(() => {})` (or log) so an unexpected rejection still reaches `.finally` and the app still renders.

If the team prefers keeping a fallback, the alternative is: extract one typed helper

```ts
const restoreSavedLayout = (): Promise<void> =>
  window.ipc.invoke('layout:load').then((saved) => {
    if (saved?.tabs?.length) return usePanesStore.getState().applyLayout(saved)
  }).catch(() => {})
```

(with the typed bridge from Step 2, `saved` is already the declared `layout:load` return type — no cast), call it from both branches, and **return** it from the `.catch` so `.finally` sequences after it. Either way: no `as any`, no eslint-disable, and `layoutReady` must not flip before the restore promise settles. Note the primary path already `void`s `applyLayout` without awaiting; awaiting it (via `return`) in the helper is a strict improvement and matches the gate's intent — verify startup restore still works (see Verification).

### Step 4 — tsconfig includes (item 21, independent)

- `tsconfig.node.json` `include`: add `"vitest.config.ts"`.
- `tsconfig.web.json` `include`: add `"__mocks__/**/*"`.

Run `npm run typecheck`; fix any errors these files reveal (they have never been checked). Fix errors in the files themselves where possible; if `vitest.config.ts` needs types (e.g. coverage config), add proper imports rather than `any`.

### Step 5 — Remove unused deps (item 36, independent)

```
npm uninstall clsx tailwind-merge
```

Re-verify first that `grep -rE "clsx|tailwind-merge" src/` is still empty. Do not touch Tailwind itself. Confirm `npm run build` still succeeds and `package-lock.json` shrinks accordingly.

## Tests

- **Typecheck is the test for Steps 1-2.** `npm run typecheck` must be green with **zero new `@ts-expect-error`, `@ts-ignore`, or `any` escapes** introduced by this work (the one *removed* `as any` + eslint-disable in App.tsx is part of the deliverable). Diff-check: `git diff | grep -E "ts-expect-error|ts-ignore|: any|as any"` should show only deletions.
- **Union drift guard:** after Step 1, temporarily add a fake name to one union and confirm `ChannelSubset` rejects it, then revert. (No committed test needed — the type system is the permanent test.)
- **updater.ts renderer test** (Step 3a, boy-scout rule): add `src/renderer/src/store/updater.test.ts` in the renderer Vitest project that (a) imports the module with no `window.ipc` present and asserts no throw; (b) with a stubbed `window.ipc.on`, asserts a valid `UpdaterStatus` payload updates the store, and a malformed payload (`{ state: 42 }`, `null`, `'ready'` as a bare string) leaves it untouched. Zustand state reset comes free from the repo `__mocks__/zustand.ts` mechanism.
- **App.tsx** (Step 3b): if a fallback survives, add a unit test for the extracted `restoreSavedLayout` helper (resolve/reject paths, `layoutReady` ordering via the returned promise). If deleted, the e2e cold-restore test (`e2e/startup.spec.ts`) remains the regression net.
- **Step 4 note:** including `vitest.config.ts` and `__mocks__/**/*` in typecheck may surface pre-existing type errors — fixing those is in scope for this spec.
- Full suite: `npm test` green; `npm run test:e2e` green (it exercises `tab:absorb` and startup restore, the two areas whose channels/paths this spec touches at the type level).

## Risks

- **The typed bridge will surface latent mismatches by design.** Budget time for per-site fixes across `panes.ts`, `sessions.ts`, `App.tsx`, `SessionBrowser`, `TabSections`, and any component invoking `window.ipc`. The failure mode to avoid is "fix" by widening `IPCChannels` signatures to `unknown`/optional — that reinstates the problem with extra steps. When a call site and the map disagree, the main-process handler is the arbiter.
- **`pane:focus-changed` dual membership** (both `EventChannels` and `SendChannels`) is intentional and already true today; one `IPCChannels` entry serves both directions. Don't "fix" it into two channels.
- **`tab:spawn-in-project-applied` arity:** the map entry must include the second `ok: boolean` arg or the typed `send` will reject `panes.ts:2067/2071`. Conversely, `handlers.ts` treats a missing `ok` as success (`ok !== false`) — keep the signature `(requestId: string, ok: boolean)` and let the two senders (which always pass it) satisfy it.
- **New tsconfig includes may reveal existing errors** in `vitest.config.ts` / `__mocks__/zustand.ts` that were invisible until now; they must be fixed, which slightly widens this PR's blast radius. That is the point of the item.
- **Preload typing:** the preload runs in its own context; keep its runtime behavior byte-identical (the e2e trace hooks at `preload/index.ts:5-24, 50-70` must keep working). Only the type annotations change.
- **App.tsx fallback deletion** changes behavior in a path believed unreachable. Mitigate with the retained `.catch` and the e2e cold-start test.

## Verification Steps

1. `npm run typecheck` — green, zero new escapes (grep the diff as above).
2. `npm test` — green, including the new `updater.test.ts`.
3. `npm run test:e2e` — green (cold layout restore, `tab:absorb`, deferred Claude spawn).
4. `npm run build` — green after `npm uninstall clsx tailwind-merge`.
5. Manual smoke (dev, `npm run dev`): cold start restores the saved layout with no prompt and no layout loss after quit/relaunch (item 46 gate); drag a tab to a second window and back (exercises `tab:release-applied` / `pane:received-applied` / `tab:return` typed sends); click a pane in the sidebar owned by a detached window (`window:focus-for-tab`); switch a git branch in a pane's repo and confirm the branch label updates (`git:branch-updated`); trigger an update check in Settings and confirm the banner still renders (`updater:status` shape guard didn't over-reject).
6. Inspect `dist` deps: `node -e "console.log(Object.keys(require('./package.json').dependencies))"` — no `clsx`, no `tailwind-merge`.

## Handoff Contract

### Non-negotiables

1. **`src/shared/types.ts` remains the single source of truth.** Every channel in any union has an `IPCChannels` signature; the unions are derived/constrained so a member without a map entry cannot compile. No channel signatures duplicated elsewhere.
2. **No runtime behavior change from the typing work** (Steps 1, 2, 4, 5). The only permitted behavior changes are the `updater.ts` guard + shape check (item 43) and the `App.tsx` fallback fix/deletion (item 46). IPC message shapes on the wire are untouched; ack semantics, timeouts, and ordering in the multi-window transfer protocol are byte-identical.
3. **`on` stays runtime-guarded, not compile-typed.** Event handler payloads keep `unknown` parameters and per-listener runtime checks. Do not introduce a typed `on` in this spec.
4. **Never loosen to pass.** No new `any`, `as any`, `@ts-expect-error`, `@ts-ignore`, or widened `IPCChannels` signatures to silence errors. Mismatches are fixed at call sites, arbitrated by the main-process handler's actual behavior.
5. No changes to PTY flow (no flow control, no PATH rewrites, deferred agent spawn untouched) — this spec is type-level plus two small renderer fixes.

### Definition of Done

- The 13 missing channel signatures are in `IPCChannels` (and `layout:state-response`/`layout:detached-state-response` were not duplicated).
- Unions constrained via `ChannelSubset` (or equivalent) — demonstrated drift-proof.
- `IpcBridge.invoke`/`send` generically typed from `IPCChannels`; preload satisfies the interface; all redundant result casts removed (grep inventory clean).
- `tsconfig.node.json` includes `vitest.config.ts`; `tsconfig.web.json` includes `__mocks__/**/*`; both type-check clean.
- `clsx` and `tailwind-merge` uninstalled.
- `updater.ts` guarded + shape-checked with its new renderer test.
- `App.tsx` fallback deleted (with commit justification) or replaced by one shared typed helper with correct `layoutReady` sequencing; the `as any` and its eslint-disable are gone either way.
- All of: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build` green; manual smoke steps pass.
- Update CLAUDE.md only if a durable lesson emerged (e.g. a note that the bridge is typed and how to add a new channel: map entry first, then union member).

## Out of Scope

- Typing `on` handlers or adding a payload-validation framework for events (deliberate — see non-negotiable 3).
- Backlog item 19 (validating `loadAgentProviderSettings` / `window-state.json` JSON) — related type-safety work, separate item.
- Backlog item 45 (MCP tool arg validation in `BrowserMcpServer`).
- Splitting `handlers.ts` or `panes.ts` (items 28/29), consolidating the ack protocol, or any refactor of the transfer flow.
- Raising coverage ratchets in `vitest.config.ts` beyond what the boy-scout test adds.
- Removing or reworking the e2e trace instrumentation in the preload.
- Any Tailwind configuration change (only the two unused runtime deps go).
