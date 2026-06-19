# 008 — Concurrent Agent-Pane Init: Render Corruption

> Handoff ticket. The session-ID probe itself is solved (see `specs/done/007`). This is a
> **separate** rendering problem that only appears when **two or more agent panes are created
> back-to-back** so they initialize at the same time. Single / sequential creation is reliable for
> both Claude and Codex.

## Problem (one sentence)

When two agent panes are spawned almost simultaneously (the trigger in practice is a **fast
double-click on the sidebar "session" button**), the first pane is left in a **broken, mis-laid-out
render** (overlapping/duplicated banner lines, mis-spaced rows) that **does not self-correct** —
only a manual pane resize fixes it. It affects **both Claude and Codex**.

## Current behavior

- Create **one** agent pane, let it fully initialize / detect its session ID → renders perfectly.
- Create a **second before the first finishes initializing** (both rendering at once) → the first
  pane's terminal is corrupted and stays corrupted.
- A manual resize of the corrupted pane forces a clean repaint and fixes it.
- Detection (session ID) currently DOES succeed for both panes (after the 007 fixes + the
  full-buffer UUID scan); the remaining defect is **purely visual rendering**.

Reproduce: `npm run dev`, close all panes, then double-click the sidebar session button quickly to
open two Codex (or two Claude) sessions. Observe the first pane.

## What is confirmed (do not re-derive)

1. **It is a renderer/terminal problem, not a probe/detection problem.** The probe reads the PTY
   byte stream in the main process independently of the renderer; detection works. The corruption
   is in the xterm pane on screen.
2. **The trigger is simultaneous initialization**, not concurrency of spawning per se. The user's
   own finding: *"rendering is correct when launching and waiting for one pane to fully initialize
   and detect session ID; the problem only happens when you launch two and they are rendering at
   the same time."*
3. **The mechanism (from renderer instrumentation, see `[T]` logs below):** creating the second
   pane mutates the pane tree, which **remounts the first pane's `<Terminal>`** (its leaf is
   re-parented into a new `Allotment` split). On remount, `Terminal`'s connect effect calls
   `fitAddon.fit()` **while the Allotment split is mid-layout**, so it computes a **transient wrong
   size** and sends it to the PTY, immediately followed by the settled size. Observed sequence for
   the first pane's PTY:
   ```
   sendResize <pane> 187x52   (alone, full width)
   sendResize <pane> 42x52    (TRANSIENT — mid-split layout)
   sendResize <pane> 42x52
   sendResize <pane> 92x52    (settled, even split)
   ```
   The CLI repaints for the transient `42`, the settled `92` lands right behind it, and the pane's
   on-screen layout ends up inconsistent. The **split hotkey (`splitPane`) does not exhibit this**
   because deliberate key presses are spaced out, so each pane is split while **stable / fully
   rendered** — the same remount on a *stable* pane is harmless.
4. **The corruption is fixed by a single clean resize** (manual). Re-sending the *same* settled
   size does nothing (no size change → no repaint). So the fix must either prevent the transient
   resize from ever reaching the CLI, or force a genuine clean repaint after the layout settles.

## What was tried (and why each was rejected / its current state in the code)

All of the below were attempted during this investigation. **None fully fixed the visual
corruption for the concurrent case.** Current code state is noted so you don't repeat them.

| Attempt | Idea | Result | Code state |
|---|---|---|---|
| **Main-side resize coalescing** (handlers.ts `pty:resize`) | Debounce ~120ms so a resize burst collapses to the settled size | **Broke Claude** — delayed resize desynced the probe's `savedSize`/restore and left Claude mis-rendered. The probe reads `PtyManager.getPtyLastSize`, which is set by `resize()`; delaying renderer resizes corrupts the probe's size bookkeeping. | **Reverted.** |
| **PTY spawn stagger** (PtyManager.createDeferred) | Delay the 2nd PTY spawn ~600ms | Didn't help — the corruption is from renderer remount/resize churn, not spawn timing. | **Reverted.** |
| **Remove `--no-alt-screen` from Codex** | Make Codex render in a fixed alt-screen buffer like Claude (no scrolling) | "Not any worse" but did **not** fix concurrent corruption (and the problem also affects Claude, which already uses alt-screen). | **Reverted** (flag restored). |
| **`newSession` → delegate to `splitPane`** | Stop `newSession` from re-rooting the whole tree (wrapping `rootNode` in a new split remounts *every* pane); split the focused pane surgically like the hotkey | Reduced remounts but the focused pane is **still** re-parented/remounted when its sibling is added, so the transient-resize storm still hits it. | **KEPT** (it's a genuine improvement / matches the hotkey; not a workaround). |
| **Fixed 750ms gap between sidebar spawns** | Space the two creations | Too short — the first pane isn't done initializing in 750ms, so they still overlap. | **Reverted.** |
| **Full serialization queue** (wait for pane 1 `sessionDetectionState==='detected'` before creating pane 2, 6s cap) | Guarantee one-at-a-time init (the user's manual workaround, automated) | **Worked for detection but left Claude's screen corrupted** in a new way and is a UX-degrading band-aid, not a real fix. User explicitly rejected the workaround approach. | **Reverted.** |
| **Forced `xterm.refresh(0, rows-1)` ~260ms after layout settles** (Terminal layoutKey effect) | Repaint stale canvas after the storm | Helped the single-pane visual but did **not** fix the concurrent case (buffer content itself can be wrong, not just stale canvas). | **Reverted.** |
| **Probe answers terminal queries / sends focus-in** (headless `onData`→PTY; `\x1b[I` on `?1004h`) | Theory: CLI blocks on a DA/DSR query or focus event | Disproven — neither unblocked the stalled pane; the focused pane renders without focus, so focus isn't the differentiator. | **Reverted.** |

### Fixes that WERE kept (part of the working single/sequential baseline)
- All of `specs/done/007` (constructor resolution, `baseY` viewport read, geometry mirror,
  split-write `/status`, no-retry, resume-probe removal).
- **Full-buffer UUID scan** (`readFullBuffer` in `SessionSpawner.ts`) — scans scrollback+viewport
  for the UUID so a scrolled `/status` dialog is still captured. Robustness improvement; kept.
- **`newSession` → `splitPane` delegation** (panes.ts) — see table above.

## Diagnostic instrumentation (gated behind `PROBE_DEBUG`, left in the tree for you)

Run `$env:PROBE_DEBUG=1; npm run dev` (PowerShell). All of this is zero-cost when the env var is
unset. **Once 008 is resolved, strip it** (search the prefixes below):

- **`[probe]`** — `SessionSpawner._probeSessionIdViaPty` state machine: start, READY matched,
  injecting /status, UUID captured, READY/PARSE timeouts, plus full-screen + raw-escaped byte dumps
  on timeout/stall. Helper: `probeDbg`. Flag: `PROBE_DEBUG` const at top of `SessionSpawner.ts`.
- **`[pty]`** — `PtyManager` PTY lifecycle: createDeferred / spawn sent / ready / first data
  (with first 120 bytes) / exit / error. Helper: `ptyDbg`.
- **`[T]`** — renderer `Terminal`/`PaneContainer` lifecycle: mount/unmount (with `reused` flag),
  connect, connect-fit, fit (with container rect + term cols/rows), `fit SKIP zero-size`,
  sendResize, focusIn/focusOut, click. Helper: `tlog` in `Terminal/index.tsx`.
- **Renderer→main forwarder**: `src/main/index.ts` has a `console-message` listener (gated by
  `PROBE_DEBUG`) that prints any renderer log starting with `[T]` into the **main terminal**, so
  `[T]`/`[pty]`/`[probe]` all appear in one place. (Otherwise `[T]` only shows in DevTools.)

### Key captured evidence (real logs)
- First pane's PTY resize storm during concurrent create: `187x52 → 42x52 → 42x52 → 92x52` (the
  transient `42` is the smoking gun).
- `[T]` shows the first pane `unmount`/`mount reused=true` cycles when the second pane is created;
  the second pane mounts once cleanly and renders fine.
- Note React **StrictMode (dev)** double-invokes mount/unmount, which *amplifies* the remount churn
  in `npm run dev`. Verify whether the bug is as severe in a production build (`npm run dist`) — if
  StrictMode is the dominant amplifier, the production severity may differ. This is unverified.

## Likely-fruitful directions (not yet tried / not completed)

1. **Stop the transient resize at the source.** In `Terminal/index.tsx` the connect path does
   `fit()` then an **immediate** `sendResize(terminal.cols, terminal.rows)`. The `fit()` already
   triggers `onResize → queueResize` (which debounces column-only changes by
   `RESIZE_COL_DEBOUNCE_MS = 100`). The immediate `sendResize` **bypasses that debounce** and is
   what delivers the transient `42`. Routing the connect resize through `queueResize` (or dropping
   the immediate call and relying on the ResizeObserver/`queueFit`, which fit *after* layout
   settles) may eliminate the transient — **but** beware: the probe's `savedSize` logic depends on
   `getPtyLastSize` reflecting the renderer's resize promptly. Decouple the probe from renderer
   resize timing FIRST (see #3) or you will reproduce the "coalescing broke Claude" failure.
2. **Don't remount the first pane when a sibling is added.** The remount is what runs `fit()`
   mid-layout. If `PaneGrid`/`renderNode` keying kept the existing pane's React subtree stable
   across the split (so it isn't unmounted/re-parented), there'd be no connect-time fit and no
   transient. This is the most principled fix but requires care with the `Allotment` tree + the
   `xtermRegistry` attach/detach model. Confirm whether the leaf can stay mounted when its parent
   changes from a leaf-slot to an `Allotment.Pane`.
3. **Decouple the probe's size restore from live renderer resizes.** Several resize fixes broke
   Claude because `_probeSessionIdViaPty` widens the PTY to 240 cols and must restore the prior
   size, reading it from `PtyManager.getPtyLastSize`, which renderer resizes mutate. Making the
   probe capture/restore size independently (e.g. thread the renderer-reported size in, or snapshot
   before widening and ignore concurrent renderer resizes) would let you safely debounce/coalesce
   resizes without corrupting detection.
4. **Force a genuine clean repaint after settle.** Since re-sending the same size is a no-op, a
   reliable repaint needs an actual size change. A controlled "nudge" (resize to N-1 then N) after
   the layout has been stable for a beat *would* force the CLI to fully repaint — ugly, but it is
   exactly what the manual resize that fixes it does. Consider only if #1/#2 prove too invasive.

## Constraints / non-negotiables

- **Do not delay or reorder resizes in a way that desyncs the probe.** Two separate attempts
  (main-side coalescing, fixed gap interacting with the probe) corrupted Claude this way. Test
  Claude single-pane detection on every change.
- Keep single / sequential creation working — it is currently reliable. Don't regress it.
- Do not reintroduce a serialization/queue that makes the user wait between sessions; the user
  explicitly rejected that as a workaround. The goal is for concurrent creation to *just work*.
- Do not mutate user/project config (`~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`).
- Keep filesystem detection as the fallback (probe cancels it on success).

## Definition of done

Opening two (or more) agent panes back-to-back via the sidebar session button — fast enough that
they initialize simultaneously — results in **every pane rendering correctly with no manual resize
needed**, for **both Claude and Codex**, while session-ID detection continues to work for all of
them. No regression to single/sequential creation or to Claude. `npm run typecheck` passes.

## Handoff contract

- Reproduce first with `PROBE_DEBUG=1` and the `[T]` renderer logs; confirm the transient-resize
  storm on the first pane. Decide between direction #1 (kill the transient resize) and #2 (prevent
  the remount) — #2 is cleaner if feasible.
- Whatever you change in the resize path, **re-verify Claude single-pane detection** (the probe's
  `savedSize` coupling is the landmine).
- After it works, **remove all `PROBE_DEBUG` diagnostics** (`[probe]`, `[pty]`, `[T]`, the
  `console-message` forwarder in `main/index.ts`) and fold any durable lesson into `CLAUDE.md`.
- Files in play: `src/renderer/src/components/Terminal/index.tsx` (fit/resize/connect lifecycle),
  `src/renderer/src/components/PaneGrid/index.tsx` + `PaneContainer.tsx` (tree render / remount /
  `layoutKey`), `src/renderer/src/store/panes.ts` (`newSession`, `splitPane`),
  `src/main/ipc/handlers.ts` (`pty:resize`), `src/main/sessions/SessionSpawner.ts` (probe + size
  restore), `src/main/pty/PtyManager.ts` (`getPtyLastSize`).
