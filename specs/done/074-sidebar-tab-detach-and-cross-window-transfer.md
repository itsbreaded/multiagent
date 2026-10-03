# Spec: Sidebar Tab Detaching and Cross-Window Tab Transfer

Status: done <!-- draft | ready | in-progress | review | done -->
Created: 2026-10-02
Completed: 2026-10-02

## Problem

The sidebar is now the only tab and project navigation surface, but its tab
headers only support local reorder. Existing detached windows can own tabs and
the application already has a transfer protocol for tear-off, adoption,
ownership, PTY routing, rollback, and detached-window cleanup. The missing
sidebar workflow forces users to use context-menu actions for detaching and
returning tabs, and does not let them move a tab directly between visible
window sidebars.

Without a single drag workflow, it is also easy for a source tab to disappear
before a destination has mounted its pane tree and adopted its PTYs, creating
duplicate rows, stale ownership, or terminals that no longer receive output.
Pane drag-and-drop is already a separate workflow and must not be affected.

## Goal

Make sidebar tab sections draggable for local reorder, drag-out detachment,
and transfer between existing windows while preserving tab identity, pane
trees, active state, PTY ownership/routing, terminal output, session state,
rollback behavior, and the existing detached-window close rule.

## Users & Context

Users navigating multiple projects and panes through the primary sidebar or a
detached window's ownership-scoped sidebar. They expect browser-like drag
feedback and a tab to remain usable until a destination has successfully
initialized and committed ownership.

## Requirements

1. MUST continue to reorder tabs when a tab/folder section is dragged onto
   another section or an insertion position within the same window.
2. MUST create a detached window at the drop location when a tab/folder is
   dragged outside the primary window.
3. MUST keep the source tab usable and visible until the detached destination
   has initialized and adopted its pane PTYs successfully.
4. MUST remove the source navigation row and show the tab in the detached
   window only after successful detachment ownership commit.
5. MUST restore the source state without duplicate or stale rows when
   detachment fails, times out, adoption fails, or the destination closes
   before commit.
6. MUST transfer a dragged tab/folder from one window sidebar to another
   window sidebar when dropped on a valid destination surface.
7. MUST preserve tab identity, pane-tree structure, focused/active state, PTY
   ownership and routing, buffered terminal output, and session metadata during
   cross-window transfer.
8. MUST remove the source tab only after destination application/acknowledgment
   and successful ownership commit.
9. MUST use the existing sidebar reorder semantics for a tab dropped onto a
   tab/folder in the same window; tab drags MUST NOT be treated as pane drags.
10. MUST keep tab and pane drag payloads distinguishable, and MUST preserve
    existing pane drag/drop behavior.
11. MUST preserve sidebar-only navigation, individual close, rename,
    project-directory actions, move/return actions, detached-window close
    semantics, terminal behavior, and session behavior.
12. MUST NOT reintroduce top-tab UI, duplicate-tab actions, bulk-close actions,
    or obsolete overflow/wrap settings.
13. MUST provide browser-like visual drag affordances: valid destination
    highlighting, insertion/drop positioning where applicable, and invalid or
    self-drop protection.
14. MUST handle source-close, destination-close, timeout, adoption failure,
    stale synchronization, and concurrent transfer races without leaving a
    duplicate, orphaned, or stale sidebar row or PTY route.

## Non-Goals

- We will NOT add a second tab-transfer protocol separate from the existing
  ownership and PTY-routing protocol.
- We will NOT change pane drag/drop semantics or allow a pane payload to be
  interpreted as a tab payload.
- We will NOT restore top tabs or add duplicate/bulk-close/overflow controls.
- We will NOT change the rule that closing a detached window closes all tabs it
  owns.
- We will NOT change tab identity, pane-tree schema, session indexing, or
  terminal rendering semantics beyond the transfer lifecycle required here.
- We will NOT add persistence for an in-flight drag beyond the existing
  transfer recovery and layout mechanisms.

## Scenarios (Acceptance Criteria)

- **Given** two local sidebar sections, **when** one header is dragged above,
  below, or onto the other in the same window, **then** the existing reorder
  behavior applies and pane rows remain unchanged.

- **Given** a primary-window tab with live panes, **when** its sidebar header is
  dragged outside the primary window and dropped at a screen location, **then**
  a detached window is created there, the source tab remains usable while it
  initializes, and the source row is removed only after destination ownership
  and PTY adoption commit.

- **Given** a tear-off whose destination cannot initialize or adopt its PTYs,
  **when** the transfer times out, fails, or the destination closes, **then**
  the source row and terminals remain usable exactly once and no destination
  row or stale PTY route remains.

- **Given** a tab in a detached window and a primary-window sidebar, **when**
  the tab is dragged onto the primary sidebar, **then** the tab is transferred
  with the same identity, pane tree, active state, sessions, output, and PTY
  routing, and the source row is removed only after the primary applies and
  acknowledges it.

- **Given** tabs in two detached windows, **when** one tab is dragged onto the
  other window's sidebar, **then** ownership moves atomically after destination
  application/acknowledgment and both sidebars contain exactly the expected
  rows.

- **Given** a tab is being transferred, **when** the source closes, the
  destination closes, a timeout fires, or a stale sync arrives, **then** the
  transfer protocol rejects or rolls back the stale operation without
  duplicate rows, orphaned tabs, or incorrect PTY ownership.

- **Given** a tab header and a pane row are both draggable, **when** either is
  dragged over a valid target, **then** only its own workflow accepts the drop;
  pane movement, split, swap, and terminal behavior remain unchanged.

- **Given** a tab is dragged over itself or an invalid/non-sidebar region,
  **when** the pointer is released, **then** no transfer or reorder occurs and
  the source remains unchanged.

- **Given** a detached window owns one or more tabs, **when** that window is
  closed, **then** all owned tabs are closed according to existing semantics
  and no tabs are silently returned to the primary window.

- **Given** the sidebar-only navigation UI is rendered after this feature,
  **when** users inspect tab actions and chrome, **then** top tabs, duplicate
  actions, bulk-close actions, and obsolete overflow/wrap settings remain
  absent while individual close, rename, project-directory, and move/return
  actions remain available.

## Open Questions

None outstanding.

## Resolved Decisions

- The existing tab transfer protocol is the authoritative path for both
  drag-out detachment and cross-window transfer; no parallel ownership path is
  introduced.
- The source remains usable until destination application, PTY adoption, and
  main-process ownership commit succeed. This is the least-surprising failure
  behavior for a live terminal and is reversible on rollback.
- Drag payloads remain explicitly typed so tab drags cannot collide with pane
  drags. Same-window tab drops retain the existing reorder semantics.
- Closing a detached window continues to close its owned tabs rather than
  returning them.

## Out-of-Scope Notes

- A later iteration may add multi-select tab dragging, but this feature moves
  one tab section at a time.
- A later iteration may add richer cross-window insertion previews; this
  feature requires valid-target feedback and safe ownership semantics.

## Implementation and Verification Handoff

Implementation is complete and recorded in the adjacent plan. Automated evidence is
green for typecheck, the full Vitest suite, production build, the 33-test Electron
suite, and `git diff --check`. A blind independent verifier was attempted but did not
return after three bounded waits; the adjacent plan records that limitation and the
same-session fallback audit. No package version or release state was changed.
