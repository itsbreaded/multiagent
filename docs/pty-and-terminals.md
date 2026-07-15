# PTY & Terminals (mechanism)

The why/how behind the terminal stack. The one-line guardrails live in `CLAUDE.md`;
this is the detail an agent needs when actually touching PTY, shell integration, resize,
or agent launch.

---

## PTY isolation

`node-pty` runs in a child process (`src/main/pty/ptyWorker.ts`) spawned with
`ELECTRON_RUN_AS_NODE=1`. This prevents Chromium's IPC handles from being inherited into
ConPTY, which would crash Claude (a Bun binary). `PtyManager` communicates with the worker
over Node IPC (`process.send`/`process.on('message')`).

The terminal stack follows VS Code's integrated-terminal shape, and **shell and agent panes
share one pty host and one worker** (`PtyManager` + `ptyWorker.ts`). `PtyManager` is the single
pty-host contract for create/input/resize/kill/data/exit/ready/error. The worker's ready event
carries pid, initial cwd, and Windows ConPTY traits. The renderer must apply xterm
`windowsPty` and the DA1 `\x1b[?61;4c` response only after `pty:ready`, not at xterm
construction time. Shell vs agent differ by launch command, cwd fallback policy, and
agent-specific env supplied by `SessionSpawner`, not by a generic Claude-tuned PTY environment.

## Output relay — no flow control

Both shell and agent panes relay PTY output directly (`sendDirectPtyOutput`, `seq=0`,
synchronous `terminal.write` in the renderer). There is **no** coalesce/ack/pause flow
control. The only buffering left is `pendingDirectOutput` in `handlers.ts`, used solely to
hold output while a pty briefly has no routable window (e.g. mid cross-window move); it
flushes via `flushDirectOutput` on (re)route.

Main relays each `node-pty` data chunk straight to the renderer as a `pty:data` payload with
`seq=0`; the renderer writes it to xterm synchronously (`terminal.write(data)`). There is no
coalescing, no `pty:data-ack`, no `pause`/`resume`, and no byte watermarks — those were removed
because they were unnecessary (node-pty + xterm absorb the volume; heavy interactive
PowerShell sessions run fine without them). The `pty:data` channel still carries
`seq`/`byteLength` args for shape compatibility, but the renderer ignores them. Terminal
resize is one-way `window.ipc.send('pty:resize', ...)`, not `invoke`. If you ever need
backpressure for a pathological flood, add it as opt-in for agents only — and read the
PATH-rewrite root cause below first, because the original "no-scroll drop" was *not* output
volume.

### No PATH rewrite (root cause of the old dropped-output bug)

`buildEnv` (`src/main/pty/buildEnv.ts`) used to prepend `%APPDATA%\npm`,
`%ProgramFiles%\nodejs`, and `~/.local/bin` to PATH — dirs already on the inherited PATH, so
the prepend only *reordered* it, shifting `git`'s startup timing into ConPTY's no-scroll flush
race and dropping short output like `git pull -> Already up to date.`. The dropped-output root
cause was this PATH rewrite, not the pty worker or output volume. Shells and agents share one
worker fine once the rewrite is gone (the deleted `ShellPtyHost`/`shellWorker` were
unnecessary). `buildEnv` is extracted pure so it can be tested; `buildEnv.test.ts` asserts
`env.PATH === process.env.PATH` (the strong, non-vacuous equality form) and that inherited
Claude renderer flags + `MULTIAGENT_*` vars are scrubbed. See `docs/testing.md`.

## Shell integration (CWD reporting)

### Windows

Shell panes spawn `powershell.exe` with `src/main/pty/shellIntegration.ps1` (via
`terminalEnvironment.ts`/`_shellCmd`), emitted beside `out/main/index.js` by
`electron.vite.config.ts`. The script uses VS Code-style OSC 633 (`OSC 633;P;Cwd=...`) for CWD
reporting; main parses it in `handlers.ts` and sends `pty:cwd`. OSC 7 parsing remains only as
compatibility fallback. Do not reintroduce ad hoc prompt wrapping or the removed
`shellterm:*`/Bare Term scaffolding as a production terminal path.

**asar caveat:** the `.ps1` lives inside `app.asar` when packaged and PowerShell (a separate
process) cannot read it, so `shellIntegrationCommand` sources a copy materialized to
`<userData>` by `ensureShellIntegrationScript('shellIntegration.ps1')` (idempotent on
content), falling back to the bundled candidates in dev. Do not revert to sourcing the raw
asar path — packaged Windows CWD tracking silently breaks.

### Unix

Shell panes launch via `unixShellLaunch` (`terminalEnvironment.ts`): bash with `--init-file`,
zsh with a generated `ZDOTDIR` (zsh has no `--init-file`; a tiny `.zshrc` there re-sources
`~/.zshrc` then our script). `src/main/pty/shellIntegration.sh` (bash + zsh in one file)
installs a `PROMPT_COMMAND`/`precmd` hook that emits `OSC 633;D` + `OSC 633;P;Cwd=<byte-escaped>`
+ `OSC 7;file://<path>` before each prompt. The same **asar caveat** applies:
`ensureShellIntegrationScript('shellIntegration.sh')` copies the bundled script to a real file
under `<userData>` and the shell sources that (the same pattern the managed-hook scripts use).
macOS' default shell is zsh, so bash-only is not enough. `_shellCmd()` returns `{ cmd, env? }`
(the ZDOTDIR rides as `createDeferred`'s `extraEnv`).

## Cross-platform process snapshot (CLI-agent promotion/demotion)

`snapshotProcesses()` (`src/main/pty/processSnapshot.ts`) is the single platform seam feeding
the pure `selectForegroundAgent` selector (`src/main/pty/agentProcessDetect.ts`). Windows
shells out to `Get-CimInstance Win32_Process`; macOS shells out to
`ps -Ax -o pid=,ppid=,comm=,command=`; Linux reads `/proc/<pid>/{stat,cmdline}` directly
(null-delimited argv). All three export pure parsers (`toEntries`/`parsePsDarwin`/
`parseProcStat`/`parseProcCmdline`) for platform-pinned unit tests. Every platform fails closed
(any error → `[]` → no pane transition). One mechanism per platform behind the seam; do not
add a per-platform scanner "fallback" for the missing platform.

The `AgentProcessSweeper` (`src/main/pty/agentProcessSweeper.ts`) is one app-global poller
constructed in `registerIpcHandlers`. It tracks **only shell panes** — `trackShell` is called
from the `pty:create` handler; `SessionSpawner` agent panes are never tracked. It subscribes
to `PtyManager`'s `ready` (records the shell pid) and `exit` (untracks). Each tick (only while
≥1 shell pane is tracked) snapshots the process table once and identifies a foreground
`claude`/`codex` (direct name, `node`/`cmd`/`powershell` wrapper + npm package paths, ignoring
`-e`/`-c` eval payloads) with herdr-style disambiguation (zero / multiple distinct agents /
sibling chains → stay shell). Two consecutive identical observations are required before
emitting `pane:agent-detected(ptyId, AgentKind | null)` (worst-case ≤ ~6 s), so a transient
`claude --version` does not flap the pane kind. Delivery is cross-window via
`windowManager.sendToWindowForPty`. When the agent exits, the pane demotes back to a shell
(scrollback and the still-running shell prompt intact).

The renderer's `pane:agent-detected` listener (`panesIpc.ts`) calls
`promoteShellPaneToAgent` / `demoteAgentPaneToShell` — **pure metadata, atomic and tab-scoped**
(no `ptyId` change, no pty kill, no xterm clear). Only panes carrying the in-memory
`promotedFromShell` flag demote; native (app-spawned) agent panes never demote.
`promotedFromShell` is **never serialized** — `normalizeTabsForLayout`
(`src/main/ipc/layoutStore.ts`) strips it and reverts a phase-1-only promotion (agent, no
`sessionId`) to `shell`, so a promotion with no linked session does not survive restart. A
promotion with a linked `sessionId` persists as an agent pane and resumes on restart
(intended behavior change: a shell pane that hosted a CLI agent resumes as that agent after
restart). Session-id linking is hook-based — see `docs/session-linking-hooks.md`.

## Resize

Renderer resize uses the VS Code principle: immediate resize for first/small-buffer
changes, vertical updates immediately once established, and horizontal reflow debounced with
a deterministic flush. Avoid raw `ResizeObserver -> pty.resize` loops.

Agent PTYs must spawn at the fitted pane size, not at 80x24 followed by a corrective resize.
Claude's classic renderer leaks a redraw into scrollback on every resize, so an avoidable
startup resize causes duplicated banners/logos. `SessionSpawner.spawnNew` and `spawnResume`
pass `deferSpawn: true`; `PtyManager.createDeferred` then waits for the renderer's first
`pty:resize` (with a short timeout fallback) before sending the worker `spawn` message. Keep
this non-interactive one-shot size handshake for agent launches.

## Agent launch shape

`createShell` uses `_shellCmd()` for the interactive prompt/CWD wrapper. Agent panes must not
start an interactive shell and then wait for a prompt before typing `codex`/`claude`;
`SessionSpawner` launches the agent command immediately through a non-profile shell command.
Keep this direct launch path so restored Codex panes do not pay the old 10s prompt-detection
fallback.

Claude panes should launch like a normal terminal command. Do not set `CLAUDECODE`,
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_DISABLE_MOUSE`,
`CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL`, or `CLAUDE_CODE_NO_FLICKER` in the generic PTY env or
default Claude launch env; `buildEnv()` also scrubs inherited copies of those flags from the
app process environment. Those nonstandard flags caused app-created Claude sessions to lose
input after `/tui fullscreen`, while launching Claude manually from a shell pane worked. The
only default Claude-specific terminal env is `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`;
provider/model/auth overrides belong in `SessionSpawner.agentEnv('claude')`. Let the user's
Claude `tui` setting and `/tui` command control classic vs fullscreen rendering unless a future
setting deliberately maps to process-scoped env.

Codex panes pass `--no-alt-screen`, `-c tui.animations=false`, and `-c tui.terminal_title=[]`
to reduce cursor redraw/flicker in xterm panes. `tui.terminal_title=[]` suppresses OSC title
sequences that serve no purpose in an embedded pane. Keep these flags unless verified against
current Codex behavior.

### cwd fallback

Agent panes must not fall back to `os.homedir()` when their saved cwd is missing.
`SessionSpawner` validates agent cwd before launch and `PtyManager.createDeferred` only allows
cwd fallback for shell panes. Missing-cwd agent resumes should reject and leave a visible
`resumeError`/recovery placeholder so the directory can be repaired rather than silently
spawning in the wrong project.

## Terminal renderer selection

Lives in `src/renderer/src/terminal/rendering/`. The `resolveBackend(pref, caps)` function is
the single decision point: `auto` picks WebGL only when `caps.webgl && !caps.softwareRendering`,
`off` is always DOM, `on` is WebGL when available. Software-rendered WebGL (SwiftShader / WARP /
llvmpipe) was the documented CPU-spike trap (50–60% on a keypress) and is now auto-detected by
probing `UNMASKED_RENDERER_WEBGL` on a throwaway canvas — the `auto` setting avoids it. The
master `optimizedTerminalRenderer` flag reverts to the legacy unconditional-WebGL try/catch
path when false. The per-renderer-process `webglDemoted` latch in `backends.ts` prevents
context-loss/reattach thrash: once a WebGL context is lost in a renderer process, all
subsequent panes in that process use DOM. Do not add flow control or ack/seq/pause to the
renderer pipeline.

## Terminal scrollback

Defaults to `250_000` lines because panes host long-running Codex/Claude chats and users need
access to full visible history. Users can adjust this in Settings → Terminal; the value is
persisted in `useSettingsStore.terminalScrollbackLines` and applied to both new and existing
xterm instances through `xtermRegistry.setScrollbackLines()`. Lowering the value can trim
existing scrollback, so do not silently lower the default as a performance fix.