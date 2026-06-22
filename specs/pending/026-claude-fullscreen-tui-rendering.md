# 025 - Claude Code Fullscreen (alt-screen) TUI Rendering Support

## Problem

Claude Code shipped a **fullscreen rendering mode** (research preview, requires Claude
Code v2.1.89+; current at v2.1.183). When this mode is active, Claude Code panes in our
app break: after switching into fullscreen, **no keyboard input is detected** — typing
into the pane does nothing.

The user wants the app to *support* fullscreen rendering rather than only trying to
suppress it. Today we suppress it, but the suppression is leaky (the user can flip it on
mid-session and strand the pane), and when it is on we have no working input path.

## Background: what fullscreen rendering actually is

Source of truth: <https://code.claude.com/docs/en/fullscreen> (verified 2026-06-22).

Fullscreen rendering is an alternative draw path for the Claude Code CLI. Instead of
appending to the terminal's primary screen + scrollback, it **takes over the terminal's
alternate screen buffer** (DECSET 1049, `\x1b[?1049h`) the way `vim`/`htop` do, keeps the
input box pinned to the bottom, renders only currently-visible messages (flat memory), and
eliminates flicker. It is the same class of behavior we already neutralize for **Codex**
via `--no-alt-screen` (see `CLAUDE.md` and `SessionSpawner.codexCliArgs`).

When fullscreen is active, Claude Code also turns on terminal input/UX modes that the
classic renderer never used:

- **Alternate screen buffer** — `\x1b[?1049h` / `\x1b[?1049l`.
- **Mouse tracking / capture** — click-to-position-cursor, click-to-expand tool output,
  wheel scrolling, drag-select. Implies the standard xterm mouse DECSETs
  (`?1000`/`?1002`/`?1003` + SGR `?1006`).
- **Focus reporting** — `\x1b[?1004h`; Claude tracks terminal focus in/out.
- **Bracketed paste** — `\x1b[?2004h`; pasted text wrapped so it is not interpreted as keys.
- **Kitty keyboard protocol** — `\x1b[>1u` (CSI u) **only** on kitty/WezTerm/Ghostty/iTerm2.
  We advertise as `xterm-256color` / `TERM_PROGRAM=vscode` and xterm.js does not negotiate
  kitty protocol, so this path should not activate for us — but it must be verified, not
  assumed.

### How it gets turned on (all equivalent)

| Trigger | Notes |
|---|---|
| `/tui fullscreen` (slash command, mid-session) | Writes `"tui": "fullscreen"` to `~/.claude/settings.json` **and relaunches the process**, clearing `CLAUDE_CODE_NO_FLICKER` from the relaunched env so the saved setting takes effect. |
| `"tui": "fullscreen"` in `~/.claude/settings.json` | Persistent; applies to every launch unless overridden. |
| `CLAUDE_CODE_NO_FLICKER=1` env var | Equivalent to the `tui` setting (documented mainly for pre-v2.1.110). |

### How it gets forced off

| Control | Effect |
|---|---|
| `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` | Documented to **force the classic renderer regardless of the saved `tui` setting**. |
| `CLAUDE_CODE_DISABLE_MOUSE=1` | Opt out of mouse capture but keep flicker-free rendering. |
| `/tui default` | Writes `"tui": "default"` and relaunches into classic. |

Caveat from the docs: **background/attached sessions** (`claude attach`, agent view)
*always* use fullscreen, and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` does **not** apply to
them. We do not use that launch path today, but it forecloses "just disable it forever."

## Current behavior in this codebase

Two layers set Claude env, and they currently disagree about intent:

- `src/main/pty/PtyManager.ts:220-229` — `buildEnv` agent profile sets:
  - `CLAUDECODE=1`
  - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`
  - `CLAUDE_CODE_DISABLE_MOUSE=1`
  - `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`
- `src/main/pty/PtyManager.ts:163-168` — `createClaude` *also* injects
  `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1` and `CLAUDE_CODE_NO_FLICKER=1`.
- `src/main/sessions/SessionSpawner.ts:360-362` — `agentEnv` (the path that actually
  launches/resumes Claude) sets `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1` and
  `CLAUDE_CODE_NO_FLICKER=1`. It does **not** set the `DISABLE_*` flags — those come from
  `buildEnv` when the pty is created.

So at process start we both request flicker-free (`NO_FLICKER=1`) and force classic
(`DISABLE_ALTERNATE_SCREEN=1`). Per docs the disable should win, so cold launches stay
classic and work. **The break happens after `/tui fullscreen`**: Claude writes
`"tui":"fullscreen"` to the user's global settings and relaunches itself. We need to
confirm whether `DISABLE_ALTERNATE_SCREEN=1` actually survives and still wins after that
in-process relaunch in v2.1.183 — the field report ("switching breaks it") suggests it may
not, or that the user already has `"tui":"fullscreen"` set globally.

### Why input dies (renderer mechanism — grounded in code)

Keystrokes reach the PTY through exactly one path:

- xterm's hidden helper textarea receives DOM key events → `terminal.onData(...)` →
  `window.ipc.send('pty:write', ptyId, data)` (`src/renderer/src/components/Terminal/index.tsx:446-449`).
- Focus is driven by `xtermRegistry.focus()` → `entry.xterm.focus()`
  (`src/renderer/src/utils/xtermRegistry.ts:85-89`).
- There is an `attachCustomKeyEventHandler` (`Terminal/index.tsx:221`) and a ConPTY DA1
  responder (`:419`).

When fullscreen turns on **mouse tracking**, xterm.js stops treating clicks as
"focus the textarea / select text" and instead encodes them as mouse escape sequences sent
to the PTY. Result: clicking the pane no longer focuses the hidden textarea, so DOM key
events never fire, `onData` never runs, and nothing is written to the pty — exactly the
reported "no input detected." Focus reporting (`?1004`) is a secondary suspect: if xterm
reports focus-out (or never reports focus-in for an embedded pane), fullscreen Claude can
gate input on focus state. The exact culprit must be confirmed during Phase 1.

## Intended behavior

1. **Input must never be lost.** Whatever the user's `tui` setting or `/tui` toggle does, a
   Claude pane must remain typeable. This is the non-negotiable.
2. **A single, coherent policy** for Claude's renderer mode, owned in one place — not two
   layers (`buildEnv` + `createClaude`/`agentEnv`) silently contradicting each other.
3. **Support fullscreen as a real, working mode** in the embedded pane: alt-screen,
   mouse capture, focus reporting, and wheel scrolling all behave, so the user can opt into
   the flicker-free experience instead of us forcing classic.
4. A **user-facing setting** (Settings → Terminal, persisted) to choose the Claude renderer
   policy: `classic` (force off) / `fullscreen` (force on) / `auto` (respect the user's own
   `~/.claude` `tui` setting). Default chosen in Phase 4 based on what actually works.

## Implementation phases

### Phase 1 — Reproduce and pin the exact failure mode (investigation, no shipping code)

Goal: replace hypotheses with a confirmed cause before changing behavior.

1. Build/run the app, open a Claude pane, confirm it types in classic mode.
2. Reproduce the break two ways and record which apply:
   - Run `/tui fullscreen` inside the pane and observe relaunch + input loss.
   - Pre-set `"tui":"fullscreen"` in `~/.claude/settings.json`, cold-launch a pane.
3. With the browser/devtools or a pty data tap, capture the escape sequences Claude emits
   on entering fullscreen. Confirm presence/absence of: `?1049h`, mouse DECSETs
   (`?1000/1002/1003/1006`), `?1004h` (focus), `?2004h` (paste), CSI u (`>1u`).
4. Determine empirically whether `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` still forces
   classic **after** a `/tui fullscreen` relaunch in v2.1.183. Document the answer.
5. Confirm the input-loss mechanism: instrument whether the xterm textarea loses focus and
   whether `terminal.onData` stops firing once mouse tracking is on.

Deliverable: a short findings block appended to this spec (sequences seen, whether the
disable flag wins post-relaunch, confirmed root cause).

### Phase 2 — Make the suppression authoritative and single-sourced (safety floor)

Regardless of Phase 4, the "force classic" path must be bulletproof and live in one place.

1. Centralize Claude renderer env into one helper (e.g. `claudeRendererEnv(mode)` in the
   main process). Remove the contradiction: do not set `NO_FLICKER=1` and
   `DISABLE_ALTERNATE_SCREEN=1` together when the intent is classic.
2. In `classic` mode emit only the disable flags
   (`DISABLE_ALTERNATE_SCREEN`, `DISABLE_MOUSE`, plus existing
   `DISABLE_TERMINAL_TITLE`/`DISABLE_VIRTUAL_SCROLL`) and **drop `NO_FLICKER`**.
3. If Phase 1 shows `/tui fullscreen` can still escape `DISABLE_ALTERNATE_SCREEN`, add a
   renderer-side guard so input survives even if Claude enters alt-screen unexpectedly
   (see Phase 3) — never rely solely on the env flag.

### Phase 3 — Make the embedded pane actually work in fullscreen (the "support" work)

This is what lets us *support* fullscreen rather than only block it.

1. **Focus on click even under mouse tracking.** Ensure a click in a Claude pane both
   focuses the xterm (so the textarea receives keys) *and* still lets xterm forward the
   mouse event. Audit `attachCustomKeyEventHandler` and the pane's pointer handling so that
   entering mouse-tracking mode never strands keyboard focus. This is the direct fix for
   "no input detected."
2. **Focus reporting.** Make sure the pane delivers focus-in to xterm when the pane is the
   app-focused pane, so fullscreen Claude does not gate input on a stale focus-out. Tie
   into the existing `focusPaneInTab` transition rather than bolting on a new path.
3. **Alt-screen + scrollback expectations.** With alt-screen active, our 250k-line
   scrollback is bypassed (Claude owns the buffer). Confirm `Ctrl+o` transcript mode and
   `[` (write-to-scrollback) behave, and that switching modes does not corrupt the xterm
   viewport. Do not add flow control (see `CLAUDE.md` no-flow-control note).
4. **Mouse wheel.** Verify wheel events reach Claude (it sends one event per notch in
   xterm.js-style terminals); document `CLAUDE_CODE_SCROLL_SPEED` as the user-tunable knob
   rather than intercepting wheel ourselves.
5. **Confirm kitty protocol stays off** for our `TERM`/`TERM_PROGRAM`; if xterm.js ever
   negotiates CSI u, ensure our key handler round-trips it.

### Phase 4 — Setting + policy wiring

1. Add `claudeRendererMode: 'auto' | 'classic' | 'fullscreen'` to `useSettingsStore`
   (persisted), surfaced in Settings → Terminal next to scrollback. Follow the shared modal
   styling and `theme.ts` tokens.
2. Map the setting to env in the single helper from Phase 2:
   - `classic` → disable flags, no `NO_FLICKER`.
   - `fullscreen` → `NO_FLICKER=1` (or `"tui":"fullscreen"` semantics), no disable flags,
     with Phase 3 renderer support live.
   - `auto` → emit nothing that forces either way; let the user's `~/.claude` `tui` setting
     decide. Only safe once Phase 3 makes fullscreen work.
3. Default value: pick after Phase 1/3. If fullscreen is solid in-pane, default `auto` or
   `fullscreen`; otherwise keep `classic` as the safe default and ship the setting so power
   users can opt in.
4. Changing the setting should apply to **new** panes; document that existing live panes
   keep their launched mode until restarted (env is fixed at spawn). Do not silently kill
   running agents.

## Risks

- **Breaking working classic panes.** The env layers are load-bearing; centralizing them
  risks regressing the current good cold-launch behavior. Diff env output before/after.
- **`DISABLE_ALTERNATE_SCREEN` precedence is undocumented for the post-`/tui` relaunch
  case.** Phase 1 must settle this; do not assume the flag wins.
- **Mouse-capture focus fix could double-handle clicks** (focus *and* mouse-forward),
  causing stray selection or cursor jumps. Test drag-select and click-to-expand.
- **Global settings mutation.** `/tui fullscreen` writes the user's real
  `~/.claude/settings.json`. Per `CLAUDE.md` we must not mutate user agent config — but the
  *user* invoking `/tui` does, not us. We must not start writing `tui` into their settings
  on their behalf; our control stays process-scoped env only.
- **Attached/background sessions** ignore the disable flag entirely; out of scope but note
  it so a future agent-view feature does not assume classic is reachable.

## Verification

- Cold launch Claude pane in each `claudeRendererMode`; confirm typing works in all three.
- From classic, run `/tui fullscreen`; confirm the pane stays typeable after relaunch
  (the core regression). Run `/tui default`; confirm it returns cleanly.
- With `"tui":"fullscreen"` pre-set in `~/.claude/settings.json` and mode=`classic`,
  confirm we still force classic (or, if Phase 1 proves we can't, confirm the renderer
  guard keeps input alive).
- In fullscreen: click-to-position cursor, click-to-expand a tool result, wheel scroll,
  drag-select + copy, `Ctrl+o` transcript + `/` search + `[` to scrollback.
- Resize the pane repeatedly while Claude streams output in fullscreen; no viewport
  corruption (cross-check the spec 010/019 redraw concerns).
- `npm run typecheck` clean; confirm no PATH rewrite or flow-control was reintroduced.

## Handoff contract

**Non-negotiables:**
1. A Claude pane is **always typeable** — no setting, `/tui` toggle, or pre-existing
   `~/.claude` config may leave a pane that silently swallows input.
2. Claude renderer env is single-sourced; `buildEnv` and `agentEnv`/`createClaude` must not
   set contradictory renderer flags.
3. We never write to `~/.claude/settings.json`, `~/.claude.json`, or other user/project
   agent config — renderer policy is process-scoped env only (per `CLAUDE.md`).
4. No PATH rewrite, no flow control / ack / pause added to the pty or renderer pipeline.

**Definition of done:**
- Phase 1 findings recorded in this spec (sequences, precedence answer, confirmed cause).
- `claudeRendererMode` setting exists, persists, and maps to env through one helper.
- `/tui fullscreen` followed by typing works in the pane (regression fixed).
- Fullscreen mouse + focus + scroll behaviors verified per the Verification list.
- `CLAUDE.md` updated with the durable rule: how Claude's fullscreen/alt-screen mode is
  handled in embedded panes and which env flags control it (mirror the existing Codex
  `--no-alt-screen` note).
- Spec moved to `specs/done/025-...` (keep the number) or folded into `CLAUDE.md` and
  deleted if the lesson is short.
