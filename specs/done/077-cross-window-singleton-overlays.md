# Spec: Cross-window singleton workspace overlays

Status: done
Created: 2026-10-03
Completed: 2026-10-03

## Problem

MultiAgent can now show a primary renderer and one or more detached renderers at
the same time. Settings, Session Browser, the Session Browser search surface,
and Command Palette are still controlled by renderer-local Zustand state and
local keyboard handlers. The same overlay can therefore be mounted in multiple
windows, or a stale renderer can keep an overlay visible after another window
opens it.

## Goal

Make the main process the authoritative owner of the workspace overlays so each
overlay kind has at most one mounted instance across all Electron windows. Every
existing control, shortcut, command, close path, and lifecycle path must obey
the same ownership policy.

## Users & Context

Users who detach a tab into another native window and then use chrome buttons,
keyboard shortcuts, or Command Palette commands from either window. The owner
window may be primary or detached and may change after a different overlay is
requested or after the owner closes.

## Requirements

1. MUST maintain one main-owned owner record for Settings, Session Browser,
   Search, and Command Palette, including kind, owner window, and a monotonic
   generation/request token. A stale renderer message MUST NOT clear or replace
   a newer owner.
2. MUST use one deterministic request path for opening/toggling every overlay
   from buttons, shortcuts, Command Palette commands, programmatic opens, and
   close actions. If the requested kind is open in another window, the owner
   window is activated and the existing instance remains the only instance. If
   it is closed, the invoking window becomes owner before mounting.
3. MUST preserve the existing mutual-exclusion behavior between overlay kinds:
   opening one kind closes the prior kind before the new owner mounts. There
   MUST never be a visible handoff interval with two owners.
4. MUST mount an overlay only after main approves that renderer and MUST clear
   denied, revoked, stale, or non-owner renderer-local overlay state. Escape,
   backdrop clicks, close buttons, and repeated requests MUST be idempotent.
5. MUST release overlay ownership when an owner window is natively closed or
   otherwise removed, invalidate late messages from that renderer, and allow a
   subsequent request from a surviving window to succeed.
6. MUST preserve overlay-specific state boundaries: Settings edits and secure
   credential handling retain their existing persistence rules; Session Browser
   searches ignore results after close or handoff; and Command Palette query and
   selection state are fresh on each mount and execute against the approved
   owner window's active tab/pane context.
7. MUST keep the existing Search scope. The repository has no independent
   Search overlay or shortcut; its summary/deep search surface is the
   Session Browser singleton, and the command-palette search box remains part of
   Command Palette. The protocol still names Search so a future explicit search
   entry point cannot bypass the coordinator.
8. MUST add focused main/coordinator and renderer tests plus a real Electron
   scenario with a primary and detached window. Tests MUST cover both opening
   orders, repeated requests, exclusivity, stale generations, native-close
   cleanup, denied mounting, all existing controls and shortcuts, settings
   handoff, stale search results, fresh Command Palette state, and Escape,
   backdrop, and close-button reopening.

## Non-Goals

- We will NOT add a new Search UI, shortcut, or search behavior that does not
  already exist in the repository.
- We will NOT alter PTY routing, session linking, MCP injection, Jira
  credential ownership, or unrelated detached-window transfer semantics.
- We will NOT add polling, file scanning, duplicate command registries, or a
  second renderer status/state write path.
- We will NOT persist transient overlay query, selection, or ownership state in
  the layout file.

## Scenarios (Acceptance Criteria)

- **Given** Settings is mounted in the primary window, **when** a detached
  window requests Settings, **then** the primary is focused and exactly one
  Settings instance remains mounted.
- **Given** an overlay is closed, **when** either window requests it, **then**
  that invoking window becomes owner and the approved renderer mounts it.
- **Given** an overlay is mounted in the detached window, **when** the primary
  requests the same kind, **then** the detached window is focused and the
  primary does not mount a duplicate.
- **Given** one overlay kind is mounted, **when** another kind is requested,
  **then** the old owner closes and acknowledges before the new owner mounts.
- **Given** generation N has been replaced by generation N+1, **when** a late
  close/release from N arrives, **then** generation N+1 remains authoritative.
- **Given** the owner native window closes, **when** the surviving window
  requests that kind, **then** it opens successfully without inheriting a
  zombie overlay.
- **Given** a Session Browser deep search or query is in flight, **when** it is
  closed or ownership changes, **then** its result cannot update a later
  instance.
- **Given** Command Palette was previously typed into, **when** it is reopened,
  **then** query and selection are reset and commands use the owner window's
  active context.
- **Given** an overlay is open, **when** Escape, backdrop, or its close button
  is used in its owner, **then** it closes and can be reopened from either
  window.
- **Given** all four existing chrome controls and their shortcuts/commands are
  used from both windows, **when** requests are repeated or interleaved,
  **then** the same main-owned coordinator enforces one instance and the
  documented exclusivity policy.

## Open Questions

None outstanding.

## Resolved Decisions

- Overlay kinds remain mutually exclusive because that is the current
  renderer-store behavior and avoids changing the workspace interaction model.
- A same-kind request from a non-owner focuses the current owner; a same-kind
  toggle from the current owner closes it. A request for a different kind first
  performs an acknowledged close handoff.
- The coordinator models `search` as a reserved protocol kind, while current
  Search behavior remains the Session Browser search surface described above.

## Out-of-Scope Notes

An independent global Search overlay can be added later as a new behavioral
spec; it must use the existing coordinator rather than introduce another owner
path.
