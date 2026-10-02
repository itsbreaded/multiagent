# Spec: Sidebar-first tab navigation cleanup

Status: done
Created: 2026-10-02
Completed: 2026-10-02

## Problem

The sidebar-first navigation work in `sidebar-first-tab-navigation` is archived
and the current interface no longer uses the former top tab strip as a
navigation surface. The repository still contains remnants of the previous
model: dead tab-strip styling, a renderer action that is no longer called,
an unreachable detached-tab proxy rendering path, an obsolete tab-overflow
setting and wrap layout, and comments/tests/docs that describe the old model.

These remnants make ownership and transfer code harder to audit, keep stale
settings in persisted state, and make it easier for a future change to
accidentally reintroduce top-tab navigation. The cleanup must reduce that
confusion without weakening the backend transfer and ownership mechanisms that
the current sidebar behavior still relies on.

## Goal

Remove or migrate tab-strip-era production code, persistence, tests, comments,
and documentation that are no longer meaningful after sidebar-first
navigation. Leave the current sidebar navigation and detached-window behavior
unchanged, with intentional transfer infrastructure clearly documented as
remaining by design.

## Users & Context

Users navigate project folders, panes, and detached windows through each
window's sidebar. Maintainers and future agents need the codebase to make the
same model obvious: top chrome is not tab navigation, each window owns and
shows its own sidebar tabs, and transfer plumbing may remain even when a
particular renderer action is gone.

## Requirements

1. MUST remove shipped styling and rendering paths that exist only to support
   the retired top tab strip, without removing the top chrome needed for
   window controls or future non-tab actions.
2. MUST remove production-unused renderer tab-reception code and tests that
   only validate that obsolete action; active return, detach, ownership-map,
   focus, pane-movement, and synchronization behavior must remain available.
3. MUST remove the unreachable primary-window detached-tab proxy rendering
   behavior while preserving internal ownership records needed to route IPC,
   focus panes, move panes, synchronize detached windows, and clean up closed
   windows.
4. MUST remove the former tab-overflow preference and its wrap layout because
   they have no current sidebar-first meaning. Persisted settings from older
   versions MUST load safely without reviving or re-emitting the retired
   option.
5. MUST update stale comments, shared IPC descriptions, documentation, tests,
   and settings migration/persistence references so they describe the current
   sidebar-first model and distinguish intentional transfer infrastructure
   from obsolete UI paths.
6. MUST preserve intentional backend transfer infrastructure, including
   tab absorption/return/release events, PTY routing and ownership tracking,
   detached-window cleanup, and the acknowledgement/rollback guarantees that
   support current sidebar movement.
7. MUST preserve sidebar navigation, ordering, move/return actions, individual
   close, detached-window close semantics, pane drag/drop, terminal behavior,
   and session behavior exactly as currently specified by the archived
   sidebar-first work.
8. MUST add or update regression coverage proving that cleanup does not expose
   a top tab UI or break sidebar movement, ownership filtering, and
   detached-window navigation.
9. MUST complete repository verification with typecheck, unit tests, build,
   Electron E2E tests, and a final diff/working-tree audit. Any unavailable
   check MUST be recorded as `UNVERIFIED` with its precise reason.

## Non-Goals

- We will NOT redesign the sidebar or change its navigation, reorder, close,
  move, return, pane, terminal, or session workflows.
- We will NOT remove backend transfer mechanisms merely because their former
  top-tab caller was removed.
- We will NOT add command-palette, search, or other new top-chrome actions in
  this cleanup.
- We will NOT change detached-window ownership or the rule that closing a
  detached window closes the tabs it owns.
- We will NOT rewrite archived historical specs solely to erase history of
  the top-tab implementation.

## Scenarios (Acceptance Criteria)

- **Given** the primary or detached window is rendered, **when** the user
  inspects its top chrome, **then** no top tab strip or top tab navigation
  appears, while the remaining window chrome stays usable.

- **Given** a primary window has local tabs and detached-window ownership
  records, **when** its sidebar renders, **then** only tabs owned by the
  primary window are navigation entries and detached records do not render as
  proxy tabs.

- **Given** a detached window owns one or more tabs, **when** its sidebar
  renders and the user selects or reorders one of those tabs, **then** the
  detached window navigates and updates its own ordering without exposing tabs
  owned by another window.

- **Given** a sidebar tab is moved to a new window or returned to the primary
  window, **when** the transfer succeeds, **then** ownership, sidebar
  visibility, active-tab behavior, PTY routing, and pane navigation remain
  correct with no duplicate or stale rendered tab.

- **Given** a tab transfer or detached-window close is in progress, **when** a
  late synchronization or transfer message arrives, **then** the existing
  ownership/rollback/cleanup protections still prevent resurrection or
  misrouting.

- **Given** settings persisted by an older version contain the former tab
  overflow value, **when** the current version loads and saves settings,
  **then** startup succeeds, the retired preference does not control layout or
  reappear as a current setting, and unrelated settings remain intact.

- **Given** the source tree and tests are searched after cleanup, **when** a
  reviewer examines tab-strip-era symbols, **then** only intentional
  regression assertions, historical archive references, or preserved backend
  transfer references remain, each with an explanatory reason.

## Open Questions

None outstanding.

## Resolved Decisions

- The obsolete tab-overflow preference and wrap layout are removed rather than
  migrated. The current interface has no top tab row whose overflow behavior
  they could control, and inventing a sidebar layout preference would expand
  the product scope. Older persisted values are ignored and are not written
  back. This is the least-surprising reversible choice and was attempted as a
  blind delegated decision; the delegated reviewer was unavailable before
  shutdown, so the decision is recorded as an orchestrator default rather than
  independent review evidence.

## Out-of-Scope Notes

The remaining top chrome may gain non-tab controls in a later, separately
specified change. The transfer events and ownership maps should be revisited
only when their backend callers and synchronization contracts are genuinely
retired, not as part of this UI cleanup.
