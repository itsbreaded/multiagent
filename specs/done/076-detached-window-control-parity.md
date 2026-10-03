# Spec: Detached-window control parity

Status: done
Created: 2026-10-03
Completed: 2026-10-03

## Problem

The sidebar-first migration left detached windows with a different top chrome
than the primary window. A real Electron reproduction shows that a detached
window renders only the command-palette button: it has no collapse-sidebar,
Settings, or Session Browser control. The renderer also disables sidebar
collapse and suppresses the Settings and Session Browser overlays, so the
missing icons represent both a rendered parity gap and unreachable behavior.

The current implementation inherited an older tab-only detached-window
assumption. The current product model is different: every window owns a
sidebar, detached windows retain that sidebar, and pane/tab actions are
window-local. The follow-up must decide parity from those current semantics,
not from the archived tab-strip design.

## Goal

Make the detached window expose the same supported workspace controls as the
primary window while preserving per-window ownership, focus, overlay behavior,
transfer semantics, and the sidebar-first model. Record the complete
main-versus-detached classification so future audits do not claim parity from
IPC/store tracing alone.

## Requirements

1. A detached window MUST render collapse/open-sidebar, Session Browser,
   command-palette, and Settings controls with the existing image-icon chrome.
2. Collapse/open-sidebar MUST be window-local, work by click and configured
   shortcut, and preserve the detached window's sidebar ownership and tab rows.
   The top tab strip MUST remain absent.
3. Settings MUST open as a visible, focusable detached-window overlay. Its
   controls, section navigation, search, Escape handling, and close/reopen
   behavior MUST work without creating a second settings dispatch path.
4. Session Browser MUST open as a visible, focusable detached-window overlay.
   Search, project/session selection, directory repair dialog, resume actions,
   Escape, and close/reopen behavior MUST target the detached renderer's active
   tab/pane through existing store and IPC boundaries.
5. Ctrl+Shift+P or the configured command-palette shortcut MUST continue to
   open the detached command palette, and palette commands MUST retain the
   detached active-tab/focused-pane context.
6. Settings and Session Browser may update app-global state through their
   existing main-owned IPC handlers, but detached renderers MUST NOT create
   duplicate Jira status polling or bypass encrypted/main-owned credential
   handling.
7. Existing detached behavior MUST remain intact: owned-tab-only sidebars,
   sidebar selection/reorder/close/move/return, pane focus/drag/drop/resize,
   terminal input/output/resize/clipboard/context menu/title behavior, agent
   launch/status/close/refresh/resume, and native close semantics.
8. Main-window behavior MUST remain unchanged except for intentionally shared
   control rendering and any necessary overlay hydration that preserves the
   existing main-owned side effects.
9. Regression coverage MUST include deterministic renderer/store/component
   checks and a real Electron check that detached controls render and each
   supported control opens/closes its local UI. It MUST cover Ctrl+Shift+P,
   representative sidebar movement, terminal behavior, native detached close,
   transfer behavior, and main-window control/overlay behavior.
10. Durable evidence MUST classify every audited behavior as supported and
    working, intentionally main-window-only, or broken/repaired, including
    sidebar collapse/navigation, settings/session browser, command palette,
    dialogs/overlays/focus/Escape, pane/terminal behavior, agent/session
    lifecycle, IPC/listener cleanup, and ownership/transfer edge cases.

## Non-Goals

- Do not restore or add a top tab strip.
- Do not change the rule that each window shows only its owned tabs.
- Do not return detached tabs implicitly when a native detached window closes.
- Do not replace or duplicate transfer, PTY routing, provider cleanup, or
  ownership protocols.
- Do not move Jira persistence, credential decryption, or status network access
  into renderer-owned storage or polling.
- Do not redesign Settings or Session Browser content beyond making their
  existing flows work in a detached renderer.

## Resolved Decisions

- Collapse-sidebar is supported because the sidebar is present and owned by
  each renderer; its state is local to that detached window and need not be
  persisted into the primary layout.
- Settings is supported as a window-local overlay over app-global settings.
  Existing main-owned IPC and encrypted credential boundaries remain in force.
- Session Browser is supported as a window-local overlay over the app-global
  session index. Resume and repair continue to use the invoking renderer's
  existing pane/store actions.
- Jira status lookup remains primary-owned: detached Settings may hydrate and
  edit credentials through main, but detached App instances do not sync or
  poll sidebar Jira rows.

## Acceptance Scenarios

- **Given** a tab is torn into a detached window, **when** it renders, **then**
  all four chrome controls are present and the top tab strip is absent.
- **Given** a detached window is focused, **when** the user clicks collapse or
  presses the configured sidebar shortcut, **then** only that window collapses
  or reopens its sidebar and focus remains valid.
- **Given** a detached window is focused, **when** the user opens Settings or
  Session Browser, **then** the matching overlay is visible, its first control
  has focus, Escape closes it, and reopening creates a fresh usable overlay.
- **Given** Session Browser is open in a detached window, **when** the user
  searches, selects a session, repairs its directory, or resumes it, **then**
  the existing detached pane/store and IPC behavior is used and no duplicate
  primary sidebar row or Jira lookup is created.
- **Given** a detached command palette is open, **when** the user runs a pane,
  tab, or sidebar command, **then** it affects the detached active tab/focused
  pane and closes according to existing command semantics.
- **Given** detached tabs are moved, returned, dragged, resized, used for
  terminal I/O, or closed natively, **when** the operation completes, **then**
  existing ownership, PTY routing, close, and cleanup invariants still hold.

## Definition of Done

- The adjacent approved plan is executed and every task has concrete evidence.
- The parity matrix records the complete audit and remaining intentional
  main-owned behavior.
- `npm run typecheck`, `npm run test`, `npm run build`, `npm run test:e2e`,
  targeted checks, `git diff --check`, and `git status` are reported truthfully.
- The pre-change missing-control Electron reproduction and post-change
  interaction verification are recorded; no unverified runtime claim is made.
