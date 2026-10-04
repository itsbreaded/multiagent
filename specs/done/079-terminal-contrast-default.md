# Spec: Make terminal contrast ratio an application default

Status: done
Created: 2026-10-03
Completed: 2026-10-03

## Problem

The Terminal settings panel exposes a minimum contrast ratio that is currently
stored as a user preference and applied to live terminals. This exposes a
renderer detail that is not intended to be a supported per-user product
choice, adds persistence and live-update plumbing, and leaves old stored
values as unnecessary configuration state.

## Goal

Make the terminal's current no-adjustment contrast behavior an application
default rather than a user setting. Existing installations must continue to
render with the same default behavior, while the control, persistence, and
runtime preference plumbing are removed.

## Users & Context

All users who open Terminal settings or create terminal panes. This is a
renderer-settings cleanup following the removal of other implementation-level
terminal renderer switches.

## Requirements

1. MUST not expose a minimum contrast ratio control in the Terminal settings
   panel, including when searching settings for contrast-related terms.
2. MUST use the existing no-adjustment contrast behavior as the fixed
   application default for every newly created terminal.
3. MUST no longer persist, hydrate, or live-update a user-controlled minimum
   contrast ratio value. Previously persisted values MUST be ignored without
   affecting other settings.
4. MUST remove dead contrast-setting state, actions, normalization, and UI
   code so the application has one fixed behavior rather than an unreachable
   preference path.
5. MUST preserve the remaining Terminal settings and terminal renderer
   behavior, including GPU acceleration, scrollback, session-linking,
   terminal error detection, idle suspension, and terminal key bindings.

## Non-Goals

- We will NOT change the terminal's current contrast rendering behavior.
- We will NOT remove or redesign the remaining Terminal settings.
- We will NOT change xterm color themes, agent output, or accessibility
  behavior outside this specific renderer preference.

## Scenarios (Acceptance Criteria)

- **Given** a user opens Terminal settings, **when** the panel renders or is
  searched for "contrast", **then** no minimum contrast ratio setting is
  shown and the remaining Terminal settings remain available.
- **Given** a terminal pane is created, **when** its xterm instance is
  initialized, **then** it uses the existing no-adjustment contrast default.
- **Given** local storage contains a legacy minimum contrast ratio value,
  **when** settings are loaded and saved, **then** the value is ignored and
  the canonical settings payload omits it without changing unrelated values.
- **Given** a user changes GPU acceleration or scrollback, **when** a terminal
  is created, **then** those settings continue to control their existing
  behavior independently of the removed contrast preference.

## Open Questions

None outstanding.

## Resolved Decisions

- The user explicitly chose to remove contrast ratio customization. Preserve
  the current no-adjustment value as the application default (`1`) rather than
  retain a hidden preference or introduce a replacement control.

## Out-of-Scope Notes

If a future accessibility requirement calls for configurable contrast
adjustment, it should be designed as a new product decision rather than
reintroducing this renderer implementation setting.
