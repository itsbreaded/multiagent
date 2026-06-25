# 026 - Claude Fullscreen TUI Rendering

## Problem

Claude panes had three related rendering/input defects:

- Startup showed repeated Claude banners/logos.
- Widening a pane left old Claude output wrapped at the old width.
- `/tui fullscreen` made the pane stop accepting input.

Shell panes did not show the same startup/resize behavior because shell PTYs were created
after xterm was fitted to the real pane size. Agent PTYs were launched at the default
80x24 and corrected later.

## Findings

The width problems came from Claude's classic renderer seeing avoidable resizes:

- Agent sessions were spawned at 80x24 because `SessionSpawner.spawnNew` and
  `spawnResume` did not pass an initial size.
- The renderer then fitted xterm and sent a corrective `pty:resize`.
- Claude's classic renderer redraws into the primary buffer on resize, so the startup
  resize produced duplicate banners and drag resizing produced extra duplicate frames.
- Fresh output after a resize used the full pane width; the narrow/ghosted area was stale
  scrollback, not a live resize-delivery bug.

The fullscreen input problem was not an xterm focus bug. Launching Claude manually from a
shell pane in the same app worked, including fullscreen. The break only affected app-created
Claude agent sessions.

Comparison with VS Code and Warp showed the important difference:

- VS Code and Warp treat Claude as a normal terminal process. They do not inject
  `CLAUDECODE`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`,
  `CLAUDE_CODE_DISABLE_MOUSE`, or `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` for ordinary
  terminal sessions.
- Warp has bundled scripts that explicitly remove `CLAUDECODE` before invoking nested
  Claude, which strongly suggests `CLAUDECODE` means "already inside Claude Code", not
  "running in an embedded terminal".
- xterm.js already handles focus reporting (`?1004h`) by emitting FocusIn/FocusOut through
  `onData`; adding host-side FocusIn shims did not fix the issue.

The root cause of fullscreen input loss was our nonstandard Claude env, especially
`CLAUDECODE=1` and the forced renderer flags.

## Implemented

### Fitted Agent Spawn

`PtyManager.createDeferred` now accepts `deferSpawn = true`.

When enabled, it registers a pending spawn and waits for the renderer's first
`pty:resize` before sending the actual worker `spawn` message. The spawn then carries the
real fitted cols/rows. A 500ms timeout falls back to the default 80x24 size if no renderer
resize arrives.

`SessionSpawner.spawnNew` and `spawnResume` pass `deferSpawn: true` for agents. Shell panes
are unchanged.

### Resize Debounce

`Terminal/index.tsx` now uses a longer horizontal resize debounce for agent panes:

- Shell panes: 100ms.
- Agent panes: 400ms.

This reduces intermediate resize events during drag without changing shell behavior.

### Normal Claude Env

`PtyManager.buildEnv()` no longer has agent-specific Claude env. It now builds a
terminal-like environment:

- inherited process env;
- no `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ASAR`;
- inherited `CLAUDECODE` and forced Claude renderer flags are scrubbed;
- `TERM=xterm-256color`;
- `COLORTERM=truecolor`;
- `TERM_PROGRAM=vscode`;
- caller-provided env vars.

`SessionSpawner.agentEnv('claude')` now sets only:

- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`;
- provider/auth/model overrides from app settings.

Removed from app-created Claude sessions:

- `CLAUDECODE=1`;
- `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`;
- `CLAUDE_CODE_DISABLE_MOUSE=1`;
- `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1`;
- `CLAUDE_CODE_NO_FLICKER=1`.

Codex also no longer inherits any accidental Claude env through the generic agent PTY path.

The deferred-spawn path also tracks whether a worker `spawn` message has actually been
sent. Resizes before spawn are remembered; resizes after spawn but before `pty:ready` are
sent once and are not replayed on `ready`.

## Verification

Confirmed by user:

- Fresh Claude pane starts with a single banner at the correct width.
- Fresh output after resize uses full pane width; stale narrow scrollback is expected in
  classic mode.
- Launching Claude from a shell pane worked before and still works.
- App-created Claude sessions now remain typeable after `/tui fullscreen`.

Automated verification:

- `npm run typecheck` passes.

## Durable Rules

- Agent PTYs must spawn at the fitted pane size. Do not reintroduce 80x24-then-correct for
  Claude/Codex agent launches.
- Normal Claude panes should be launched like a normal terminal command. Do not set
  `CLAUDECODE` or force Claude renderer modes in the generic PTY env, and keep scrubbing
  inherited copies from `process.env`.
- Keep renderer policy process-scoped; do not write to `~/.claude/settings.json` or other
  user/project Claude config files.
- Do not add xterm focus-reporting shims unless a current regression proves xterm's native
  `?1004h` handling is insufficient.
- Do not reintroduce PATH rewrites, PTY flow control, or prompt-detection launch fallback.
