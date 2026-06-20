# 013 - VS Code-style terminal rebuild

Status: **Working idea found and shipped for shell panes; agent panes not yet aligned.**
Supersedes `specs/done/012-conpty-no-scroll-output-loss.md` as the implementation direction. Spec
012 remains the historical record of why the bug is the *pane code path*, not the environment.

The original symptom is fixed for normal shell panes: `git pull` in an up-to-date repo now prints
`Already up to date.` and `echo hi` at the top of a fresh viewport now prints `hi`. This was
achieved by building a real, VS Code-shaped **direct** path for shell panes instead of grafting
onto the agent pipeline. The remaining work — and the new definition of done — is to **migrate the
agent (Claude/Codex) panes onto the same rendering path** so we do not keep two diverging terminal
stacks that can silently re-break shell output.

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

## 3. Current architecture — two paths exist (the problem)

Shell and agent panes now share the IPC surface (`pty:*`, `pty:ready`, `pty:cwd`, window routing,
close/transfer) but run on **different hosts, workers, data flows, and xterm lifecycles**:

```
SHELL pane                              AGENT pane (Claude/Codex)
  pty:create (cols,rows)                  SessionSpawner.createDeferred(agent cmd)
    -> ShellPtyHost.create                  -> PtyManager.createDeferred
      -> shellWorker.js (ELECTRON_RUN_AS_NODE)  -> ptyWorker.js (ELECTRON_RUN_AS_NODE)
        node-pty -> onData -> send direct        node-pty -> onData -> send raw
  handlers: shellPtyHost.on('data')        handlers: ptyManager.on('data')
    -> sendDirectPtyOutput (seq 0)            -> enqueuePtyOutput (coalesce, seq>0, ack, pause)
  renderer: seq===0 -> terminal.write       renderer: enqueueOutput -> slice-write -> ack
  xterm: xtermRegistry cache, survives      xterm: xtermRegistry cache, survives  (unified)
```

Shared/aligned already: both workers emit ConPTY traits + ready; both `*.on('ready')` blocks in
`handlers.ts` send `pty:ready` + `pty:cwd`; both parse OSC 633; renderer ready-gating + resize
debouncer + stable `setPaneCwd` apply to both. So the agent path has *received* the VS Code-shaped
ready/resize/cwd improvements — it just still carries the coalesce/ack data stack and the registry
xterm lifecycle.

File map of the change set (current branch, untracked + modified):

- New: `ShellPtyHost.ts`, `shellWorker.ts`, `terminalEnvironment.ts`, `shellIntegration.ps1`.
- Modified main: `handlers.ts` (dual data/ready/exit handlers, `parseShellIntegrationCwd`,
  `sendDirectPtyOutput`, `pty:get-ready`, size-aware `pty:create`), `PtyManager.ts` (ready event
  with pid/cwd/traits, `getReadyEvent`, `_shellCmd` switched to `shellIntegrationCommand`),
  `ptyWorker.ts` (conpty traits, ready-when-pid), `electron.vite.config.ts` (emit script +
  `shellWorker` input), `shared/types.ts` (`PtyReadyMetadata`, `pty:ready`, `pty:get-ready`,
  size args).
- Modified renderer: `Terminal/index.tsx` (seq===0 direct write, direct-vs-registry xterm,
  ready-gated windowsPty/DA1, resize rewrite), `store/panes.ts` (stable `setPaneCwd`),
  `xtermRegistry.ts` (deferred `open` via `opened` flag).
- `App.tsx` and `PaneGrid/PaneContainer.tsx` show as modified but are **line-ending only** (no
  content diff) — leave them or normalize EOL, do not treat as logic changes.

---

## 4. Known gaps / risks introduced by the dual path

- **G1 — FIXED.** Shell xterm used to `dispose()` on unmount, losing scrollback across tab
  switches / pane moves / layout remounts. Shell panes now go through `xtermRegistry` like agent
  panes (registry defers `open()` until attach), so the instance and its full scrollback survive
  remounts and are disposed only on explicit `closePane`. The shell write path (seq===0 direct
  `terminal.write`) is unchanged.
- **G2 — duplicated handler blocks.** `handlers.ts` has near-identical `on('data')`,
  `on('ready')`, and `on('exit')` blocks for `ptyManager` and `shellPtyHost`. Easy to fix one and
  forget the other. Unify behind one host interface.
- **G3 — duplicated worker logic.** `windowsBuildNumber`, conpty flags, ready/pid handling, and
  the spawn/queue scaffolding are copy-pasted across `ptyWorker.ts` and `shellWorker.ts`.
- **G4 — dead `PtyManager.createShell`.** Shell panes go through `ShellPtyHost`; `createShell` /
  `_shellCmd` are now unused for production shell panes (agents use `createDeferred`). Remove or
  fold in once the host is unified, so future readers don't wire shell panes back through it.
- **G5 — agent panes still on the suspect stack.** They have not been proven against the spec 012
  symptom. Low-volume agent output at the top of a fresh viewport could in principle drop the same
  way. The migration is what closes this.

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

## 6. New definition of done — fully migrate and align onto the working path

The goal is no longer "make shell work" (done) — it is **one terminal rendering path** that both
shell and agent panes use, shaped like VS Code's, so the working behavior cannot drift apart.

Target end state:

1. **One pty-host primitive + one worker.** Collapse `ShellPtyHost`/`shellWorker` and
   `PtyManager`/`ptyWorker` into a single host contract (`create/write/resize/kill` +
   `data/ready/exit/error`, ConPTY traits, ready-when-pid) with one worker implementation.
   Shell vs agent differ by **policy passed in**, not by a parallel stack. Resolve G3, G4.
2. **One renderer data path.** Default everything to the synchronous direct write
   (the seq===0 behavior). If flow control is still required for high-volume agent output, it
   must be an **opt-in policy behind the host contract** and proven to leave shell output
   untouched — not a separate renderer branch. Remove the duplicated handler blocks (G2).
3. **One xterm lifecycle.** Done — both pane types share the registry creation/attach/detach
   model and preserve scrollback across remounts (G1 fixed). Keep it unified as the host work
   lands.
4. **Ready-gated ConPTY setup, OSC 633 CWD, VS Code resize debouncer** remain the shared model for
   both pane types (already true; keep it that way).
5. **Agent throughput unaffected.** Codex/Claude output stays smooth; resume/start still work; no
   flicker regressions from the Codex TUI flags.
6. Bare Term / `shellterm:*` scaffolding stays removed; durable lessons live in `CLAUDE.md`
   (already updated for the dual-path reality — update again when paths unify).

### Migration plan

1. Define the unified host interface and move `ptyWorker`/`shellWorker` onto one worker with a
   `flowControl: boolean` (or similar) spawn option. Keep shell = no flow control.
2. Unify the `handlers.ts` data/ready/exit handlers onto the single host; keep the seq===0 direct
   write as the default and gate coalesce/ack on the policy flag.
3. Xterm lifecycle already unified (both pane types on the registry, G1 fixed); just keep it that
   way as the host/worker collapse lands.
4. Delete dead `PtyManager.createShell`/`_shellCmd` shell branch once nothing routes through it.
5. Re-verify the full test plan with both pane types before removing any old code.

Migrate incrementally and re-run the test plan after **each** step — the seq===0 direct-write
contract (section 2) is the thing most likely to be lost in a refactor.

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
