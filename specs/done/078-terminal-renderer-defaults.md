# Spec: Make terminal renderer defaults application-owned

Status: done <!-- draft | ready | in-progress | review | done -->
Created: 2026-10-03
Completed: 2026-10-03

## Problem

The Terminal settings page exposes two renderer controls—`Optimized renderer`
and `Rescale overlapping glyphs`—that are implementation-level switches rather
than meaningful day-to-day preferences. The optimized renderer switch can
restore a legacy unconditional-WebGL path, while glyph rescaling is a renderer
compatibility behavior. Exposing both creates user-facing choices whose safest
behavior is already known and makes the persisted settings model carry legacy
state.

## Goal

Make the optimized renderer path and glyph-rescaling behavior application-owned
defaults, removing their controls and persisted user preferences while keeping
the remaining terminal preferences unchanged.

## Users & Context

Users configure terminals through Settings → Terminal. They should still be
able to control genuine workflow preferences such as GPU fallback behavior,
scrollback capacity, terminal color accessibility, session linking, status
detection, and idle-session suspension.

## Requirements

1. MUST remove the `Optimized renderer` control from the Terminal settings
   section and from Terminal settings search results.
2. MUST remove the `Rescale overlapping glyphs` control from the Terminal
   settings section and from Terminal settings search results.
3. MUST always use the environment-aware terminal renderer selection path,
   preserving the existing `auto`/`on`/`off` GPU acceleration preference and its
   software-rendering safety behavior.
4. MUST keep overlapping-glyph rescaling enabled for terminal instances,
   including instances created after layout remounts or pane metadata changes.
5. MUST ignore legacy persisted values for the removed preferences so an older
   `optimizedTerminalRenderer: false` or
   `terminalRescaleOverlappingGlyphs: false` value cannot restore the removed
   behavior or change the application default.
6. MUST preserve the existing user-facing controls and behavior for minimum
   contrast ratio, scrollback lines, CLI session linking, fatal terminal-output
   detection, idle agent suspension, GPU acceleration, and terminal key
   bindings.

## Non-Goals

- We will NOT remove or redesign GPU acceleration selection.
- We will NOT remove or redesign minimum contrast ratio or scrollback settings.
- We will NOT change agent-specific terminal behavior such as erase-in-display
  handling, Codex mouse reporting, fonts, theme, or cursor behavior.
- We will NOT remove terminal key-binding customization or custom macros.
- We will NOT change session-linking hooks, terminal status detection, or idle
  suspension policy.

## Scenarios (Acceptance Criteria)

- **Given** the Terminal settings section is open, **when** the user views it,
  **then** neither `Optimized renderer` nor `Rescale overlapping glyphs` is
  shown, while the retained terminal settings remain available.
- **Given** the user searches Terminal settings for `optimized`, `renderer`,
  `glyphs`, or `rescale`, **when** the search runs, **then** the removed
  controls are not returned.
- **Given** a terminal pane is created on hardware with usable WebGL2,
  **when** GPU acceleration is `auto`, **then** the existing environment-aware
  backend decision is used without consulting a removed master flag.
- **Given** a terminal pane is created on software-rendered or unavailable
  WebGL, **when** GPU acceleration is `auto`, **then** the existing DOM
  fallback behavior remains in effect.
- **Given** an older persisted settings record contains either removed key,
  **when** the application loads settings and creates a terminal, **then** the
  old value has no effect and glyph rescaling remains enabled.
- **Given** a user changes minimum contrast ratio, scrollback, GPU
  acceleration, session-linking, status-detection, idle-suspension, or terminal
  key-binding settings, **when** the application is restarted or a new pane is
  created, **then** those retained settings continue to behave as before.

## Open Questions

None outstanding.

## Resolved Decisions

- Remove only the two unambiguous renderer implementation switches. Preserve
  minimum contrast ratio as a user preference because its accessibility value
  is conditional and the least-surprising choice is not to remove it without a
  separate accessibility decision. Resolved from the user's accepted cleanup
  recommendation.
- Existing persisted values for the removed settings are intentionally reset to
  the application defaults. This is a user-authorized visible behavior change
  and is reversible by reverting the application version, not by restoring the
  removed controls.

## Out-of-Scope Notes

The GPU acceleration choices may be simplified in a later iteration (for
example, keeping `auto` and an explicit DOM fallback while hiding forced WebGL
behind an advanced/debug surface), but that is not part of this change.
