# 026 - Claude Renderer Mode: Resize Corruption + Fullscreen (alt-screen) Support

## Problem

Claude Code panes in our app suffer **three related defects, all rooted in one thing: the
renderer mode Claude runs in.** We currently force Claude's *classic (primary-screen)*
renderer, which is itself buggy on resize; the proper cure (alt-screen / fullscreen
rendering) currently breaks keyboard input in our embedded pane.

### Symptom A — duplicated banners / stacked logos

On startup (and on resize), Claude's ASCII logo + version banner render repeatedly,
stacking vertically in scrollback (observed ~8× right after `[Starting Claude session...]`).

### Symptom B — no reflow on widen / early line breaks

After the pane is resized wider, Claude's rendered text keeps wrapping at a narrower width,
leaving a large empty region on the right. The same Claude content renders full-width when
Claude runs in the native Windows console. Shell (PowerShell) panes are unaffected — their
output soft-wraps and reflows cleanly.

### Symptom C — input dies in fullscreen mode

Claude shipped a **fullscreen rendering mode** (research preview, v2.1.89+). When it is
active, Claude panes break: typing into the pane does nothing. The user wants the app to
*support* fullscreen rather than only suppress it; today we suppress it, but the
suppression is leaky (the user can flip it on mid-session and strand the pane), and when it
is on we have no working input path.

## Root cause (unified)

**We force Claude into its classic primary-screen renderer**, and that renderer has a known
upstream bug. The agent env profile sets `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`
(`src/main/pty/PtyManager.ts:226`), forcing the classic append-to-scrollback path. On a
resize (SIGWINCH) — and on other redraw triggers (large output, recap renders,
prompt-state transitions) — the classic renderer **redraws the frame without first clearing
the previous one**, so each intermediate width during a drag accumulates as a duplicate
frame in scrollback. Well-behaved fullscreen TUIs (vim, htop) avoid this by drawing into
the **alternate screen buffer**, which isolates redraws from scrollback. The native Windows
console "looks fine" because Claude there runs in its default/fullscreen (alt-screen) mode.

This is confirmed upstream, reproducible across Terminal.app, VS Code's integrated
terminal, Windows Terminal, JetBrains, and xterm.js. Tracking issues: anthropics/claude-code
[#49086](https://github.com/anthropics/claude-code/issues/49086),
[#46462](https://github.com/anthropics/claude-code/issues/46462),
[#46981](https://github.com/anthropics/claude-code/issues/46981),
[#51410](https://github.com/anthropics/claude-code/issues/51410),
[#40555](https://github.com/anthropics/claude-code/issues/40555),
[#48318](https://github.com/anthropics/claude-code/issues/48318) (and several dupes).

We make it worse in two ways we control:

1. **We guarantee an extra startup redraw.** Agent PTYs spawn at a hard-coded **80×24**
   (`PtyManager.createDeferred` default, `PtyManager.ts:124`; neither
   `SessionSpawner.spawnNew` nor `spawnResume` passes a size — `SessionSpawner.ts:70,86`).
   Claude prints its banner at 80 cols, then the renderer fits the xterm to the real pane
   size and sends a corrective `pty:resize` (`Terminal/index.tsx:497-498`). That first
   resize fires the leaky redraw → the banner is re-emitted at the new width → **stacked
   logos at startup** (symptom A). Shell panes avoid this: the Terminal component fits the
   xterm *before* calling `pty:create`, so the shell PTY starts at the correct size and
   takes no startup resize (`Terminal/index.tsx:343-371`).

2. **We set contradictory renderer flags.** `CLAUDE_CODE_NO_FLICKER=1` (requests
   flicker-free / fullscreen) is set in both `PtyManager.ts:166` and
   `SessionSpawner.ts:362`, while `DISABLE_ALTERNATE_SCREEN=1` forces classic. Per the docs
   the disable wins, so we get classic — the buggy mode — but the intent is muddied across
   two layers.

### How this maps to the symptoms

- **Symptom A** = the startup 80×24→fitted resize firing one leaked redraw, plus any
  further resizes.
- **Symptom B** = classic-renderer scrollback can't reflow on Windows: ConPTY hard-wraps
  emitted lines at the width in effect when written, so old scrollback stays wrapped at the
  old narrower width regardless of xterm's reflow, and the leaky redraw leaves **ghost
  cells** from prior frames (a stranded fragment floating in the blank area is leftover
  cells a narrower redraw never cleared). Same root family as A.
- **Symptom C** = the cure for A/B (alt-screen) turns on mouse tracking, which steals
  keyboard focus in our pane (mechanism detailed below).

**The durable cure for A and B is alt-screen rendering — which is exactly what fixing C
unlocks.** That is why these are one spec: A/B are why we *want* alt-screen; C is what
*blocks* it. Phases 1-2 are a stopgap that makes the forced-classic mode bearable now;
Phases 3-5 are the permanent fix.

### Open question to settle before Symptom-B work (do this FIRST)

Symptom B has two candidate live-state causes and the screenshot is ambiguous:

- **(A1) Stale scrollback only** — Claude's *live* width is correct; only old scrollback is
  narrow/ghosted. Inherent to classic mode; the host can't reflow it.
- **(B1) Live width is genuinely wrong** — Claude is currently rendering narrower than the
  xterm pane actually is, i.e. a host-side resize-delivery bug.

**Discriminator (cheap, no code):** run `npm run dev`, open a Claude pane, widen it, let it
settle, then produce one line of *fresh* output and observe:

- Input box + status line + fresh output span the **full** pane width → cause (A1); the
  narrow region is stale scrollback. Scope symptom-B fixes to "reduce wrong-width renders."
- Input box / fresh output are **also** narrow → cause (B1); there is a real
  resize-delivery bug to fix in `Terminal/index.tsx` (`queueResize`/`flushPendingResize`,
  lines 451-498) on top of everything else.

Record the answer in this spec before implementing symptom-B work.

## Background: what fullscreen rendering actually is

Source of truth: <https://code.claude.com/docs/en/fullscreen> (verified 2026-06-22).

Fullscreen rendering is an alternative draw path for the Claude Code CLI. Instead of
appending to the terminal's primary screen + scrollback, it **takes over the terminal's
alternate screen buffer** (DECSET 1049, `\x1b[?1049h`) the way `vim`/`htop` do, keeps the
input box pinned to the bottom, renders only currently-visible messages (flat memory), and
eliminates flicker. It is the same class of behavior we already neutralize for **Codex**
via `--no-alt-screen` (see `CLAUDE.md` and `SessionSpawner.codexCliArgs`). Because it
isolates redraws from scrollback, **it also fixes symptoms A and B.**

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
  - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (forces classic — the buggy renderer)
  - `CLAUDE_CODE_DISABLE_MOUSE=1`
  - `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`
- `src/main/pty/PtyManager.ts:163-168` — `createClaude` *also* injects
  `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1` and `CLAUDE_CODE_NO_FLICKER=1`.
- `src/main/sessions/SessionSpawner.ts:360-362` — `agentEnv` (the path that actually
  launches/resumes Claude) sets `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1` and
  `CLAUDE_CODE_NO_FLICKER=1`. It does **not** set the `DISABLE_*` flags — those come from
  `buildEnv` when the pty is created.
- `src/main/pty/PtyManager.ts:124` — `createDeferred` defaults `initialSize` to
  `{ cols: 80, rows: 24 }`.
- `src/main/sessions/SessionSpawner.ts:70,86` — `spawnNew`/`spawnResume` call
  `createDeferred` with **no** `initialSize` (so agents always start at 80×24).
- `src/renderer/src/components/Terminal/index.tsx:343-371` — shell panes fit before
  `pty:create` (the good path agents lack).
- `src/renderer/src/components/Terminal/index.tsx:451-498` —
  `queueResize`/`flushPendingResize`/`sendResize`; 750ms suppress window + 100ms horizontal
  debounce.
- `src/renderer/src/store/panes.ts` `runNewAgentSession`/`resumeAgentPane` — spawn agents
  via `session:new`/`session:resume` from the store, **before** the xterm has mounted, so
  no fitted size is available at spawn time.

So at process start we both request flicker-free (`NO_FLICKER=1`) and force classic
(`DISABLE_ALTERNATE_SCREEN=1`). Per docs the disable should win, so cold launches stay
classic — **but classic is itself broken on resize (symptoms A/B); it is not a safe
baseline.** The input break (symptom C) happens after `/tui fullscreen`: Claude writes
`"tui":"fullscreen"` to the user's global settings and relaunches itself. We need to
confirm whether `DISABLE_ALTERNATE_SCREEN=1` actually survives and still wins after that
in-process relaunch in current Claude — the field report suggests it may not, or that the
user already has `"tui":"fullscreen"` set globally.

### Why input dies in fullscreen (renderer mechanism — grounded in code)

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
gate input on focus state. The exact culprit must be confirmed during Phase 3.

## Intended behavior

1. Opening a Claude pane shows the banner **once**, at the correct width.
2. Resizing a Claude pane does not pile duplicate frames into scrollback; fresh output uses
   the pane's full width.
3. **Input must never be lost.** Whatever the user's `tui` setting or `/tui` toggle does, a
   Claude pane must remain typeable. Non-negotiable.
4. **A single, coherent policy** for Claude's renderer mode, owned in one place — not two
   layers (`buildEnv` + `createClaude`/`agentEnv`) silently contradicting each other.
5. **Support fullscreen as a real, working mode** in the embedded pane: alt-screen, mouse
   capture, focus reporting, and wheel scrolling all behave — which simultaneously fixes the
   resize corruption (symptoms A/B).
6. A **user-facing setting** (Settings → Terminal, persisted) to choose the Claude renderer
   policy: `classic` / `fullscreen` / `auto`. Default chosen in Phase 5 based on what works.
7. No regression to shell panes, Codex panes, session detection, or resume.

## Implementation phases

> Sequencing: Phases 0-2 are independent host-side stopgaps for the forced-classic mode and
> can ship **now** without touching the renderer mode. Phases 3-5 are the durable cure
> (alt-screen support + the focus fix). When Phases 3-5 land, re-evaluate whether the
> Phase 1-2 stopgaps are still needed (alt-screen may make the startup resize harmless) and
> prune accordingly.

### Phase 0 — Settle the symptom-B discriminator (investigation, no code)

Run the discriminator test above; record (A1) vs (B1). This decides whether Phase 2
includes a resize-pipeline delivery-bug fix.

### Phase 1 — Eliminate the startup resize (highest-confidence; fixes symptom A startup stacking)

Spawn agent PTYs at the real pane size so Claude never renders its banner at 80 cols then
redraws. The plumbing wrinkle: agents spawn from the **store** before the xterm exists, so
the fitted size isn't known at `session:new`/`session:resume` time. Options, in order of
preference:

1. **Defer the launch until first size is known.** Have `createDeferred` for agents hold
   the spawned command until the renderer reports the first `pty:resize`, then launch with
   that size already applied. Cleanest: Claude never prints at 80. Verify this does not
   reintroduce the old 10s prompt-detection fallback (`CLAUDE.md`: agents must launch the
   command immediately, not wait for an interactive prompt — "after the one-shot size is
   known" is acceptable as long as the path stays non-interactive).
2. **Pass a best-effort size from the store.** Thread a cached last-known pane size into
   `session:new`/`session:resume` → `spawnNew`/`spawnResume` → `createDeferred(initialSize)`.
   Less precise than (1) but removes the gross 80→full jump.
3. **Guarantee the corrective resize lands before the banner.** Weakest; only if (1)/(2)
   are infeasible. Racy — prefer (1).

`session:new`/`session:resume` IPC signatures, `spawnNew`/`spawnResume`, and `createDeferred`
may need an optional `initialSize`; keep the 80×24 default for shell-style callers. Update
`src/shared/types.ts` for any IPC signature change.

### Phase 2 — Reduce resize-driven duplication during drag (mitigates symptom A on resize)

The renderer already debounces horizontal reflow (100ms) and suppresses for 750ms after
connect. Tighten so a drag sends Claude **one** final resize, not every intermediate width:

1. Confirm `flushPendingResize` always fires the final size after a drag ends (no path
   where the last width is dropped). If Phase 0 = cause (B1), fix the delivery bug here.
2. Consider lengthening the horizontal debounce specifically for **agent** panes (shell
   panes tolerate frequent resizes; agents pay a leaked redraw per resize). Gate on
   `paneType === 'agent'`; leave shell behavior unchanged.
3. Do **not** add flow control / ack / pause (`CLAUDE.md` no-flow-control rule).

### Phase 3 — Reproduce and pin the fullscreen input failure (investigation, no shipping code)

Goal: replace hypotheses with a confirmed cause before changing renderer mode.

1. Build/run the app, open a Claude pane, confirm it types in classic mode.
2. Reproduce the break two ways and record which apply:
   - Run `/tui fullscreen` inside the pane and observe relaunch + input loss.
   - Pre-set `"tui":"fullscreen"` in `~/.claude/settings.json`, cold-launch a pane.
3. With devtools or a pty data tap, capture the escape sequences Claude emits on entering
   fullscreen. Confirm presence/absence of: `?1049h`, mouse DECSETs (`?1000/1002/1003/1006`),
   `?1004h` (focus), `?2004h` (paste), CSI u (`>1u`).
4. Determine empirically whether `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` still forces
   classic **after** a `/tui fullscreen` relaunch in current Claude. Document the answer.
5. Confirm the input-loss mechanism: instrument whether the xterm textarea loses focus and
   whether `terminal.onData` stops firing once mouse tracking is on.

Deliverable: a short findings block appended to this spec (sequences seen, whether the
disable flag wins post-relaunch, confirmed root cause).

### Phase 4 — Make the embedded pane actually work in fullscreen (the "support" work + the durable A/B cure)

1. **Single-source the renderer env.** Centralize Claude renderer env into one helper (e.g.
   `claudeRendererEnv(mode)` in the main process). Remove the contradiction: do not set
   `NO_FLICKER=1` and `DISABLE_ALTERNATE_SCREEN=1` together. In `classic` mode emit only the
   disable flags (`DISABLE_ALTERNATE_SCREEN`, `DISABLE_MOUSE`, plus existing
   `DISABLE_TERMINAL_TITLE`/`DISABLE_VIRTUAL_SCROLL`) and **drop `NO_FLICKER`**.
2. **Focus on click even under mouse tracking.** Ensure a click in a Claude pane both
   focuses the xterm (so the textarea receives keys) *and* still lets xterm forward the
   mouse event. Audit `attachCustomKeyEventHandler` and the pane's pointer handling so that
   entering mouse-tracking mode never strands keyboard focus. Direct fix for symptom C.
3. **Focus reporting.** Deliver focus-in to xterm when the pane is the app-focused pane, so
   fullscreen Claude doesn't gate input on a stale focus-out. Tie into the existing
   `focusPaneInTab` transition rather than bolting on a new path.
4. **Alt-screen + scrollback expectations.** With alt-screen active, our 250k-line
   scrollback is bypassed (Claude owns the buffer). Confirm `Ctrl+o` transcript mode and `[`
   (write-to-scrollback) behave, and that switching modes does not corrupt the xterm
   viewport. No flow control (`CLAUDE.md`).
5. **Mouse wheel.** Verify wheel events reach Claude; document `CLAUDE_CODE_SCROLL_SPEED` as
   the user-tunable knob rather than intercepting wheel ourselves.
6. **Confirm kitty protocol stays off** for our `TERM`/`TERM_PROGRAM`; if xterm.js ever
   negotiates CSI u, ensure our key handler round-trips it.
7. If Phase 3 shows `/tui fullscreen` can still escape `DISABLE_ALTERNATE_SCREEN`, add a
   renderer-side guard so input survives even if Claude enters alt-screen unexpectedly —
   never rely solely on the env flag.

### Phase 5 — Setting + policy wiring

1. Add `claudeRendererMode: 'auto' | 'classic' | 'fullscreen'` to `useSettingsStore`
   (persisted), surfaced in Settings → Terminal next to scrollback. Follow the shared modal
   styling and `theme.ts` tokens.
2. Map the setting to env in the single helper from Phase 4:
   - `classic` → disable flags, no `NO_FLICKER`.
   - `fullscreen` → `NO_FLICKER=1` (or `"tui":"fullscreen"` semantics), no disable flags,
     with Phase 4 renderer support live.
   - `auto` → emit nothing that forces either way; let the user's `~/.claude` `tui` setting
     decide. Only safe once Phase 4 makes fullscreen work.
3. **Default value:** decide after Phases 3-4. Note that classic is *not* a clean fallback —
   it carries the resize corruption (symptoms A/B). If fullscreen is solid in-pane, prefer
   defaulting to `fullscreen` (or `auto`) precisely because it fixes A/B; only fall back to
   `classic` + the Phase 1-2 mitigations if fullscreen input cannot be made reliable.
4. Changing the setting applies to **new** panes; existing live panes keep their launched
   mode until restarted (env is fixed at spawn). Do not silently kill running agents.

### Phase 6 — Codex note (one line, not an investigation)

Codex launches with `--no-alt-screen` (`SessionSpawner.ts:414`), the same non-isolated
redraw posture, so it is likely *more* exposed to resize duplication, not less. Verify
whether Codex shows the same stacking; if so, the Phase 1-2 mitigations apply to Codex too.
Do not change the Codex flags without re-verifying against current Codex behavior (`CLAUDE.md`).

## Risks

- **Breaking working classic panes.** The env layers are load-bearing; centralizing them
  (Phase 4.1) risks regressing the current cold-launch behavior. Diff env output
  before/after.
- **Deferring agent launch (Phase 1.1)** could shift Codex detection timing (it keys off
  first user input + start-time). Re-run the Codex resume/detection path.
- **Threading a size through IPC (Phase 1.2)** touches `src/shared/types.ts` — keep the
  80×24 default so shell and other callers are unaffected; typecheck.
- **Changing the agent resize debounce (Phase 2)** must not touch shell panes; gate on
  `paneType === 'agent'`.
- **`DISABLE_ALTERNATE_SCREEN` precedence is undocumented for the post-`/tui` relaunch
  case.** Phase 3 must settle this; do not assume the flag wins.
- **Mouse-capture focus fix could double-handle clicks** (focus *and* mouse-forward),
  causing stray selection or cursor jumps. Test drag-select and click-to-expand.
- **Global settings mutation.** `/tui fullscreen` writes the user's real
  `~/.claude/settings.json`. Per `CLAUDE.md` we must not mutate user agent config — the
  *user* invoking `/tui` does, not us. Our control stays process-scoped env only.
- **Attached/background sessions** ignore the disable flag entirely; out of scope but noted
  so a future agent-view feature does not assume classic is reachable.
- **Upstream residue.** Until alt-screen (Phases 3-5) ships, some classic-mode resize
  duplication remains even with Phases 1-2. Set expectations: the host stopgaps remove the
  *startup* stack and the *extra* drag frames, not the upstream classic-renderer bug itself.

## Verification

- Phase 0: discriminator result (A1/B1) recorded in this spec.
- Open a fresh Claude pane: banner appears **once**, at full pane width (was ~8× stacked).
- Open a Claude pane in a narrow split, then zoom/widen it: fresh output uses full width;
  duplicate banners pushed to scrollback drop sharply vs before.
- Drag-resize a streaming Claude pane: far fewer duplicated frames than before.
- Shell (PowerShell) panes: unchanged reflow and startup behavior.
- Cold launch Claude pane in each `claudeRendererMode`; confirm typing works in all three.
- From classic, run `/tui fullscreen`; confirm the pane stays typeable after relaunch (the
  symptom-C regression). Run `/tui default`; confirm it returns cleanly.
- With `"tui":"fullscreen"` pre-set in `~/.claude/settings.json` and mode=`classic`, confirm
  we still force classic (or, if Phase 3 proves we can't, confirm the renderer guard keeps
  input alive).
- In fullscreen: click-to-position cursor, click-to-expand a tool result, wheel scroll,
  drag-select + copy, `Ctrl+o` transcript + `/` search + `[` to scrollback; resize
  repeatedly while streaming — **no banner stacking and no viewport corruption** (this is
  the payoff: alt-screen fixes A/B).
- Codex pane: re-check resume + session detection still work; note duplication behavior.
- `npm run typecheck` clean; no PATH rewrite, no flow control reintroduced (`CLAUDE.md`).

## Handoff contract

**Non-negotiables:**
1. A Claude pane is **always typeable** — no setting, `/tui` toggle, or pre-existing
   `~/.claude` config may leave a pane that silently swallows input.
2. A Claude pane shows its banner once at the correct width on open.
3. Shell-pane reflow/startup behavior is untouched; size plumbing keeps the 80×24 default
   for non-agent callers.
4. Claude renderer env is single-sourced; `buildEnv` and `agentEnv`/`createClaude` must not
   set contradictory renderer flags.
5. We never write to `~/.claude/settings.json`, `~/.claude.json`, or other user/project
   agent config — renderer policy is process-scoped env only (per `CLAUDE.md`).
6. No PATH rewrite, no flow control / ack / pause added to the pty or renderer pipeline.
7. Agent launch stays non-interactive (no return of the old prompt-detection fallback).

**Definition of done:**
- Phase 0 discriminator answer + Phase 3 findings recorded in this spec.
- Agent PTYs spawn at the real pane size (startup banner stacking gone); drag-resize
  duplication measurably reduced; final width always delivered.
- `claudeRendererMode` setting exists, persists, and maps to env through one helper.
- `/tui fullscreen` followed by typing works in the pane (symptom C fixed); fullscreen
  mouse + focus + scroll behaviors verified per the Verification list; resize-in-fullscreen
  shows no stacking/corruption (A/B fixed via the cure).
- Codex behavior checked and noted.
- `CLAUDE.md` updated with the durable rules: (a) agent PTYs must spawn at fitted size (not
  80×24) and *why* (Claude's classic renderer leaks a redraw per resize), mirroring the
  shell-pane fit-before-create note; (b) how Claude's fullscreen/alt-screen mode is handled
  in embedded panes and which env flags control it (mirror the Codex `--no-alt-screen` note).
- Spec moved to `specs/done/026-...` (keep the number) or folded into `CLAUDE.md` if the
  lesson collapses to a short note.
