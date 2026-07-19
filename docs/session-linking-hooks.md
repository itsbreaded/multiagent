# Session Linking via Managed Hooks (Architecture)

How MultiAgent links a running agent session to its pane — i.e. how a pane knows
*"this is Claude/Codex session `<id>`, resume it on restart"* — even when the agent was
typed by hand inside a shell pane instead of spawned through the UI.

This covers spec 047 phase 4. If you only read one section, read
[How the hook talks back to the app](#how-the-hook-talks-back-to-the-app) — that's the
core mechanism.

---

## The problem

A "pane" is a terminal in the UI. An "agent session" is a Claude or Codex conversation
with a unique `session_id` (and a transcript file on disk). For resume-on-restart and the
Session Browser to work, the pane needs to know which `session_id` is running inside it.

- **App-launched Claude** is easy: MultiAgent generates the UUID and launches
  `claude --session-id <uuid>`, so the id is known the instant the pane is created.
- **Everything else** (app-launched Codex, CLI-launched Claude, CLI-launched Codex) has no
  launch-time id available to us. The agent creates its own `session_id` internally. We
  need the agent to *tell us* what it is.

The mechanism: a **`SessionStart` hook** the agent runs at session start, which reports the
id back to MultiAgent over a **localhost HTTP endpoint**.

> Note: the *global session index* (`TranscriptScanner`/`CodexSessionScanner`, the 5s poll
> that powers the Session Browser) is a separate feature and is **not** what links a pane
> to a session. This doc is about the pane-linking hook path only.

---

## The big picture

```
                         ┌─────────────────────────────────────────────┐
                         │              MultiAgent main process         │
                         │                                             │
   agent CLI  ──────────▶│  (nothing here knows the session id yet)     │
   (claude/codex)        │                                             │
                         │  PtyManager spawns the agent PTY with env:   │
                         │    MULTIAGENT_PTY_ID    = <pane ptyId>       │
                         │    MULTIAGENT_ENV       = 1                  │
                         │    MULTIAGENT_HOOK_PORT = <report server>   │
                         └─────────────────────────────────────────────┘
                                              │ env inherited by the agent
                                              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  agent (claude / codex)                                          │
   │                                                                  │
   │  on SessionStart: reads hooks config, runs our hook command:     │
   │    powershell.exe -NoProfile -ExecutionPolicy Bypass `           │
   │      -File "<userData>/multiagent-agent-state.ps1" <claude|codex>│
   │                                                                  │
   │  feeds it JSON on stdin:                                         │
   │    { "session_id": "...", "transcript_path": "...",              │
   │      "hook_event_name": "SessionStart", "source": "startup" }    │
   └──────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  multiagent-agent-state.ps1  (our hook script)                   │
   │                                                                  │
   │  • bails unless MULTIAGENT_ENV=1 + PTY_ID + HOOK_PORT are set    │
   │    (so it's a no-op for agents launched outside MultiAgent)      │
   │  • bails if MULTIAGENT_SESSION_ID is set (app-Claude already has │
   │    its --session-id; no redundant report)                        │
   │  • parses stdin JSON → POSTs the id to our report server         │
   └──────────────────────────────────────────────────────────────────┘
                                              │ HTTP POST
                                              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  AgentSessionReportServer  (127.0.0.1, random port)              │
   │  endpoint: POST /agent-session                                   │
   │  body: { ptyId, agentKind, sessionId, transcriptPath }           │
                         │
                         │  onReport(report)
                         ▼
                         │  main emits IPC: session:detected(ptyId, agentKind, sessionId)
                         │  → routed to the owning window via windowManager.sendToWindowForPty
                         ▼
                         │  renderer (panesIpc.ts) listener:
                         │    find pane by ptyId → promote if still a shell → setSessionId
                         ▼
                         │  pane now carries sessionId → saved to layout.json → resumes on restart
```

The key insight: **the agent process and the MultiAgent main process are otherwise
unrelated.** The only bridge between them is (a) env vars MultiAgent sets on the PTY that
the agent inherits, and (b) the HTTP POST the hook script makes back to a port MultiAgent
is listening on. There is no IPC channel, no shared file watcher, no out-of-band channel.

---

## How the hook talks back to the app

This is the heart of it.

### 1. MultiAgent starts a tiny localhost HTTP server

At startup, `registerIpcHandlers` (in `src/main/ipc/handlers.ts`) creates an
`AgentSessionReportServer` (`src/main/integration/agentSessionReportServer.ts`). It binds
to **`127.0.0.1` only** (loopback — never exposed to the network) on an
**OS-assigned random port** (`listen(0, '127.0.0.1')`). The port is not fixed so there's no
collision risk.

It listens for exactly one thing:

```
POST http://127.0.0.1:<port>/agent-session
Content-Type: application/json
Body: { "ptyId": "<pane ptyId>", "agentKind": "claude"|"codex",
        "sessionId": "<uuid>", "transcriptPath": "<path or null>" }
```

Anything else (wrong method, wrong path, missing/invalid fields, unknown agentKind) → 400
or 404, and `onReport` is **not** called. The server validates `agentKind` against
`['claude','codex']`.

### 2. Each pane is tagged with identity env vars

`PtyManager` is constructed with a `getPaneEnv(ptyId)` callback. For **every** pane (shell
and agent) it injects:

| Env var | Meaning |
|---|---|
| `MULTIAGENT_PTY_ID` | The pane's ptyId — so the report knows *which pane* to link. |
| `MULTIAGENT_ENV` | `1` — the hook's "am I inside MultiAgent?" gate. |
| `MULTIAGENT_HOOK_PORT` | The report server's port — where to POST. |

These ride in the PTY's environment, so any process launched in that pane (the shell, and
any agent the user types into it) inherits them. `buildEnv` **scrubs** inherited copies of
all four `MULTIAGENT_*` vars first, so a MultiAgent launched *inside* a MultiAgent pane
can't accidentally reuse the outer pane's identity.

`getPaneEnv` only returns the vars while the session-linking toggle is on (default-on). If
the report server hasn't assigned a port yet, `MULTIAGENT_HOOK_PORT` is omitted and the hook
bails silently for that pane.

### 3. The agent fires the hook at SessionStart

Both Claude and Codex support a `SessionStart` hook: when a session begins, they run a
configured command, feeding it a JSON payload on **stdin**:

```json
{ "session_id": "019f62df-...",
  "transcript_path": "C:\\Users\\...\\rollout-....jsonl",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "cwd": "C:\\Code\\multiagent",
  "model": "gpt-5.5", ... }
```

(`source` is one of `startup | resume | clear | compact` — so an in-pane `claude --resume`
or `codex resume` *re-fires* the hook with the new id, which is exactly what we want.)

The hook command MultiAgent installs is **platform-split**:

```
# Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<userData>/multiagent-agent-state.ps1" <claude|codex>

# Linux / macOS
bash '<userData>/multiagent-agent-state.sh' <claude|codex>
```

Both do the same thing; the only differences are the shell and the HTTP client
(`Invoke-RestMethod` on Windows, `curl` on Unix — both preinstalled). The path is
single-quoted on Unix so a userData path with a space (macOS `~/Library/Application Support/…`)
survives shell parsing. The script is chosen by `process.platform` at install time.

### 4. The hook script POSTs the id home

`multiagent-agent-state.ps1` (`src/main/integration/assets/`, copied to
`<userData>/multiagent-agent-state.ps1` at install time) does, in order:

1. `if ($env:MULTIAGENT_SESSION_ID) { exit 0 }` — app-launched Claude already knows its id
   (passed `--session-id`); skip the redundant report.
2. `if ($env:MULTIAGENT_ENV -ne '1') { exit 0 }` — not inside MultiAgent; no-op.
3. Read `MULTIAGENT_PTY_ID` + `MULTIAGENT_HOOK_PORT`; bail if either is missing.
4. Read stdin, parse JSON, pull `session_id` + `transcript_path`; bail if no `session_id`.
5. `Invoke-RestMethod -Method POST` to `http://127.0.0.1:<port>/agent-session` with the
   `{ ptyId, agentKind, sessionId, transcriptPath }` body. 2s timeout.

**Every failure path exits 0 silently.** A hook must never block or break the agent's
session start.

### 5. Main links the id to the pane

When the report server's `onReport` fires, main does:

```ts
windowManager.sendToWindowForPty(r.ptyId, 'session:detected', r.ptyId, r.agentKind, r.sessionId)
```

This is the existing `session:detected` IPC event, routed to whichever window owns that
ptyId (cross-window correct — `PtyManager` is a singleton, panes can live in detached
windows). The renderer listener in `panesIpc.ts`:

1. Finds the pane by `ptyId` across all tabs.
2. **If the pane is still a `shell` pane** (the hook fired before the process-tree sweeper
   promoted it — a race), promotes it to an agent pane first.
3. Calls `setSessionId(pane.id, sessionId)`.

Done. The pane now carries the `sessionId`, which is saved to `layout.json`, so on restart
the pane resumes that exact session.

### The report-server port: how it's chosen and how it reaches the hook

A natural question: the hook POSTs to `http://127.0.0.1:<port>/agent-session` — what picks
`<port>`, and how does the hook script know it? It's a two-part handoff: **the OS picks the
port; an env var carries it to the hook.**

**The OS picks the port.** The report server binds to port **`0`**:

```ts
// agentSessionReportServer.ts
this.server.listen(0, '127.0.0.1', () => {
  const addr = this.server?.address()
  this._port = addr && typeof addr === 'object' ? addr.port : null
})
```

`listen(0, …)` is the standard convention: port `0` means *"OS, you pick an unused
ephemeral port."* On Windows that's a dynamic-range port (~49152–65535). The OS chooses
whatever is free at bind time, and `server.address().port` returns the actual number, which
we store in `_port`. We don't compute it — the OS assigns it, **fresh each app launch**
(which is why different runs show different ports, e.g. `49726`, `51466`, `59587`).
Binding to `0` means there's never a collision with another process.

**An env var carries it to the hook.** The chosen port is stamped onto every pane's
environment by `PtyManager`'s `getPaneEnv` callback:

```ts
// handlers.ts
getPaneEnv: (ptyId) => {
  if (!cliSessionLinkingEnabled) return {}
  const port = reportServer.port                       // the OS-assigned port
  const base = { MULTIAGENT_PTY_ID: ptyId, MULTIAGENT_ENV: '1' }
  return port ? { ...base, MULTIAGENT_HOOK_PORT: String(port) } : base
}
```

That env is applied to the PTY at spawn, so the shell — and any agent the user runs inside
it — inherits `MULTIAGENT_HOOK_PORT`. The hook script, launched by the agent as a child
process, inherits it too and reads it:

```ps1
# multiagent-agent-state.ps1
$port = $env:MULTIAGENT_HOOK_PORT
...
Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/agent-session" -f $port) ...
```

Full chain:

```
OS assigns a free port (listen 0)
        │  stored in reportServer.port
        ▼
getPaneEnv reads it  →  MULTIAGENT_HOOK_PORT=<port> on the pane env
        │  inherited by shell → agent → hook script
        ▼
hook reads $env:MULTIAGENT_HOOK_PORT  →  POST http://127.0.0.1:<port>/agent-session
```

**The timing wrinkle (and the startup-race fix).** The port is assigned *asynchronously* —
the `listen` callback fires on the next tick, so `reportServer.port` is `null` for a few
milliseconds after startup. If a pane were spawned in that window, `getPaneEnv` would omit
`MULTIAGENT_HOOK_PORT` and the hook would bail (no port → no POST → that pane wouldn't link
that launch).

`reportServer.ready()` is a promise that resolves once `_port` is set (it polls every 5ms
until the `listen` callback fires). The `session:new` / `session:resume` IPC handlers
**`await` that promise before spawning**, so by the time any pane is created the port
exists and `getPaneEnv` can stamp it onto the env. This is the startup-race fix mentioned
again under [The toggle](#the-toggle).

---

## What gets installed where (the config mutation)

This is the scoped exception to the "don't mutate agent config" rule, and it's reversible
from the toggle. With the toggle **on** (default), `ManagedHookController`
(`src/main/integration/managedHookController.ts`) writes a managed, marked, idempotent set of managed hook entries into each file
(spec 047 `SessionStart` for linking + spec 032 lifecycle events for status badges):

| File | What | Surgery |
|---|---|---|
| `~/.claude/settings.json` | Claude `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification` (matcher `permission_prompt`), `Stop`, `StopFailure` | `managedHooks.ts` (JSON) |
| `~/.codex/hooks.json` | Codex `SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PermissionRequest` (matcher `.*`), `Stop` | `managedHooks.ts` (same JSON shape) |
| `~/.codex/config.toml` | `[features] hooks = true` | `codexConfigFeatures.ts` (line-based TOML) |

Properties:
- **Marked / sentinel-based**: our entry is detected by the substring
  `multiagent-agent-state` (the script basename **without** extension) in the command, so
  it matches both the Windows `.ps1` and Unix `.sh` command strings, and reinstall updates
  *our* entry in place instead of duplicating. Unrelated hooks/keys are never touched.
- **Idempotent**: if nothing changed, the file isn't rewritten (no `.bak` spam on every
  startup).
- **Self-cleaning on install (reconcile)**: `install` is not additive-only. Before injecting
  the current event set it prunes any of our (sentinel-tagged) entries from event keys NOT in
  that set, so an event dropped in a new version (e.g. Codex `PostToolUse`, dropped in spec
  032 because `PreToolUse` + `Stop` already cover the badge state) is swept on the next
  startup — no manual cleanup, no full uninstall needed. `uninstall` is the empty-allow-list
  case of the same sweep (removes our entries across all keys).
- **`.bak` on every actual change** + atomic temp-file-and-rename.
- **Legacy cleanup**: also strips any stray managed hook a prior version left in
  `~/.claude.json` (Claude doesn't read hooks from there).
- **On uninstall**: both hooks removed; the `[features] hooks = true` flag is intentionally
  **left** (matches herdr; harmless once the hook entry is gone).

### The hook script lives at a fixed path

The platform-appropriate bundled script (`multiagent-agent-state.ps1` on Windows,
`multiagent-agent-state.sh` on Linux/macOS) is copied to **`<userData>/multiagent-agent-state.<ps1|sh>`**
at install time (refreshed only when the bundled content changes). The hook commands point
there, not at the app install dir. Reason: **Codex persists hook trust as a hash of the
command string.** If the command string changed across app versions, Codex would revoke
trust and re-prompt. A fixed path keeps the command byte-identical across dev / packaged /
version bumps, so trust survives upgrades. (The command embeds only the `<userData>` script
path — never the Electron binary path — which is why we use bash/powershell rather than
Node-via-Electron: the latter would put an install-location-dependent runtime path in the
command and destabilize trust.)

---

## Claude vs Codex — the differences that matter

The two agents share the same hook shape but diverge in three ways. Getting any of these
wrong breaks linking silently.

### 1. The `matcher` field

The hook entry sits in a group: `{ "matcher": "...", "hooks": [...] }`. The matcher decides
which SessionStart sources fire the hook.

- **Claude**: `"matcher": ""` — empty string means *match all sources*. Works (verified
  firing).
- **Codex**: **omit the `matcher` key entirely.** In Codex, an empty-string matcher matches
  *nothing* — the hook shows as Trusted in `codex /hooks` but never fires. This is the
  single most load-bearing difference. `injectManagedHook(cfg, cmd, null)` for Codex vs
  `injectManagedHook(cfg, cmd, '')` for Claude. (Mirrors herdr's `install_codex`.)

### 2. The trust gate (Codex only)

Codex requires the user to **review and trust** command hooks once via the `codex /hooks`
TUI before they run. There's a `--dangerously-bypass-hook-trust` flag that skips it, but
MultiAgent **does not use it**. Instead:

- The user accepts the managed hook once via `codex /hooks`.
- Codex records the trust in `~/.codex/config.toml` under `[hooks.state]` as a hash of the
  hook command.
- That persisted trust covers **every future Codex launch** (app-launched and CLI-launched
  alike), because the command string is stable (fixed script path).

Claude has no trust gate — its hook just runs.

### 3. *When* SessionStart fires

- **Claude**: fires at cold launch. A Claude pane links immediately.
- **Codex**: the interactive TUI **defers `SessionStart` until the first user message**,
  because that's when the rollout (and the `session_id`) is created. So a Codex pane links
  on its **first message**, not at launch. This is inherent to Codex — there is no
  `session_id` before the first message, so "right away" is impossible by any mechanism.
  Do not treat first-message Codex linking as a bug; it's the earliest possible moment.

  (Aside: reports of "Codex TUI doesn't fire hooks" — openai/codex#17532 — are about
  repo-local config and testers who never sent a message. User-level `~/.codex/hooks.json`
  **does** fire, at first message. Verified live.)

### App-launched Claude — the one exception

App-launched Claude does **not** use the hook for its id. `SessionSpawner.spawnNew`
generates a UUID and launches `claude --session-id <uuid>`, so the renderer has the id at
spawn. To stop the global Claude hook from re-reporting that same id, app-Claude panes also
set `MULTIAGENT_SESSION_ID=<guid>` via `agentEnv`, and the hook script bails on that env var
(step 1 above). The hook is still installed globally (for CLI-launched Claude), but it's a
no-op for app-launched Claude panes.

---

## The toggle

Settings → Terminal → **"Session linking & live status (managed hooks)"**, **default-on**.

- Main is the authority (`<userData>/cli-session-linking.json`). The renderer hydrates its
  checkbox from main at startup (`settings:get-cli-session-linking`) so the two never drift.
- Turning it on: starts the report server, installs both hooks + the `[features]` flag.
- Turning it off: stops the report server, uninstalls both hooks (leaves `[features]`).
- Default-on because app-launched Codex can **only** link via the managed hook (there's no
  scanner fallback anymore); if it were off, only app-launched Claude would link (via
  `--session-id`).

### Startup race fix

The report server's port is assigned asynchronously. If an app-Codex pane were spawned in
the first few milliseconds (e.g. layout restore on startup), before the port was assigned,
`getPaneEnv` would omit `MULTIAGENT_HOOK_PORT` and the hook would bail — missing the link
for that launch. To prevent this, the `session:new` / `session:resume` IPC handlers
**`await` the initial `applyCliSessionLinking` promise** before spawning, so the port is
always assigned first.

---

## Failure modes (everything fails closed)

The system is designed so that a failure anywhere leaves the pane **promoted but unlinked**
— never mis-linked.

- **Hook not installed / toggle off**: no hook fires; app-Claude still links via
  `--session-id`; Codex panes don't link.
- **Codex hook not trusted yet**: hook doesn't run; pane stays unlinked until the user
  trusts via `codex /hooks`. No spurious id.
- **Report server down / port missing**: hook bails (no `MULTIAGENT_HOOK_PORT`); no POST;
  pane unlinked. Next launch links.
- **POST fails / malformed body**: server returns 400/404; `onReport` not called; pane
  unlinked. Hook still exits 0 (never breaks the agent).
- **`session_id` absent in payload**: hook bails; pane unlinked.
- **Wrong ptyId / pane not found**: `session:detected` is sent but the renderer finds no
  pane for that ptyId; nothing happens.

In all cases the pane continues to work as a terminal — only the session linkage is lost.

---

## File map

| File | Role |
|---|---|
| `src/main/integration/assets/multiagent-agent-state.ps1` | The hook script for **Windows** (bundled asset). Bails unless inside MultiAgent, POSTs the id home via `Invoke-RestMethod`. |
| `src/main/integration/assets/multiagent-agent-state.sh` | The hook script for **Linux/macOS** (bundled asset). Bash port: pure-`sed` JSON parse (no `jq`) + `curl`. Same logic as the `.ps1`. |
| `src/main/integration/agentSessionReportServer.ts` | The localhost HTTP server (`POST /agent-session`). |
| `src/main/integration/managedHooks.ts` | Pure JSON surgery for the `SessionStart` hook entry (kind-agnostic; matcher `''` vs `null`); `generateHookCommand(path, kind, platform)` — win32 → powershell + `.ps1`, else → bash + `.sh`. |
| `src/main/integration/codexConfigFeatures.ts` | Pure TOML surgery for `[features] hooks = true` in `~/.codex/config.toml`. |
| `src/main/integration/managedHookController.ts` | IO orchestrator: installs/uninstalls both hooks + the feature flag, copies the script to `<userData>`, writes `.bak`, atomic replace, legacy cleanup. |
| `src/main/ipc/handlers.ts` | Constructs the report server + controller, wires `getPaneEnv`, emits `session:detected` from `onReport`, default-on apply + startup-race `await`. |
| `src/main/pty/buildEnv.ts` | Scrubs inherited `MULTIAGENT_*` vars so a nested MultiAgent can't reuse them. |
| `src/main/sessions/SessionSpawner.ts` | App-Claude `--session-id` + `MULTIAGENT_SESSION_ID` via `agentEnv`. (Codex launches plain — no bypass flag.) |
| `src/main/pty/agentProcessSweeper.ts` | Phase 1: process-tree promotion/demotion of shell panes that host a CLI agent. Independent of the hook; needed for demotion-on-exit (hooks fire on start, not exit). |
| `src/renderer/src/store/panesIpc.ts` | Listener for `session:detected` → promote-if-shell → `setSessionId`. |
| `src/renderer/src/store/settings.ts` + `…/CliSessionLinkingSetting.tsx` | The toggle (default-on, hydrates from main). |
| `electron.vite.config.ts` | Emits both `multiagent-agent-state.ps1` and `.sh` beside `out/main/index.js` at build time (runtime picks by platform). |

---

## Live status badges (spec 032)

The same managed hooks also drive a per-pane status badge (`idle` / `working` / `waiting` /
`error` / `unknown`) in each agent's `PaneHeader`. The hook script POSTs each lifecycle
event to a second report-server route, `/agent-event`, which main forwards raw to the
owning pane's renderer; the renderer runs a pure `eventToState` reducer per pane. State is
in-memory only (never persisted) and sourced **entirely from the agent's own hook events** —
never from screen/OSC scraping (the lesson of the rolled-back spec 048). No hook events yet
=> `unknown`, the honest fallback.

Event -> state mapping (the reducer in `src/shared/agentStatus.ts`):

| Event | State |
|---|---|
| `session_start` | `idle` (session ready, waiting for input; seeded only on cold start) |
| `user_prompt_submit` | `working` (turn started) |
| `pre_tool_use` / `post_tool_use` | `working` (detail = tool name) |
| `permission_request` | `waiting` (permission prompt — needs you) |
| `stop` | `idle` (turn ended) |
| `stop_failure` | `error` (Claude only) |
| `promote` / `demote` (synthetic, from the process sweeper) | `working` / clears the badge |

Claude vs Codex for badges:
- **Claude** reports permission prompts via the `Notification` hook (matcher
  `permission_prompt`) and turn failures via `StopFailure`, so all five states are
  reachable.
- **Codex** has **no `Notification` hook** and **no `StopFailure`**. Permission prompts come
  from the `PermissionRequest` hook (matcher `.*`); a failed Codex turn simply shows `idle`
  (honest — there is no hook error signal to report). `error` is therefore Claude-only via
  hooks. Spec 050 adds the scoped, opt-in `agentStatusScraping` complement that detects
  Codex fatal terminal errors (e.g. provider-compat 4xx/5xx) from the PTY byte stream as a
  latched `terminal_error` event — see `docs/pty-and-terminals.md`. It is off by default and
  composes at the reducer; it does not add a hook or a second status write path.
- Both seed `working` on every turn via `UserPromptSubmit` (Codex ignores the matcher for
  that event but still fires it; turn identity is Codex's `turn_id`, Claude's `prompt_id`).
- Turn identity (`prompt_id` / `turn_id`) lets the reducer drop out-of-order late tool
  events after a `stop` without a monotonic counter; when it is absent (older Claude) the
  reducer stays `idle` rather than flap.

The `SessionStart` command is intentionally kept arg-less (byte-identical to the 047
install) so Codex's persisted `/hooks` trust for `SessionStart` survives the 032 upgrade;
only the **new** lifecycle-event commands add a 2nd positional arg and require a fresh
one-time trust via `codex /hooks`.

---
## Quick reference: the full Claude flow

1. User spawns a Claude pane (UI) → `SessionSpawner.spawnNew` generates UUID, launches
   `claude --session-id <uuid>`, sets `MULTIAGENT_SESSION_ID=<uuid>` in the pane env.
2. Renderer receives the id immediately. Pane linked. (Hook fires too, but bails on
   `MULTIAGENT_SESSION_ID` — no redundant report.)

## Quick reference: the full Codex flow

1. User spawns a Codex pane (UI) **or** types `codex` in a shell pane.
   - If CLI-launched, the `AgentProcessSweeper` promotes the shell pane to an agent pane
     (process-tree detection). The pane has no id yet.
2. Pane env has `MULTIAGENT_PTY_ID` / `MULTIAGENT_ENV` / `MULTIAGENT_HOOK_PORT`.
3. Codex starts. **First time only**: it prompts the user to trust the managed hook via
   `/hooks`. User accepts. Codex records `[hooks.state]` trust in `config.toml`.
   - (If the user already trusted it on a prior launch, this step is skipped.)
4. User sends their first message → Codex creates the rollout → fires `SessionStart`
   (source `startup`).
5. Codex runs `powershell … multiagent-agent-state.ps1 codex`, feeds it the payload on
   stdin.
6. The script POSTs `{ ptyId, agentKind:'codex', sessionId, transcriptPath }` to
   `http://127.0.0.1:<port>/agent-session`.
7. Report server → `onReport` → main emits `session:detected(ptyId, 'codex', sessionId)`.
8. Renderer finds the pane by ptyId, promotes if needed, `setSessionId`. Pane linked.
9. On a later `codex resume <id>` inside the same pane, step 4–8 repeat with the new id, so
   the pane follows the fork.
10. On app restart, the pane's saved `sessionId` → `hydrateTabRuntime` → `session:resume`.