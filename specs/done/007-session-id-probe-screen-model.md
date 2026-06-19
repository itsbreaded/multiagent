# 007 — Session ID Probe: Screen-Model Capture

## Problem

`SessionSpawner._probeSessionIdViaPty()` (`src/main/sessions/SessionSpawner.ts`) detects a
pane's session ID by injecting `/status` into the running CLI and regexing the session UUID
out of the PTY output. It is unreliable:

- **Codex never detects.** No UUID is ever captured.
- **Claude detects only after a pane resize**, and the Escape that dismisses the `/status`
  dialog sometimes hangs.

The probe is the *primary* detection path; filesystem detection (chokidar for Claude, polling
for Codex) is the fallback and works, but the probe exists to give a definitive **per-pane**
answer that disambiguates multiple panes sharing one cwd (the filesystem path deliberately
bails on ambiguity — see `processClaudeBatch`). So the probe's value is real and we want to
fix it, not delete it.

## Root cause (agreed across three independent investigations)

The probe treats PTY output as **append-only text**: it does `buffer += stripAnsi(data)` and
runs a regex over the accumulated string (`SessionSpawner.ts` ~399-446). Both Claude (Ink) and
Codex paint their `/status` UI with **cursor-addressed writes** (absolute/relative cursor moves,
right-aligned box borders, per-cell diffing). Two distinct effects break the append-only regex:

1. **Arrival order ≠ screen order.** The UUID lands in the correct screen cells but its bytes
   arrive interleaved with cursor-move escapes. `stripAnsi` removes the escapes and concatenates
   the literal fragments, so the buffer never contains a clean contiguous UUID — even though the
   screen visibly does. A resize forces a full top-to-bottom repaint that *does* emit the UUID
   contiguously, which is exactly why Claude succeeds only after resize.

2. **Width truncation.** PTYs spawn at 80x24 (`PtyManager.createDeferred`) and the renderer
   re-fits to the real pane width (`Terminal/index.tsx`). Split panes are frequently narrower
   than the ~85-char status line, so the TUI truncates/pads the UUID to fit and the full value
   is not on screen at all until a wider repaint.

Codex has a second, independent failure: `CODEX_READY_RE = /›/` matches the hint/tip line that
appears **before** Codex's input loop is live, so `/status\r` is injected too early and dropped —
the dialog never renders. The fixed 1000ms delay is a cold-start timing guess.

The event wiring itself is **correct and not the bug**: `ptyWorker` sends `{type:'data',id,data}`,
`PtyManager` emits `('data', id, data)`, and the probe's `(id, data)` listener shape matches. Data
reaches the probe verbatim. Do not spend time re-investigating the IPC/event path.

`\r` is the correct submit terminator — do not change it to `\r\n`. Bare `\x1b` is the correct
Escape byte — the hang is render-state timing, not the byte.

## Intended behavior

Capture the session UUID off the **rendered screen**, not the byte stream, so initial paint is
equivalent to a resize repaint — and ensure the screen is wide enough that the UUID is never
truncated. Both Claude and Codex detect on first `/status` without requiring a user resize.

## Implementation phases

### Phase 1 — Screen-model capture (core fix)
- Feed **raw** PTY data (NOT `stripAnsi`'d) into a headless terminal screen buffer, then read the
  rendered screen text and run `SESSION_ID_RE` against it.
- Use `@xterm/headless`. The project already depends on `@xterm/xterm`, so this matches the stack.
  Confirm it installs/rebuilds cleanly (no native deps expected). If a dependency is unacceptable,
  a minimal VT screen parser is the fallback — higher risk, only if asked.
- When reading the screen, **join wrapped rows** (`isWrapped`) so a soft-wrapped UUID isn't split
  by the box border `│`. Prefer reading the post-wide-resize full repaint where it is one row.
- The probe currently strips ANSI before buffering — that path must be removed for the headless
  feed (the screen model needs the escapes to position the cursor).

### Phase 2 — Width independence
- Before injecting `/status`, resize the PTY wide (e.g. `cols=240`, keep rows) so the box never
  truncates, and size the headless buffer to match. **After capture (and after the Claude Escape),
  restore the prior size — this is non-negotiable.** A static pane left at 240 cols is broken;
  do not rely on a later renderer `fit()` that may never fire.
- `PtyManager` does not currently track per-id size (only `pendingResizes`). Add a `lastSize` map
  (or thread the renderer-reported size into the probe) so the probe can restore it.

### Phase 3 — Codex readiness
- Stop firing on the first `›`. Wait for Codex to settle: detect the banner, then wait for an
  **idle period with no PTY output** before injecting `/status\r`.
- If no UUID appears within the parse timeout, **re-inject `/status\r`** at a low cadence until the
  timeout, instead of failing on the first attempt (`/status` is idempotent in Codex).
- Do **not** re-inject `/status` for Claude — it opens a modal; repeated injection misbehaves.

### Phase 4 — Claude Escape
- Send Escape after capture once the dialog has settled; send two `\x1b` spaced ~250-500ms apart.
- Make it best-effort — capture has already succeeded, so the Escape must never block or fail
  detection.

## Risks

- **Headless buffer sized to a narrow pane reproduces truncation** and will still fail — Phase 2
  (wide resize) is what makes Phase 1 robust on split panes. Ship them together.
- Wide-resize without size restore breaks static panes. Verify restore on a pane that receives no
  subsequent resize event.
- The probe taps a shared `ptyManager.on('data')`; ensure the headless terminal instance is torn
  down on capture/timeout/PTY-exit so it doesn't leak per pane.
- Codex idle-detection cadence is a heuristic; tune against real cold-start traces, not a guess.

## Verification

- Add temporary diagnostic logging first (matched ptyId, ready trigger, write time, raw chunk with
  control chars visible, screen-read text, regex result). Confirm whether Codex fails *before*
  write, *after* write, or only at *parse* — and confirm whether the Claude UUID is visible on
  screen pre-resize (decides whether truncation is in play).
- Claude: new pane in a **narrow split** detects session ID on first `/status` with no user resize;
  dialog dismisses cleanly; pane returns to its real width.
- Codex: new pane detects on first `/status` (with retry if needed); `codex resume` fork detection
  still works (`_resolveCodexByPrefix` path preserved or superseded with equivalent coverage).
- Multiple panes in the same cwd each get their own correct session ID (the disambiguation the
  probe exists for).
- `npm run typecheck` passes.

## Constraints (non-negotiable)

- Do not mutate `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`, or any user/project config.
- PTY runs in the `ptyWorker` child process over Node IPC; data arrives via `PtyManager` `'data'`
  events. Keep the direct agent-launch path intact (no interactive-shell prompt wait).
- Keep filesystem detection as the fallback; the probe cancels it on success today — preserve that.
- `\r` submit and `\x1b` Escape bytes are correct; do not change them.

## Definition of done

Both Claude and Codex panes — including narrow split panes — reliably detect their session ID on
first `/status` without a manual resize, the Claude dialog dismisses without hanging, panes are
restored to their real width, same-cwd panes disambiguate correctly, and `npm run typecheck`
passes.

## Resolution (done)

Shipped. Verified in the running app: Claude and Codex new panes detect on the first `/status`,
restored panes resume clean (no `/status` injected), and Codex resume-fork detection is preserved
via the filesystem watcher. Phases 1–4 implemented as specced, plus several issues found only by
running with `PROBE_DEBUG=1` and reading the raw byte stream:

1. **`@xterm/headless` constructor:** the webpacked CJS bundle (no `"exports"` map, dead `"module"`
   field) exposes the constructor at `m.default.Terminal` under dynamic `import()`, not `m.Terminal`.
   Resolve `m.Terminal ?? m.default?.Terminal ?? m.default`. This crashed construction on every probe.
2. **Viewport vs buffer-top read (the core Phase-1 bug):** TUIs emit startup newlines that push the
   prompt into scrollback (`baseY` advances). `readScreen` read absolute lines `0..rows-1` (blank
   scrollback) and never saw the prompt/UUID. Fix: read `getLine(baseY + y)`.
3. **Codex geometry:** the headless buffer fixed at 24 rows while the renderer fits the PTY taller
   made Codex's newline-padded composer scroll out of view. Fix: mirror the headless size to
   `getPtyLastSize` on each chunk until widening.
4. **Codex `/status` submit:** `'/status\r'` in one write let `\r` land as a composer newline; the
   old per-2s retry masked this by spamming until it stuck (and polluted the transcript). Fix: type
   `'/status'`, wait ~250ms, send `'\r'` separately; single idempotent injection, no retry.
5. **Resume pollution:** the probe ran on `spawnResume` for Codex and injected `/status` into restored
   sessions. Removed — fork detection is handled by the filesystem watcher alone; resume-mode watcher
   timeout is silent.

Durable operational details folded into CLAUDE.md → Session Detection → "PTY session-id probe".

## Scope boundary / follow-on

This spec covers the probe for **single / sequential** pane creation, which is reliable. A
**separate, unresolved** problem surfaced afterward: when **two or more agent panes are created
back-to-back (e.g. a fast double-click on the sidebar session button) so they initialize/render at
the same time**, the concurrent layout reflow corrupts rendering (and, before the full-buffer scan,
detection) for **both** Claude and Codex. That is **not** a probe bug — it reproduces independently
of detection — and is tracked in **`specs/pending/008-concurrent-pane-init-render-corruption.md`**,
which records the full investigation and every fix attempt. Do not reopen 007 for it.
