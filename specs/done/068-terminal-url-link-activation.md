# Spec: Reliable terminal URL links

Status: done
Created: 2026-08-24
Completed: 2026-08-24

## Problem

Terminal panes automatically make URLs clickable, but link activation currently
has two user-visible failures:

1. Long URLs can be displayed over multiple terminal rows. When an agent TUI
   redraws rows with cursor positioning instead of using the terminal's natural
   wrap markers, the link detector can expose only the first visible fragment;
   clicking it opens a partial URL. Natural wrapping must remain correct as well.
2. The terminal linkifier can activate a link on a non-primary mouse release,
   so right-clicking a URL can open the browser instead of only showing the
   terminal context menu.

The project uses xterm.js 6.0.0 and `@xterm/addon-web-links` 0.12.0. The addon
handles naturally wrapped rows, but its documented/current behavior does not
join cursor-positioned rows. The upstream xterm issue describing the same
limitation in agent/TUI output is
https://github.com/xtermjs/xterm.js/issues/5793. The xterm link-handling guide
also treats implicit web links and explicit OSC-8 links as separate activation
paths: https://xtermjs.org/docs/guides/link-handling/.

## Goal

Make terminal URLs open the complete logical URL on a primary left click,
regardless of whether the terminal display continued the URL through natural
wrapping or agent/TUI row redraw, while ensuring non-left clicks never open a
URL.

## Users & Context

Users interact with long-running shell and agent sessions in the app's terminal
panes. The behavior applies consistently to every terminal pane because shell
and agent panes share the same terminal renderer and link handling.

## Requirements

1. MUST detect a URL that is visually continued across terminal rows by natural
   terminal wrapping as one link, and the activated target MUST contain the
   complete URL rather than only the visible fragment.
2. MUST detect a URL that is visually continued across adjacent rows produced
   by terminal/TUI cursor-positioned redraw as one link when each continuation
   crosses the terminal edge directly into the next row and the row contents
   form one contiguous URL, and the activated target MUST contain the complete
   URL.
3. MUST preserve URL boundaries: unrelated text on adjacent rows, whitespace,
   a non-contiguous row, or an ambiguous boundary MUST NOT be silently
   concatenated into a different URL target; the detector MUST fail closed when
   it cannot establish display continuity.
4. MUST activate both automatically detected web URLs and explicit OSC-8 links
   through the same primary-button rule.
5. MUST open a recognized link only for a primary left-button activation
   (`button === 0`). Right-click, middle-click, auxiliary buttons, and their
   corresponding releases MUST never invoke external URL opening.
6. MUST leave the terminal's existing right-click selection/context-menu
   behavior available when a user right-clicks a URL.
7. MUST continue to route opened URLs through the existing validated external
   URL boundary; this change MUST NOT broaden accepted external protocols.
8. MUST cover the reconstruction and button-filter behavior with deterministic
   regression tests, including natural wrapping, cursor-positioned rows, a
   boundary/non-merge case, left-click activation, and non-left-click rejection.

## Non-Goals

- We will NOT disable terminal line wrapping or change terminal dimensions to
  make URLs fit on one row.
- We will NOT change PTY output, agent CLI rendering, cursor-positioning
  behavior, or the no-flow-control terminal pipeline.
- We will NOT change the main-process external URL protocol allow-list or
  navigation security policy.
- We will NOT add URL editing, copying, previews, a browser panel, or a new
  user setting for link behavior.
- We will NOT require a modifier key for the requested primary left-click
  activation.

## Scenarios (Acceptance Criteria)

- **Given** a long `https://` URL naturally wrapped by the terminal width,
  **when** the user left-clicks any visible URL segment, **then** the existing
  external-open path receives the complete URL exactly once.

- **Given** a long URL whose successive display rows were written using
  cursor-positioned terminal output, fill the terminal edge, begin directly at
  the next row, and therefore lack natural-wrap markers,
  **when** the user left-clicks any visible URL segment, **then** the complete
  logical URL opens rather than only the row fragment.

- **Given** a URL-like fragment followed by unrelated text on a separate,
  non-contiguous, whitespace-separated, or otherwise ambiguous row boundary,
  **when** the user hovers or clicks, **then** the detector does not
  concatenate the unrelated text into the URL.

- **Given** an automatically detected URL, **when** the user right-clicks it,
  **then** no external-open invocation occurs and the terminal context-menu
  behavior remains available.

- **Given** an explicit OSC-8 link, **when** the user right-clicks or
  middle-clicks it, **then** no external-open invocation occurs.

- **Given** either link type, **when** the user left-clicks it, **then** the
  existing validated external URL boundary is invoked with the link target.

- **Given** terminal output containing a non-http(s) or malformed target,
  **when** the user activates it, **then** the existing external URL validation
  behavior remains unchanged.

## Open Questions

None outstanding.

## Resolved Decisions

- Scope is all shell and agent terminal panes, because they share one renderer
  component and users expect the same terminal interaction in both contexts.
- Primary left click is intentionally sufficient; modifier-key requirements are
  not part of this fix.
- The complete logical URL is the link target even when its visual rendering
  spans rows; the implementation must fail closed rather than merge a row when
  the boundary cannot be established.

## Out-of-Scope Notes

- If future agent TUIs emit link fragments separated by semantic content while
  using absolute cursor positioning, a provider-specific protocol or OSC-8
  integration may be needed; this iteration only covers contiguous URL text.
