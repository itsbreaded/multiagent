# 012 — Short, no-scroll command output dropped in shell panes

Status: **Unsolved, but strongly localized.** A working reference path now exists *inside the
app*. This document is a complete handoff — read it fully before experimenting; it already
records ~50 experiments so they aren't repeated.

> ⚠️ This spec was rewritten after a major reversal. An earlier version concluded the root
> cause was "ConPTY running under the Electron/Chromium process tree." **That conclusion is
> wrong** — see "Reversal" below. Disregard any older notes claiming the environment is the
> cause.

## Symptom

In a normal **shell pane**, short single-line output that does **not** cause the viewport to
scroll is silently dropped. Canonical case: `git pull` in an up-to-date repo shows nothing
instead of `Already up to date.`. `echo hi` near the top of a fresh viewport also drops.
Multi-line output (`ls`, `git status`) and anything that scrolls always shows (a scroll forces
ConPTY to emit). Reproduces deterministically when the prompt is high in the viewport (no
scroll); "fills up then works" because later output scrolls. Present since the **first commit**.
Target machine: low-powered Windows 11.

## The key result: a barebones path works *inside the app*

We built a second, deliberately un-plumbed terminal path in the real app ("Bare Term" button,
bottom-right). It runs node-pty in a dedicated `ELECTRON_RUN_AS_NODE` worker child and relays
output **straight** to a minimal xterm — no coalescing, no seq/ack flow-control, no `pause()`,
no slice-write, no `setPaneCwd` re-render. **It works**: `git pull` prints `Already up to date.`

Crucially it still works even after we made its xterm match the normal pane's config exactly
(`scrollback: 250000`, `scrollOnEraseInDisplay: true`, `allowProposedApi: true`, `lineHeight`,
**and** the WebGL renderer). So:

- It is **NOT** the environment / Chromium process tree (the Bare Term runs in the same app,
  same process tree, same worker architecture, same ConPTY — and works).
- It is **NOT** node-pty, conpty.dll, the prompt wrapper, the spawn config, the env, or any
  xterm option.

**Therefore the bug lives entirely in the normal pane's code path** — the difference between
`Terminal` + `PtyManager`/`handlers` pipeline (drops) and `BareTerminal` + `bareTerminal`/
`bareWorker` (works).

### Reversal (why the old "Chromium tree" conclusion was wrong)

The old conclusion came from a **standalone harness** (`experiments/barebones-terminal/` driven
in fan-out/loop mode) that dropped output under a full Electron main. That harness was **not
faithful** — it measured a git-pull loop into a buffer with no real interactive xterm. The
faithful test is the in-app Bare Term, which does **not** drop. So treat all harness-only
results below as weak/superseded; trust in-app results.

## Ruled out

Strong (tested in the real app or via the faithful in-app Bare Term):
- **In-app barebones path works** (the whole point above).
- **All xterm options** — scrollback 250000, `scrollOnEraseInDisplay`, `allowProposedApi`,
  lineHeight, WebGL renderer: Bare Term still delivers with all of them.
- **Bypassing main's coalescing + seq/ack flow-control + `pause()`** (direct `pty:data` send to
  the *normal* `Terminal` renderer): normal pane **still dropped** → points at the renderer, or
  at something other than the main batching layer.
- **node-pty version** (1.1.0 and 1.2.0-beta.13), **conpty.dll** (system vs bundled v1.23/v1.25),
  **the OSC-7 prompt wrapper** (bare `powershell -NoLogo -NoExit` also dropped in the full app),
  **spawn size / 80×24-then-resize**, **`TERM_PROGRAM=vscode`**, **`name`/TERM value**, **full
  buildEnv** — all delivered in Bare Term / didn't change the normal pane.

Weaker (tested only in the unfaithful standalone harness; likely irrelevant since the bug is the
pane code path, not the environment — re-test via Bare Term only if a hypothesis points back to
the environment): process priority, `detached`/job-group, Windows timer resolution, Windows 11
EcoQoS/power-throttling, non-Chromium intermediate parent, renderer CPU (idle vs busy).

Other note: **node-pty in the Electron *main* process produces no output** for the bare path
(input reaches it, nothing renders) — that's why Bare Term uses a worker child. Consistent with
why the app isolates node-pty in a worker at all.

## Remaining suspects (the diff between normal pane and Bare Term)

Loss is NOT in: env, conpty, worker, spawn, xterm options. So it is one of these app-specific
layers (in rough priority — the main batching layer was already bypassed without a fix, so lead
with the renderer):

1. **Renderer `Terminal` data handling** (`src/renderer/src/components/Terminal/index.tsx`):
   - dual `pty:data` subscription + `pendingOutputRef` + `listenPtyIdRef` handoff
   - slice-write in 64 KiB chunks + **per-payload seq/ack** (`pty:data-ack`)
2. **`setPaneCwd` on every OSC-7 prompt** → new pane object → React re-render of the pane tree
   on *every command*. Bare Term does none of this. Prime suspect for a per-prompt disruption.
3. **Resize behavior** — `ResizeObserver`, column-debounce `queueResize`, fit-on-connect; any
   `pty:resize` that reaches ConPTY around the output could reflow and drop the no-scroll line.
   (`resize` + `pause` are the only renderer→ConPTY feedback paths.)
4. **`xtermRegistry` lifecycle** — xterm is created in a registry, opened into a *detached*
   wrapper, then attached to the container; survives remounts. Bare Term opens directly.
5. **main pipeline** (`handlers.ts`: 5 ms coalesce + flow-control + `pause`) — bypass didn't fix
   it, but re-confirm in combination with the renderer.

## Next steps (do these in order)

1. **Bisect with Bare Term as the known-good baseline.** Add ONE normal-pane layer at a time to
   the bare path until it breaks; the breaking layer is the culprit. Suggested order: (a) route
   bare data through the renderer slice-write+seq/ack; (b) add `setPaneCwd`-style re-render on
   OSC-7; (c) add the `Terminal` resize logic; (d) route bare data through main's
   `enqueuePtyOutput` coalesce/flow-control. Each is a small, reversible change.
   - Equivalent reverse approach: strip the real `Terminal`/pane path toward bare in a normal
     shell pane and test `git pull` after each removal.
2. **Pragmatic fix (may be faster than full root-cause):** route **shell** panes through the
   proven bare path (`bareWorker` + direct relay + minimal write), keeping **agent** panes
   (Claude/Codex) on the existing `Terminal` path. If shell panes then behave, ship that and
   leave root-cause for later. Watch: scrollback persistence, multi-window/pane-move routing,
   CWD tracking (OSC-7), focus, and packaging (bareWorker must be a build entry — it already is).

## How to reproduce / test

- `npm run dev`. Open a normal shell pane, `cd` into an up-to-date repo, `git pull` as the
  **first command** (prompt at top, no scroll) → drops. Click **Bare Term** (bottom-right),
  `cd` + `git pull` → works. That side-by-side in the same app is the whole test rig.
- To check where a chunk is lost, add a **deferred** (`setImmediate`, non-blocking) log inside
  the worker's `onData` — a *synchronous* `stderr.write` per chunk itself perturbs timing.
- Note: in the in-app bare path, beware **React StrictMode** double-mount: effect cleanup must
  NOT kill the pty/worker (only kill on explicit Close), or you'll see "input queued, no pty."
  (Already handled in `bareTerminal.ts`/`BareTerminal`.)

## Current scaffolding (branch `experimental/barebones-terminal`)

Experiment/diagnostic code to KEEP while investigating, REMOVE once fixed:
- `src/main/pty/bareWorker.ts` — minimal node-pty worker (electron-as-node child); queues
  input/resize until the pty spawns; emits `{t:'data'|'ready'|'exit'|'error'|'debug'}`.
- `src/main/pty/bareTerminal.ts` — main-side relay on `bareterm:*` IPC; worker lifecycle;
  kills the worker only on explicit Close (not effect cleanup); debug forwarding.
- `src/renderer/src/components/BareTerminal/index.tsx` — minimal xterm overlay; has
  `MATCH_NORMAL_XTERM` / `MATCH_NORMAL_WEBGL` bisect toggles (currently both `true`, and it
  still works) plus an on-screen debug log + "Send test" button.
- `electron.vite.config.ts` — `bareWorker` build entry (→ `out/main/bareWorker.js`).
- `src/shared/types.ts` — channels: `bareterm:create|input|resize|kill` (send),
  `bareterm:data|exit|debug` (event).
- `src/renderer/src/App.tsx` — "Bare Term" button + overlay.
- `src/main/ipc/handlers.ts` — calls `registerBareTerminal(mainWindow)`; the normal
  `ptyManager.on('data')` handler is on the REAL path (the earlier direct-send bypass was
  reverted).
- `experiments/barebones-terminal/` — the original standalone experiment (main.js, worker.js,
  index.html) with toggles `USE_WORKER/USE_WRAPPER/SPAWN_SMALL/USE_TERMPROGRAM/USE_REALNAME/
  USE_FULLENV/TICKLE`. Useful but **unfaithful** (see Reversal) — prefer in-app Bare Term.

`master` is clean (these changes live only on the branch). When done, delete the scaffolding and
fold the durable lesson into `CLAUDE.md`.

## Definition of done

`git pull` (and any short no-scroll output) reliably appears in a **normal shell pane** at the
top of a fresh viewport — no flicker, no full-screen redraw — on the Win11 target machine, with
agent (Claude/Codex) panes still working. Verify in the real app, not just a harness.
