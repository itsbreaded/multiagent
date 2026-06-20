# 013 - VS Code-style terminal rebuild

Status: **Implemented — paths unified onto one host; pending real-app verification.**
Supersedes `specs/done/012-conpty-no-scroll-output-loss.md` as the implementation direction. Spec
012 remains the historical record of why the bug is the *pane code path*, not the environment.

The original symptom is fixed for normal shell panes: `git pull` in an up-to-date repo now prints
`Already up to date.` and `echo hi` at the top of a fresh viewport now prints `hi`. This was first
achieved by building a VS Code-shaped **direct** path for shell panes (the `ShellPtyHost` /
`shellWorker` stack) instead of grafting onto the agent pipeline.

That dual stack has now been **collapsed onto a single pty host** (`PtyManager` + `ptyWorker`).
Shell vs agent differ only by a per-PTY flow-control policy (`directIds` / `flowControl:false`),
not by separate hosts/workers/xterm lifecycles. `ShellPtyHost` and `shellWorker` are deleted. The
remaining work is real-app verification (see Test plan) before moving this spec to `done`.

The durable contract now lives in `CLAUDE.md`; sections below are the rationale and the
do-not-break details.

Reference local repo: `C:\Users\cdhan\Desktop\vscode` (confirmed present). Key files listed under
"VS Code baseline" below.

---

## 1. What now works, and why (the working idea)

The fix was to give shell panes a dedicated pty host + worker that relays node-pty output
**straight to xterm** — the proven in-app "Bare Term" path from spec 012, productionized — while
the agent pipeline (coalesce + sequence/ack flow-control) was left in place for high-volume CLI
output. Concretely:

- **`src/main/pty/ShellPtyHost.ts`** (new) — main-side host. Spawns `shellWorker.js` as an
  `ELECTRON_RUN_AS_NODE` child (same isolation rationale as `ptyWorker`). Contract mirrors
  `PtyManager`: `create / write / resize / kill` + `data / ready / exit / error` events, and it
  caches `PtyReadyEvent` per id for the `pty:get-ready` catch-up path.
- **`src/main/pty/shellWorker.ts`** (new) — minimal node-pty relay. `instance.onData(d => send
  {type:'data'})` with **no batching**. Queues input/resize until spawn, emits a `ready` event
  carrying `pid`, `cwd`, and Windows ConPTY traits `{ backend:'conpty', buildNumber }`.
- **`handlers.ts` data routing** — the single most important divergence:
  - `shellPtyHost.on('data')` → `sendDirectPtyOutput()` →
    `windowManager.sendToWindowForPty(ptyId, 'pty:data', ptyId, data, /*seq*/ 0, byteLength)`.
    **seq is hard-coded `0`** — the sentinel for "direct, no ack."
  - `ptyManager.on('data')` (agents) → `enqueuePtyOutput()` → 5 ms / 256 KiB coalesce, **monotone
    seq > 0**, in-flight byte tracking, pause/resume watermarks.
- **`Terminal/index.tsx` write path** — keyed on the seq sentinel:
  ```ts
  if (seq === 0) terminal.write(data)      // shell: synchronous, no slice, no ack
  else            enqueueOutput(data, seq, byteLength)  // agent: bounded slices + pty:data-ack
  ```
  This synchronous `terminal.write` for shell output is what makes the short no-scroll line appear.
- **`Terminal/index.tsx` xterm lifecycle** — both shell and agent panes use
  `xtermRegistry.getOrCreate` + `attach`, so the xterm instance and its scrollback survive
  remounts. The registry now defers `xterm.open()` until the wrapper is attached to a live
  container (the `opened` flag in `xtermRegistry.ts`), which is what made the earlier
  shell-only "direct open + dispose on unmount" path unnecessary. (This was gap G1; now fixed.)
- **Process-ready gating (VS Code shape)** — both hosts now emit `pty:ready` with
  `{ pid, cwd, windowsPty }`. The renderer applies `xterm.options.windowsPty` and registers the
  DA1 `\x1b[?61;4c` CSI handler **only after `pty:ready`** (with `pty:get-ready` as a
  missed-event fallback), not at xterm construction from `window.osRelease`. `ptyWorker.ts` also
  now waits for a valid pid before emitting ready on Windows.
- **Shell integration via OSC 633** — `shellIntegration.ps1` (new, modeled on VS Code) replaces
  the old `-EncodedCommand` OSC 7 prompt wrapper. It emits `OSC 633;P;Cwd=<escaped>` plus
  A/B/C/D/E command-boundary markers. `terminalEnvironment.ts` (new) builds the launch args
  (`-NoLogo -NoExit -ExecutionPolicy Bypass -Command . "<script>"`). `handlers.ts`
  `parseShellIntegrationCwd()` parses OSC 633 (OSC 7 kept only as fallback). The script is emitted
  beside `out/main/index.js` by the `copy-shell-integration` plugin in `electron.vite.config.ts`,
  which also adds `shellWorker` as a build input.
- **`setPaneCwd` churn removed** (`store/panes.ts`) — now returns the same object references when
  nothing changed, and `lastPtyCwd` in main de-dupes `pty:cwd`. This kills the per-prompt
  pane-tree re-render that spec 012 flagged as suspect #2. Benefits both paths.
- **VS Code-style resize** (`Terminal/index.tsx`) — `suppressResizeUntil = now + 750ms` after
  subscribe (no resize feedback during the unstable startup window), immediate resize for a small
  buffer (`< 200` lines) or first change, vertical (rows) immediate, horizontal (cols) debounced
  100 ms with a deterministic flush. Replaces the old raw `ResizeObserver -> pty.resize` loop.
- **`pty:create` carries initial size** — the renderer fits and passes `cols/rows`, so the pty
  spawns at the correct geometry and avoids an early reflow that could eat the no-scroll line.

### Why the old path dropped it (kept for posterity)

Short no-scroll output went through: main coalesce (5 ms/256 KiB) + seq/ack + pause/resume →
renderer enqueue + bounded slice-write + per-payload ack → plus a `setPaneCwd` re-render on every
prompt and `windowsPty`/DA1 applied at construction. Somewhere in that stack a single short,
non-scrolling ConPTY emission was lost. The direct path removes every one of those layers for
shell, and it prints reliably. We did **not** isolate the one guilty layer — we removed the whole
stack for shell. That is why the agent path, which still has the stack, is the open risk.

---

## 2. Working vs broken contract — DO NOT re-break

This table is the regression guard. The left column is the shipped, working behavior; the right is
the behavior that drops `Already up to date.`. Any "cleanup" that moves a shell pane toward the
right column re-introduces the bug.

| Concern | WORKING (shell, shipped) | BROKEN (the old/agent stack for shell) |
|---|---|---|
| Main → renderer data | `sendDirectPtyOutput`, **seq = 0**, no coalesce | `enqueuePtyOutput`, 5 ms/256 KiB coalesce, seq > 0 |
| Flow control | none (no pause/resume, no ack) | in-flight byte watermarks + `pty:data-ack` + `pause()` |
| Renderer write | `terminal.write(data)` synchronous | enqueue + 64 KiB slice-write + ack on final slice |
| xterm instance | `xtermRegistry` (deferred open), survives remounts | (was: fresh `open()` + dispose on unmount — removed) |
| `windowsPty` / DA1 | applied **after `pty:ready`** | applied at construction from `window.osRelease` |
| CWD reporting | OSC 633 `;P;Cwd=` shell integration | `-EncodedCommand` OSC 7 prompt wrapper |
| Pane re-render | `setPaneCwd` referentially stable | new pane/tab objects on every prompt |
| Resize | VS Code debouncer + 750 ms startup suppress | raw `ResizeObserver -> pty.resize` |
| Spawn size | real `cols/rows` from fit | fixed 80×24 then resize |

Non-negotiables when touching the terminal stack:

1. Shell output must reach `terminal.write` **synchronously**, not behind a coalesce/ack queue.
2. `windowsPty` and the DA1 responder must be applied **only after** ready metadata, never at
   construction.
3. Do not reintroduce the `-EncodedCommand`/OSC 7 prompt wrapper as the production CWD source.
4. Do not reintroduce the Bare Term / `shellterm:*` / `bareWorker` scaffolding (already removed
   from source; only doc references remain).

---

## 3. Current architecture — one path, two policies

Shell and agent panes share the IPC surface (`pty:*`, `pty:ready`, `pty:cwd`, window routing,
close/transfer) **and** the same host (`PtyManager`), worker (`ptyWorker`), and xterm lifecycle
(`xtermRegistry`). The only difference is the data-flow policy, selected at create time:

```
SHELL pane                                AGENT pane (Claude/Codex)
  pty:create (cols,rows)                    SessionSpawner.createDeferred(agent cmd)
    -> PtyManager.createShell                 -> PtyManager.createDeferred
       (flowControl:false, envProfile shell)     (flowControl:true,  envProfile agent)
    ----------------- one ptyWorker.js (ELECTRON_RUN_AS_NODE) -----------------
                       node-pty -> onData -> send raw
  handlers: ptyManager.on('data')           handlers: ptyManager.on('data')
    isDirect(id) -> sendDirectPtyOutput        !isDirect -> enqueuePtyOutput
                    (seq 0)                                 (coalesce, seq>0, ack, pause)
  renderer: seq===0 -> terminal.write       renderer: enqueueOutput -> slice-write -> ack
  xterm: xtermRegistry cache, survives      xterm: xtermRegistry cache, survives
```

Fully shared: one worker emits ConPTY traits + ready (ready-when-pid); one `on('ready')` /
`on('exit')` / `on('error')` block in `handlers.ts`; OSC 633 parsing; renderer ready-gating +
resize debouncer + stable `setPaneCwd`; the registry xterm lifecycle. The `directIds` set in
`PtyManager` is the single source of truth for which policy a PTY uses; `isDirect(id)` is checked
in the `data`/`exit`/`error` handlers.

Key files:

- `PtyManager.ts` — `directIds`, `createShell` (`flowControl:false`/`envProfile:'shell'`),
  `createDeferred` (options bag), `isDirect()`, `buildEnv(extraVars, profile)`.
- `ptyWorker.ts` — the single worker (ConPTY traits, ready-when-pid).
- `handlers.ts` — unified `on('data'|'ready'|'exit'|'error')` branching on `isDirect`;
  `sendDirectPtyOutput` (seq 0) vs `enqueuePtyOutput` (coalesce/ack); `pty:get-ready`.
- `terminalEnvironment.ts` + `shellIntegration.ps1` — OSC 633 shell integration (used by
  `_shellCmd()`); `.ps1` emitted beside `out/main/index.js` by `electron.vite.config.ts`.
- `Terminal/index.tsx` — `seq===0 → terminal.write` switch; ready-gated windowsPty/DA1; resize
  debouncer. `store/panes.ts` — stable `setPaneCwd`. `xtermRegistry.ts` — deferred `open`.

---

## 4. Gap status (from the former dual-path implementation)

- **G1 — FIXED.** Shell xterm used to `dispose()` on unmount, losing scrollback across tab
  switches / pane moves / layout remounts. Shell panes now go through `xtermRegistry` like agent
  panes (registry defers `open()` until attach), so the instance and its full scrollback survive
  remounts and are disposed only on explicit `closePane`. The shell write path (seq===0 direct
  `terminal.write`) is unchanged.
- **G2 — FIXED.** `handlers.ts` now has a single `on('data')` / `on('ready')` / `on('exit')` /
  `on('error')` block on `ptyManager`, branching on `ptyManager.isDirect(id)` for the data-flow
  policy. The duplicate `shellPtyHost` blocks are gone.
- **G3 — FIXED.** There is one worker (`ptyWorker.ts`). `shellWorker.ts` is deleted;
  `windowsBuildNumber`, conpty flags, and ready/pid handling exist in one place.
- **G4 — FIXED.** `PtyManager.createShell` is the live shell entry point again (it sets
  `flowControl:false` + `envProfile:'shell'`). `ShellPtyHost` is deleted, so nothing competes
  with it.
- **G5 — agent panes still use flow control (by design), but now on the *same* host/worker as
  shell.** Flow control is opt-in (`flowControl:true`, the default for `createDeferred`). If an
  agent ever shows the spec 012 symptom, it can be moved to the direct policy without touching the
  host. Not expected — agent output volume is exactly why flow control exists.

---

## 5. VS Code baseline to follow

Reference local repo: `C:\Users\cdhan\Desktop\vscode`. Key files:

- `src/vs/platform/terminal/node/ptyHostMain.ts` — dedicated pty host process entrypoint.
- `src/vs/platform/terminal/node/terminalProcess.ts` — node-pty spawn, ConPTY flags,
  process-ready metadata, shutdown ordering, resize, data events.
- `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts` — renderer wiring: xterm data,
  process-ready handling, DA1 ConPTY response, `windowsPty` option.
- `src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts` — xterm construction +
  options incl. `windowOptions`.
- `src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts` — resize behavior.
- `src/vs/platform/terminal/node/terminalEnvironment.ts` — shell integration injection args/env.
- `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1` — PowerShell integration
  and CWD reporting model (our `shellIntegration.ps1` is derived from this).

---

## 6. Definition of done — unify onto one path (DONE; verify)

The goal is **one terminal rendering path** that both shell and agent panes use, shaped like VS
Code's, so the working behavior cannot drift apart. End state, now implemented:

1. **One pty-host primitive + one worker — DONE.** `ShellPtyHost`/`shellWorker` deleted; everything
   runs on `PtyManager` + `ptyWorker` (`create/write/resize/kill` + `data/ready/exit/error`,
   ConPTY traits, ready-when-pid). Shell vs agent differ by **policy passed in**
   (`createShell` → `flowControl:false` + `envProfile:'shell'`), not by a parallel stack.
2. **One renderer data path — DONE.** The renderer keeps its single `seq===0 → terminal.write`
   vs `enqueueOutput` switch; main decides which by `ptyManager.isDirect(id)`. Flow control is an
   opt-in policy behind the host (default `flowControl:true` for `createDeferred`), not a separate
   renderer branch. The duplicated handler blocks are gone.
3. **One xterm lifecycle — DONE.** Both pane types use the registry creation/attach/detach model
   and preserve scrollback across remounts (G1 fixed).
4. **Ready-gated ConPTY setup, OSC 633 CWD, VS Code resize debouncer** — shared model for both
   pane types. Keep it that way.
5. **Agent throughput unaffected** — agents still use flow control on the same host; verify
   Codex/Claude start, resume, and heavy-output smoothness in the real app.
6. Bare Term / `shellterm:*` / `ShellPtyHost` / `shellWorker` scaffolding removed; durable
   contract documented in `CLAUDE.md`.

### Remaining work

Real-app verification only (build + typecheck already pass). Run the Test plan below on the Win11
target; if it passes, move this spec to `specs/done/`. The thing most likely to regress in any
future refactor is the **seq===0 direct-write contract** (section 2) — guard it.

---

## 7. Test plan (real app, not harness)

- Fresh normal shell pane, prompt at top of a fresh viewport:
  - `git pull` in an up-to-date repo shows `Already up to date.`
  - `echo hi` shows `hi`
- TUI/interactive: `codex` renders correctly (no mangled wrapping / duplicated input); resize the
  pane before and after launching `codex`.
- Shell: `cd` updates pane cwd/header (via OSC 633); open-folder / split-in-current-dir use the
  correct cwd.
- Agent panes: Claude and Codex start and resume; throughput stays smooth under heavy output.
- Scrollback survival (covers G1): generate long history in a shell pane, switch tabs / move the
  pane / trigger a layout remount, return — history is intact.
- Multi-pane/window: split, move panes, detach/reattach tabs; PTY routing and CWD follow.

## Definition of done

Shell **and** agent panes run on a single VS Code-shaped pty-host + xterm path. Short no-scroll
shell output and full TUI rendering both work; agent throughput and resume are unaffected; shell
scrollback survives remounts; the dual-path duplication (G1–G5) is gone; and `CLAUDE.md` reflects
the unified architecture.
