# Atomic State Audit — Follow-Up Review Findings

Date: 2026-06-13

This document records **critical issues found while re-reviewing the code referenced by
`specs/atomic-state-audit.md`**, whose "Fixed In Current Code" section claims all 16 original
findings are resolved. Most of those claims hold up. The issues below are the ones that do **not**.

Per the audit's own Guiding Principle ("Moving a pane or tab across windows should have a
transaction ... that cannot partially complete"), the items below are real gaps, not style.

---

## 1. [CRITICAL] `tab:absorb` can permanently lose a tab and orphan its PTYs on ack timeout

**Files:**
- `src/main/ipc/handlers.ts` — `tab:absorb` handler, lines 528–573
- `src/renderer/src/store/panes.ts` — `tab:release` listener (1307–1318), `removeTabLocally` (384–395)
- `src/renderer/src/App.tsx` — absorb caller, lines 213–216
- `src/renderer/src/components/TabBar/index.tsx` — absorb caller, lines 367–370

### What the code does

The absorb flow is meant to be a transactional, ack-based handoff (audit finding #6, marked fixed):

1. Target window (absorber `B`) optimistically adds the tab: `receiveTab(tab)`, then invokes
   `tab:absorb`. On a falsy result it rolls its optimistic copy back:
   ```ts
   // TabBar/index.tsx:367–370 (and App.tsx:213–216)
   window.ipc.invoke('tab:absorb', JSON.stringify(tab), ptyIds, sourceWindowId ?? -1)
     .then((ok) => {
       if (!ok) usePanesStore.getState().removeTabLocally(tab.id)
     })
   ```
2. Main sends `tab:release` to the source window and **waits up to 1000 ms** for
   `tab:release-applied`:
   ```ts
   // handlers.ts:542–562
   const released = await new Promise<boolean>((resolve) => {
     const timer = setTimeout(() => {
       ipcMain.removeListener('tab:release-applied', onApplied)
       resolve(false)                       // <-- timeout path
     }, 1000)
     ...
     sourceWin.webContents.send('tab:release', tab.id, ..., releaseId)
   })
   if (!released || toWin.isDestroyed()) return false   // handlers.ts:563
   ```
3. The source window, on receiving `tab:release`, **removes the tab immediately and
   unconditionally** — before (and independently of) acking:
   ```ts
   // panes.ts:1307–1318
   window.ipc.on('tab:release', (tabId, ownerWindowId, releaseId) => {
     if (store.isDetachedWindow) {
       store.removeTabLocally(tabId)        // <-- source drops the tab here
     } else {
       store.detachTab(tabId, ...)
     }
     if (typeof releaseId === 'string') window.ipc.send('tab:release-applied', releaseId)
   })
   ```
   `removeTabLocally` deletes the tab **without killing its PTYs** (panes.ts:384–386), by design,
   because absorb is supposed to transfer them.

### The bug

The source acts on `tab:release` *before* the transfer is confirmed, and there is **no rollback /
restore path** if the transfer subsequently fails. Concretely, when the source is a **detached
window** (`isDetachedWindow === true`):

1. `B` calls `receiveTab(T)` and invokes `tab:absorb`. `B` and `A` now both hold `T` (expected
   handoff overlap).
2. Main sends `tab:release` to source `A`.
3. `A` runs `removeTabLocally(T)` — **`T` is gone from `A`** — and sends `tab:release-applied`.
4. The ack takes **longer than 1000 ms** (busy renderer, GC pause, many live terminals
   re-rendering after the removal). The `setTimeout` fires, `released` resolves `false`, and the
   handler returns `false` at line 563 **without ever calling `transferPty`** (lines 569–571).
5. `B` receives `ok === false` and runs `removeTabLocally(T)` — **`T` is gone from `B`**.

**Result:** `T` is removed from *both* windows. Its PTYs are still alive in the main process but
remain routed to `A`'s now-stale `webContents` (the `transferPty` loop never ran), so their output
goes to a pane that no longer exists. The user's tab — including any running Claude/Codex agent
sessions in it — vanishes from every window with no way to recover it from the UI, and the PTY
processes leak.

The same outcome occurs if `toWin.isDestroyed()` becomes true between the ack and line 563.

### Why this is reachable in practice

The 1000 ms budget covers a full main→renderer→main round trip whose middle step is a synchronous
store mutation that triggers a React re-render of a window that may host many xterm instances. This
is non-deterministic; it does not need a crash, just transient load. Because the failure mode is
silent, total, and unrecoverable (lost tab + orphaned PTYs), the low probability does not lower the
severity.

### Suggested direction

- The source must not destroy its copy until the transfer is known to have committed. Either:
  - keep the source tab in a "releasing" state and only finalize removal after a main-sent
    `tab:absorb-committed` (mirroring the `pane:received-applied` → `pane:remove-remote` ordering
    used for panes), **or**
  - have main send an explicit `tab:release-rollback` to the source on the timeout / destroyed
    path so `A` can restore the tab it removed.
- On timeout, main should not leave PTYs routed to a window that no longer renders the tab; either
  roll routing back to the source explicitly or do not let the source drop the tab first.

---

## 2. [MEDIUM] `pane:transfer` leaves a duplicate pane (and unrouted PTY) on ack timeout

**File:** `src/main/ipc/handlers.ts` — `pane:transfer` handler, lines 459–497

Same 1000 ms ack model as absorb (lines 474–489). Here the ordering is safer — source removal
(`pane:remove-remote`, line 492) happens only *after* a successful commit, and PTY routing moves at
line 491 — so a timeout does **not** lose the pane. However, the target's `pane:received` listener
adds the pane optimistically before acking. If the ack is lost/late:

- Main returns `false` and never calls `transferPty` (line 491) or `pane:remove-remote` (line 492).
- The **source keeps** its working pane (good), but the **target may have already committed** the
  pane from `pane:received` with no corresponding PTY routing.

Net effect is a duplicate, dead pane in the target window (renders, but receives no PTY output),
rather than data loss. Lower severity than #1, but it is the same missing-rollback pattern and
should be handled when #1 is fixed (e.g. target rolls back its optimistic `pane:received` add if it
does not observe routing / a commit within the window).

---

## 3. [LOW/MEDIUM] `tab:bring-home` and `tab:reattach-home` do not wait for release before return

**File:** `src/main/ipc/handlers.ts` — lines 500–511 and 517–526

Unlike `tab:absorb`, these handlers send `tab:release` to the source and **immediately** send
`tab:return` to the destination, with no `tab:release-applied` handshake:

```ts
// handlers.ts:505–510
windowManager.unrecordTab(tabId)
sourceWin.webContents.send('tab:release', tabId)
const callerWin = BrowserWindow.fromWebContents(e.sender)
callerWin?.webContents.send('tab:return', tabId)
```

Audit finding #7's improvement list explicitly suggested "Consider `tab:release-applied` before
`tab:return`"; that was implemented for `tab:absorb` but **not** for the bring-home / reattach
paths. Impact is limited because the primary window retains the detached tab's full data (detached
tabs stay visible in the primary), so this is mainly a PTY re-adoption ordering race
(`tab:return` → `tab:adopt`, panes.ts:1321–1334) rather than data loss. Worth tightening for
consistency, but not critical.

---

## Items re-checked and confirmed correctly fixed (no action needed)

To keep signal high, these claims from the audit's "Fixed In Current Code" were verified against
the code and found genuinely sound:

- **Shell PTY single owner** — `addShellPane` no longer calls `pty:create`; `Terminal` is the sole
  owner (panes.ts:761 comment + Terminal mount).
- **`closePane` tab-safety** — `closePane` only ever receives the focused pane (always in the active
  tab); the sidebar uses `closePaneInTab(tabId, paneId)`. No cross-tab disposal leak.
- **`zoomedPaneId` validation** — `setActiveTab` (panes.ts:570–585) clears/validates the zoom target
  against the destination tab.
- **Optimistic vs confirmed focus** — `focusDetachedPaneOptimistically` arms a 1 s guard;
  `clearPendingRemoteFocus` (panes.ts:27–32) cancels the timer on success and intentionally keeps
  `pendingFocusTarget` until `focus:target-changed` confirms. The "stuck highlight on timeout"
  concern does not occur — the timer is cancelled when the remote window actually receives focus
  (panes.ts:1393–1400).
- **Ownership generations + sync version + tombstones** — `recordDetachedTabsForWindow`
  (WindowManager.ts:128–149) rejects stale syncs by per-window version and rejects re-claims of
  departed tabs by tombstone. Stale syncs early-return without mutating `tabToWindowId`, so a moved
  tab is not resurrected. Electron's per-`webContents` FIFO IPC ordering closes the
  add-before-sync race for the absorbing window.
- **Agent metadata commit** — `newSession` commits `{ ptyId, sessionId }` in a single `updatePane`
  (panes.ts ~928). `resumeSession` commits the durable `sessionId` on the leaf at insert time and
  only the runtime `ptyId` later, which is correct (no partial *identity* is ever persisted).
