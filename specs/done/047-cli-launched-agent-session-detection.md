# 047 — Detect agents launched manually inside a shell pane

> **Status:** Phases 1–3 implemented (2026-07-14). **Phase 4 (unified hook-based session
> detection) is designed but NOT implemented — it is the handoff for the next developer.**
> Phase 4 supersedes Phase 2 (removes file-poll linking) and extends Phase 3 (adds Codex).
>
> **Implementation notes (read alongside the design below):**
> - **Phase 1** ships as designed: `src/main/pty/agentProcessDetect.ts` (pure selector),
>   `src/main/pty/processSnapshot.ts` (process-table snapshot), `src/main/pty/
>   agentProcessSweeper.ts` (app-global poller), the `pane:agent-detected` IPC, and
>   `promoteShellPaneToAgent` / `demoteAgentPaneToShell` store actions with the in-memory
>   `promotedFromShell` flag + the persistence rule (`normalizeTabsForLayout` strips it).
>   **Phase 1 STAYS under Phase 4** — process-tree promotion/demotion is still how a
>   CLI-launched agent is identified and how demotion-on-exit works; hooks only capture
>   the session id.
> - **Process-tree approach:** the plan's preferred `@vscode/windows-process-tree` native
>   addon was **not** used — it builds from source on every install and requires Visual
>   Studio Build Tools (not present on this machine or the release machine), and its only
>   advantage (cwd/creationTime) was not used by the plan. The Windows implementation
>   shells out to `Get-CimInstance Win32_Process` instead; the pure selector is the
>   platform seam a future Linux/macOS `/proc`/`ps` implementation slots in behind.
>   `snapshotProcesses()` is the single interface.
> - **The "live status dot / Agents dock" deliverable is dropped.** The spec-045/048
>   status engine was rolled back and does not exist in the tree (verified). Promotion is
>   surfaced via the pane/tab label recompute and (once linked) the session list +
>   resume-on-restart. Rebuilding a status engine is a separate effort.
> - **Phase 2 ships but is SUPERSEDED by Phase 4 (to be removed).** Today:
>   `src/main/sessions/promotedSessionLinker.ts` drives Codex via
>   `SessionSpawner.registerPromotedCodex` (generalized scanner) and Claude via a one-shot
>   baseline-new-transcript poll (`src/main/sessions/claudeCliLink.ts`). Both emit the
>   existing `session:detected`; the listener promotes a still-shell pane if the report
>   raced ahead of the sweeper. **Phase 4 replaces both with managed hooks and deletes
>   `codexDetection.ts`, `claudeCliLink.ts`, and the SessionSpawner Codex poll machinery.**
> - **Phase 3 ships Claude-only and is EXTENDED by Phase 4 (adds Codex).** The managed
>   Claude hook is installed into **`~/.claude/settings.json`** — the user-scope settings
>   file Claude Code actually reads hooks from. **The design below says `~/.claude.json`;
>   that is wrong for current Claude Code** (it does not read hooks from `~/.claude.json`),
>   so the implementation targets `settings.json` instead, and `managedHookController`
>   cleans up any stray hook a prior version left in `~/.claude.json`. The pure surgery is
>   `src/main/integration/managedHooks.ts`; the IO wrapper is `managedHookController.ts`
>   (`.bak` + atomic + no-op-skip + legacy cleanup); the standalone PowerShell hook script
>   is `src/main/integration/assets/multiagent-agent-state.ps1`; the localhost report
>   server is `src/main/integration/agentSessionReportServer.ts`. Pane identity uses
>   `MULTIAGENT_PTY_ID` (main knows the ptyId at creation — no pane-id threading needed),
>   set via `PtyManager`'s `getPaneEnv` option and scrubbed by `buildEnv`. Toggle today:
>   Settings → Terminal → "Enhanced session detection (CLI-launched agents)" (opt-in,
>   off by default). **Phase 4 changes the toggle's role — see Phase 4.**
> - **Phase 4 (NOT implemented; handoff).** Codex DOES have a SessionStart hook (verified
>   against the Codex docs + herdr's `install_codex`): same stdin payload (`session_id` +
>   `transcript_path`), configured in **`~/.codex/hooks.json`** (JSON — reuses the same
>   pure surgery) plus a `[features] hooks = true` flag in `~/.codex/config.toml`. The
>   directive: **all session-id capture moves to hooks except app-launched Claude** (which
>   keeps `--session-id <GUID>`). herdr was checked (`C:\Users\cdhan\Desktop\herdr`): it
>   installs the Codex hook the same way and does **nothing** about the Codex trust gate —
>   the user must trust via `/hooks` once (herdr accepts this; so do we). Full design,
>   decisions, and open questions in the Phase 4 section below.
> - Tests: `agentProcessDetect`, `processSnapshot`, `agentProcessSweeper`,
>   `promotedSessionLinker`, `claudeCliLink`, `managedHooks`, `managedHookController`,
>   `agentSessionReportServer`, plus store/layout/buildEnv tests. 483 unit tests green;
>   typecheck green; e2e smoke 14/15 (the one failure, "closing a detached shell tab from
>   the primary sidebar kills its process", fails identically on master — pre-existing,
>   not a regression).
>
> Scope: when a user opens a shell pane and types `claude` or `codex` directly (instead
> of spawning an agent pane through our UI), the running agent is not linked to the pane.
> This spec closes that gap by adapting two techniques observed in the `herdr` repo
> (`C:\Users\cdhan\Desktop\herdr`, a Rust terminal agent multiplexer — read-only reference,
> AGPL-3.0). **Do not vendor any herdr code.** Reimplement the techniques in
> MultiAgent's own words and idioms. herdr is consulted for technique only; no source or
> rule text is copied.

## Corrections to the record (read this first)

This spec has **no dependency on spec 048** (agent state detection and display) or on any
"spec 045." Both names have been used in prose elsewhere to describe a live per-pane status
engine — neither currently exists in this codebase:

- "Spec 045" never existed as real code; no spec file, no implementation, ever.
- Spec 048 was implemented at one point (a rule-engine + OSC + hysteresis status-detection
  module under `src/renderer/src/terminal/status/`, an `agentStatus` store slice, a status
  dot in `PaneHeader`/sidebar `PaneRow`) and was subsequently **rolled back** — its spec
  file was deleted and its code reverted. There is currently no status-detection code
  anywhere in this tree.

Two things follow, and both matter for anyone picking this spec up:

1. **There is no "Agents dock" and there never was.** Every mention below of an "Agents
   dock" / `Sidebar/AgentsDock.tsx` / `SidebarDock.tsx` refers to a component that was
   never built by any spec, ever. There is no dedicated dock surface in this codebase for
   agent panes; the only per-pane sidebar surface is `PaneRow` inside
   `src/renderer/src/components/Sidebar/TabSections.tsx`. Read every "Agents dock" mention
   in this document as informal shorthand for "wherever live per-pane status might someday
   be surfaced in the sidebar" — currently nothing.
2. **Phase 1's "live status dot" deliverable has no foundation to attach to.** This spec's
   phase 1 assumes a status-tick effect and an `agentStatus` store slice already exist to
   hook promotion/demotion into (see the "critical wiring detail" section below, written
   against 048 while it was live). None of that exists now. Phase 1's *other* work —
   process-tree agent identification, the pure selector, `promoteShellPaneToAgent`/
   `demoteAgentPaneToShell` metadata actions, the `promotedFromShell` flag, persistence
   rules — has no dependency on a status engine and can be implemented entirely on its
   own. If phase 1 is picked up, scope its definition of done down to "pane
   promotes/demotes correctly and links a session (phase 2)" and drop the "live status dot
   appears" claim, or build a status-tick foundation as part of this spec if one is wanted
   — do not assume 048's shape is what that foundation should look like; it was never
   validated against real CLI output before being rolled back (see 046's equivalent
   correction for why).

A future agent re-deriving this spec's citations should verify every file/line reference
against what actually exists in the tree at the time — do not trust any citation below,
including the ones added by this correction, without checking first.

## Problem

Today an agent is only "known" to a pane when we spawn it ourselves:

- `SessionSpawner.spawnNew` / `spawnResume` set `agentKind` on the pane up front, pass
  `claude --session-id <uuid>` for Claude, and run the Codex cwd/time-constrained rollout
  scanner (`codexDetection.ts`) to claim a Codex session.
- `agentKind` is the gate for everything downstream: spec 045's status engine
  (`src/renderer/src/terminal/status/index.ts` `detectFromRegions` returns `unknown` when
  the kind has no rule set), the Agents dock (`Sidebar/AgentsDock.tsx`), the status dot
  (`PaneHeader`), and startup resume (`hydrateTabRuntime` → `session:resume`).

A shell pane (`paneType: 'shell'`, no `agentKind`) that the user runs `claude` or `codex`
inside gets **none** of this:

- No live status (the dot stays absent / not-an-agent).
- Not listed in the Agents dock.
- No `sessionId` on the pane, so closing/reopening does not resume that session from the
  pane — the user is back to a bare shell.
- The session is not surfaced as a *live* agent anywhere, even though the CLI is actively
  running in that pane.

**Important nuance — the gap is pane linkage, not global indexing.** `TranscriptScanner`
polls `~/.claude/projects/**/*.jsonl` and `CodexSessionScanner` polls `~/.codex/sessions/`
every 5 s, so a CLI-launched session **is** indexed and **does** appear in the Session
Browser (`Ctrl+Shift+O`) and the sidebar Recent section once the transcript is written. The
missing piece is connecting that running process — and eventually its session id — back to
the pane it is running in, so the pane behaves like an agent pane for status, dock, and
resume. Keep this distinction central: we are not trying to "discover" sessions that the
scanner already finds; we are trying to *promote* the hosting shell pane.

herdr has solved this for any launch method. We need to check how, and adapt it within our
constraints.

## Current behavior (precise)

- `agentKind` is assigned only in the spawn paths (`runNewAgentSession`, `resumeIntoPane`,
  `splitPane`/`spawnInTab` in `src/renderer/src/store/panes.ts`; `SessionSpawner` on main).
  A shell pane never gains `agentKind` after creation.
- Spec 045 status detection runs per-pane only when `agentKind` is set
  (`src/renderer/src/terminal/status/index.ts`; the per-pane tick is wired in `panes.ts`
  for agent panes). Shell panes are not ticked.
- `SessionSpawner.notePtyWrite` + the Codex pending-detection map are wired only to panes
  we spawned as agents. A CLI-launched Codex in a shell pane never enters that map.
- `PtyManager` emits `ready` with the PTY shell `pid` (`src/main/pty/PtyManager.ts`), and
  that pid is the root we would need for process-tree inspection. The pid is currently used
  for resize/exit routing, not for process inspection.
- The 5 s transcript poll indexes CLI-launched sessions globally regardless of pane type.

## Intended behavior

1. When an agent CLI (`claude` or `codex`, including `node …/claude.js`, `cmd /c
   codex.cmd`, PowerShell wrappers, npm-package-path invocations) becomes the foreground
   process in a shell pane, the pane is **promoted** to an agent pane for status and dock
   purposes: it gets `agentKind`, the spec 045 status engine ticks it, and it appears in
   the Agents dock with a live status dot — without the user having spawned it through our
   UI.
2. When the agent exits and control returns to the shell, the pane **demotes** back to a
   shell pane (status stops, dock entry leaves). Re-running the agent promotes it again.
3. The session id is linked to the pane so that, on close/restart, the pane can resume that
   session instead of reverting to a bare shell — to the fidelity each agent allows without
   mutating agent config files (see phases).
4. Detection is **advisory and conservative**: ambiguity (two agent processes in one pane,
   unrecognized wrapper) leaves the pane as a shell. Never mis-promote a plain shell
   command (`git`, `vim`, `node build.js`) as an agent.

## How herdr does it (reference, do not copy)

herdr uses two complementary, launch-method-agnostic mechanisms. Both work when the user
types `claude`/`codex` inside a shell pane.

### A. Foreground-process identification via process-tree inspection

herdr identifies *which agent* runs in a pane by inspecting the pane's process tree, not by
remembering how it was launched.

- `src/detect/mod.rs` `identify_agent_in_job` maps a foreground job's process name + argv
  to a known agent. It handles generic runtimes/shells that wrap an agent (`node`, `bun`,
  `python`, `sh`/`bash`/`zsh`/`fish`, `cmd`, `powershell`/`pwsh`) by parsing the wrapper's
  argv to find the wrapped agent token, plus npm package paths (e.g.
  `…/node_modules/@openai/codex/bin/codex.js`), `.cmd`/`.bat`/`.ps1`/`.exe` suffix
  stripping, and symlink/nix-wrapper canonicalization. Crucially it **ignores**
  `-e`/`-c`/`--eval` payloads so `python -c '…' /tmp/codex` and `node -e '…' /tmp/codex`
  do **not** classify as Codex (tests in `src/detect/mod.rs`).
- **Windows is a real, working path** — `src/platform/windows.rs`
  `select_pane_foreground_job` + `snapshot_processes`: `CreateToolhelp32Snapshot` enumerates
  all processes; `NtQueryInformationProcess` + `ReadProcessMemory` read each process's
  `RTL_USER_PROCESS_PARAMETERS.CommandLine` (and current directory). It walks descendants of
  the pane's shell pid, collects candidates that `identify_agent_in_job` recognizes, and
  picks the single agent chain (topmost ancestor when all candidates are the same agent;
  falls back to the shell when there are zero, multiple distinct agents, or ambiguous
  sibling chains). This **corrects spec 046's "finding B"**, which called herdr's Windows
  foreground-job detection a no-op — that was true only of `src/platform/fallback.rs`, the
  *unsupported-platform* stub, not `windows.rs`.

> **Spec 046 correction to record:** spec 046 "Considered and not adopted → B" claims
> herdr's Windows foreground-process-group path is a no-op (`foreground_job → None`) and
> rejects the technique as "hard/unreliable on Windows." That is factually wrong for
> herdr's current tree: `src/platform/windows.rs` implements it fully with
> ToolHelp + NtQuery + ReadProcessMemory and unit-tests the selection logic. The rejection
> in 046 should be disregarded for this spec. (Live *status screen detection* via the spec
> 045 engine is separate and already shipped; this spec is about pane *promotion + session
> linkage*.)

### B. Hook-based session-id capture

Identifying the agent kind is not enough to link a session id — that requires the agent to
tell us its session id. herdr installs a **managed, versioned, idempotent** hook
(`src/integration/config_edit.rs` `ensure_command_hook`, preserves unrelated hooks) into
`~/.claude.json` (and Codex config) that runs `herdr-agent-state.ps1`/`.sh`
(`src/integration/assets/{claude,codex}/`) on `SessionStart`.

The hook:
- Bails immediately unless `HERDR_ENV=1` **and** `HERDR_PANE_ID` are set — env vars herdr
  injects on **every** pane, shell panes included. This is the trick that makes it work for
  a CLI-launched agent: the user's `claude` inherits `HERDR_PANE_ID` from the shell pane, so
  the hook knows which pane to report to.
- Reads the Claude/Codex hook payload from stdin (JSON: `session_id`, `transcript_path`,
  `hook_event_name`, `source`), then calls `herdr pane report-agent-session <PANE_ID>
  --source herdr:claude --agent claude --agent-session-id <id> --agent-session-path
  <transcript>` (`src/api/schema.rs:166` `PaneReportAgentSession`).
- Result: the pane gets the **exact** session id + transcript path, including on
  resume/fork, regardless of launch method.

This is the high-fidelity path. It is also the one that **conflicts with our
non-negotiable**: CLAUDE.md states *"The app must not mutate user or project agent config
files. Do not write to `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`, or similar
files as part of startup. MCP injection is process-scoped only."* So phase 3 below is a
deliberate, user-consented, off-by-default **policy exception** — not a silent behavior.

## Implementation plan (phased)

### Phase 1 — Process-tree agent identification (no config mutation; the big win)

Goal: detect that an agent is running in a shell pane and promote it so spec 045 status +
Agents dock work, for both `claude` and `codex`, any launch method.

- New pure main-process module `src/main/pty/agentProcessDetect.ts` (extracted pure so it
  is unit-testable, per the CLAUDE.md testability discipline — like `buildEnv`/`paneTree`).
  Two layers:
  - **Identification (pure):** `identifyAgentFromProcess(name, argv, cmdline)` →
    `AgentKind | null`. Adapt herdr's `identify_agent_in_job` logic: strip
    `.exe`/`.cmd`/`.bat`/`.ps1`/`.js`; recognize `claude`/`claude-code` and `codex`; when
    the process is a generic runtime/shell (`node`, `bun`, `python`, `cmd`, `powershell`,
    `pwsh`, `sh`/`bash`/`zsh`/`fish`), parse its argv to find the wrapped agent token,
    handling `-Command`/`-File`/`/c`/`/k`/`-c` and npm package paths
    (`…/node_modules/@openai/codex/…`, `…/@anthropic-ai/claude-code/…` — confirm the exact
    package paths on the user's machine before encoding them). **Ignore** `-e`/`--eval`/`-c
    <script>` payloads so a script whose path happens to contain "codex" is not
    misclassified. Return `null` for plain shells and unknown programs.
  - **Tree selection (pure over a process snapshot):** given the pane's shell pid + a
    `ProcessEntry[]` snapshot (`pid`, `parentPid`, `name`, `argv`, `cmdline`), return the
    foreground agent kind by walking descendants, collecting recognized candidates, and
    applying herdr's disambiguation: exactly one candidate → that agent; multiple
    candidates all the same agent → topmost ancestor of the chain; zero / multiple distinct
    agents / ambiguous sibling chains → `null` (stay a shell). Reuse the
    cycle-safe descendant walk (visited set) from herdr's `descendant_entries`.
- **Native snapshot on Windows:** a thin main-process helper (not pure — uses native APIs)
  that produces `ProcessEntry[]` where each entry is `{ pid, parentPid, name, argv?, cwd?,
  createTime? }`. (`cwd` and `createTime` are used by phase 2; include them now so the
  snapshot is not reshaped later.) Implementation options, in order of preference:
  1. **Recommended primary:** an existing native process-tree library rather than
     hand-rolling FFI. `@vscode/windows-process-tree` (the package VS Code's terminal uses
     for exactly this — `CreateToolhelp32Snapshot` + per-process command line) exposes
     `getProcessTree(pid, cb)` returning name/pid/ppid/command line. Evaluate its API shape
     and whether it exposes `cwd`/creation time; if it lacks those, supplement with a
     single `GetProcessTimes` / `NtQueryInformationProcess` call per candidate only (not
     per snapshot). It is a prebuilt native addon — confirm it survives
     `@electron/rebuild` (CLAUDE.md `postinstall`) and add it to `asarUnpack` like the
     other `*.node` modules.
  2. **Direct native** (`CreateToolhelp32Snapshot` + `NtQueryInformationProcess` +
     `ReadProcessMemory` for `CommandLine` + `CurrentDirectory`, `GetProcessTimes` for
     creation time) via a small native addon or `node-ffi-napi`. Matches herdr's
     `src/platform/windows.rs` exactly but is the most build/maintenance cost.
  3. **Fallback (no new native dep):** shell out to `powershell -NoProfile -Command
     "Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,CommandLine,
     ExecutablePath | ConvertTo-Csv"` (avoid `wmic` — deprecated and removed from newest
     Windows 11 builds). Cheaper to ship, but spawns a PowerShell process per sweep
     (~100–300 ms) and is parser-fragile; does not give `cwd`/`createTime` (phase 2 then
     falls back to `getLastCwd` + detection timestamp). Use only if 1 and 2 are blocked.
  Whatever the source, keep the native/IO behind a single `snapshotProcesses(): ProcessEntry[]`
  interface so the pure selector is testable with synthetic snapshots (mirror herdr's
  `windows.rs` unit tests — same shape, our data). Open processes with
  `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ` only and **fail closed** (treat as
  "no candidate") on any access error — never surface a pid the user does not own.
- **Wiring (main, singleton-aware):** `PtyManager` is a single app-global instance
  (`src/main/ipc/handlers.ts:57`); cross-window delivery is `windowManager.sendToWindowForPty(
  ptyId, channel, ...args)` (see `src/main/ipc/ptyOutputRouter.ts`). So the inspector is one
  app-global sweeper, not per-window. Land the impure sweeper in a new
  `src/main/pty/agentProcessSweeper.ts` (owns the `setInterval`, the `ptyId → shell pid` map,
  and `lastDetectedKind`), constructed in `handlers.ts` next to `PtyManager`/`SessionSpawner`.
  It must track **only shell panes** — the `shell:new` IPC handler (`handlers.ts:228`,
  `ptyManager.createShell`) calls `sweeper.trackShell(ptyId)`; `SessionSpawner`'s
  `createDeferred` agent panes are **not** tracked. Subscribe to `ptyManager.on('ready', e =>
  record pid)` to capture the shell pid and `ptyManager.on('exit', id => untrack)` to clean
  up. After a shell pane's `pty:ready`, the sweep (every 2–3 s, **only over tracked
  shell-pane ptyIds**, paused when the set is empty) snapshots once and selects per ptyId.
  Track `lastDetectedKind: Map<ptyId, AgentKind|null>` and emit a new IPC event **only on
  transition**: `sendToWindowForPty(ptyId, 'pane:agent-detected', ptyId, agentKind)` where
  `agentKind` is `AgentKind | null` (`null` = demote). Add the channel to
  `src/shared/types.ts` (`EventChannels` + the typed `on` map, mirroring `session:detected`).
  Require **two consecutive confirmed observations** before emitting promotion or demotion so
  a transient child (`claude --version`) does not flap the pane kind; this gives a worst-case
  promotion latency of ~2 × sweep interval (≤ ~6 s).
- **Renderer store action:** `promoteShellPaneToAgent(paneId, agentKind)` /
  `demoteAgentPaneToShell(paneId)` in `panes.ts`, plus an in-memory (non-serialized)
  `promotedFromShell: boolean` flag on the pane. The `pane:agent-detected` listener (new,
  in `src/renderer/src/store/panesIpc.ts`, modeled on the `session:detected` listener at
  `panesIpc.ts:38` — find the pane by ptyId via `findLeafByPtyId` across tabs) calls these.
  - **Promotion** sets `paneType:'agent'`, `agentKind`, `promotedFromShell:true`, and
    **must not touch `ptyId`** — the shell pty is already running and must keep running.
    Do not clear scrollback or remount the Terminal.
  - **Demotion** (only when `promotedFromShell === true`, so **native agent panes never
    demote** — they keep their existing exit/resume behavior) reverts `paneType:'shell'`,
    drops `agentKind`/`sessionId`/`promotedFromShell`, and clears `agentStatus[paneId]`. It
    must **not kill the pty or clear xterm scrollback**; it is pure metadata.
  - **These must be atomic, tab-scoped transitions** (per CLAUDE.md multi-window
    invariants — use the `focusPaneInTab` discipline, no composed primitives).
- **Status tick activation (critical wiring detail):** the spec 045 status poll lives in
  the **`Terminal` component effect** (`src/renderer/src/components/Terminal/index.tsx:596`,
  gated `isAgentPane && pane.agentKind && oscTracker`), not in the store. The store action
  only flips metadata; the component effect starts/stops the `setInterval`. **That effect's
  dependency array is eslint-disabled and keyed on `pane.ptyId`**, so flipping `paneType`
  in-place **with the same ptyId will not re-run the effect** and the tick will not start.
  Fix this as part of phase 1: add `paneType`/`agentKind` (or `pane.agentKind ?? null`) to
  the effect deps so promotion/demotion re-runs the connect effect and the status interval
  starts/stops correctly. Verify the cleanup path (`clearPaneAgentStatus` + `clearInterval`)
  fires on demotion. Without this, promotion sets the metadata but no status dot appears —
  the exact symptom this spec is meant to fix.
- **Persistence/hydration rule (resolves the biggest ambiguity):** a phase-1-only promoted
  pane has `agentKind` but **no `sessionId`**, and the startup resume guard
  (`src/renderer/src/store/panes.ts:202`: `if (leaf.paneType !== 'agent' || !leaf.agentKind
  || !leaf.sessionId || leaf.ptyId) continue`) skips agent panes with no `sessionId`. If we
  persisted `paneType:'agent'` for a phase-1-only promotion, the pane would hydrate on
  restart as an agent pane with no pty and no resume — broken. Therefore:
  - **Phase-1 promotion is in-memory only.** `applyLayout`/layout-save must serialize a
    `promotedFromShell` pane with no `sessionId` back as `paneType:'shell'` (its original
    type). On restart the pane comes back as a shell; re-running `claude`/`codex` re-promotes
    it live. (`promotedFromShell` itself is not serialized.)
  - **Promotion is persisted as `paneType:'agent'` only once a `sessionId` is linked
    (phase 2).** A phase-2-linked pane saves as `agent` + `sessionId` and hydrates via the
    normal `hydrateTabRuntime → sessions:validate → session:resume` path — i.e. on restart
    the user's old shell pane resumes as the linked agent session. This is an intended
    behavior change (shell pane → resumed agent pane on restart) and must be surfaced in the
    UI/Docs. If the transcript is gone, it gets `resumeError` like any agent pane (CLAUDE.md).
- **Guard the non-negotiables:** this phase writes nothing to agent config, sets no env
  vars, and changes no PTY env. It only reads process metadata. It must not reintroduce a
  PATH rewrite or any env mutation (CLAUDE.md "Do not reintroduce any PATH rewrite for
  terminal panes").
- **What phase 1 does NOT do:** it does not link a `sessionId`. The promoted pane has
  `agentKind` and live status but no session id yet (phase 2/3). Closing the pane still
  loses the resume link until phase 2 lands. State this limitation in the UI (the dock can
  show "session linking pending" for a promoted-but-unlinked pane).

### Phase 2 — Session-id linking without hooks (no config mutation) — SUPERSEDED by Phase 4

> **Status:** shipped, but slated for removal in Phase 4. Phase 4 replaces both the Codex
> scanner and the Claude transcript poll with managed hooks. The files
> `src/main/sessions/codexDetection.ts`, `src/main/sessions/claudeCliLink.ts`, the
> `promotedSessionLinker` poll paths, and the SessionSpawner Codex pending-detection
> machinery (`_registerCodexDetection` / `registerPromotedCodex` / `cancelPromotedCodex` /
> the 1 s poll) are deleted once Phase 4 lands. Keep this section as the historical record
> of what shipped; do not extend it.

Goal: best-effort `sessionId` for a phase-1-promoted pane, using metadata we already have
(pane cwd via OSC 633, agent process start time, the existing scanners).

- **Inputs (shared):** the promoted pane's cwd and the agent process start time.
  - **cwd source (preferred):** the agent process's own `CurrentDirectory` from the phase-1
    snapshot (`ProcessEntry.cwd`, read via `NtQueryInformationProcess` — herdr's
    `process_cwd`). This is the ground truth for "where the agent was launched." Fallback:
    `ptyOutputRouter.getLastCwd(ptyId)` (`src/main/ipc/ptyOutputRouter.ts` exposes
    `getLastCwd`), which tracks the shell's OSC 633 cwd. The two should agree; if they
    diverge, prefer the process cwd.
  - **start-time anchor:** the agent process's `CreationTime` from `GetProcessTimes`
    (`ProcessEntry.createTime`). Fallback if the snapshot lacks it: the phase-1 promotion
    detection timestamp (agent started ≤ detection time, within ~one sweep). Use the anchor
    only as a bound for the grace window, not as an exact key.
- **Codex:** generalize the existing cwd/time-constrained rollout scanner
  (`src/main/sessions/codexDetection.ts` `selectCodexAssignments`) so it can claim a
  session for a *promoted* shell pane, not only for `SessionSpawner`'s pending map.
  - Register the promoted pane's ptyId into the pending-detection structure when it is
    promoted, and wire `SessionSpawner.notePtyWrite` for that ptyId so Codex's
    first-message-submit gate (`codexWriteContainsFirstMessageSubmit`) starts the poll —
    Codex detection only claims after the first real message (CLAUDE.md). Without this, a
    CLI-launched Codex that never messages stays unlinked (correct), but one that does
    message never gets claimed (the bug to avoid).
  - Reuse the existing `_readNewCodexCandidates` filters unchanged: reject rollouts whose
    `originator !== 'codex-tui'` or `source !== 'cli'` (a normally-invoked `codex` CLI
    sets these; a non-CLI rollout is not ours to claim).
  - Claim only an unambiguous single cwd/time match; ignore ambiguity (CLAUDE.md "Ambiguous
    matches are ignored rather than assigned"). Reuse `claimedCodexFiles` dedup so two
    panes cannot claim the same rollout. Set `sessionDetectionState:'pending'` +
    `sessionDetectionStartedAt` + `sessionDetectionCwd` markers on the pane (CLAUDE.md
    "Session Detection") so the UI and startup-recovery logic treat it like any agent pane.
- **Claude:** Claude writes transcripts to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
  Use `claudeProjectDirForCwd(cwd)` from `src/main/sessions/claudePaths.ts` (already
  extracted and tested) to resolve the directory, then link the **newest transcript whose
  `firstActivity` aligns with the agent process start time** (within a grace window, e.g.
  ±15 s — tune from observed Claude transcript write timing). Derive the `sessionId` from
  the transcript filename (`<sessionId>.jsonl`).
  - **This is not the reintroduction CLAUDE.md bans.** The non-negotiable
    *"Do not reintroduce Claude filesystem matching for new panes; preserve the launch-time
    `--session-id` path"* is specifically about panes **we spawn** (where we control the
    launch and must keep passing `--session-id`). For a **CLI-launched agent we did not
    spawn**, there is no launch-time `--session-id` to preserve — filesystem matching is the
    only non-hook option. The constraint's intent (don't regress the controlled-launch
    path) is preserved: our `SessionSpawner.spawnNew` still passes `--session-id` and that
    path is untouched. Flag this distinction explicitly in code comments and in CLAUDE.md
    when this lands.
  - Keep the match **time-constrained and one-shot**: claim once, by start-time + cwd, then
    stop scanning. Do not continuously re-match (which would chase the wrong session after a
    `claude --resume` fork inside the pane). If the match is ambiguous (more than one new
    transcript in the cwd within the grace window), leave the pane unlinked rather than
    guess.
- **Linking:** once a `sessionId` is determined, main sends the **existing** `session:detected`
  IPC (`session:detected(ptyId, agentKind, sessionId)`). The existing listener in
  `src/renderer/src/store/panesIpc.ts:38` finds the pane by ptyId and calls
  `setSessionId(pane.id, sessionId)` — **no new listener needed**, and it already works for
  both `claude` and `codex`. Promotion (phase 1) must have already set `paneType:'agent'` +
  `agentKind` so the pane is consistent before `sessionId` is attached. Because a sessionId
  is now linked, the persistence rule flips: the pane is saved as `paneType:'agent'` +
  `sessionId` and hydrates via the normal `hydrateTabRuntime → sessions:validate →
  session:resume` path on restart (see the phase-1 persistence rule).
- **Resume/fork limitation (state plainly):** without hooks, a `claude --resume` or
  `codex resume` *typed inside* an already-promoted pane can fork to a new session id that
  our one-shot match will not re-link. Phase 3 closes this. Until then, the dock should
  show a "session link may be stale after in-pane resume" hint for phase-2-linked panes.
  This is an acceptable v1 limitation; the spec-045 live status still works regardless.

### Phase 3 — Opt-in managed hooks (policy exception; requires user sign-off) — EXTENDED by Phase 4

> **Status:** shipped (Claude-only). Phase 4 extends this to Codex and makes hooks the
> sole session-id capture mechanism (except app-launched Claude). The Claude hook install
> into `~/.claude/settings.json` (not `~/.claude.json` — see the implementation notes) and
> the `managedHooks.ts` / `managedHookController.ts` / `agentSessionReportServer.ts`
> infrastructure are reused verbatim by Phase 4. The toggle's role changes under Phase 4.

Goal: high-fidelity session-id capture for CLI-launched agents, including resume/fork, by
adapting herdr's hook technique. **This phase is a deliberate exception to the "no agent
config mutation" non-negotiable and must be off-by-default, user-consented, and
reversibly uninstallable.** Do not implement without explicit user approval.

- New Settings → Terminal toggle: **"Enhanced session detection (CLI-launched agents)"**,
  default off, with copy that states exactly what it does: installs a managed hook block
  into `~/.claude.json` and `~/.codex/config.toml` that reports session ids back to
  MultiAgent; uninstallable from the same toggle; does not touch any other config.
- Set a pane-identity env var on **every** pane (shell and agent), e.g.
  `MULTIAGENT_PANE_ID=<paneId>` and `MULTIAGENT_ENV=1`, in `buildEnv`/`agentEnv`
  (`src/main/pty/buildEnv.ts`, `SessionSpawner.agentEnv`) so a CLI-launched agent inherits
  it from its shell pane. **Scrub these from the inherited env in `buildEnv`** the same way
  Claude renderer flags are scrubbed, so they never leak into a nested MultiAgent.
- Managed hook install (`src/main/integration/managedHooks.ts`, new): idempotent, versioned
  (`# MULTIAGENT_INTEGRATION_ID=claude` / `# MULTIAGENT_INTEGRATION_VERSION=N`), wrapped in
  begin/end markers (`# >>> multiagent session-integration` / `# <<< multiagent
  session-integration`) and **preserving all unrelated hooks** (adapt herdr's
  `ensure_command_hook` discipline — never replace the hooks array; append/update only our
  marked entry). The hook script (bundled asset, shipped via `package.json` `build.files`
  like the MCP templates — CLAUDE.md packaging) reads the agent's SessionStart payload and
  reports `session_id` + `transcript_path` back to main over a **local** channel.
  - **No external host runtime:** herdr's Unix hook needs `python3` and its Windows hook
    shells out to the `herdr` CLI. We are a per-user Windows installer with no
    prerequisites (spec 045 non-negotiable). The hook script must be a standalone
    PowerShell script that talks to main via a channel that needs no CLI — e.g. write a
    small JSON line to a PID-scoped temp file / named pipe the main process watches, or
    POST to a localhost loopback endpoint spun up by main. Confirm the transport during
    impl; keep it self-contained.
- On the report, main links `sessionId` + `transcriptPath` to the pane (by
  `MULTIAGENT_PANE_ID`) and emits `session:detected`. This supersedes the phase-2
  one-shot match for hook-enabled panes and correctly follows resume/fork (each
  `SessionStart` re-reports).
- **Uninstall must be clean:** toggling off removes only our marked hook block from both
  config files (leaving all other hooks intact), writes a timestamped `.bak`, and clears
  the env vars on new panes. Existing panes keep their env until respawn.
- Update CLAUDE.md's "Agent MCP Injection" / non-negotiable section to record this scoped,
  opt-in exception so future agents don't treat it as a regression.

### Phase 4 — Unified hook-based session detection (DESIGNED; NOT implemented; handoff)

> **This is the handoff for the next developer.** It is designed against verified facts
> (Codex docs + the herdr repo) but no code is written. Read the implementation notes at
> the top first — Phase 1 stays, Phase 2 is deleted, Phase 3 is extended.

**Directive:** move **all** session-id capture to managed hooks, with one exception —
**app-launched Claude keeps `--session-id <GUID>`** (the id is known at launch; no
detection). Every other path, now and for future agent kinds, uses hooks. Specifically:

| Path | Today (Phases 1–3) | After Phase 4 |
|---|---|---|
| App-launched Claude (`SessionSpawner.spawnNew/Resume`) | `--session-id <GUID>` | **unchanged** — `--session-id <GUID>` (the exception) |
| App-launched Codex (`SessionSpawner.spawnNew/Resume`) | cwd/baseline/first-message scanner (`_registerCodexDetection`) | **hook** + `--dangerously-bypass-hook-trust` on the launch command |
| CLI-launched Claude (typed in shell pane) | Phase 2 transcript poll OR Phase 3 hook | **hook** (Claude has no trust gate) |
| CLI-launched Codex (typed in shell pane) | Phase 2 generalized scanner | **hook** (user must `/hooks` trust once) |

**Verified facts (do not re-litigate):**
- Codex HAS a `SessionStart` hook. Fires on startup/resume/clear/compact; stdin JSON
  includes `session_id` + `transcript_path` (+ `source`). Same payload shape as Claude.
  (Codex docs; `codex-rs/hooks/src/events/session_start.rs`.)
- Codex reads hooks from **`~/.codex/hooks.json`** (user scope, **JSON**, same nested
  `{ matcher, hooks:[{type:"command",command}] }` shape as Claude) **and** requires
  `[features] hooks = true` in `~/.codex/config.toml` to enable the hooks system.
- Codex command hooks require **manual trust** via the `/hooks` TUI command before they
  run (trust is hashed; a changed hook reverts to untrusted). The only bypass is the
  `--dangerously-bypass-hook-trust` CLI flag. There is no non-flag bypass.
  **VERIFIED 2026-07-14** on the target install (`codex-cli 0.144.4`): `codex --help`
  lists `--dangerously-bypass-hook-trust` — "Run enabled hooks without requiring persisted
  hook trust for that invocation." So app-launched Codex can bypass trust (we control the
  command); CLI-launched Codex cannot (the user types the command).
- herdr (`install_codex` in `targets.rs:167`) installs the Codex hook exactly this way
  (writes `~/.codex/hooks.json` via the same `ensure_command_hook` JSON surgery as Claude,
  sets `[features] hooks = true` in `config.toml`) and **does nothing about the trust
  gate** — no `--dangerously-bypass-hook-trust`, no managed/requirements.toml, no trust
  API. It accepts the one-time `/hooks` trust as the cost of Codex hooks. So do we.
- Known risk: [openai/codex#17532](https://github.com/openai/codex/issues/17532) — hooks
  configured via **repo-local** `.codex/config.toml` don't fire in the interactive TUI. We
  use **user-level** `~/.codex/hooks.json`, which should be unaffected, but verify on the
  target Codex version before shipping.

**Design:**

1. **One hook script, agent-kind argument.** Generalize
   `src/main/integration/assets/multiagent-agent-state.ps1` to take the agent kind as
   `$args[0]` (e.g. `claude` / `codex`) and include `agentKind` in the POST body:
   `{ ptyId, agentKind, sessionId, transcriptPath }`. It still gates on
   `MULTIAGENT_ENV=1` + `MULTIAGENT_PTY_ID` + `MULTIAGENT_HOOK_PORT` and bails silently
   otherwise (so it's a no-op for any agent session launched outside MultiAgent). Hook
   commands become `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<script>"
   claude` and `… codex`. (This mirrors herdr's `param([string]$Action)` action arg.)

2. **Report server uses the kind.** `agentSessionReportServer.ts`'s `onReport` currently
   hardcodes `'claude'`; change it to emit
   `session:detected(ptyId, agentKind, sessionId)` using `agentKind` from the POST. The
   existing `panesIpc.ts` `session:detected` listener already promotes a still-shell pane
   (handles the hook-fires-before-sweeper race) and attaches the id — no listener change.

3. **Stable script path (trust persistence).** Copy the hook script to a **fixed user
   path** — `app.getPath('userData')/multiagent-agent-state.ps1` — at install time (and
   refresh it if the bundled asset's content changed). Point both hook commands at that
   fixed path. This keeps the command string byte-identical across dev / packaged /
   version bumps, so **Codex trust persists** (a changed command would revert to
   untrusted) and the Claude install is stable too. The `resolveHookScriptPath` fallbacks
   remain for source-of-truth at build time; the installed copy is what the command points
   at.

4. **Codex hook install.** Generalize `ManagedHookController` to target a given file +
   agent kind (instantiate twice: Claude → `~/.claude/settings.json` kind `claude`; Codex
   → `~/.codex/hooks.json` kind `codex`). Reuse the pure `managedHooks.ts` surgery
   verbatim — the sentinel is the script filename, and since the two hooks live in
   **separate files**, per-file sentinel detection is unambiguous. Additionally, for
   Codex, enable the feature flag: a new pure helper `codexConfigFeatures.ts` that does
   minimal string-based TOML surgery on `~/.codex/config.toml` to ensure
   `[features]\nhooks = true` exists (reimplement herdr's `build_codex_config_with_hooks`
   in our idioms — ~50 lines of line surgery; do not vendor). On uninstall, remove the
   Codex hook from `hooks.json`; the `[features] hooks = true` flag may be left (matches
   herdr; harmless once the hook entry is gone) or reverted — pick one and document it.

5. **App-launched Codex bypasses trust.** Add `--dangerously-bypass-hook-trust` to the
   Codex launch command in `SessionSpawner.codexCliArgs()` (both `newSessionCommand` and
   `resumeSessionCommand` for codex). We control that command, so the hook fires without
   manual trust and reports the session id at start — replacing the scanner entirely for
   app-launched Codex, including across `codex resume` forks (each SessionStart
   re-reports). **The flag is verified to exist** (`codex-cli 0.144.4`, see Verified facts);
   still confirm it applies to `codex resume` (it is a per-invocation flag, so it should).
   **No extra env work:** app-launched Codex panes already receive `MULTIAGENT_PTY_ID` /
   `MULTIAGENT_ENV` / `MULTIAGENT_HOOK_PORT` via `PtyManager.getPaneEnv`, which runs for
   **all** panes (shell and agent) — not just shells. The app-Codex pane is already an agent
   pane at spawn, so the `session:detected` listener's promote-if-shell step is a no-op and
   `setSessionId` attaches the id. The renderer needs **no change** — only the *source* of
   `session:detected` for app-Codex switches (scanner → hook); the IPC + listener are
   reused. **Startup race:** the report server's port is assigned async; if an app-Codex
   pane is spawned in the first few ms before the port is ready, `getPaneEnv` returns the
   env without `MULTIAGENT_HOOK_PORT` and the hook bails (no link that launch). Acceptable
   (next launch links), or `await reportServer.ready()` before returning from the
   `session:new`/`session:resume` handlers — pick one.

6. **CLI-launched Codex trust UX.** We cannot add the flag to a user-typed `codex`, so a
   CLI-launched Codex pane links only after the user trusts the hook once via `/hooks` in
   the Codex TUI. Until then the pane **promotes** (Phase 1 process-tree detection works
   without the hook) but stays **unlinked**. Surface this: when a Codex pane is promoted
   but has no `sessionId` within a few seconds, show a hint ("trust the MultiAgent hook in
   `codex /hooks` to link this session"). After the one-time trust, all future CLI Codex
   launches link automatically.

7. **App-launched Claude stays on `--session-id`.** Unchanged. Optional refinement: set
   `MULTIAGENT_SESSION_ID=<guid>` on app-launched Claude panes (via `agentEnv`) so the
   global Claude hook bails (the id is already known) and avoids a redundant report — the
   script would `if ($env:MULTIAGENT_SESSION_ID) { exit 0 }` near the top. Otherwise the
   hook harmlessly re-reports the same id. Either is fine; pick one.

8. **Delete the file-poll detection.** Remove: `src/main/sessions/codexDetection.ts` (+test),
   `src/main/sessions/claudeCliLink.ts` (+test), the `promotedSessionLinker.ts` Codex/Claude
   poll paths (the linker becomes unnecessary for linking — the hook does it; **delete the
   linker entirely** or reduce it to nothing), and the SessionSpawner Codex pending
   machinery (`_registerCodexDetection` / `registerPromotedCodex` / `cancelPromotedCodex` /
   `_pollCodexDetections` / `_readNewCodexCandidates` / `_assignCodexCandidates` /
   `_claimCodexCandidate` / `_logCodexAmbiguity` / `claimedCodexFiles` / the
   `codexWriteContainsFirstMessageSubmit` first-message gate / `notePtyWrite`). The
   `pty:write` handler's `spawner.notePtyWrite(ptyId, data)` call is removed with it.

9. **What STAYS:** Phase 1 unchanged — `agentProcessDetect.ts`, `processSnapshot.ts`,
   `agentProcessSweeper.ts`, the `pane:agent-detected` IPC, `promoteShellPaneToAgent` /
   `demoteAgentPaneToShell`, the `promotedFromShell` flag + persistence rule. The sweeper
   is still required for **demotion on exit** (hooks fire on start, not exit) and as the
   promotion path when a CLI Codex hook isn't trusted yet. The `session:detected`
   listener stays. The Phase-3 infrastructure (`managedHooks.ts`,
   `managedHookController.ts`, `agentSessionReportServer.ts`, the env injection via
   `PtyManager.getPaneEnv`, the `buildEnv` scrub) stays and is shared by both agents.

**Toggle semantics (DECISION REQUIRED — see Open questions).** Today the toggle is
opt-in/off ("Enhanced session detection (CLI-launched agents)"). Under Phase 4, app-launched
Codex **needs** the Codex hook installed to link at all (there is no scanner fallback). So
the hooks can no longer be purely opt-in if app-launched Codex must link out of the box.
Recommended: **default ON**, rename to "Session linking (managed hooks)", with copy that
states it writes a managed hook to `~/.claude/settings.json` and `~/.codex/hooks.json`
(+ the `[features]` flag in `~/.codex/config.toml`), is reversible from the same toggle,
and that CLI-launched Codex requires a one-time `/hooks` trust. The toggle becomes an
off-switch (user can opt out of all config mutation; then only app-launched Claude links,
via `--session-id`). Alternative: keep it opt-in and accept that app-launched Codex does
not link until the user enables it. **Pick one with the product owner before implementing.**

**Files (Phase 4):**
- New: `src/main/integration/codexConfigFeatures.ts` (+test) — pure `[features] hooks=true`
  TOML surgery on `~/.codex/config.toml`.
- Edit: `assets/multiagent-agent-state.ps1` (agent-kind arg + `agentKind` in POST +
  optional `MULTIAGENT_SESSION_ID` bail); `agentSessionReportServer.ts` (use `agentKind`
  from the POST in `session:detected`); `managedHookController.ts` (generalize to
  file+kind; install the script copy to a fixed userData path; orchestrate Claude + Codex);
  `managedHooks.ts` (`generateHookCommand(scriptPath, kind)` replacing
  `generateClaudeHookCommand`); `SessionSpawner.ts` (add `--dangerously-bypass-hook-trust`
  to the Codex command; remove all Codex pending-detection machinery + `notePtyWrite`;
  optional `MULTIAGENT_SESSION_ID` on app-launched Claude); `handlers.ts` (remove
  `spawner.notePtyWrite` from `pty:write`; wire the generalized controller for both
  agents; default-on apply at startup); `buildEnv.ts` (also scrub `MULTIAGENT_SESSION_ID`
  if the optional refinement is taken); `settings.ts` + Settings UI (toggle rename +
  default-on + Codex `/hooks` trust copy); `CLAUDE.md` (record "Claude + Codex" hooks, the
  `--dangerously-bypass-hook-trust` app-launch bypass, and the scanner removal).
- Delete: `src/main/sessions/codexDetection.ts` (+test), `src/main/sessions/claudeCliLink.ts`
  (+test), `src/main/sessions/promotedSessionLinker.ts` (+test), the SessionSpawner Codex
  poll methods above.

**Open questions (confirm before implementing):**
1. Toggle default: default-ON (recommended, so app-launched Codex links out of the box) vs
   opt-in (app-launched Codex won't link until enabled). Product call.
2. On Codex uninstall: leave `[features] hooks = true` (herdr does; harmless) or revert it?
3. App-launched Claude: take the `MULTIAGENT_SESSION_ID` bail refinement (avoids a
   redundant hook report) or let the hook re-report the same id harmlessly?
4. Startup race for app-Codex (see Design 5): accept a missed-link on a pane spawned in the
   first few ms, or `await reportServer.ready()` before the `session:new`/`session:resume`
   handlers return?

> **SPIKE FIRST (the one design-blocking unknown):** confirm that a hook in **user-level**
> `~/.codex/hooks.json` actually **fires in the interactive Codex TUI** on the target
> version. Bug [openai/codex#17532](https://github.com/openai/codex/issues/17532) is about
> repo-local `.codex/config.toml` not firing interactively; user-level `hooks.json` should
> be fine, but if it is NOT, the CLI-launched-Codex path needs a different mechanism. Spend
> ~30 min: install a trivial test hook (e.g. one that writes a marker file) into
> `~/.codex/hooks.json`, set `[features] hooks = true`, run `codex` interactively, trust it
> via `/hooks`, and verify the marker appears. Do this before building anything else.

**Recommended implementation order:**
1. Spike (above) — resolves the only design-blocking risk.
2. Generalize the hook script (agent-kind arg + `agentKind` in POST) and the report server
   (emit `session:detected` with the POST's `agentKind`). Unit-test the POST→event flow.
3. `codexConfigFeatures.ts` — pure `[features] hooks=true` TOML surgery (+test).
4. Generalize `ManagedHookController` to file+kind; add the fixed-path script copy;
   instantiate Codex (`~/.codex/hooks.json` + `[features]` flag) and Claude. Tests for
   Codex install/uninstall/unrelated-preservation/`.bak`.
5. App-Codex `--dangerously-bypass-hook-trust` in `SessionSpawner.codexCliArgs()`.
6. Toggle default-ON + rename + Codex `/hooks`-trust UI copy + the unlinked-promoted-Codex
   hint.
7. Delete the scanner: `codexDetection.ts`, `claudeCliLink.ts`, `promotedSessionLinker.ts`,
   SessionSpawner Codex poll machinery, `notePtyWrite` + its `pty:write` call.
8. `npm test` / `typecheck` green; CLAUDE.md update (Claude+Codex exception, app-launch
   bypass, scanner removal).

**Phase 4 handoff contract (non-negotiables):**
1. **No vendoring** — reimplement herdr's `build_codex_config_with_hooks` TOML surgery in
   our own idioms.
2. **App-launched Claude `--session-id` path stays untouched.** `SessionSpawner.spawnNew`
   still generates a UUID and passes `--session-id`.
3. **Config mutation is still the scoped, reversible exception.** Both hook installs
   (Claude `settings.json`, Codex `hooks.json` + `config.toml [features]`) stay
   marked-block / sentinel-based, preserve all unrelated keys/hooks, write a `.bak` on
   every change, atomically replace, and are cleanly uninstallable. Update CLAUDE.md's
   non-negotiable section to record "Claude + Codex" (it currently says Claude-only).
4. **Codex trust is a documented user step for CLI launches.** App-launched Codex bypasses
   it via `--dangerously-bypass-hook-trust`; CLI-launched Codex requires a one-time
   `/hooks` trust. Do not try to bypass trust for CLI launches (herdr doesn't either).
5. **Fail closed.** If a hook isn't installed/trusted, the pane promotes (Phase 1) but
   stays unlinked — never mis-link. The hook report is the sole source of the session id.
6. **Phase 1 stays; Phase 2 is deleted.** Do not leave the scanner as a "fallback" — that
   re-introduces the ambiguity/first-message-gate problems hooks remove. One mechanism.
7. **Tests ship with the phase** — the Codex TOML `features` surgery, the generalized
   controller (Codex `hooks.json` install/uninstall + unrelated preservation + `.bak`),
   the agent-kind POST → `session:detected` flow, and the `--dangerously-bypass-hook-trust`
   arg presence in the Codex launch command.

**Phase 4 definition of done:**
- App-launched Codex links its session id at start (no first-message gate, no polling),
  including across `codex resume` forks, with no manual `/hooks` step.
- CLI-launched Claude links at start (no poll).
- CLI-launched Codex links after a one-time `/hooks` trust; the UI hints at the trust step
  for an unlinked promoted Codex pane.
- App-launched Claude unchanged (`--session-id`).
- `codexDetection.ts`, `claudeCliLink.ts`, `promotedSessionLinker.ts`, and the
  SessionSpawner Codex poll machinery are deleted; `npm test` / `typecheck` green; the
  Phase-1 promotion/demotion tests still pass.
- CLAUDE.md records the Claude+Codex hook exception and the scanner removal.

**Phase 4 verification:** Toggle on (or default-on) → check `~/.claude/settings.json` has
the Claude SessionStart hook and `~/.codex/hooks.json` has the Codex SessionStart hook and
`~/.codex/config.toml` has `[features] hooks = true`, all unrelated settings/hooks
preserved. App-launch a Codex pane → links at start (no message needed). Type `codex` in a
shell pane → promotes (cursor stops blinking within ~6 s) → after `/hooks` trust, links at
start. Type `claude` in a shell pane → promotes + links at start. App-launch a Claude pane
→ `--session-id` as before. Toggle off → both hooks removed, unrelated hooks intact,
`.bak` written.

## Risks

- **Mis-promotion of plain shells.** A `node build.js` or `python -c '…' /tmp/codex` must
  not become an agent pane. Mitigation: port herdr's `-e`/`-c`/`--eval` ignoring + the
  "multiple distinct agents → stay shell" disambiguation; characterize with the same unit
  tests herdr has. A false promotion is annoying but recoverable (demote on next sweep); a
  false *session link* is worse, so phase 2 must be conservative.
- **Flap on promotion/demotion.** A transient agent child (e.g. a quick `claude --version`)
  could promote then immediately demote. Mitigation: require two consecutive confirmed
  observations before promoting; demote after the agent process is gone for one full sweep
  (so a brief subshell does not drop the dot). Worst-case promotion latency ≈ 2 × sweep
  interval (≤ ~6 s at a 2–3 s sweep) — acceptable for an advisory signal.
- **Native process-inspection cost / packaging.** A native tree library
  (`@vscode/windows-process-tree`) is the recommended path; confirm it rebuilds under
  `@electron/rebuild` and is `asarUnpack`ed (CLAUDE.md packaging). If the build/packaging
  cost is too high, fall back to the `Get-CimInstance` shell-out (slower, parser-fragile,
  no `cwd`/`createTime` — phase 2 then uses `getLastCwd` + detection timestamp). The pure
  selector is identical either way.
- **Reading other users' processes.** `OpenProcess` is scoped to processes the user owns;
  a per-user installer runs at user privilege, so this only ever inspects the user's own
  panes. Still, open with `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ` only and
  fail closed (treat as "no candidate") on any access error — never surface a pid from
  another user.
- **Phase-2 Claude filesystem matching correctness.** Matching by cwd + start-time can
  bind the wrong transcript if the user starts two Claude CLIs in the same project
  directory within the grace window. Mitigation: if more than one new transcript fits,
  leave the pane unlinked (phase 3 hook is the real fix). Document the limitation.
- **Phase-3 policy/safety.** Writing to `~/.claude.json` / `~/.codex/config.toml` is the
  single highest-risk change in this spec. Mitigations: off-by-default, explicit consent
  copy, versioned idempotent install, marked blocks + clean uninstall, timestamped `.bak`,
  preserve all unrelated hooks, self-contained hook transport (no host runtime), and a
  CLAUDE.md update recording the scoped exception. A botched uninstall that corrupts the
  user's agent config is the worst-case failure mode — the marked-block + `.bak` pattern
  exists precisely to prevent it; test install/uninstall idempotence and
  unrelated-hook-preservation exhaustively.
- **Cross-window / detached invariants.** `PtyManager` is a **single app-global instance**,
  not per-window; cross-window delivery is `windowManager.sendToWindowForPty(ptyId, …)`
  (same path `pty:ready`/`pty:cwd`/`session:detected` already use). So the phase-1 sweeper
  is global and emits to whichever window owns the ptyId; the `pane:agent-detected`
  listener (in each window's `panesIpc.ts`) finds the pane by ptyId via `findLeafByPtyId`
  and applies the atomic, tab-scoped transition. A detached window's promoted pane is
  promoted inside that detached window's store, exactly like a primary-window pane. No
  per-window sweep state is required.

## Edge cases (resolved)

- **Native agent pane must not demote.** Only panes with the in-memory
  `promotedFromShell` flag demote when the agent process exits. Panes we spawned as agents
  (`SessionSpawner`) never set that flag and keep their existing exit/`resumeError`/retry
  behavior. The flag is not serialized.
- **Demotion preserves the pty and scrollback.** Demotion flips metadata only
  (`paneType`/`agentKind`/`sessionId`/`agentStatus`); it must not call `kill`, not clear
  `ptyId`, and not remount/clear the xterm buffer. The shell is still running underneath
  the agent; when the agent exits, the shell prompt returns and the pane reverts to a shell.
- **Promotion with same ptyId must re-run the status effect.** The `Terminal` connect
  effect (`Terminal/index.tsx`) is keyed on `ptyId`; add `paneType`/`agentKind` to its deps
  so promotion/demotion re-runs it and the status interval starts/stops. Verify by hand:
  type `claude` in a shell pane → the dot appears within ~6 s; exit → the dot disappears and
  the pane is a shell again, scrollback intact.
- **Inactive / not-yet-hydrated tabs (spec 001).** Main can detect the agent from the
  process tree even when the hosting tab is not mounted (detection is in main, not the
  Terminal component). `pane:agent-detected` fires and the store promotes the pane by ptyId.
  The status tick only starts once the tab is hydrated and the `Terminal` mounts on first
  focus — which is fine (the dot appears on first focus). No change to lazy hydration.
- **`claude --version` / `--help` / a piped `claude | codex`.** The two-observation debounce
  handles brief transients. Two distinct agent processes in one pane → disambiguation
  returns `null` → stay a shell (herdr's rule). Same-agent siblings → `null` → shell.
- **User `cd`s then runs the agent.** The agent process `cwd` (phase-2 preferred source) is
  the directory the agent was launched in, regardless of later shell `cd`s. Use process cwd
  over `getLastCwd` when they differ.
- **User runs `claude --resume <id>` inside an already-promoted pane.** Phase 2's one-shot
  match does **not** re-link (by design — it would chase the wrong transcript). The pane
  keeps its original linked id, which is now stale. This is the documented v1 limitation;
  the dock shows the "session link may be stale after in-pane resume" hint. Phase 3 hooks
  fix it (each `SessionStart` re-reports). Phase-1 live status is unaffected.
- **Pane label recompute.** Promotion changes `paneType`/`agentKind`, so
  `tabLabels.ts`/`paneLabelText` recompute the tab/pane label automatically via the existing
  store subscription — no extra wiring, but verify the label updates on promote/demote.
- **Sweep cost when many shell panes exist.** The sweep runs only over shell-pane ptyIds
  and is paused when there are none. One process snapshot per sweep is shared across all
  shell panes (snapshot once, select per ptyId) — do not snapshot per pane.
- **Agent launched, then the shell pane is dragged to another window.** PTY routing/ownership
  rules (CLAUDE.md "Multi-Window State Invariants") apply unchanged; `sendToWindowForPty`
  re-routes `pane:agent-detected` to the new owning window. The promotion state lives in
  whichever window's store owns the pty at emit time; on cross-window move, the source
  window should carry the promoted `paneType`/`agentKind`/`promotedFromShell`/`sessionId`
  with the pane in the transfer (the existing `tab:absorb`/`tab:state-sync` machinery moves
  full pane metadata), and the destination applies it. Confirm the transfer preserves
  `promotedFromShell` (in-memory flag must be included in the cross-window pane snapshot
  even though it is not in the saved layout).

## Verification steps

- **Unit (phase 1, pure selector):** synthetic `ProcessEntry[]` snapshots covering:
  direct `claude.exe`/`codex.exe`; `node …/codex.js` and `node …/claude.js` package paths;
  `cmd /c codex.cmd`; `powershell -File claude.ps1`; `python -c '…' /tmp/codex` (must stay
  null); `node -e '…' /tmp/codex` (null); plain `git`/`vim`/`node build.js` (null); single
  agent chain (pick topmost ancestor); two distinct agents in one pane (null); same-agent
  siblings (null → shell); cycle-safe descent. Pin `process.platform` to `win32`
  (CLAUDE.md determinism). Mirror the assertions in herdr's `src/detect/mod.rs` and
  `src/platform/windows.rs` tests, on our data.
- **Unit (phase 2):** Codex claim with cwd + start-time, ambiguous → ignored, dedup across
  two panes. Claude newest-transcript-in-encoded-cwd match within grace, ambiguous →
  unlinked, one-shot (does not re-match after a simulated in-pane resume).
- **Integration (phase 1):** in a shell pane, type `claude` → pane promotes within ~6 s
  (two observations × 2–3 s sweep), status dot appears and tracks
  input-required/idle/working (spec 045), pane joins the Agents dock; exit Claude → pane
  demotes back to a shell, scrollback and the still-running shell prompt intact. Repeat
  with `codex`. Repeat with `node <codex package path>` to exercise the wrapper path.
  Confirm `git status` / `vim` / `node build.js` do not promote. Confirm a native
  (UI-spawned) agent pane does **not** demote when its agent exits (it shows its normal
  resume/retry state).
- **Integration (phase 1, persistence):** promote a pane via `claude` but do **not** let
  phase 2 link a session; close the app and restart → the pane comes back as a **shell**
  (phase-1-only promotion is not persisted). Then promote + let phase 2 link a session;
  restart → the pane hydrates as an agent pane and resumes the linked session.
- **Integration (phase 1, cross-window):** promote a pane in a detached window → the dot
  appears in that window. Drag the promoted pane to the primary window → the promotion
  (and `promotedFromShell`) carries over and the dot persists in the primary window.
- **Integration (phase 2):** after promotion, close the pane and restart the app → the
  promoted pane hydrates as an agent pane and resumes its linked session (Claude and
  Codex each). Confirm ambiguous-cwd case (two Claude CLIs in the same project dir within
  the grace window) leaves the pane unlinked, not mis-linked. Confirm a CLI-launched Codex
  that the user never messages stays unlinked (no spurious claim).
- **Unit (phase 1, Terminal effect):** a React Testing Library test that flips
  `paneType:'shell'`→`'agent'` on a pane with an unchanged `ptyId` and asserts the status
  interval starts (e.g. `detectFromRegions` is called / `setPaneAgentStatus` fires). This
  guards the deps-array fix.
- **Integration (phase 3):** toggle the setting on → marked hook block appears in
  `~/.claude.json` and `~/.codex/config.toml`, unrelated hooks preserved; launch `claude`
  in a shell pane → pane links the exact `sessionId` + transcript path; run `claude
  --resume <other>` inside the pane → re-links to the new id (the resume/fork case phase 2
  misses). Toggle off → marked block removed, unrelated hooks intact, `.bak` written.
- **Regression guards:** `npm run typecheck` and `npm test` green; the PATH-rewrite guard
  (`buildEnv.test.ts`) still passes (phase 3 env additions must not touch PATH); E2E
  (`npm run test:e2e`) still passes — the new env vars must not break the fake-agent
  command path or Claude deferred spawning.

## Handoff contract (non-negotiables)

1. **No vendoring.** Reimplement herdr's technique in our own code. herdr is AGPL-3.0 and
   read-only reference.
2. **Phase 1 ships first and stands alone.** It must land with tests, require **no config
   mutation and zero env-var changes** (the `MULTIAGENT_PANE_ID` env vars are phase 3 only),
   and not touch PATH. It has value by itself: live status + dock for CLI-launched agents.
   Two non-obvious must-dos ship with phase 1: (a) the `Terminal` connect effect's dep
   array must include `paneType`/`agentKind` so promotion/demotion re-runs it and the
   status interval starts/stops; (b) the in-memory `promotedFromShell` flag so only
   promoted panes demote and native agent panes keep their exit/resume behavior.
3. **Phase-1-only promotion is not persisted.** A promoted pane with no `sessionId` is
   serialized back to `paneType:'shell'` in the saved layout; promotion is persisted as
   `agent` only once phase 2 links a `sessionId`. Do not persist `promotedFromShell`.
4. **Phase 3 is opt-in and reversible.** It is the only phase that writes to agent config.
   It is off by default, user-consented, versioned, idempotent, marked-block, clean
   uninstall, `.bak` on every change, preserves unrelated hooks, and ships with a
   CLAUDE.md update recording the scoped exception. **Do not begin phase 3 without
   explicit user sign-off.**
5. **The `--session-id` launch path for app-spawned Claude panes is untouched.**
   `SessionSpawner.spawnNew` keeps generating a UUID and passing `--session-id`. Phase 2's
   Claude filesystem matching is strictly for CLI-launched agents we did not spawn.
6. **Conservative promotion.** Ambiguity = stay a shell / leave unlinked. Never mis-promote
   a plain shell command; never mis-link a session. Fail closed.
7. **Respect multi-window invariants.** Promotion/demotion are atomic tab-scoped
   transitions; no composed primitives. `PtyManager` is a singleton; delivery is via
   `windowManager.sendToWindowForPty`; `promotedFromShell` rides with the pane in
   cross-window transfers (`tab:absorb`/`tab:state-sync`).
8. **Tests ship with each phase** (CLAUDE.md boy-scout rule). The pure selector and the
   pure Codex/Claude matchers are extracted to testable modules with synthetic-input unit
   tests; integration coverage for the promote/demote and link flows; the `Terminal`-effect
   deps-array fix has its own RTL test.

## Definition of done

- Phase 1: typing `claude` or `codex` (and the wrapped variants above) in a shell pane
  promotes it within ~6 s — live status dot + Agents dock entry — and exiting demotes it
  back to a shell with scrollback intact; plain commands never promote; native agent panes
  never demote; phase-1-only promotion does not survive restart. Pure selector unit tests +
  the `Terminal`-effect deps test green; integration verified on Windows.
- Phase 2: a promoted+linked pane that is closed and restarted resumes its linked session
  for both agent kinds; ambiguous cases leave the pane unlinked, not mis-linked; an
  unmessaged CLI Codex stays unlinked. Unit + integration green.
- Phase 3 (only if approved): opt-in toggle installs/uninstalls the managed hook cleanly,
  preserves unrelated hooks, links the exact session id including across in-pane resume/fork,
  and CLAUDE.md records the exception.
- Phase 4 (NOT implemented; handoff — see the Phase 4 section): all session-id capture via
  hooks except app-launched Claude (`--session-id`). App-launched Codex links at start via
  hook + `--dangerously-bypass-hook-trust`; CLI-launched Claude via hook; CLI-launched Codex
  via hook after a one-time `/hooks` trust. File-poll detection (`codexDetection.ts`,
  `claudeCliLink.ts`, `promotedSessionLinker.ts`, SessionSpawner Codex poll) deleted. Phase 1
  promotion/demotion unchanged.

## Reference index

**herdr (read-only, do not copy):**
- Process-tree foreground-job selection (Windows, real impl): `src/platform/windows.rs`
  (`select_pane_foreground_job`, `snapshot_processes`, `descendant_entries`,
  `read_process_parameters`).
- Agent identification from process name/argv (wrappers, package paths, `-e`/`-c`
  ignoring): `src/detect/mod.rs` (`identify_agent`, `identify_agent_in_job`,
  `normalized_process_name`, `wrapped_agent_name_from_runtime_argv`).
- Unsupported-platform stub (do not confuse with the Windows impl):
  `src/platform/fallback.rs`.
- Managed hook install (idempotent, preserves unrelated hooks): `src/integration/
  config_edit.rs` (`ensure_command_hook`, `ensure_hooks_object`).
- Hook scripts (SessionStart → report session id + transcript path, gated on env vars):
  `src/integration/assets/{claude,codex}/herdr-agent-state.ps1`.
- **Codex hook install (Phase 4 reference):** `src/integration/targets.rs:167`
  (`install_codex`) — writes `~/.codex/hooks.json` via the same JSON `ensure_command_hook`
  surgery as Claude, with command `hook_command(hook_path, Some("session"))` (an action
  arg). `src/integration/config_edit.rs:687` (`build_codex_config_with_hooks`) — the
  minimal line-based TOML surgery that ensures `[features] hooks = true` in
  `~/.codex/config.toml`. herdr does NOT handle the Codex trust gate anywhere (grep
  `trust|bypass|dangerously` in `src/integration` → 0 hits); it accepts the one-time
  `/hooks` trust.
- Session-report IPC schema: `src/api/schema.rs:166` (`PaneReportAgentSession`).
- Pane-identity env var injection (Unix shown; Windows equivalent in the Windows backend):
  `src/pty/backend/unix.rs:77` (`HERDR_ENV_VAR`).

**MultiAgent (where this lands):**
- Spawn + agentKind assignment (the only current promotion path): `src/main/sessions/
  SessionSpawner.ts`, `src/renderer/src/store/panes.ts` (`runNewAgentSession`,
  `resumeIntoPane`, `splitPane`/`spawnInTab`; hydrate-resume guard at `panes.ts:202`;
  `setSessionId` at `panes.ts:1287`).
- `PtyManager` is a **singleton** (`src/main/ipc/handlers.ts:57`); the shell pid comes from
  its `ready` event (`src/main/pty/PtyManager.ts`). Cross-window delivery +
  pane-cwd tracking (phase-2 cwd fallback): `src/main/ipc/ptyOutputRouter.ts`
  (`windowManager.sendToWindowForPty`, `getLastCwd`).
- Status tick is in the **`Terminal` component** (`src/renderer/src/components/Terminal/
  index.tsx:596`), gated `isAgentPane && pane.agentKind`; its connect effect deps must be
  extended to re-run on promotion/demotion (phase 1). `PaneHeader` reads `agentStatus`
  only for agent panes (`PaneHeader/index.tsx:42`).
- IPC listeners to model the new `pane:agent-detected` listener on, and the **reused**
  `session:detected` listener: `src/renderer/src/store/panesIpc.ts:38`
  (`findLeafByPtyId` + `setSessionId`). IPC channel source of truth: `src/shared/types.ts`
  (`session:detected` at `:385`).
- Claude transcript dir encoding (phase 2): `src/main/sessions/claudePaths.ts`
  (`claudeProjectDirForCwd`, `claudeTranscriptPathForCwd`).
- Codex cwd/time detection to generalize: `src/main/sessions/codexDetection.ts`
  (`selectCodexAssignments`); candidate filters (`originator`/`source`) in `SessionSpawner.
  _readNewCodexCandidates`.
- Agents dock + status dot: `src/renderer/src/components/Sidebar/AgentsDock.tsx`,
  `SidebarDock.tsx`, `src/renderer/src/components/PaneHeader/index.tsx`.
- Pane label recompute on promote/demote: `src/renderer/src/utils/tabLabels.ts`.
- Claude transcript scanner (for firstActivity used in phase-2 matching):
  `src/main/sessions/TranscriptScanner.ts`.
- Env injection + scrubbing (phase 3 env vars, PATH-rewrite guard):
  `src/main/pty/buildEnv.ts`, `SessionSpawner.agentEnv`.
- Multi-window atomic-transition discipline + cross-window pane transfer:
  CLAUDE.md "Multi-Window State Invariants"; `tab:absorb`/`tab:state-sync` in `panesIpc.ts`.
- Packaging (hook script asset shipping, native module rebuild, `asarUnpack` for a new
  `*.node`): `package.json` `build.files` / `asarUnpack`, `postinstall`; CLAUDE.md
  "Packaging Notes".

## Related specs

- **045** — sidebar Agents section + live status (the screen/OSC engine this spec
  activates for promoted panes). This spec is the pane-promotion + session-linkage
  complement to 045's live-status work.
- **046** — herdr detection findings. Its "finding B" (foreground-process identification)
  is corrected above and adopted here as phase 1; its "finding A" (hook-based capture) is
  adopted here as phase 3 with the opt-in policy exception 046 only sketched.
- **007** — Claude session id at launch (`--session-id` path this spec preserves, and the
  sole exception under Phase 4).
- **008** — Codex filesystem session matching (the cwd/time scanner phase 2 generalizes).
  **Phase 4 supersedes 008** — the scanner is deleted in favor of the Codex SessionStart
  hook; 008's cwd/time/ambiguity-ignored invariants inform the hook design but the
  filesystem-poll mechanism is retired.