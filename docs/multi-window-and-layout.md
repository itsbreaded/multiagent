# Pane Layout & Multi-Window State (mechanism)

The why/how behind the pane tree, layout save/restore, and cross-window tab/pane movement.
The one-line guardrails live in `AGENTS.md`.

---

## Pane layout model

The layout is a binary tree of `PaneNode = PaneLeaf | PaneSplit` (same model as tmux). Each
`Tab` has a `rootNode` and a `focusedPaneId`. `PaneLeaf` holds `paneType` (`'shell'|'agent'`),
optional `agentKind` (`'claude'|'codex'`), `cwd`, optional `ptyId`, optional `sessionId`, and
optional `customName` (user-set label prefix).

Display labels: `src/renderer/src/utils/tabLabels.ts` is the single source for label
computation. `paneLabelText(pane, sessions)` returns `"customName - directory"` or just the
directory. `computeLabels(tabs, sessions)` returns a `Map<tabId, string>` for sidebar rows.

## Startup restore

Layouts are auto-restored on startup without prompting. `App.tsx` guards restore with a ref
so React StrictMode cannot start duplicate restores, and layout saving is disabled until
`layoutReady` to avoid overwriting a saved layout with an empty initial state. Saved layout
includes `activeTabId`, `sidebarSectionOpen`, and `sidebarPanelSizes`; `layout:save` and
`applyLayout` normalize every saved tab to `detached: false` because detached BrowserWindows
are not recreated on cold start. `applyLayout` validates focused pane IDs, restores tab/pane
metadata and sidebar section expansion state, clears stale detached-window ownership maps,
and hydrates only the restored active tab. Inactive restored tabs stay visible in the sidebar
from metadata but their pane trees, shell PTYs, xterms, and agent resumes are
deferred until first focus. Once a tab has hydrated, keep it mounted while inactive so
scrollback and live PTY/session state survive tab switches. Startup resume should feel
exactly like "where we left off"; do not collapse, expand, or focus UI sections implicitly
unless that state was not present in an older saved layout. Any new resizable/collapsible
sidebar panel must use a stable panel id and persist its size through `sidebarPanelSizes`.

Terminal scrollback default + the terminal renderer decision live in `docs/pty-and-terminals.md`.

## Multi-window ownership

Every window owns its own sidebar navigation rows. The primary renderer filters out detached
ownership records, while a detached renderer shows only its local tabs. The top chrome remains for
window controls and non-tab actions, but the top tab strip is no longer rendered. Detached
sidebars stay open in this first version; their collapse state is not independently persisted.
Multi-window tab and pane movement should preserve a single coherent ownership model across
main, source renderer, target renderer, and PTY routing.

### Sidebar-first tab movement

The sidebar is the only tab/folder navigation surface. Individual sidebar actions retain
rename, project-directory, pane navigation, and close; duplicate, close-other, and close-to-
right actions are not part of the interface. The primary sidebar starts a tokenized tear-off
with `tab:tear-off`, but the source keeps its tab and PTY routes until the detached renderer
has passed the `tab:adopt` preflight and sent `tab:detached-ready`. Main validates every PTY's
source route, reroutes the complete set, records target ownership, and sends the existing
`tab:absorb-committed` finalization event. Timeout, startup failure, source close, target close,
or explicit source cancellation restores only routes still owned by the pending target and
removes the target's optimistic row.

Returning a tab uses the explicit detached-sidebar return action. Native detached-window close
is different: `WindowManager.unregister` invalidates pending tear-offs synchronously, retains
closed-window tombstones so stale sync cannot reclaim ownership, removes primary detached
ownership records
with `tab:closed`, and cleans PTYs routed to the closing window. It never emits `tab:return`.

### Atomic focus transitions

User-level focus transitions must be atomic. Do not compose primitive actions such as
`setActiveTab()` followed by `focusPane()` when the UI expects one focus change; use
tab-aware transition actions such as `focusPaneInTab(tabId, paneId)`. Primitive setters should
stay side-effect-light, and named transition actions should own any paired state update plus
IPC broadcast.

### PTY routing must not move ahead of renderer ownership

For cross-window pane or tab movement, the destination should commit and ack before main
reroutes PTYs, and the source should not delete its last good copy until the transfer is
committed or rollback is possible. This is especially important for `tab:absorb`: a release
timeout after the source has already removed the tab can lose the tab from all windows and
orphan its PTYs.

### Transfer ack must reflect actual apply

A cross-window transfer ack must reflect that the destination *actually applied* the change,
not merely that it received the message. Destination store actions used by transfers
(`addPaneToTab`, `insertPaneAtSplit`, `replacePaneById`) return a success boolean, and their
renderer listeners send the `*-applied` ack only when that boolean is true. A no-op apply
(self-drop, or a target tab/pane that vanished mid-drag) must stay silent so main times out
and discards/rolls back instead of removing the source pane — otherwise the source is deleted
after a no-op insert and the pane is lost (spec 024). Guard self-drops
(`sourcePaneId === targetPaneId`) at the drop site, at the IPC handler, and in the store
action; the local-only path's `movePaneToSplit` guard does not cover the cross-window IPC
path.

### Versioned detached sync

Detached sync and focus messages should be versioned or generation-checked. Stale
`tab:state-sync` or focus acks must not reclaim moved tabs or focus a window that no longer
owns the tab.

## Renderer state

Two Zustand stores:

- `usePanesStore` (`src/renderer/src/store/panes.ts`) - pane tree, tab list, focus, zoom, CWD
  updates via `setPaneCwd`
- `useSessionsStore` (`src/renderer/src/store/sessions.ts`) - session list synced from main
  via `sessions:updated`

IPC listeners are wired at module level after store creation (not inside components) to avoid
multiple registrations.

## Shutdown state collection

On primary window close, main intercepts the `close` event once (via `isShutdownSaveComplete`
flag), sends `layout:request-state` to the primary renderer and `layout:collect-detached-state`
to each detached window (up to 1000ms timeout each), merges the fresh detached snapshots into
the primary's tab list, and writes a final `layout.json`. This ensures detached-window changes
made immediately before shutdown are preserved despite the 300ms sync debounce. New IPC
channels: `layout:request-state`, `layout:collect-detached-state` (EventChannels);
`layout:state-response`, `layout:detached-state-response` (SendChannels).
