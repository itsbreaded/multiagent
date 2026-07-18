# 032 — Agent status badges via managed lifecycle hooks

> **Status:** pending / design. Not implemented. This is a planning spec intended as a
> handoff. Read spec 047's implementation notes first — this spec is a direct extension of
> the managed-hook + report-server infrastructure 047 shipped (Phase 3 / Phase 4).

## Problem

Users cannot tell at a glance what an agent pane is *doing* — thinking, running a tool,
blocked on a permission prompt, idle and waiting for input, or errored — without clicking
into the pane and reading the terminal. In a multi-pane/multi-window layout this means a
permission prompt can sit unnoticed in a background pane for minutes, which is the original
motivation behind the (rolled-back) spec 048 and the still-pending spec 046.

We want **status badges** per agent pane: `idle`, `working`, `waiting`, `error`, and
`unknown`. The question this spec answers is *how to source them in a controlled,
standardized way* — not by guessing from screen contents.

## Prior art and the lesson that shapes this spec (read first)

- **Spec 048** built a live per-pane status engine (priority-gated rule engine +
  screen-region extractors + OSC capture + hysteresis + an `agentStatus` store slice + a
  status dot in `PaneHeader`) and was **rolled back**. Its rule sets were educated guesses
  at Claude/Codex CLI output, never verified against real captured screens. The concrete
  failure: normal chat text that merely *discussed* the detection rules (quoting phrases
  like "do you want to proceed?") was misread as a live permission prompt, because the
  rules matched loose single-phrase substrings over a large scrollback window. See
  `specs/pending/046-herdr-detection-findings-and-improvements.md` "Correction to the
  record."
- **There is currently no status-detection code anywhere in this tree.** No `agentStatus`
  store slice, no status dot in `PaneHeader`, no `src/renderer/src/terminal/status/`
  directory. (Verified: `grep agentStatus` hits only specs 046/047.)
- **Spec 047** shipped the managed-hook + report-server infrastructure this spec reuses:
  `src/main/integration/managedHooks.ts` (pure JSON surgery), `managedHookController.ts`
  (`.bak` + atomic install, per-agent), `agentSessionReportServer.ts` (localhost HTTP
  loopback), the hook script `assets/multiagent-agent-state.ps1`, and `MULTIAGENT_PTY_ID` /
  `MULTIAGENT_ENV` / `MULTIAGENT_HOOK_PORT` env injection on **all** panes via
  `PtyManager.getPaneEnv` (scrubbed by `buildEnv`). 047 installs a single `SessionStart`
  hook per agent that POSTs `{ptyId, agentKind, sessionId, transcriptPath}` to
  `http://127.0.0.1:<port>/agent-session`.

**The lesson, made explicit:** a screen-scraping rule engine is the wrong primitive. It
guesses state from rendered text and is guaranteed to misfire as the CLIs change. The
research conclusion (see "Background" below) is that both Claude Code and Codex expose
**deterministic, agent-self-reported lifecycle events via hooks** — `Stop`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`/`Notification(permission_prompt)`, `StopFailure`. These
fire in the **interactive TUI** (unlike `--output-format stream-json`, which is headless
only), and 047 already has the pipe to receive them. **This spec extends that pipe to
lifecycle events instead of rebuilding a scraper.** That is the "controlled standardized
way": the agent tells us its own state; we render it.

## Background (the standardized seam — researched, cited)

There is **no universal/standardized status protocol** and neither Anthropic nor OpenAI
expose a clean live-state query API for interactive sessions (Claude Code issues
[#32634](https://github.com/anthropics/claude-code/issues/32634) and
[#38184](https://github.com/anthropics/claude-code/issues/38184), both closed *not planned*).
The supported seam is **hooks**. Relevant events:

| Badge state | Claude Code hook | Codex hook | Reliability |
|---|---|---|---|
| `idle` (turn ended) | `Stop` | `Stop` | **Deterministic, immediate** — the best "done" signal |
| `working` (turn started) | `UserPromptSubmit` (+ `SessionStart` already wired) | `UserPromptSubmit` (+ `SessionStart`) | Deterministic |
| `working` (tool running) | `PreToolUse` / `PostToolUse` / `PostToolBatch` | `PreToolUse` / `PostToolUse` | Deterministic, per tool |
| `waiting` (permission) | `Notification` matcher `permission_prompt` | `PermissionRequest` | Deterministic |
| `error` | `StopFailure` | `Stop` w/ error payload (verify) | Deterministic |
| subagent done | `SubagentStop` | `SubagentStop` | Deterministic |

Key traps the research surfaced, which this spec respects:

- **`Notification` matcher `idle_prompt` has a ~60s timer and false-positives during
  thinking pauses** (issue #32634). **Do not use `idle_prompt` for the `idle` badge.** Use
  `Stop`. `idle_prompt` may optionally drive a *secondary* "still waiting for you" nudge
  much later, but it is not the idle signal.
- **`thinking` is NOT separately distinguishable from `working`** via hooks in
  interactive mode. Token-level "thinking" granularity exists only in headless
  `--output-format stream-json --include-partial-messages`, which does not apply to our
  interactive PTY panes. **Collapse "thinking" into `working`** and say so in the UI. A
  badge set of `{idle, working, waiting, error, unknown}` is honest; a "thinking" badge
  would be a lie.
- **`Stop` can arrive late or out of order** in practice (issue #9320 statusline refresh;
  [zellaude#5](https://github.com/ishefi/zellaude/issues/5) "status stuck on Thinking").
  Mitigation is the process-level ground truth from 047's `agentProcessSweeper` (the agent
  process exiting → pane demotes → badge clears), not a timer heuristic. A stuck
  `working` badge from a missed `Stop` is a benign cosmetic glitch; a false `waiting`
  badge from a scraper (the 048 failure) is not. Accept the former; refuse to reintroduce
  the latter.

Sources: [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide) /
[reference](https://code.claude.com/docs/en/hooks.md) /
[statusline](https://code.claude.com/docs/en/statusline) /
[streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output);
[Codex hooks](https://developers.openai.com/codex/hooks) /
[Codex non-interactive](https://developers.openai.com/codex/noninteractive).

## Intended behavior

1. Each agent pane shows a single status badge in `PaneHeader` (where 048's dot lived),
   drawn from a small fixed set: `idle`, `working`, `waiting`, `error`, `unknown`. Image
   icons from `src/renderer/src/assets/` per the CLAUDE.md UI guardrail — **not text/emoji**;
   ask for a missing `.png` before implementing.
2. State is driven by lifecycle hook events the agent itself emits, received through the
   existing 047 report server — never by screen/OSC scraping. No new rule engine.
3. A pane with no hook events yet (cold start, or a CLI-launched Codex that hasn't trusted
   the hook via `/hooks`) shows `unknown` — **not** a guessed state. This is the honest
   fallback and the explicit refusal of 048's approach.
4. The badge is an in-memory renderer concern (an `agentStatus` slice), not persisted —
   like 047's `promotedFromShell` flag. On restart every pane re-derives from live events.
5. No new agent-config mutation beyond what 047 already does. We **extend the existing
   managed-hook install** (which already writes the marked `SessionStart` block into
   `~/.claude/settings.json` and `~/.codex/hooks.json`) to also register the lifecycle
   events. Same marked block, same `.bak`/atomic/reversible discipline, same opt-in toggle.
   The CLAUDE.md scoped-exception note (currently "Claude + Codex SessionStart") is
   extended to name the added events.

## How the pieces fit (grounded in current code)

- **Report server** (`src/main/integration/agentSessionReportServer.ts`): today has one
  POST route `/agent-session` validating `{ptyId, agentKind, sessionId, transcriptPath}`.
  Add a second route `/agent-event` validating `{ptyId, agentKind, event, ts?, detail?}`
  where `event ∈ {user_prompt_submit, pre_tool_use, post_tool_use, stop, permission_request,
  stop_failure, subagent_stop}`. `onEvent` callback emits a new IPC event.
- **Hook script** (`src/main/integration/assets/multiagent-agent-state.ps1`): today takes
  `$args[0]` = agentKind, reads the SessionStart stdin payload, POSTs to `/agent-session`.
  Generalize so the same script handles multiple hook events: the registered hook command
  passes a second positional arg = event name (e.g. `… -File "<script>" claude stop`).
  The script reads stdin (the event payload, whose shape varies per event — `session_id`
  for SessionStart, `tool_name`/`tool_use_id` for Pre/PostToolUse, the notification message
  for `permission_prompt`, etc.), and POSTs `{ptyId, agentKind, event, detail}` to
  `/agent-event`. Keep the existing `MULTIAGENT_ENV`/`MULTIAGENT_PTY_ID`/
  `MULTIAGENT_HOOK_PORT` gate and the `MULTIAGENT_SESSION_ID` bail verbatim; never block
  (every path exits 0). The `.sh` sibling gets the parallel treatment for symmetry even
  though Windows is the target.
- **Managed hook install** (`managedHooks.ts` / `managedHookController.ts`): the pure
  surgery already builds a `{matcher, hooks:[{type:"command", command}]}` entry for
  `SessionStart`. Extend it to emit entries for the additional event names. The sentinel
  is already the script filename; per-file detection stays unambiguous (Claude and Codex
  hooks live in separate files). `generateHookCommand(scriptPath, kind)` from 047 Phase 4
  gains an event parameter → `generateHookCommand(scriptPath, kind, event)`. **Codex
  `matcher` stays omitted (not `""`); Claude uses `""`** — CLAUDE.md guardrail, unchanged.
- **Main wiring** (`src/main/ipc/handlers.ts`): the report server is constructed next to
  `PtyManager`/`SessionSpawner`. Its `onEvent` calls
  `windowManager.sendToWindowForPty(ptyId, 'pane:agent-status', ptyId, state)` — the same
  cross-window delivery path `session:detected` and `pane:agent-detected` already use.
  `PtyManager` is a singleton; delivery is global-to-owning-window. Add the channel to
  `src/shared/types.ts`.
- **Renderer store**: a new in-memory `agentStatus: Record<paneId, AgentStatusState>`
  slice in `src/renderer/src/store/panes.ts` (not serialized — mirror `promotedFromShell`).
  A `panesIpc.ts` listener for `pane:agent-status` finds the pane by ptyId
  (`findLeafByPtyId`) and sets its status. A pure reducer `eventToState(prev, event)`
  maps events → states (see mapping below). `PaneHeader` reads `agentStatus[pane.id]`.
- **Process-level ground truth**: 047's `agentProcessSweeper` already emits
  `pane:agent-detected` with `agentKind | null` on promote/demote. Wire **demotion**
  (`null`) to clear the badge (`unknown`/absent) — this is the no-`Stop`-arrived fallback:
  if the agent process exits, the sweeper demotes the pane and the badge clears regardless
  of whether `Stop` fired. Promotion sets initial `working` (an agent that just became
  foreground is presumed active until events say otherwise).

### Event → state mapping (pure, unit-tested)

```
user_prompt_submit  → working
pre_tool_use        → working   (tool running sub-state; optional detail: tool name)
post_tool_use       → working   (still in-turn; stays working until Stop)
stop                → idle
stop_failure        → error
permission_request  → waiting   (Claude Notification permission_prompt / Codex PermissionRequest)
subagent_stop       → (no pane-level change; informational only — out of scope v1)
pane:agent-detected null (demotion) → clear (unknown/absent)
pane:agent-detected <kind> (promotion) → working   (initial, until events refine)
```

`prev` is taken into account only to avoid flapping on out-of-order `Stop` after a late
`PostToolUse`: once `idle`, ignore tool events that clearly belong to the ended turn
(requires a turn-id/monotonic — see Open questions). Absent that, accept that a late
`post_tool_use` could briefly flip `idle`→`working`; the next `Stop` recovers. Benign.

## Implementation plan (phased)

### Phase 1 — App-launched agents only: hook events → badge (the safe foundation)

Goal: badges for panes we spawn ourselves (Claude via `--session-id`, Codex via the 047
Phase-4 hook + `--dangerously-bypass-hook-trust`). These panes already carry the
`MULTAGENT_*` env vars, so the generalized hook script can fire immediately with no new
trust UX.

1. **Spike (design-blocking):** confirm `Stop`, `PostToolUse`, and `Notification`
   (`permission_prompt`) hooks **fire in the interactive Claude Code TUI** on the target
   version, and that `Stop` fires `PermissionRequest`/`PostToolUse`/`Stop` fire in the
   interactive Codex TUI on the target version. Spend ~30 min: install a trivial test hook
   per event that writes a marker file, run `claude`/`codex` interactively (app-launched,
   so Codex bypasses trust), and verify the markers appear in the right order. **Do this
   before building anything else** — it is the only design-blocking unknown. Record the
   exact stdin payload shape per event (the docs describe them; confirm on the binary).
2. **Report server:** add the `/agent-event` route + an `onEvent` dep + a `VALID_EVENTS`
   allow-list. Unit-test the POST→`onEvent` flow and the 400 paths (mirror
   `agentSessionReportServer.test.ts`).
3. **Hook script:** generalize to `event` as `$args[1]`; POST to `/agent-event` with
   `{ptyId, agentKind, event, detail}`. Keep all existing gates/bails. Unit-test the
   arg/event dispatch by extracting the dispatch into a pure function if feasible (PowerShell
   testability is limited; at minimum cover via the integration spike).
4. **Managed hook install:** extend `managedHooks.ts`/`managedHookController.ts` to
   register the additional event entries (Claude `Stop`/`PostToolUse`/`Notification` w/
   `permission_prompt` matcher; Codex `Stop`/`PostToolUse`/`PermissionRequest`). Idempotent
   update of the existing marked block; preserve all unrelated hooks; `.bak` on change.
   Tests: install adds all events, uninstall removes all (and only) our events, unrelated
   hooks preserved, idempotent re-run, `.bak` written. Mirror `managedHookController.test.ts`.
5. **IPC + store:** add `pane:agent-status(ptyId, state)` to `src/shared/types.ts`; add the
   `agentStatus` slice + `eventToState` reducer + the `panesIpc.ts` listener. Unit-test
   `eventToState` over the mapping table above, including demotion-clears and
   out-of-order-late-tool-after-stop.
6. **UI:** badge in `PaneHeader` reading `agentStatus[pane.id]`, image icons (request the
   `.png`s). Tooltip with the last event detail (e.g. tool name). `unknown` shown as a
   neutral dot. Reuse theme tokens (`src/renderer/src/styles/theme.ts`); no raw hex.
7. **Toggle:** extend the existing 047 Settings → Terminal toggle (currently "Session
   linking (managed hooks)", default-on under Phase 4) to cover the lifecycle hooks too —
   one toggle, one marked block, one uninstall. Copy names the added events. (Open
   question: one toggle or a separate "live status" toggle — recommend one.)

**Phase 1 does NOT do:** CLI-launched agent badges (those need the trust UX), subagent
badges, `idle_prompt` nudges, any screen/OSC fallback.

### Phase 2 — CLI-launched agents + robustness

Goal: badges for panes promoted by 047 Phase 1's `agentProcessSweeper` (user typed
`claude`/`codex` in a shell pane), plus the robustness fallbacks.

1. **Promotion seeds `working`:** the existing `pane:agent-detected` listener already
   fires on promotion. Set `agentStatus[pane.id] = 'working'` on promotion so a
   CLI-launched agent shows *something* immediately, then refine as hook events arrive.
2. **Demotion clears:** on `pane:agent-detected` `null` (agent process exited), clear the
   badge. This is the missed-`Stop` fallback for the
   [zellaude#5](https://github.com/ishefi/zellaude/issues/5) case.
3. **CLI-launched Codex trust UX:** a CLI-launched Codex pane does not fire hooks until the
   user trusts via `/hooks` (047 Phase 4 constraint; we cannot add
   `--dangerously-bypass-hook-trust` to a user-typed command). Until trust, the pane shows
   `unknown` (not a guess). Reuse 047's unlinked-promoted-Codex hint pattern: after a few
   seconds with no events, show "trust the MultiAgent hook in `codex /hooks` for live
   status" alongside the existing session-linking hint.
4. **`StopFailure` / error:** wire the error state. Verify Codex's error signal (the docs
   list `Stop`; confirm whether a failed turn surfaces a distinct payload or a `Stop` with
   error detail — Open question).
5. **Cross-window:** confirm a detached window's promoted-then-badged pane keeps its badge
   on drag to the primary window. The badge is in-memory per-window store state; on
   `tab:absorb`/`tab:state-sync` the source window must carry `agentStatus` for the pane
   (in-memory, like `promotedFromShell`) so the destination doesn't lose it mid-turn. The
   next hook event re-syncs it anyway, but carry it to avoid a flash to `unknown`.

### Phase 3 — Explicitly NOT building a screen/OSC fallback (the controlled part)

A fallback that scrapes the terminal to infer state when hooks are absent is **out of
scope and deliberately rejected.** That is 048, and 048 was rolled back for cause. When
hooks are absent (toggle off, CLI-launched-untrusted Codex, a future agent kind with no
hook), the badge is `unknown` — full stop. This is recorded here so a future agent does
not re-investigate it. If coverage gaps become painful, the answer is **more hooks / OTA
hook updates**, not scraping.

The one narrow, non-scraping exception worth considering later: wiring Codex's `osc 9`
progress / Claude's OSC title **only as a tie-breaker for the `idle` sub-state** (046
finding #7), never as the primary signal. Defer; not in v1.

## Risks

- **Hook reliability in the interactive TUI (design-blocking).** If `Stop`/`PostToolUse`
  do not fire reliably in interactive mode on the target versions, the whole approach
  weakens. Mitigation: the Phase-1 spike gates the spec; the `agentProcessSweeper`
  demotion is the process-level fallback for missed `Stop`. A stuck `working` is benign;
  a missed `waiting` is not, but `permission_request` is a distinct, high-signal event
  unlikely to be dropped.
- **Out-of-order / late events.** A `PostToolUse` arriving after `Stop` could flap
  `idle`→`working`. Mitigation: a turn-id / monotonic counter (Claude hook payloads carry
  `session_id` + sometimes a turn marker; Codex carries thread/turn ids in headless mode —
  verify what the interactive hook payloads include). If a stable turn id is available,
  `eventToState` ignores events from a turn older than the current. If not, accept the
  flap (self-heals on next `Stop`) — do NOT add a timer heuristic (the #32634 trap).
- **Codex trust gate for CLI launches.** CLI-launched Codex won't badge until `/hooks`
  trust. This is the same constraint 047 Phase 4 already accepts for session linking;
  reuse the hint. Do not attempt to bypass trust for CLI launches.
- **Broadening the 047 config-mutation exception.** Adding more hook events writes more
  into `~/.claude/settings.json` / `~/.codex/hooks.json`. Mitigation: same marked block,
  same `.bak`/atomic/reversible/idempotent surgery, same single toggle, same
  preserve-all-unrelated-hooks discipline, CLAUDE.md update. A botched uninstall that
  corrupts agent config is the worst-case failure — the marked-block + `.bak` pattern
  exists to prevent it; test install/uninstall idempotence exhaustively (as 047 did).
- **Re-adding 048 by the back door.** The temptation to "just also parse the screen for
  the cases hooks miss" is exactly the failure mode this spec exists to prevent.
  Mitigation: the `unknown` fallback is the spec's hard line; Phase 3 names the rejection
  explicitly. Reviewers should reject any PR that reintroduces screen/OSC content as a
  status signal source.
- **Cross-window state carry.** In-memory `agentStatus` must ride with the pane in
  `tab:absorb`/`tab:state-sync` to avoid a flash to `unknown` on drag. Mirror 047's
  `promotedFromShell` carry rule.

## Edge cases (resolved)

- **App-launched Claude already has `--session-id`; the hook bails on
  `MULTIAGENT_SESSION_ID`.** Lifecycle hooks (Stop/PostToolUse/etc.) do **not** bail —
  they must fire for app-launched Claude too, since that's the primary badge use case.
  Only the `SessionStart` (session-id) report bails on `MULTIAGENT_SESSION_ID`. Keep these
  code paths separate in the script.
- **Pane not yet hydrated (spec 001).** Hook events can arrive before the hosting tab is
  mounted (detection is in main). `sendToWindowForPty` delivers to the owning window; the
  store listener sets `agentStatus` by ptyId regardless of mount. The badge renders when
  `PaneHeader` mounts on first focus.
- **Inactive agent pane that goes `waiting`.** A background pane hitting
  `permission_request` shows `waiting` in its `PaneHeader` badge. A *proactive* toast is
  046 finding #1, not this spec — but this spec makes that toast trivial to wire later
  (subscribe to `agentStatus` transitions).
- **Toggle off mid-turn.** Toggling off uninstalls the hooks; in-flight panes stop
  receiving events. Their badge freezes on the last state, then clears on the next
  demotion (sweeper) or app restart. Acceptable; document in toggle copy.
- **Two agent processes in one pane.** 047's sweeper disambiguates to `null` (stay shell)
  in ambiguous cases — no promotion, no badge. No new ambiguity here.

## Verification steps

- **Unit (report server):** `/agent-event` POST→`onEvent` for each event in the
  allow-list; 400 on bad shape / unknown event / bad agentKind; 404 on wrong path. Mirrors
  `agentSessionReportServer.test.ts`.
- **Unit (managed hooks):** install registers all lifecycle events for both agents;
  uninstall removes exactly our events; unrelated hooks preserved; idempotent re-run;
  `.bak` written; Codex `matcher` omitted, Claude `matcher` `""`.
- **Unit (`eventToState`):** every event in the mapping table; demotion-clears; a
  late `post_tool_use` after `stop` (with and without a turn-id guard).
- **Integration (Phase 1 spike, the gate):** the interactive-TUI hook-firing spike
  passes — markers appear for `Stop`/`PostToolUse`/`permission_prompt` (Claude) and
  `Stop`/`PostToolUse`/`PermissionRequest` (Codex) in the right order.
- **Integration (Phase 1):** app-launch a Claude pane → send a prompt → badge goes
  `working` (with tool-name tooltip during tool use) → on turn end → `idle`. Trigger a
  permission prompt → `waiting`. Repeat for app-launched Codex. Confirm toggle off
  removes the marked block, unrelated hooks intact, `.bak` written.
- **Integration (Phase 2):** type `claude` in a shell pane → promotes (047) → badge
  `working` → tracks the turn → `idle` on exit → demote on agent-exit clears the badge.
  Type `codex` in a shell pane → promotes → `unknown` until `/hooks` trust → then badges.
  Drag a mid-turn badged pane to another window → badge carries (no `unknown` flash).
- **Regression:** `npm run typecheck` and `npm test` green; the PATH-rewrite guard
  (`buildEnv.test.ts`) still passes (no env changes here — the `MULTIAGENT_*` vars already
  exist from 047); E2E (`npm run test:e2e`) still passes.

## Open questions (confirm before implementing)

1. **Interactive-TUI hook firing (the gate).** Do `Stop`/`PostToolUse`/`Notification`
   fire reliably in interactive Claude, and `Stop`/`PostToolUse`/`PermissionRequest` in
   interactive Codex, on the target versions? (Phase-1 spike.)
2. **Turn identity.** Do the interactive hook payloads include a stable turn/thread id
   we can use to drop out-of-order late events? If not, accept the flap.
3. **Codex error signal.** Does a failed Codex turn emit a distinct error payload, or a
   `Stop` with error detail? (Phase 2.)
4. **`idle_prompt`.** Wire the `Notification` `idle_prompt` matcher at all (secondary
   "still waiting" nudge only), or ignore entirely? Recommend ignore for v1.
5. **Toggle.** One toggle covering session-linking + lifecycle hooks (recommended), or a
   separate "live status" toggle? One keeps the config-mutation exception single and
   simple.
6. **Subagent badges.** `SubagentStart`/`SubagentStop` — out of scope for v1; confirm we
   ignore at the pane level.

## Handoff contract (non-negotiables)

1. **No screen/OSC scraping as a status source.** The `unknown` fallback is the hard line.
   This is the lesson of 048. Any PR reintroducing rendered-text content as a status
   signal is out of scope and should be rejected.
2. **Reuse 047's infrastructure; do not fork it.** Same report server (add a route), same
   hook script (add an event arg), same managed-hook controller (add event entries), same
   env injection, same toggle, same marked-block/`.bak`/atomic/reversible discipline. One
   config-mutation exception, extended — not two.
3. **No new agent-config mutation surface.** We extend the existing marked block in
  `~/.claude/settings.json` and `~/.codex/hooks.json` only. Codex `matcher` omitted;
   Claude `matcher` `""`. Update CLAUDE.md's scoped-exception note to name the added
   events. Do not touch `~/.claude.json` / `.mcp.json` / `~/.codex/config.toml` (the
   `[features] hooks = true` from 047 Phase 4 already enables the hooks system).
4. **Fail closed / honest.** No hooks → `unknown`, never a guessed state. A stuck
   `working` from a missed `Stop` is acceptable; a false `waiting` is not.
5. **Honest badge set.** `{idle, working, waiting, error, unknown}` — no "thinking"
   badge. "Thinking" collapses into `working`. State so in the UI.
6. **Respect multi-window invariants.** `PtyManager` is a singleton; delivery via
   `windowManager.sendToWindowForPty`; `agentStatus` is in-memory and rides with the pane
   in `tab:absorb`/`tab:state-sync`. Atomic, tab-scoped; no composed primitives.
7. **No env / PATH changes.** The `MULTIAGENT_*` vars already exist from 047; this spec
   adds none. `buildEnv` scrub unchanged.
8. **No vendoring.** Reimplement any adapted technique in our own idioms.
9. **Tests ship with each phase.** The report-server route, the managed-hook
   install/uninstall for the new events, and `eventToState` are all pure and unit-tested.
10. **The spike gates Phase 1.** Do not build Phase 1 until the interactive-TUI hook-firing
    spike passes.

## Definition of done

- Phase 1: app-launched Claude and Codex panes show a correct `working`/`waiting`/`idle`/
  `error` badge driven by lifecycle hooks; toggle on/off installs/uninstalls all events
  cleanly with unrelated hooks preserved and `.bak` written; unit tests + the spike green;
  `typecheck`/`npm test`/E2E green; CLAUDE.md updated.
- Phase 2: CLI-launched Claude badges from promotion; CLI-launched Codex badges after
  `/hooks` trust with the hint; demotion clears the badge (the missed-`Stop` fallback);
  cross-window drag preserves the badge.
- Phase 3: none (the rejected fallback — documented, not built).

## Related specs

- **047** — the infrastructure this spec extends (managed hooks, report server, env
  injection, process sweeper, promotion/demotion, the Codex trust gate). This spec adds
  lifecycle-event routes to 047's pipe and a renderer badge; it does not duplicate 047's
  install/surgery.
- **048** — the rolled-back screen-scraping status engine. This spec is its replacement,
  deliberately sourced from hooks instead of rendered text. Read 048's failure mode
  before touching this spec.
- **046** — herdr detection findings. Finding #1 (needs-attention toast) becomes trivial
  once this spec's `agentStatus` slice exists; finding #7 (OSC 9 idle tie-breaker) is the
  only screen-derived signal worth considering, and only as a tie-breaker, deferred.