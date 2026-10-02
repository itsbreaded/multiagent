# Spec: Sidebar-first tab navigation

Status: done
Created: 2026-10-02
Completed: 2026-10-02

## Problem

MultiAgent currently presents project folders/tabs in both a top tab area and the
sidebar. The top area is the dominant navigation surface, while the sidebar
contains the project and pane hierarchy that users need to understand which
workspace they are entering. Detached windows currently have a top tab area but
no sidebar, so moving a tab into another window removes the primary project
navigation surface and makes that window dependent on the top tab UI.

The duplicated navigation surfaces also carry tab-management actions that are
not needed for the intended workflow. The interface should move toward a
browser-like vertical-tab model in which the sidebar is the authoritative place
to see, organize, and switch tabs.

This direction is consistent with current browser UX patterns: Microsoft Edge
describes vertical tabs as a side layout intended to improve tab scanning and
management, and Firefox documents a sidebar mode in which open tabs appear in
the sidebar instead of along the top. See [Microsoft Edge vertical tabs](https://www.microsoft.com/en-us/edge/features/vertical-tabs) and
[Firefox sidebar and vertical tabs](https://support.mozilla.org/bm/kb/use-sidebar-access-tools-and-vertical-tabs).

## Goal

Make the sidebar the primary and consistent tab/folder navigation surface in
the main window and every detached window. Remove the top tab strip and its
unneeded duplicate-tab and bulk-close affordances while preserving the existing
window chrome and essential sidebar tab actions.

## Users & Context

Users who keep multiple project folders, terminal panes, and agent sessions open
at the same time. They may work in the primary window or move one or more tabs
into detached windows and must be able to navigate those tabs without returning
to the primary window.

## Requirements

1. MUST make the sidebar the primary way to view and switch between tabs/project
   folders in the primary window.
2. MUST make the sidebar the primary way to view and switch between tabs/project
   folders in every detached window.
3. MUST keep the detached-window sidebar open and usable for navigation in this
   iteration; detached-sidebar collapse and per-window collapse persistence are
   out of scope.
4. MUST hide the top tab strip in both primary and detached windows. The top
   chrome must remain available for window controls and other non-tab actions;
   this spec does not require adding new top-level actions.
5. MUST show each window's sidebar tab list using only the tabs owned by that
   window. The primary window must not display detached-window tabs as
   navigation entries, and a detached window must not display tabs owned by
   another window.
6. MUST activate the selected tab's content when a user selects its folder/tab
   entry in the sidebar, with the active tab visibly distinguishable from other
   entries.
7. MUST preserve the sidebar's existing project-folder and pane navigation
   capabilities, including tab ordering, tab renaming, project-directory
   management, pane selection, and individual tab closing.
8. MUST provide a sidebar tab action to move a tab from the primary window into
   a new detached window. After a successful move, the new window must show the
   moved tab in its sidebar and the source window must no longer show it.
9. MUST provide the appropriate sidebar action for returning a detached tab to
   the primary window. After a successful return, the tab must disappear from
   the detached window and become available in the primary window's sidebar.
10. MUST NOT expose duplicate-tab functionality in the new interface. A user
   must not be able to create a duplicate tab through a sidebar or top-chrome
   tab action.
11. MUST NOT expose bulk tab-closing actions that were provided by the top tab
    section, including closing other tabs or closing tabs to the right.
    Individual tab closing from the sidebar remains available.
12. MUST close all tabs owned by a detached window when that window is closed.
    Those tabs must not be returned to, recreated in, or left as navigation
    entries in the primary window.
13. SHOULD leave the remaining top chrome intentionally open for future
    non-tab controls without introducing replacement controls in this change.

## Non-Goals

- We will NOT add new command-palette, search, or other top-chrome actions in
  this iteration.
- We will NOT redesign pane layout, pane drag/drop, terminal behavior, or agent
  session behavior.
- We will NOT introduce a second tab-navigation surface to replace the hidden
  top tab strip.
- We will NOT change the meaning of creating a new project folder/tab.
- We will NOT add cross-device, browser-style tab synchronization.

## Scenarios (Acceptance Criteria)

- **Given** the primary window has multiple project folders, **when** the user
  selects a different folder in the sidebar, **then** that folder becomes active
  and its pane content is shown without using a top tab strip.

- **Given** the primary window has tabs and one tab is owned by a detached
  window, **when** the primary sidebar is displayed, **then** it lists only tabs
  owned by the primary window.

- **Given** a detached window owns multiple tabs, **when** the detached window
  is focused, **then** it displays a sidebar containing only those tabs and the
  user can switch between them from that sidebar.

- **Given** either window has the new layout, **when** the user inspects the top
  chrome, **then** window controls and existing non-tab chrome remain usable but
  no top tab strip or top tab list is shown.

- **Given** a tab is listed in the primary sidebar, **when** the user invokes
  its move-to-new-window action, **then** a detached window opens with that tab,
  the tab is removed from the primary sidebar, and the detached sidebar lists
  the tab.

- **Given** a move-to-new-window request cannot be completed, **when** the move
  fails, **then** the source sidebar retains the tab and no stale or duplicate
  tab remains in the destination window.

- **Given** a detached window owns a tab, **when** the user returns that tab to
  the primary window from the detached sidebar, **then** the tab is removed from
  the detached sidebar and appears in the primary sidebar.

- **Given** a sidebar tab context menu is open, **when** the user inspects its
  tab actions, **then** individual close, rename, and project-directory actions
  remain available, the applicable window-movement action is available, and
  duplicate/close-other/close-to-right actions are absent.

- **Given** a detached window owns one or more tabs, **when** the user closes
  that window, **then** all of its owned tabs are closed and none reappear in the
  primary window.

- **Given** the user reorders tabs in a window's sidebar, **when** the reorder
  completes, **then** the new order is reflected by that window's sidebar and
  does not introduce or remove tabs in another window.

- **Given** the sidebar has no tabs owned by its window, **when** the window is
  rendered, **then** it does not show stale entries belonging to another window;
  the detached-window lifecycle handles an empty detached window according to
  its existing window behavior.

## Open Questions

None outstanding.

## Resolved Decisions

- The top tab strip is hidden, but the top chrome remains because window
  controls and future non-tab actions still need a home.
- Detached windows receive a sidebar and show only the tabs they own.
- Closing a detached window closes its owned tabs instead of returning them to
  the primary window.
- Individual sidebar tab actions remain useful; bulk close actions and duplicate
  tab are removed from the new interface.
- Detached sidebars remain open in this iteration and do not gain independent
  collapse-state persistence, resolved by the auto-orchestrator blind subagent
  because this preserves reliable navigation and is reversible.

## Out-of-Scope Notes

The remaining top chrome may later gain command-palette, search, or other
workspace actions, but those should be specified separately once their exact
workflow is known.
