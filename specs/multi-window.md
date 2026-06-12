# Multi-Window Tab Tear-Off Spec

## Guiding principle

Maximum flexibility. Users can move tabs and panes anywhere across any number of windows and expect intuitive, common-sense behavior at every step.

---

## Window anatomy

| Window   | Sidebar | Tab bar | Notes |
|----------|---------|---------|-------|
| Primary  | Yes     | Yes     | Full UI — created on app launch |
| Detached | No      | Yes     | Content only; fully tab-capable (+, close, rename, tear-off) |

---

## Sidebar (primary window only)

- Lists **every tab across all windows** — local and detached — in one unified list
- Detached tabs render **identically** to local tabs — no dimming, no opacity change
- Only visual distinction: a small `↗` badge after the tab name
- **Click local tab header / pane row** → switch to it in the primary window
- **Click detached tab header / pane row** → brings that window to front (`window:focus-for-tab`)
- **Pane row drag** → works on all tabs, local and detached (see cross-window pane drag)
- **Sidebar always shows live state** — renames, CWD changes, new panes, and new tabs created inside any detached window sync back in real time

---

## Context menu (right-click on any tab — sidebar or tab bar)

| Item | When shown |
|------|------------|
| Rename | Always |
| Set Default Directory | Always |
| — separator — | |
| Bring to This Window | Detached tabs only; moves just that one tab back to primary |
| — separator — | |
| Close Tab | Always (destroys tab + PTYs) |
| Close Other Tabs | Always |
| Close Tabs to Right | Always |
| — separator — | |
| Duplicate | Always |

---

## Tearing a tab off

- Works from **any window** — primary or detached
- Drag a tab chip outside any window → new detached window containing that tab
- The primary sidebar always reflects where each tab currently lives, regardless of how many hops it has taken
- If the **source window is detached** and its last tab is torn off → that detached window closes automatically
- If the **primary window** is left with zero local tabs → shows empty/blank landing screen; **no auto-created tab**

---

## Moving tabs back

| Action | Result |
|--------|--------|
| Drag tab chip into any window's tab bar | Tab drops at the target position; source window closes if it was a detached window and had no remaining tabs |
| Close detached window (X button) | All tabs in that window append to the end of the primary tab bar in order |
| Context menu → "Bring to This Window" on one detached tab | That one tab moves to the end of the primary tab bar; source detached window closes if it was its last tab |

---

## Cross-window pane drag (via sidebar)

- Drag any pane row in the sidebar, drop onto **any tab section header** (local or detached)
- The pane moves to that tab; if the target tab is in a detached window, an IPC call transfers the pane and its PTY routing to that window
- Source tab: if it was the last pane, the tab goes **blank** (default landing screen) — **never auto-closes**

---

## Closing behaviour

| Action | Result |
|--------|--------|
| Close detached window (X button) | All its tabs return to the end of the primary tab bar |
| Close tab chip or context menu "Close Tab" | Tab destroyed, PTYs killed; if it was the last tab in a detached window → that window closes |
| Close primary window | All detached windows close; `before-quit` kills all PTYs and cleans up resources |

---

## Live state sync (detached → primary)

- Whenever a detached window's tab list changes (rename, CWD update, new pane, new tab, close tab), the detached window sends a debounced `tab:state-sync` IPC event to the main process
- Main process routes it to the primary window and updates the `WindowManager` tab-to-window routing table
- Primary window merges the update:
  - Updates existing detached tab entries that match by ID
  - Adds new detached tab entries for tabs created inside the detached window
  - Removes entries for tabs that were closed inside the detached window
  - All synced entries are marked `detached: true`

---

## IPC channels involved

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `tab:tear-off` | renderer → main | Create a new detached window for a tab |
| `tab:adopt` | renderer → main | New window claims PTY routing for its tabs |
| `tab:absorb` | renderer → main | Absorb a tab dropped from another window |
| `tab:release` | main → renderer | Tell source window to mark a tab as detached |
| `tab:return` | main → renderer | Tell primary window to un-mark a tab as detached (with latest tab data) |
| `tab:state-sync` | renderer → main → primary | Push live tab state from a detached window to the primary sidebar |
| `window:get-id` | renderer → main | Get this window's Electron window ID |
| `window:get-init-data` | renderer → main | Detached window fetches its initial tab + PTY data on startup |
| `window:get-all-bounds` | renderer → main | Fetch all window bounds before a drag (for tear-off detection) |
| `window:snap-apply` | renderer → main | Apply snap-dock positioning |
| `window:snap-zones` | main → renderer | Push snap zone hints during window move |
| `window:focus-for-tab` | renderer → main | Focus whichever window currently owns a given tab |
| `pane:transfer` | renderer → main → renderer | Move a single pane (with PTY) from one window's tab to another |
