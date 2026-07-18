# 032 — Agent status badges via managed lifecycle hooks

> **Status:** pending / design, **ready for handoff to an AI implementer.** Open questions
> resolved (see "Research findings" and "Open questions (resolved)"). Not implemented. This
> spec is a direct extension of the managed-hook + report-server infrastructure 047 shipped
> (Phase 3 / Phase 4).
>
> **For the AI implementer (read this first):**
> - **You do NOT need to read specs 047/048/046.** Every 047 fact you need (file paths,
>   function signatures, behavior, the `.bak`/atomic/marked-block discipline, the Codex trust
>   gate, `promotedFromShell` semantics) is inlined and verified against the current tree in
>   "Implementation contracts." Reading the done specs burns context and risks drift; open
>   them only if debugging a specific 047 interaction.
> - **Work the "Implementation order" section top-to-bottom.** It's sequenced with verify
>   gates so you don't compound errors. Mark each step done before the next.
> - **The one thing you must NOT do** (the whole reason this spec exists): reintroduce
>   screen/OSC/terminal-content scraping as a status source. The `unknown` fallback is the
>   hard line. See handoff contract #1. Reject any instinct to "also parse the screen for
>   cases hooks miss."
> - **The Phase-1 spike is no longer build-blocking.** Firing is documented; build the hook
>   script with **defensive field reading** against the documented shapes (cited) and confirm
>   with a real app-launched turn. See "Spike procedure (for an AI)".
> - **No new `.png` assets.** The badge is a colored CSS dot. Don't block on art.

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
| `working` (turn started) | `UserPromptSubmit` (+ `SessionStart` already wired) | `UserPromptSubmit` (supported — see Research findings #4) + `SessionStart` (already wired); the sweeper's promotion also seeds `working` | Deterministic (both) |
| `working` (tool running) | `PreToolUse` / `PostToolUse` | `PreToolUse` / `PostToolUse` | Deterministic, per tool |
| `waiting` (permission) | `Notification` matcher `permission_prompt` | `PermissionRequest` | Deterministic. Note: Codex `PermissionRequest` landed in PR [openai/codex#17563](https://github.com/openai/codex/pull/17563) (Apr 2026) — confirm it is present in the target Codex version during the spike |
| `error` | `StopFailure` (matchers: `rate_limit`/`overloaded`/`authentication_failed`/`server_error`/…) | **No `StopFailure` exists.** Codex `Stop` carries no error field (`session_id`/`turn_id`/`cwd`/`transcript_path`/`model`/`permission_mode`/`stop_hook_active`/`last_assistant_message`) | **`error` badge is Claude-only for v1.** A failed Codex turn surfaces as a normal `Stop` → `idle`. This is an honest limitation; do not fake it |
| subagent done | `SubagentStop` | `SubagentStop` | Deterministic (out of scope v1) |

**Turn identity (resolves the out-of-order risk):** Claude payloads carry `prompt_id` (a UUID shared by every event in the same turn, present from Claude Code **v2.1.196+**; absent on older versions until first user input). Codex payloads carry `turn_id`. Both are stable per-turn correlation ids — `eventToState` can use them to drop a late `PostToolUse` that arrives after a `Stop` from an earlier turn. **Gate the guard on presence**: if `prompt_id`/`turn_id` is present, ignore events whose id is older than the current turn's; if absent (older Claude), accept the self-healing flap (next `Stop` recovers). Do NOT add a timer heuristic.

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

### Research findings (resolved before implementation — cited)

These resolve Open questions 1–3 so the spike is no longer *design-blocking*, only
*payload-shape-confirming*. Verified against the official docs and the openai/codex source.

1. **Hooks fire in the interactive TUI (OQ 1 — RESOLVED, yes).** The Claude Code hooks
   reference lists every event above as firing in interactive TUI mode; hooks are a general
   lifecycle feature, not headless-only. GitHub issues
   [#40506](https://github.com/anthropics/claude-code/issues/40506) and
   [#30143](https://github.com/anthropics/claude-code/issues/30143) confirm the *inverse*:
   `PreToolUse`/`PostToolUse`/`PermissionRequest` do **not** fire in `claude -p` (headless)
   mode — they fire in interactive mode only. That is exactly our use case (interactive PTY
   panes), so the seam is sound. Codex hooks likewise fire in the interactive TUI (the
   `/hooks` trust flow and `statusMessage` surfacing are TUI features).
2. **Turn identity (OQ 2 — RESOLVED, yes, with a version gate).** Claude: `prompt_id`
   (UUID, v2.1.196+; absent on older versions). Codex: `turn_id`. See the table note above.
3. **Codex error signal (OQ 3 — RESOLVED, none).** Codex has no `StopFailure` and its `Stop`
   payload carries no error field. `error` is therefore Claude-only for v1 (`StopFailure`).
   Source: [codex stop.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/stop.rs),
   [permission_request.rs](https://github.com/openai/codex/blob/f1affbac/codex-rs/hooks/src/events/permission_request.rs).
4. **Codex `UserPromptSubmit` — IS supported (prior error corrected).** The Codex hooks
   table's "not supported" is in the **matcher** column — it means *matchers are ignored for
   this event* (it always fires), NOT that the event is unsupported. Codex `UserPromptSubmit`
   is a fully supported turn-scoped hook carrying `prompt` + `turn_id` (verified against the
   [Codex hooks doc](https://learn.chatgpt.com/docs/hooks)). So Codex `working` is seeded at
   every turn start by `UserPromptSubmit`, same as Claude — the earlier "pure-chat Codex turns
   show idle" limitation is withdrawn. (Codex still has **no `Notification` hook** — that is a
   Claude-only event; the `codex-terminal-progress` plugin's "Notification" reference is
   Codex's separate `notify` config key, not a hook.)
5. **Claude `PreToolUse`/`PostToolUse` payloads do NOT include `tool_use_id`** (only
   `tool_name` + `tool_input` + common fields). Codex does include `tool_use_id`. The badge
   tooltip therefore shows `tool_name` (available on both); do not depend on `tool_use_id`.
6. **`Notification` matchers (Claude):** `permission_prompt`, `idle_prompt`, `auth_success`,
   `elicitation_*`, `agent_needs_input`, `agent_completed`. Payload carries a `message` field.
   We install only the `permission_prompt` matcher. `idle_prompt` is ignored for v1 (OQ 4).

The spike in Phase 1 step 1 is retained — but its job is now to **confirm the exact stdin
payload shape per event on the target binaries and the event ordering**, not to re-establish
that hooks fire. Firing is documented; payload shapes can lag the docs.

## Intended behavior

1. Each agent pane shows a single status badge in `PaneHeader` (immediately after the
   type icon, where 048's dot lived), drawn from a small fixed set: `idle`, `working`,
   `waiting`, `error`, `unknown`. **Rendered as a small colored CSS dot** (the 048 pattern),
   color-mapped to state via `theme.ts` tokens — not text/emoji, and **not a button**, so
   the CLAUDE.md "image icon for buttons" guardrail does not require a new `.png` asset.
   (Distinct per-state `.png` icons are an optional future upgrade if assets are provided;
   do not block v1 on asset creation.)
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
   events. Same marked block, same `.bak`/atomic/reversible discipline, same opt-in toggle
   (`cliSessionLinking`, default-on). The CLAUDE.md scoped-exception guardrail
   (`## Guardrails` → "Don't mutate user/project agent config … the **one** scoped exception
   is the managed `SessionStart` hook install") and `docs/session-linking-hooks.md` (the
   "What gets installed where" table + the toggle section) are extended to name the added
   events and the renamed toggle copy.

## How the pieces fit (grounded in current code)

- **Report server** (`src/main/integration/agentSessionReportServer.ts`): today has one
  POST route `/agent-session` validating `{ptyId, agentKind, sessionId, transcriptPath}`.
  Add a second route `/agent-event` validating `{ptyId, agentKind, event, detail?, turnId?}`
  where `event` is in the `VALID_EVENTS` allow-list (see Implementation contracts —
  `session_start`/`user_prompt_submit`/`pre_tool_use`/`post_tool_use`/`stop`/
  `permission_request`/`stop_failure`; **no** `subagent_*`, **no** synthetic `promote`/
  `demote`). Codex will never send `user_prompt_submit` or `stop_failure`. Add an `onEvent`
  dep alongside the existing `onReport`; `onEvent` forwards to the renderer (main does not
  reduce).
- **Hook script** (`src/main/integration/assets/multiagent-agent-state.ps1`): today takes
  `$args[0]` = agentKind, reads the SessionStart stdin payload, POSTs to `/agent-session`.
  Generalize so the same script handles multiple hook events: the registered hook command
  passes a second positional arg = event name (e.g. `… -File "<script>" claude stop`).
  The script reads stdin (the event payload, whose shape varies per event — `session_id`
  for SessionStart, `tool_name` (+ `tool_use_id` on Codex only) for Pre/PostToolUse, the
  notification `message` for `permission_prompt`, `prompt_id`/`turn_id` for turn identity),
  and POSTs `{ptyId, agentKind, event, detail, turnId?}` to `/agent-event`. Carry `turnId`
  (Claude `prompt_id` / Codex `turn_id`) when present so `eventToState` can guard ordering.
  Keep the existing `MULTIAGENT_ENV`/`MULTIAGENT_PTY_ID`/`MULTIAGENT_HOOK_PORT` gate and the
  `MULTIAGENT_SESSION_ID` bail verbatim — **but only on the SessionStart path**; lifecycle
  events must NOT bail on `MULTIAGENT_SESSION_ID` (see Edge cases). Never block (every path
  exits 0). The `.sh` sibling gets the parallel treatment for symmetry even though Windows
  is the target.
- **Managed hook install** (`managedHooks.ts` / `managedHookController.ts`): the pure
  surgery today builds a `{matcher, hooks:[{type:"command", command}]}` entry, but it is
  **hardcoded to the `SessionStart` event key** — `injectManagedHook`/`removeManagedHook`/
  `hasManagedHook` all read/write `cfg.hooks['SessionStart']` only. **Generalize them to
  take an event-name parameter** (e.g. `injectManagedHook(cfg, eventName, command, matcher)`),
  so install can loop over the per-agent event set and uninstall can remove our entries
  across **every** event key, not just `SessionStart`. The sentinel (`HOOK_SENTINEL =
  'multiagent-agent-state'`, the script basename without extension) already disambiguates
  our entries from unrelated hooks regardless of which event key they sit under, so
  detection/removal generalizes cleanly without touching unrelated hooks. Install must add
  one entry per event in the per-agent set below; uninstall removes exactly our entries
  across all event keys and prunes empty groups/keys as today. `generateHookCommand(scriptPath,
  kind, platform)` from 047 Phase 4 gains an event parameter →
  `generateHookCommand(scriptPath, kind, event, platform)`, appended as a second positional
  arg to the script (`… -File "<script>" <kind> <event>`). **Per-agent event sets differ:**
  - Claude: `SessionStart` (existing), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
    `Notification` (matcher `permission_prompt`), `Stop`, `StopFailure`.
  - Codex: `SessionStart` (existing), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
    `PermissionRequest`, `Stop`. **No `Notification` (not a Codex hook) and no `StopFailure`
    (does not exist).**
  **Matcher policy unchanged:** Codex `matcher` is **omitted** (not `""`) for matcher-less
  events; Claude uses `""` for match-all on `SessionStart`/`Stop`/`UserPromptSubmit` and the
  literal matcher (`permission_prompt`, tool name) where the event is matcher-qualified —
  CLAUDE.md guardrail, unchanged.
- **Main wiring** (`src/main/ipc/handlers.ts`): the report server is constructed next to
  `PtyManager`/`SessionSpawner` with an `onReport` dep today. Add an `onEvent` dep alongside
  it. **Main is a thin forwarder — it does NOT run the state machine.** `onEvent` calls
  `windowManager.sendToWindowForPty(ptyId, 'pane:agent-event', ptyId, event, detail, turnId)`
  — the same cross-window delivery path `session:detected` and `pane:agent-detected` already
  use. The renderer owns the per-pane prev state and runs `eventToState` (see Implementation
  contracts). `PtyManager` is a singleton; delivery is global-to-owning-window. Add the
  `pane:agent-event` channel to `src/shared/types.ts` (both the signature map and the
  `EventChannels` union).
- **Renderer store**: in-memory per-pane status, **not persisted** — mirror `promotedFromShell`
  exactly. `promotedFromShell` is a non-serialized field on `PaneLeaf` (`src/shared/types.ts`)
  that `normalizeTabsForLayout` / `layoutStore.ts` strips before writing `layout.json`; because
  it is a leaf field it rides with the pane automatically in `tab:absorb` / `tab:state-sync`
  payloads (which are pane-tree-shaped). **Add `agentStatus?: AgentStatusState` as a sibling
  non-serialized field on `PaneLeaf`** and strip it in the same `normalizeTabsForLayout` path
  (one extra `delete`), rather than a separate `Record<paneId, AgentStatusState>` slice. This
  is the faithful reading of "mirror `promotedFromShell`" and gets cross-window carry for
  free; a separate Record keyed by paneId would need a sidecar merge into every cross-window
  pane snapshot and is **not recommended**. (The 047 done-spec's `agentStatus[paneId]`
  phrasing was aspirational pseudo-syntax, not a commitment to a Record.) A `panesIpc.ts`
  listener for `pane:agent-event` finds the pane by ptyId (`findLeafByPtyId`) and runs
  `eventToState` (pure, in `src/shared/agentStatus.ts`) to derive the next state, then stores
  it via a `setPaneAgentStatus(paneId, state)` action (pure `patchLeafInTabs`). `PaneHeader`
  (`src/renderer/src/components/PaneHeader/index.tsx`) reads `pane.agentStatus`. Full
  contracts in "Implementation contracts" below.
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
subagent_stop       → not installed, not in VALID_EVENTS, never arrives (out of scope v1)
pane:agent-detected null (demotion) → clear (unknown/absent)
pane:agent-detected <kind> (promotion) → working   (initial, until events refine)
```

`prev` is taken into account only to avoid flapping on an out-of-order `PostToolUse`
arriving after `Stop`. **Turn identity is available** (Claude `prompt_id` v2.1.196+; Codex
`turn_id` — see Research findings #2): store the current turn's id alongside the state, and
once `idle`, ignore tool events whose turn id is older than the current turn. **Gate on
presence** — if the payload carries no turn id (older Claude), accept that a late
`post_tool_use` could briefly flip `idle`→`working`; the next `Stop` recovers. Benign. Do
NOT add a timer heuristic (the #32634 trap).

## Implementation plan (phased)

### Phase 1 — App-launched agents only: hook events → badge (the safe foundation)

Goal: badges for panes we spawn ourselves (Claude via `--session-id`, Codex via the 047
Phase-4 hook + `--dangerously-bypass-hook-trust`). These panes already carry the
`MULTAGENT_*` env vars, so the generalized hook script can fire immediately with no new
trust UX.

1. **Spike — payload-shape + ordering confirmation (NOT build-blocking; see "Spike
   procedure (for an AI)" for the exact steps).** Firing in the interactive TUI is documented
   (Research findings #1). The remaining job is to confirm the exact stdin field names per
   event on the target binaries, since docs can lag. **Because the hook script reads fields
   defensively (see Implementation contracts → Hook script dispatch), a wrong/missing field
   name degrades gracefully (lost `detail`/`turnId`) rather than breaking** — so you may
   build against the documented shapes (cited) and treat the first real app-launched turn
   (Phase 1 verification) as the live confirmation. Run the scripted spike if you can
   automate it; otherwise proceed with defensive parsing and confirm in-app.
2. **Report server:** add the `/agent-event` route + an `onEvent` dep + a `VALID_EVENTS`
   allow-list. Unit-test the POST→`onEvent` flow and the 400 paths (mirror
   `agentSessionReportServer.test.ts`).
3. **Hook script:** generalize to `event` as `$args[1]`; POST to `/agent-event` with
   `{ptyId, agentKind, event, detail}`. Keep all existing gates/bails. Unit-test the
   arg/event dispatch by extracting the dispatch into a pure function if feasible (PowerShell
   testability is limited; at minimum cover via the integration spike).
4. **Managed hook install:** extend `managedHooks.ts`/`managedHookController.ts` per the
   "Managed hook install" bullet above — generalize the surgery to a per-event-name param
   and register the per-agent event sets: **Claude** `UserPromptSubmit`/`PreToolUse`/
   `PostToolUse`/`Notification`(matcher `permission_prompt`)/`Stop`/`StopFailure` (plus the
   existing `SessionStart`); **Codex** `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/
   `PermissionRequest`/`Stop` (plus the existing `SessionStart`) — **no Codex `Notification`
   (not a Codex hook), no Codex `StopFailure` (does not exist)**. Idempotent update of each
   marked entry; preserve all unrelated hooks;
   `.bak` on change; uninstall removes our entries across **all** event keys. Tests: install
   adds all events for both agents; uninstall removes exactly our events across every event
   key; unrelated hooks preserved; idempotent re-run; `.bak` written; Codex `matcher`
   omitted, Claude `matcher` `""` for match-all events. Mirror `managedHookController.test.ts`
   and `managedHooks.test.ts`.
5. **IPC + store:** per "Implementation contracts" — add `pane:agent-event` to
   `src/shared/types.ts` (signature map + `EventChannels` union); add the `agentStatus` leaf
   field + `setPaneAgentStatus` action; add the pure `eventToState` reducer in
   `src/shared/agentStatus.ts`; add the `panesIpc.ts` `pane:agent-event` listener. Unit-test
   `eventToState` over the truth table, including demotion-clears, turn-id guard, and
   out-of-order-late-tool-after-stop.
6. **UI:** `StatusDot` in `PaneHeader` (after the type icon) reading
   `pane.agentStatus?.status ?? 'unknown'` — a colored CSS dot, **no `.png` asset needed**.
   Tooltip with the last event detail (e.g. tool name). Add `statusWorking`/`statusWaiting`
   tokens to `theme.ts`; reuse `danger`/`textMuted`/`textFaint` for the rest. No raw hex in
   the component.
7. **Toggle:** reuse the existing 047 Settings → Terminal toggle (`cliSessionLinking`,
   "Session linking (managed hooks)", default-on) — **one toggle, one marked block per file,
   one install/uninstall** (resolved in Open questions #5). The `MULTIAGENT_*` env injection
   and the report server are already gated on this toggle, so lifecycle hooks fire and
   `/agent-event` is reachable only while it is on. Rename the copy to name the added
   lifecycle events (e.g. "Session linking & live status (managed hooks)"); update the
   description in `CliSessionLinkingSetting.tsx` accordingly. No new setting key.

**Phase 1 does NOT do:** CLI-launched agent badges (those need the trust UX), subagent
badges, `idle_prompt` nudges, any screen/OSC fallback.

### Phase 2 — CLI-launched agents + robustness

Goal: badges for panes promoted by 047 Phase 1's `agentProcessSweeper` (user typed
`claude`/`codex` in a shell pane), plus the robustness fallbacks.

1. **Promotion seeds `working`:** the existing `pane:agent-detected` listener already
   fires on promotion and calls `promoteShellPaneToAgent`, which (per Implementation
   contracts) now sets `agentStatus = eventToState(prev, {event:'promote'}, now)` →
   `working`. So a CLI-launched agent shows *something* immediately, then refines as hook
   events arrive. No extra listener code.
2. **Demotion clears:** on `pane:agent-detected` `null` (agent process exited),
   `demoteAgentPaneToShell` now sets `agentStatus = undefined`. This is the missed-`Stop`
   fallback for the [zellaude#5](https://github.com/ishefi/zellaude/issues/5) case. No extra
   listener code.
3. **CLI-launched Codex trust UX:** a CLI-launched Codex pane does not fire hooks until the
   user trusts via `/hooks` (047 Phase 4 constraint; we cannot add
   `--dangerously-bypass-hook-trust` to a user-typed command). Until trust, the pane shows
   `unknown` (not a guess). Reuse 047's unlinked-promoted-Codex hint pattern: after a few
   seconds with no events, show "trust the MultiAgent hook in `codex /hooks` for live
   status" alongside the existing session-linking hint.
4. **`StopFailure` / error:** wire the error state for **Claude only** (`StopFailure`).
   Codex has no error hook (Research findings #3) — a failed Codex turn shows `idle`, which
   is the honest fallback. Do not invent a Codex error signal.
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

### Other non-hook seams — considered and rejected (recorded so a future agent doesn't
re-investigate)

For Claude Code interactive panes, hooks are the only first-class live-status seam. The
alternatives below are documented here as **rejected**, with reasons:

- **`statusLine` command** (`~/.claude/settings.json` `statusLine`): interactive-TUI, runs a
  shell command with JSON stdin (incl. `prompt_id`, `session_id`, `transcript_path`, cost,
  context window), debounced 300ms, event-driven on assistant-message/`compact`/permission-
  mode-change/vim-toggle + optional `refreshInterval` timer. **Rejected for status badges:**
  (1) it carries **no live `state` field** — issue
  [#40589](https://github.com/anthropics/claude-code/issues/40589) asked Anthropic for exactly
  `idle`/`thinking`/`tool_calling`/`waiting_subagents` and was **closed stale**; (2) without
  `refreshInterval` it only refreshes during Claude's activity cycle, so busy/idle is
  "impossible from the script alone" (per the issue); (3) it is coarser than hooks — no
  per-tool (`PreToolUse`/`PostToolUse`) or permission-prompt (`Notification(permission_prompt)`)
  events, so `working`-while-tool-running and `waiting`-on-prompt are not derivable. It
  could
  at best supplement `idle`, which hooks' `Stop` already covers richer and per-event. Also it
  adds a second `~/.claude/settings.json` mutation surface with a documented shadowing gotcha
  (project `.claude/settings.local.json` overrides user-level `statusLine` wholesale). Do not
  use it for v1. Source: [statusline docs](https://code.claude.com/docs/en/statusline.md).
- **Transcript JSONL watching** (`~/.claude/projects/**/*.jsonl`): structured-file
  observation, not scraping — the app already scans these for session indexing. **Rejected as
  the status source:** flush latency (Claude writes JSONL in chunks, not per-event), coarser
  than hooks, and does not cleanly capture an in-flight permission prompt. Fine for the
  existing session-index/DeepSearch use; not for a live badge.
- **OTEL telemetry / `--output-format stream-json` / Agent SDK callbacks:** `stream-json` and
  SDK callbacks are headless/programmatic only — they do **not** fire in the interactive TUI
  (issues [#40506](https://github.com/anthropics/claude-code/issues/40506) /
  [#30143](https://github.com/anthropics/claude-code/issues/30143)). OTEL is an observation
  bus, impractical for real-time UI. Out of scope.

**Codex parallels (same shape, same conclusion):**

- **Codex `/statusline`** ([PR #10546](https://github.com/openai/codex/pull/10546)): an
  interactive multi-select for built-in TUI footer items (model, context, rate limits, git
  branch, tokens, session id, cwd, version) — **not** a command-backed statusline. A
  command-backed variant (script receives JSON on stdin) was attempted in
  [PR #10170](https://github.com/openai/codex/pull/10170) and **closed**; the open request is
  [#20244](https://github.com/openai/codex/issues/20244)→[#17827](https://github.com/openai/codex/issues/17827).
  So Codex's statusline is even less usable than Claude's for status — no command hook, no
  state field, no JSON-to-script pipe. Rejected.
- **Codex `osc 9;4` progress:** a *terminal* channel (escape sequences the TUI/terminal
  renders), not a hook. The community `codex-terminal-progress` plugin actually **drives OSC
  9;4 from Codex hooks** (SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/Stop) —
  i.e. OSC 9 here is downstream of hooks, not an independent seam. As a primary status source
  it's screen-derived (046 finding #7) and deferred as an idle tie-breaker at most.
- **`codex exec --json` / `codex app-server`:** headless/programmatic (NDJSON event stream /
  WebSocket-stdio server). Not interactive-TUI panes. Out of scope.
- **Codex transcript JSONL** (`~/.codex/sessions/**/*.jsonl`): same laggy/structured-file
  rejection as Claude's.

The practical taxonomy: **hooks** (control/event surface — used here observation-only) vs
**statusline/transcript/OTEL/exec-json/app-server** (coarser or headless-only observation) vs
**screen/OSC scraping** (brittle, 048). Only hooks give per-event, low-latency, interactive-
TUI status. Anthropic declining #40589's `state` field (and Codex closing command-backed
statusline #10170) is the clearest signal that hooks are the sanctioned path on both CLIs.

### Confirming prior art: `codex-terminal-progress`

The community plugin
[`codex-terminal-progress`](https://github.com/bcanozgur/codex-terminal-progress) implements
exactly this hook→state mapping for Codex — it uses `SessionStart`/`UserPromptSubmit`/
`PreToolUse`/`PermissionRequest`/`Stop` (Codex's `notify` config for turn-ended) to drive
OSC 9;4 states: spinner (busy), paused (waiting for approval), orange (waiting for input),
red (tool error), cleared (idle). This is independent confirmation that (a) hooks are the
established way to get live Codex status, (b) our event→state mapping (working/waiting/
idle, with permission via `PermissionRequest`) matches the community's, and (c) Codex
`UserPromptSubmit` fires and seeds busy. We reuse the same events for a badge instead of OSC
9;4 output. (Their "tool error" red is a transient per-tool indicator in the tab title; our
`error` is turn-level via `StopFailure` — Claude only — so we do NOT map a Codex tool error
to the pane `error` badge; the turn is still in progress.)

## Risks

- **Hook reliability in the interactive TUI.** Firing is documented (Research findings
  #1); the residual risk is a *missed* event, not absence of the seam. If `Stop`/`PostToolUse`
  are occasionally dropped on the target versions, the `agentProcessSweeper` demotion is the
  process-level fallback for a missed `Stop` (agent exits → badge clears). A stuck `working`
  is benign; a missed `waiting` is not, but `permission_request` is a distinct, high-signal
  event unlikely to be dropped.
- **Out-of-order / late events.** A `PostToolUse` arriving after `Stop` could flap
  `idle`→`working`. Mitigation (resolved): turn identity is available — Claude `prompt_id`
  (v2.1.196+), Codex `turn_id` (Research findings #2). `eventToState` stores the current
  turn id and ignores tool events from an older turn; **gated on presence** so older Claude
  (no `prompt_id`) accepts the self-healing flap. Do NOT add a timer heuristic (#32634).
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

## Open questions (resolved)

1. **Interactive-TUI hook firing — RESOLVED (yes).** See Research findings #1. The spike
   now confirms payload shape + ordering, not firing.
2. **Turn identity — RESOLVED (yes, version-gated).** Claude `prompt_id` (v2.1.196+), Codex
   `turn_id`. Gate the out-of-order guard on presence; accept the self-healing flap on older
   Claude. See Research findings #2.
3. **Codex error signal — RESOLVED (none).** Codex has no `StopFailure`; `error` is
   Claude-only for v1. See Research findings #3.
4. **`idle_prompt` — RESOLVED (ignore for v1).** Do not wire it. It has a ~60s timer and
   false-positives during thinking pauses (issue #32634); `Stop` is the idle signal. A
   secondary "still waiting for you" nudge much later is a possible future enhancement, not
   v1, and would be sourced from `idle_prompt` only as a nudge — never as the idle badge.
5. **Toggle — RESOLVED (one toggle).** Reuse the existing 047 Settings → Terminal toggle
   `cliSessionLinking` ("Session linking (managed hooks)", default-on) — one toggle, one
   marked block per file, one install/uninstall. The `MULTIAGENT_*` env injection and the
   report server are already gated on this toggle in `handlers.ts`/`getPaneEnv`, so
   lifecycle hooks get their env and their `/agent-event` route for free when it is on.
   Rename the copy to name the added lifecycle events (e.g. "Session linking & live status
   (managed hooks)"). Keeps the config-mutation exception single.
6. **Subagent badges — RESOLVED (out of scope v1).** Ignore `SubagentStart`/`SubagentStop`
   at the pane level. The badge reflects the pane's agent, not its subagents.

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
   Claude `matcher` `""` for match-all events. Update the CLAUDE.md `## Guardrails`
   scoped-exception line (currently "the **one** scoped exception is the managed
   `SessionStart` hook install") and `docs/session-linking-hooks.md` to name the added
   events. Do not touch `~/.claude.json` / `.mcp.json` / `~/.codex/config.toml` (the
   `[features] hooks = true` from 047 Phase 4 already enables the hooks system).
4. **Fail closed / honest.** No hooks → `unknown`, never a guessed state. A stuck
   `working` from a missed `Stop` is acceptable; a false `waiting` is not.
5. **Honest badge set.** `{idle, working, waiting, error, unknown}` — no "thinking"
   badge. "Thinking" collapses into `working`. State so in the UI. **`error` is
   Claude-only for v1** (Claude `StopFailure`; Codex has no error hook — a failed Codex
   turn shows `idle`, which is honest).
6. **Respect multi-window invariants.** `PtyManager` is a singleton; delivery via
   `windowManager.sendToWindowForPty`; `agentStatus` is in-memory and rides with the pane
   in `tab:absorb`/`tab:state-sync`. Atomic, tab-scoped; no composed primitives.
7. **No env / PATH changes.** The `MULTIAGENT_*` vars already exist from 047; this spec
   adds none. `buildEnv` scrub unchanged.
8. **No vendoring.** Reimplement any adapted technique in our own idioms.
9. **Tests ship with each phase.** The report-server route, the managed-hook
   install/uninstall for the new events, and `eventToState` are all pure and unit-tested.
10. **The spike is confirmatory, not build-blocking.** Firing in the interactive TUI is
    documented (Research findings #1); the hook script reads fields **defensively** against
    the documented shapes, so a wrong field name degrades gracefully (lost `detail`/`turnId`)
    rather than breaking. Build against the cited shapes; run the scripted spike
    ("Spike procedure (for an AI)") if automatable, else let the Phase 1 in-app turn
    (Implementation order step 10) be the live confirmation. Do not block the build on the
    spike.

## Definition of done

- Phase 1: app-launched Claude and Codex panes show a correct `working`/`waiting`/`idle`/
  `error` badge driven by lifecycle hooks; toggle on/off installs/uninstalls all events
  cleanly with unrelated hooks preserved and `.bak` written; unit tests + the spike green;
  `typecheck`/`npm test`/E2E green; CLAUDE.md updated.
- Phase 2: CLI-launched Claude badges from promotion; CLI-launched Codex badges after
  `/hooks` trust with the hint; demotion clears the badge (the missed-`Stop` fallback);
  cross-window drag preserves the badge.
- Phase 3: none (the rejected fallback — documented, not built).

## Implementation contracts (build-by-numbers)

Every decision below is final; the developer implements, does not re-derive. All file paths
verified against the current tree.

### Types — `src/shared/types.ts`

Add to the pane/session type region and the IPC channel maps:

```ts
// Badge state — honest set, no "thinking".
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error' | 'unknown'

// In-memory per-pane status. NOT serialized (stripped in normalizeNodeForLayout, like
// promotedFromShell). `turnId` is the Claude `prompt_id` / Codex `turn_id` of the turn this
// status reflects; used by eventToState to drop out-of-order late tool events.
export interface AgentStatusState {
  status: AgentStatus
  detail?: string        // tool name, permission message, error type — shown in the tooltip
  turnId?: string
  event?: AgentLifecycleEvent
  updatedAt: number      // Date.now() at the reducer call (injected for testability)
}

// Lifecycle events the hook script reports. `promote`/`demote` are synthetic, fed by the
// pane:agent-detected listener (sweeper), not by a hook. `session_start` doubles as the
// 047 session-linking trigger (see Hook script dispatch).
export type AgentLifecycleEvent =
  | 'session_start' | 'user_prompt_submit' | 'pre_tool_use' | 'post_tool_use'
  | 'stop' | 'permission_request' | 'stop_failure' | 'promote' | 'demote'

// What main forwards on pane:agent-event, and what the reducer consumes.
export interface AgentStatusInput {
  event: AgentLifecycleEvent
  detail?: string
  turnId?: string
}
```

IPC channel (main → renderer, raw event forward — main does NOT reduce): add to the
signature map near `pane:agent-detected` AND to the `EventChannels` union (~line 595):

```ts
'pane:agent-event': (ptyId: string, event: AgentLifecycleEvent, detail?: string, turnId?: string) => void
```

### Pure reducer — new `src/shared/agentStatus.ts`

Pure extraction (mirrors `paneTree.ts`/`cwdRepair.ts` — testable, no Electron deps). Full
truth table; `prev` is `AgentStatusState | undefined`; `now` is injected so tests are
deterministic (`vi.setSystemTime`).

```
eventToState(prev, input, now) -> AgentStatusState | undefined

promote              -> { status:'working', updatedAt:now }                      // initial; refined by first event
demote               -> undefined                                                 // clear the badge (sweeper: agent exited)
session_start        -> { status:'working', turnId:input.turnId, updatedAt:now } // incl. resume; never bails on MULTIAGENT_SESSION_ID
user_prompt_submit   -> { status:'working', turnId:input.turnId, updatedAt:now } // new turn (Claude only)
pre_tool_use         -> working, detail=tool_name, turnId=input.turnId            // (turn-id guard applies — see below)
post_tool_use        -> working, detail=tool_name, turnId=input.turnId            // (turn-id guard applies)
stop                 -> { status:'idle', turnId:input.turnId, updatedAt:now }    // ended turn; detail cleared
stop_failure         -> { status:'error', detail:input.detail ?? 'error', turnId:input.turnId, updatedAt:now }
permission_request   -> { status:'waiting', detail:input.detail, turnId:input.turnId ?? prev?.turnId, updatedAt:now }
subagent_*           -> NOT in the allow-list; never arrives; no handler needed
```

**Turn-id guard (out-of-order late tool event after `stop`):** once `prev.status === 'idle'`,
a `pre_tool_use`/`post_tool_use` is applied only if its `turnId` differs from `prev.turnId`
(a new turn started — we missed its `user_prompt_submit`, or the tool fired first). If
`turnId` is equal (same turn, delayed) **or absent** (older Claude with no `prompt_id`),
**ignore the tool event** and return `prev`. Rationale: UUID turn ids are unique per turn, so
"different from the ended turn" == "new turn"; no monotonic counter needed. A late
`post_tool_use` from the ended turn is dropped; a tool event from a new turn promotes to
`working`. A new `user_prompt_submit` always wins (sets a fresh turnId). `permission_request`
and `stop_failure` always apply (high-signal). When `prev` is `undefined` (cold start, first
event), any non-`demote` event seeds the state normally.

### Report server — `src/main/integration/agentSessionReportServer.ts`

Add `onEvent` to `AgentSessionReportServerDeps` and a second route in `handle()`:

```ts
const VALID_EVENTS: readonly AgentLifecycleEvent[] = [
  'session_start','user_prompt_submit','pre_tool_use','post_tool_use',
  'stop','permission_request','stop_failure',
] as const  // note: NO promote/demote (synthetic, renderer-only) and NO subagent_*

// POST /agent-event — validate { ptyId:string, agentKind in VALID_AGENT_KINDS,
//   event in VALID_EVENTS, detail?:string, turnId?:string } -> deps.onEvent({...}); 204.
// 400 on bad shape / unknown event / bad agentKind; 404 on any other path (mirrors /agent-session).
```

Keep `/agent-session` byte-identical. `session_start` events go to `/agent-event` (status);
the session-id still goes to `/agent-session` (linking) — both from the same SessionStart
hook invocation (see script dispatch).

### Hook script dispatch — `assets/multiagent-agent-state.ps1` (+ `.sh` sibling)

`$args[0]` = agentKind (existing). `$args[1]` = event name (new; absent ⇒ legacy
SessionStart install ⇒ treat as `session_start` for back-compat). Dispatch:

- **`session_start` (or `$args[1]` absent):** read stdin JSON. **Always** POST `/agent-event`
  `{ptyId, agentKind, event:'session_start', turnId:<session_id>}` (seeds `working` — does
  NOT bail on `MULTIAGENT_SESSION_ID`; app-launched Claude must still badge). **Then**, iff
  `MULTIAGENT_SESSION_ID` is unset, also POST `/agent-session` `{…, sessionId, transcriptPath}`
  (the existing 047 linking report, with its existing bail). This preserves 047 behavior
  exactly while adding the status seed.
- **lifecycle event (`user_prompt_submit`/`pre_tool_use`/`post_tool_use`/`stop`/
  `permission_request`/`stop_failure`):** read stdin JSON. Extract `turnId` =
  `payload.prompt_id` (Claude) or `payload.turn_id` (Codex) — branch on `$args[0]`. Extract
  `detail` per event: `tool_name` for `pre_tool_use`/`post_tool_use`; the notification
  `message` (Claude) or `tool_name` (Codex `PermissionRequest`) for `permission_request`;
  the error type for `stop_failure` if present else omit; omitted for `user_prompt_submit`/
  `stop`. POST `/agent-event` `{ptyId, agentKind, event, detail, turnId}`. **Never bail on
  `MULTIAGENT_SESSION_ID`** for lifecycle events (only the session-id report bails).
- **Every path exits 0** (never blocks the agent). Keep the `MULTIAGENT_ENV` /
  `MULTIAGENT_PTY_ID` / `MULTIAGENT_HOOK_PORT` gate verbatim. `.sh` sibling: identical
  dispatch, pure-`sed` JSON parse + `curl` (no `jq`), as today.

**Defensive field reading (build against docs, survive drift):** every field extraction must
tolerate absence — read `$payload.prompt_id` (Claude) / `$payload.turn_id` (Codex) into
`turnId` but send `turnId` only when present; read `tool_name`/`message` into `detail` only
when present. A wrong or missing field name means a lost `detail`/`turnId`, never a thrown
error or a blocked agent. This is why the spike is not build-blocking: the documented shapes
(cited in Research findings) are sufficient to build, and the first real app-launched turn
confirms.

### Spike procedure (for an AI) — optional confirmation

Only run this if you want to confirm payload shapes before the in-app verification. It is
fiddly to fully automate (hooks fire in *interactive* TUI only, not `claude -p`), so the
**doc-trust + defensive-parsing path above is the default**; this is a confirmatory pass.

1. Write a throwaway dump hook `dump.ps1`: reads stdin, appends `"$args[0] >>> $raw` to
   `%TEMP%\ma-spike.log`, exits 0.
2. Temporarily install one hook entry per event in `~/.claude/settings.json`
   (`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Notification`(matcher
   `permission_prompt`)/`Stop`/`StopFailure`), each command
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <dump.ps1> <EventName>`.
3. Drive one interactive turn that uses a tool and triggers a permission prompt. Easiest
   from inside the app (`npm run dev`, app-launch a Claude pane, type a prompt that reads a
   file) — the app's PTY is already interactive. Failing that, spawn `claude` under
   `node-pty` (the repo has it) and write a prompt + a tool-granting keystroke.
4. Read `%TEMP%\ma-spike.log`: confirm each event fired and capture the exact JSON fields
   (esp. `prompt_id`, `tool_name`, `message`). Diff against the documented shapes.
5. **Revert** `~/.claude/settings.json` (remove the dump entries; restore from the `.bak`
   the controller wrote, or hand-edit). Do not leave dump hooks installed.

Repeat for Codex (`~/.codex/hooks.json`, `SessionStart`/`UserPromptSubmit`/`PreToolUse`/
`PostToolUse`/`PermissionRequest`/`Stop`; app-launched so `--dangerously-bypass-hook-trust`
applies) — confirm `turn_id`, that `UserPromptSubmit` fires on each prompt (seeds `working`),
and that `PermissionRequest` is present (it landed in
[openai/codex#17563](https://github.com/openai/codex/pull/17563), Apr 2026). Also confirm
the Codex tool-event matcher: `".*"` should match all tools (per `codex-terminal-progress`);
verify vs omitted.

If the spike is impractical to automate, skip it: build with defensive parsing against the
documented shapes and let Phase 1 verification (a real app-launched turn) be the
confirmation. Do not block on the spike.

### Managed-hook install — `managedHooks.ts` / `managedHookController.ts`

Generalize the pure surgery from the hardcoded `SessionStart` key to a per-event-name param:

```ts
injectManagedHook(config, eventName: string, command: string, matcher: string | null): unknown
removeManagedHook(config): unknown              // removes our entries across ALL event keys (sentinel-based)
hasManagedHook(config): boolean                 // true if any event key holds our sentinel
generateHookCommand(scriptPath, kind, event?: string, platform = process.platform): string
// event omitted/undefined -> existing no-arg command (back-compat for legacy SessionStart entries)
// event present -> appends ` <event>` as the script's 2nd positional arg
```

`managedHookController.install()` loops over the per-agent event set, calling
`injectManagedHook(cfg, eventName, generateHookCommand(scriptPath, kind, event), matcher)`
per event. **Per-agent event sets + matcher policy:**

| Agent | Events (eventName → matcher) |
|---|---|
| Claude | `SessionStart`→`""`, `UserPromptSubmit`→`""`, `PreToolUse`→`""`, `PostToolUse`→`""`, `Notification`→`"permission_prompt"`, `Stop`→`""`, `StopFailure`→`""` (or a combined matcher; `""` matches all error types) |
| Codex | `SessionStart`→omitted, `UserPromptSubmit`→omitted (matcher not supported/ignored), `PreToolUse`→`".*"`, `PostToolUse`→`".*"`, `PermissionRequest`→`".*"`, `Stop`→omitted (matcher not supported/ignored) |

(`""` = Claude match-all; omitted = Codex match-all for source/non-matcher events — the
existing 047 policy. For Codex **tool** events, use `".*"` to match all tools — the working
`codex-terminal-progress` plugin uses `matcher = ".*"` for `PreToolUse`; confirm during the
spike that `".*"` (vs omitted) matches all tools, since 047 established Codex treats `""` as
match-nothing.) **No Codex `Notification` (not a Codex hook event) and no Codex `StopFailure`
(does not exist).** The hook `eventName` passed to `generateHookCommand` is the **script
event arg**: `session_start`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `stop`,
`permission_request`, `stop_failure` (lowercase snake; the script maps these to the
`/agent-event` `event` field verbatim). `uninstall()` removes every entry whose command
contains `HOOK_SENTINEL` across every event key and prunes empty groups/keys. `.bak` +
atomic replace + legacy `~/.claude.json` cleanup unchanged.

**Codex trust:** each distinct hook command string is a separate trust hash in Codex
`[hooks.state]`. Adding lifecycle events means the user re-trusts once via `codex /hooks`
(new hashes). App-launched Codex bypasses trust via `--dangerously-bypass-hook-trust`
(047). CLI-launched Codex shows `unknown` until trust — reuse 047's hint (Phase 2).

### Store — `src/renderer/src/store/panes.ts` + `src/shared/types.ts`

- Add `agentStatus?: AgentStatusState` to `PaneLeaf` (non-serialized).
- Action `setPaneAgentStatus(paneId, state: AgentStatusState | undefined)`: pure
  `patchLeafInTabs` (mirror `updatePane`).
- `promoteShellPaneToAgent(paneId, agentKind)`: also set `agentStatus: eventToState(prev,
  {event:'promote'}, Date.now())` → `{status:'working'}`. (Read current leaf's
  `agentStatus` as `prev`.)
- `demoteAgentPaneToShell(paneId)`: also set `agentStatus: undefined` (the missed-`Stop`
  fallback — agent exited).
- **Native (app-spawned) agent panes:** initial `agentStatus` is `undefined` (renders
  `unknown`) until the first hook event (`session_start` → `working`). Do not seed
  `working` at spawn for native panes — `session_start` will. On cold restart, a resumed
  native pane shows `unknown` until `session_start` (resume) fires, which is immediate.
- `normalizeNodeForLayout` (`src/main/ipc/layoutStore.ts` ~line 146): in BOTH the
  promoted-leaf and defensive branches, `delete (cleaned)['agentStatus']` alongside
  `promotedFromShell`. One-line additions; `agentStatus` never reaches `layout.json`.

### Renderer IPC — `src/renderer/src/store/panesIpc.ts`

Add a module-level listener (next to the `pane:agent-detected` listener):

```ts
window.ipc.on('pane:agent-event', (ptyId, event, detail, turnId) => {
  if (typeof ptyId !== 'string' || typeof event !== 'string') return
  const store = usePanesStore.getState()
  for (const tab of store.tabs) {
    const pane = tab.rootNode && findLeafByPtyId(tab.rootNode, ptyId)
    if (pane) {
      const next = eventToState(pane.agentStatus, { event: event as AgentLifecycleEvent, detail: safeStr(detail), turnId: safeStr(turnId) }, Date.now())
      store.setPaneAgentStatus(pane.id, next)
      break
    }
  }
})
```

The existing `pane:agent-detected` listener already calls `promoteShellPaneToAgent` /
`demoteAgentPaneToShell`; since those actions now set/clear `agentStatus`, promotion seeds
`working` and demotion clears automatically — no extra listener code. (`safeStr` = helper
returning `undefined` for non-strings.) Pane not yet hydrated: the store tree (incl.
`rootNode`) exists for all tabs regardless of runtime hydration (spec 001), so
`findLeafByPtyId` resolves and the badge renders when `PaneHeader` mounts on first focus.

### UI — `src/renderer/src/components/PaneHeader/index.tsx` + `src/renderer/src/styles/theme.ts`

Insert a status dot immediately after the type-icon `<span>` (before the title), only when
`pane.paneType === 'agent'`:

```tsx
{isAgent && <StatusDot status={pane.agentStatus?.status ?? 'unknown'} detail={pane.agentStatus?.detail} />}
```

`StatusDot` (new small component in `PaneHeader/`): a 7px circle, `flexShrink:0`, with a
`title` tooltip `StatusDot: <state>[\n<detail>]`. Colors via `theme.ts` — **add two tokens**
to `ui.color` (the guardrail: add shared tokens there, no raw hex in components):
`statusWorking: '#60a5fa'` (blue) and `statusWaiting: '#fbbf24'` (amber). Reuse existing
tokens for the rest:

| status | color | meaning |
|---|---|---|
| `working` | `ui.color.statusWorking` (new blue) | turn in progress (incl. "thinking" — collapsed) |
| `waiting` | `ui.color.statusWaiting` (new amber) | permission prompt — needs you |
| `error` | `ui.color.danger` (`#f87171`) | turn ended on API error (Claude only) |
| `idle` | `ui.color.textMuted` (`#6b7280`) | turn ended, awaiting input |
| `unknown` | `ui.color.textFaint` (`#3a3b3e`) | no hook events yet (honest fallback) |

Tooltip copy: `working` → "Working" (+ ` · <tool_name>` when detail set); `waiting` →
"Waiting for permission" (+ detail); `error` → "Error" (+ detail); `idle` → "Idle";
`unknown` → "Status unknown". State "thinking is part of working" in the working tooltip
only (e.g. "Working — includes thinking") to honor the no-thinking-badge honesty rule.

### Toggle + docs (exact text)

- `CliSessionLinkingSetting.tsx`: rename `title` to `"Session linking & live status (managed
  hooks)"`. New `description` (drop-in):
  > "Links agent sessions to their pane and resumes them on restart, and shows a live
  > status badge per agent pane (working/waiting/idle/error), by installing managed hooks
  > in ~/.claude/settings.json and ~/.codex/hooks.json (plus the [features] hook flag in
  > ~/.codex/config.toml). On by default; uninstallable from this same toggle; preserves
  > all unrelated settings/hooks. Claude links and badges automatically; Codex links and
  > badges after you trust the hook once via codex /hooks (app-launched and CLI-launched
  > alike)."
- `CLAUDE.md` `## Guardrails` scoped-exception line: change "the managed `SessionStart`
  hook install" → "the managed `SessionStart` + lifecycle (`UserPromptSubmit`/`PreToolUse`/
  `PostToolUse`/`Notification(permission_prompt)`/`Stop`/`StopFailure` for Claude;
  `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PermissionRequest`/`Stop` for Codex) hook
  install". Keep the `→ docs/session-linking-hooks.md` link.
- `docs/session-linking-hooks.md`: in the "What gets installed where" table, expand the
  Claude/Codex rows to list the lifecycle events; in the toggle section, note the rename and
  that lifecycle events are installed/uninstalled atomically with the `SessionStart` block.

### Known limitation to document in `docs/session-linking-hooks.md`

**Codex has no `error` badge and no `Notification` hook.** Codex has no `StopFailure`, so a
failed Codex turn surfaces as a normal `Stop` → `idle` (the `error` badge is Claude-only via
`StopFailure`). Codex also has no `Notification` hook — permission-prompt waiting is sourced
from `PermissionRequest` instead. Both are honest limitations, not bugs; do not chase them
and do not add a scraper. (An earlier draft of this spec believed Codex lacked
`UserPromptSubmit` and that pure-chat Codex turns would show `idle` throughout — that was
wrong: `UserPromptSubmit` is supported, so Codex `working` is seeded every turn, same as
Claude. Recorded so a future agent doesn't re-derive the old limitation.)

### Test checklist (ship with each phase)

- **`agentSessionReportServer.test.ts`** (extend): `/agent-event` POST→`onEvent` for each
  `VALID_EVENTS` entry with `detail`/`turnId` pass-through; 400 on bad shape / unknown
  event / bad agentKind / missing ptyId; 404 on wrong path; `/agent-session` unchanged.
- **`managedHooks.test.ts`** (extend): `injectManagedHook(cfg, 'Stop', cmd, '')` adds a
  `Stop` group; install over an existing `SessionStart` keeps both; `removeManagedHook`
  removes our entries across `SessionStart` + `Stop` + `Notification` + … and leaves
  unrelated hooks; `hasManagedHook` true when any event key holds the sentinel; Codex
  `SessionStart`/`UserPromptSubmit`/`Stop` matcher omitted, Codex tool events `".*"`, Claude
  `""`; Claude `Notification` matcher `'permission_prompt'`.
- **`managedHookController.test.ts`** (extend): install writes all per-agent events to both
  files; uninstall removes all and only our events across every event key; unrelated hooks
  preserved; idempotent re-run; `.bak` written; Codex has `UserPromptSubmit` but **no**
  `Notification` and **no** `StopFailure` entries.
- **`agentStatus.test.ts`** (new, shared): every row of the truth table; turn-id guard —
  late `post_tool_use` after `stop` with same `turnId` → ignored; with different `turnId`
  → `working`; with no `turnId` → ignored (older Claude flap suppressed, self-heals on next
  `stop`); `promote`→`working`, `demote`→`undefined`; `session_start`→`working`;
  `stop_failure`→`error`; `permission_request`→`waiting`; `prev undefined` seeds normally.
  Pin `now` via an injected param.
- **`panes.test.ts`** (extend): `setPaneAgentStatus` patches the leaf; `demoteAgentPaneToShell`
  clears `agentStatus`; `promoteShellPaneToAgent` seeds `working`; `normalizeNodeForLayout`
  strips `agentStatus` (never serialized).
- **`PaneHeader/index.test.tsx`** (extend): renders the dot for an agent pane; correct
  color/token per status; tooltip shows detail; no dot for shell panes.
- **Integration spike (Phase 1 gate):** per Phase 1 step 1 — confirm payload shapes +
  ordering on the target binaries (firing already documented).
- **Regression:** `npm run typecheck`, `npm test`, `npm run test:e2e` green; `buildEnv.test.ts`
  PATH guard still green (no env changes here). No new E2E (driving a real claude/codex turn
  in E2E is impractical; the spike + unit tests cover the surface).

## Implementation order (sequenced — work top-to-bottom, verify at each gate)

Follow this order to keep the build green at every step. "Impl contracts §X" refers to the
section above.

1. **Types** — add `AgentStatus`/`AgentStatusState`/`AgentLifecycleEvent`/`AgentStatusInput`
   to `src/shared/types.ts`; add `agentStatus?: AgentStatusState` to `PaneLeaf`; add the
   `pane:agent-event` signature + `EventChannels` union entry. → **Gate:** `npm run
   typecheck` green.
2. **Pure reducer** — create `src/shared/agentStatus.ts` with `eventToState(prev, input,
   now)` per the truth table + turn-id guard; create `agentStatus.test.ts` covering every
   row + guard cases. → **Gate:** `npm test` green (new test file passes).
3. **Report server** — extend `agentSessionReportServer.ts` with `onEvent` dep +
   `/agent-event` route + `VALID_EVENTS`; extend `agentSessionReportServer.test.ts`. →
   **Gate:** `npm test` green. (Do not wire `onEvent` in `handlers.ts` yet.)
4. **Hook script** — generalize `multiagent-agent-state.ps1` (+ `.sh`) per "Hook script
   dispatch" + defensive reading. No unit test (PowerShell); the integration turn covers it.
   → **Gate:** `npm run typecheck` green (script isn't TS, but confirm no asset/emission
   breakage in `electron.vite.config.ts`).
5. **Managed-hook install** — generalize `managedHooks.ts` (`injectManagedHook(cfg,
   eventName, …)` etc.) + `generateHookCommand(…, event?, …)`; extend
   `managedHookController.ts` to loop the per-agent event sets; extend
   `managedHooks.test.ts` + `managedHookController.test.ts`. → **Gate:** `npm test` green.
6. **Wire main** — in `handlers.ts`, pass `onEvent: (e) => windowManager.sendToWindowForPty(
   e.ptyId, 'pane:agent-event', e.ptyId, e.event, e.detail, e.turnId)` to the report server.
   → **Gate:** `npm run typecheck` green.
7. **Store + renderer IPC** — add `setPaneAgentStatus`; extend
   `promoteShellPaneToAgent`/`demoteAgentPaneToShell` to set/clear `agentStatus`; add the
   `pane:agent-event` listener in `panesIpc.ts`; strip `agentStatus` in
   `normalizeNodeForLayout`; extend `panes.test.ts`. → **Gate:** `npm test` + `npm run
   typecheck` green.
8. **UI** — add `statusWorking`/`statusWaiting` to `theme.ts`; add `StatusDot` + mount it in
   `PaneHeader`; extend `PaneHeader/index.test.tsx`. → **Gate:** `npm test` green; visually
   confirm in `npm run dev` (app-launch a Claude pane).
9. **Toggle + docs** — update `CliSessionLinkingSetting.tsx` (rename + description), the
   `CLAUDE.md` guardrail line, and `docs/session-linking-hooks.md` (install table + toggle +
   Codex no-error/no-Notification limitation). → **Gate:** `npm run typecheck` green.
10. **End-to-end confirmation (the real spike gate)** — `npm run dev`, app-launch a Claude
    pane, send a prompt that uses a tool → badge goes `working` (tool-name tooltip) → `idle`
    on turn end; trigger a permission prompt → `waiting`. App-launch a Codex pane, drive a
    tool-using turn → `working` → `idle`. Toggle off → marked block removed, unrelated hooks
    intact, `.bak` written; badge freezes then clears on demotion. → **Gate:** observed.
11. **Regression** — `npm run typecheck`, `npm test`, `npm run test:e2e` all green;
    `buildEnv.test.ts` PATH guard still green. → **Gate:** all green. Then Phase 2 per the
    phased plan.

If any gate is red, fix before proceeding — do not accumulate breakage. Use a worktree/branch
(this repo follows "branch before implementing on the default branch").

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