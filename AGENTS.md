# AGENTS.md

This file provides shared guidance for Codex and Claude Code when working with code in this
repository.

Treat this as a living document. Keep it concise and operational — guardrails + architecture
map + docs index — so an agent can scan it before acting.

## Shared Agent Skills

Project skill contents live only in `.agents/skills/`. On Windows, `.claude/skills/` is a local,
uncommitted directory junction to that canonical directory. Read and edit skills through their
`.agents/skills/<skill>/SKILL.md` paths; do not create copies or commit the `.claude/skills/`
alias.

### How to document a change (the repo pattern)

This file and `docs/` are a **two-layer split**. Follow it when adding or changing anything
non-obvious, so the structure stays scannable and the mechanism detail stays findable:

- **`AGENTS.md` holds rules.** A durable constraint a future agent must respect at decision
  time goes in `## Guardrails` as one terse line under the right group ("Do not…", "Keep…",
  "must not…"). If a new subsystem area doesn't fit an existing group, add a group with a
  `→ docs/<file>.md` link.
- **`docs/<subsystem>.md` holds mechanism/why.** The narrative behind a rule — how it works,
  root-cause history, config surgery, failure modes — goes in the relevant doc. One doc per
  cohesive subsystem; don't fragment a subsystem across files or cram unrelated subsystems
  into one.
- **Rule ↔ doc pointers go both ways.** A guardrail group ends with `→ docs/<file>.md`; the
  doc's header names which `AGENTS.md` guardrails it expands. When you add a new `docs/` file,
  add a row to the **Docs index** table; when you remove or merge a doc, drop its row.
- **Prefer a rule over a doc when the lesson is one line.** Don't create a doc to hold a
  single sentence — fold it into `AGENTS.md` and link nothing. Don't create a doc that
  duplicates code comments or git history.
- **No prose sections in `AGENTS.md` for mechanism.** If you find yourself narrating *how*
  something works here, move it to the doc and leave the one-line rule behind. The test: an
  agent mid-edit needs the rule; it reads the doc only when it's touching that subsystem.

`## Planning Specs` below is the exception — specs live in `specs/`, not `docs/`.

## Planning Specs

Use `specs/pending/` for planned work that needs design before implementation. Name spec
files with a three-digit global sequence and kebab-case title, e.g.
`001-lazy-tab-hydration.md`. Before creating a new spec, check both `specs/pending/` and
`specs/done/` and use the next unused number across both folders, preserving the number when
moving the file to `specs/done/`. A pending spec should describe the problem, current
behavior, intended behavior, risks, and verification steps. Implementation phases and
repository-specific HOW details belong in the adjacent plan. If the spec is intended as a
handoff to another developer or agent, include a clear handoff contract with non-negotiables
and a definition of done. Keep specs practical and delete or move them when they stop being
useful; do not keep stale todos or historical investigation logs around.

The lifecycle is `draft-spec -> brainstorm-spec -> plan-spec -> review-plan -> execute-spec -> verify-spec`.
Specs contain WHAT/WHY; the adjacent `<slug>.plan.md` contains the verified repository-specific HOW.
`execute-spec` requires `Plan Status: approved` for a ready spec and must not invent a minimal plan
to bypass the pre-execution review. See [`docs/writing-plans.md`](docs/writing-plans.md).

### Agent workflow guardrails

- A plan approval is a technical readiness gate, not authorization for an unapproved product,
  security, privacy, cost, destructive, or external-side-effect decision; route those choices
  to the user or maintainer before execution.
- Record requirements, scenarios, non-goals, decisions, feedback, and verification evidence in
  the spec/adjacent plan or a focused follow-up artifact; do not make chat the only record.
- Never claim a check, review, runtime observation, or user approval that did not occur. Treat
  missing behavioral evidence as `UNVERIFIED`, and do not archive around it.
  → [`docs/writing-specs.md`](docs/writing-specs.md), [`docs/writing-plans.md`](docs/writing-plans.md)

Move completed specs to `specs/done/` only when they still provide durable context worth
preserving. If the useful lesson is short, fold it into `AGENTS.md` instead and delete the spec.

## Commands

```bash
npm run dev        # start dev server (Electron + Vite HMR)
npm run build      # compile only (no packaging)
npm run typecheck  # TypeScript type-check without emitting
npm run test       # vitest run (both projects, no coverage)
npm run test:e2e   # build + Playwright Electron smoke tests (isolated temp profile)
npm run dist       # build + package to dist\ (host OS; requires Windows Developer Mode on win)
```

`postinstall` rebuilds native modules for the Electron ABI — do not add `--ignore-scripts`.
Test/coverage/watch flags, the native-rebuild details, and the regression-guard harness are
covered in [`docs/testing.md`](docs/testing.md). Packaging, per-OS artifacts, signing, and
the release publish flow are in [`docs/packaging-and-release.md`](docs/packaging-and-release.md).

## Architecture

Three Electron processes:

1. **Main** (`src/main/`) — IPC, PTY management, session indexing, browser panel
2. **Preload** (`src/preload/index.ts`) — typed `window.ipc` bridge (`invoke`/`on`/`send`)
3. **Renderer** (`src/renderer/`) — React + Zustand, xterm.js terminals, all UI

All IPC channel names and their signatures are the single source of truth in
`src/shared/types.ts`.

## Guardrails

Terse non-negotiables. The mechanism/why for each group is in the linked doc.

### Terminals & PTY → [`docs/pty-and-terminals.md`](docs/pty-and-terminals.md)

- **No PATH rewrite for terminal panes.** `buildEnv` must keep `env.PATH === process.env.PATH`
  and scrub inherited Claude flags + `MULTIAGENT_*` vars. `buildEnv.test.ts` guards this.
- **No flow control** in PTY output or the renderer pipeline — no coalesce/ack/pause/watermarks.
  `pty:data` is `seq=0`, synchronous `terminal.write`. Resize is one-way `send`, not `invoke`.
- Terminal-host failure must clear every affected PTY id, allow only one replacement-host attempt
  per incident, and preserve only verified agent session identity; see the recovery mechanism in
  `docs/pty-and-terminals.md`.
- Agent PTYs spawn at the fitted pane size via the `deferSpawn` handshake — never 80×24 then
  resize. Agent panes launch the agent command directly through a non-profile shell — no
  interactive-shell-then-type.
- Agent panes must **not** fall back to `os.homedir()` on missing cwd — reject with
  `resumeError`. Shell panes may fall back.
- Don't set `CLAUDECODE`/`CLAUDE_CODE_DISABLE_*`/`CLAUDE_CODE_NO_FLICKER` in the generic or
  default Claude env; `buildEnv` scrubs inherited copies. Only default Claude env is
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`. Keep Codex `--no-alt-screen`
  `-c tui.animations=false -c tui.terminal_title=[]`.
- Shell CWD via OSC 633, sourcing the `<userData>`-materialized copy of
  `shellIntegration.{ps1,sh}`, **not** the raw asar path. Don't reintroduce `shellterm:*`/Bare
  Term. One process-snapshot mechanism per platform behind `snapshotProcesses()`; fails closed.
- Renderer resize: VS Code principle (immediate first/small, vertical immediate, horizontal
  debounced) — no raw `ResizeObserver -> pty.resize` loops. `resolveBackend` is the single
  renderer decision point; `auto` must avoid software-rendered WebGL. Don't silently lower the
  250_000-line scrollback default.
- **Terminal-error scraping is the one scoped (`agentStatusScraping`, default on,
  toggleable off) exception** to the hooks-only badge discipline: it feeds `eventToState`
  as a `terminal_error` event, latched until the next
  `user_prompt_submit`/`session_start`/`demote`. Codex-only at launch, agent-agnostic
  plumbing; canonical signatures only from a rolling fresh-output buffer (never scrollback,
  never keywords like `Error:`/`panic` — that's the rolled-back spec 048). No second status
  write path, no new managed hooks. Provider-authoritative empty work evidence is the only
  automatic-suspension authorization; Claude work snapshots ignore explicitly terminal
  background-task rows (linked/completed results) but keep missing/unknown task status
  protective; Claude's current-session/current-turn `idle_prompt`
  may recover the visible foreground badge but remains suspension-blocked until complete
  empty work evidence arrives. Incomplete/missing evidence and active/scheduled work remain
  protected.
  → [`docs/pty-and-terminals.md`](docs/pty-and-terminals.md)

### Layout & multi-window → [`docs/multi-window-and-layout.md`](docs/multi-window-and-layout.md)

- Layout auto-restored on startup **without prompting**; StrictMode guard ref + `layoutReady`
  gate. Don't reintroduce a restore prompt.
- Saved layout includes `activeTabId`/`sidebarSectionOpen`/`sidebarPanelSizes`; saved tabs
  normalize to `detached:false`. Hydrate only the active tab; keep hydrated tabs mounted while
  inactive. New resizable/collapsible sidebar panels use a stable id + `sidebarPanelSizes`.
- Focus transitions are atomic — use `focusPaneInTab(tabId, paneId)`, not
  `setActiveTab()` + `focusPane()`.
- PTY routing must not move ahead of renderer ownership: destination commits/acks before main
  reroutes; source keeps its last good copy until committed/rollbackable (esp. `tab:absorb`).
- Transfer ack must reflect **actual** apply (store actions return boolean); a no-op apply
  stays silent so main times out/rolls back. Guard self-drops at the drop site, the IPC
  handler, and the store action. Detached sync/focus messages are versioned/generation-checked.

### UI & command registry

- Overlay modal language: centered dark overlay, `#1a1b1e` panel, `#2a2b2e` borders, 10px
  radius, `0 24px 64px rgba(0,0,0,0.6)` shadow, `#4ade80` accents. Start from
  `src/renderer/src/styles/theme.ts` — don't copy raw hex into components.
- Buttons use image icons from `src/renderer/src/assets/`, not text/emoji; ask for a missing
  `.png` before implementing a button. Non-terminal scrollable surfaces use the shared
  `dark-scrollbar` class; expose a `className` hook for internal scroll containers.
- Multiple presentation modes share their pieces structurally (tab cards, controls, metrics
  come from the same constants). In Electron chrome, default top regions to draggable,
  exempt real controls; avoid `no-drag` rects on horizontally scrolled children.
- Command palette is **not** auto-discovered — every action is explicit in
  `src/renderer/src/commands/registry.ts`. New settings section → `settings.open.<section>`;
  new store action → `Command`; new context data → extend `CommandContext`. `shortcut`/`enabled`
  are evaluated per render. Sessions are not in the palette (use Session Browser
  `Ctrl+Shift+O`).

### Sessions & MCP → [`docs/sessions.md`](docs/sessions.md), [`docs/session-linking-hooks.md`](docs/session-linking-hooks.md)

- `SessionIndex` is summary-only FTS5 (not full transcript); `DeepSearcher` does full
  transcript via a pure Node streamer (no PATH `rg`). Cwd repair is project-level and app-owned
  first (SQLite overrides); Claude copies/merges the transcript dir, Codex doesn't; don't
  rewrite whole JSONL for normal repair. `sessions:repair-cwd` rewrites `layout.json` + `.bak`
  + broadcasts `layout:cwd-repaired`.
- Claude id is known at launch (`claude --session-id <uuid>`); Codex id comes only from the
  managed `SessionStart` hook. **No file-poll scanner**, no scanner fallback, no
  `--dangerously-bypass-hook-trust`. Don't reintroduce Claude filesystem matching for panes we
  spawn. Startup defaults to resume.
- Pending agent panes (`sessionDetectionState` + no `sessionId`) recover only from an exact
  single cwd/time match or stay as recovery placeholders; legacy no-marker panes revert to
  shell. `hydrateTabRuntime` validates `(agentKind, sessionId, cwd)` before resume — missing
  transcript → `resumeError`, no spawn.
- PATH-based app/provider availability resolves regular command files from the inherited
  `PATH`/`PATHEXT` asynchronously; never launch a version probe or search fixed install paths
  to answer availability. → [`docs/sessions.md`](docs/sessions.md)
- **Don't mutate user/project agent config** (`~/.claude.json`, `~/.codex/config.toml`,
  `.mcp.json`). MCP injection is process-scoped only. The **one** scoped exception is the
  managed `SessionStart` + lifecycle hook install (spec 047 + 032: marked-block, `.bak`, atomic, reversible from the
  Settings → Terminal toggle). Codex hook `matcher` is **omitted** for source events and `".*"` for tool events, not `""`; Claude uses `""`.
  `install` **reconciles**: it prunes sentinel-tagged entries from event keys not in the current
  per-agent set (so a dropped event self-cleans on next startup), and `uninstall` is the same sweep
  with an empty allow-list — never leave stale managed hooks behind.
  → [`docs/session-linking-hooks.md`](docs/session-linking-hooks.md).
- Claude uses a PID-scoped temp `--mcp-config` file (no `--strict-mcp-config`); Codex gets MCP
  via `-c` overrides. Browser MCP tools are inlined in `BrowserMcpServer.ts` (registrations +
  descriptions) backed by `BrowserViewManager.ts` (methods) — keep the tool list in sync
  there, not in docs.

### Packaging → [`docs/packaging-and-release.md`](docs/packaging-and-release.md)

- `npm run dist` builds the **host OS**. Native modules aren't cross-compiled — don't build
  mac/linux from Windows; each CI runner rebuilds natively. `asarUnpack` covers `*.node`,
  `node-pty`, `better-sqlite3`; MCP templates must stay in `package.json` `build.files`.
- Auto-update needs **no token** (public repo). Don't reintroduce a token / `private: true`
  on the feed/publish config. Release: `npm version patch` then `publish.bat` (pushes the tag
  that CI builds). Don't hardcode tokens in source.

## Docs index

| File | Covers |
|---|---|
| [`docs/pty-and-terminals.md`](docs/pty-and-terminals.md) | PTY isolation, shell integration (Win/Unix), process snapshot, resize, agent launch shape, no-flow-control + no-PATH-rewrite root cause, terminal renderer selection, scrollback |
| [`docs/multi-window-and-layout.md`](docs/multi-window-and-layout.md) | Pane tree model, label computation, startup restore + hydration, multi-window ownership, transfer-ack semantics, shutdown state collection, renderer stores |
| [`docs/sessions.md`](docs/sessions.md) | Session indexing, deep search, cwd repair, session detection states, startup-resume flow, MCP injection + browser panel |
| [`docs/session-linking-hooks.md`](docs/session-linking-hooks.md) | Hook-based session-id linking: the managed-hook install, Claude vs Codex differences, the report server, failure modes, file map |
| [`docs/testing.md`](docs/testing.md) | Vitest projects, postinstall/native rebuild, the PATH-rewrite guard, testable extractions, Zustand mock, determinism, E2E, coverage ratchets |
| [`docs/packaging-and-release.md`](docs/packaging-and-release.md) | Per-OS `dist` output, signing/notarization deferral, icons, asar/native modules, auto-update, release publish flow, `patch-package` |
| [`docs/writing-specs.md`](docs/writing-specs.md) | Behavioral contracts, acceptance scenarios, definition of done, and spec lifecycle |
| [`docs/writing-plans.md`](docs/writing-plans.md) | Detailed implementation-plan structure, lifecycle, task quality, and blind pre-execution review |
