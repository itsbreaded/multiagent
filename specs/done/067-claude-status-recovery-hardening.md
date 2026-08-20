# Spec: Harden Agent Status Recovery After Interrupts and Completed Turns

Status: done <!-- draft | ready | in-progress | review | done -->
Created: 2026-08-19
Completed: 2026-08-19

## Problem

The status badge can remain `working` after an agent is no longer doing work. The
clearest reproduction is pressing Escape in Claude Code: Claude Code documents
that its `Stop` hook does not run when a turn ends because of a user interrupt,
so the current hook-driven reducer has no normal idle event to consume. The pane
can therefore continue to show Working after Claude returns control to the user.

A related failure occurs after an otherwise complete response. The current
background-subagent protection deliberately fails safe when a completion event is
missed, and the pane can retain a working state even when no background agent is
running. The result is a badge that no longer describes the session and can also
prevent legitimate idle-session behavior from taking effect.

The existing lifecycle model is strong when all expected signals arrive, but it
has no explicit recovery contract for omitted signals, delayed delivery, stale
in-memory tracking, or provider-specific work that continues after the visible
turn ends. This is a status correctness problem, not a change to any provider's
ability to cancel or continue work.

### Independently researched provider contracts

The shared rule is intentionally narrow: a pane is not idle while any work in
that pane can still execute or wake without a new user prompt. The evidence used
to establish that rule is provider-specific:

| Provider | Authoritative completion/interruption evidence | Work that can outlive the visible turn | Reliability boundary |
|---|---|---|---|
| Claude Code | `Stop` for a normal response, `StopFailure` for API failure, and provider-labeled notification/task lifecycle signals. `Stop` is explicitly omitted for user interrupts. | `background_tasks` includes shell, subagent, monitor, workflow, teammate, cloud, and MCP task types; `session_crons` describes scheduled wakeups. | `Stop` and `SubagentStop` carry structured task snapshots in current Claude Code; a missing `Stop` must not be treated as completion. |
| Codex | App Server emits `turn/started` and terminal `turn/completed` statuses, including `interrupted` and `failed`; `turn/interrupt` resolves before the terminal turn event. | Background terminals are explicitly separate from turn cancellation and continue until cleaned up. | Codex's CLI hook coverage differs by mode, and official repository reports document missing `Stop` hooks after Escape and in `exec`; hook absence is not completion evidence. |
| OpenCode | The plugin/event contract exposes session `busy`/`retry`/`idle` and error/permission events; current server protocols also expose execution terminal states where available. | Experimental background subagents and child sessions can continue independently of a parent session's ordinary idle event. | OpenCode's plugin/event surface is versioned; `session.idle` is a per-run signal, not a universal finalization guarantee, and event names must be validated against the installed protocol. |

Claude facts are documented in the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks): `Stop` is not emitted for user interrupts; `background_tasks` and `session_crons` are present on current `Stop` and `SubagentStop` inputs; `Notification` exposes provider-labeled `idle_prompt` and `agent_completed` events. The local environment currently reports Claude Code `2.1.226`, so the plan must verify those signals against that target.

Codex facts are documented in the [Codex App Server reference](https://developers.openai.com/codex/app-server/) and the [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md): interrupted turns end with `turn/completed` status `interrupted`, while background terminals are separate. The official [Codex interruption-hook issue](https://github.com/openai/codex/issues/22858) and [Codex exec hook-coverage issue](https://github.com/openai/codex/issues/18607) are treated as compatibility evidence, not as a substitute for the protocol contract.

OpenCode facts are documented in the [OpenCode plugin reference](https://opencode.ai/docs/plugins/), the [OpenCode session-status schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts), the [OpenCode session client state](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/context/server-session.ts), and the [OpenCode CLI reference](https://dev.opencode.ai/docs/cli/). The [OpenCode finalization discussion](https://github.com/anomalyco/opencode/issues/35540) records why `session.idle` must not be treated as a process/session-finalization signal, and the [OpenCode event-version compatibility issue](https://github.com/anomalyco/opencode/issues/40808) shows why the current event surface must be checked against the installed protocol before implementation.

Comparable monitors use the same hook lifecycle for ordinary transitions but add
a bounded recovery path for Escape: [Claude-Code-Agent-Monitor hook lifecycle](https://github.com/hoangsonww/Claude-Code-Agent-Monitor#hook-lifecycle)
uses provider-generated interruption evidence and keeps a parent waiting while
subagents remain active; [Claude-Code-Agent-Monitor state machine and interrupt recovery](https://hoangsonww.github.io/Claude-Code-Agent-Monitor/wiki/)
describes its conservative fallback. [Claude Status](https://github.com/gmr/claude-status)
combines hook notifications with filesystem watching, polling, and process
liveness. These projects inform the reliability shape, but their heuristics are
not accepted as MultiAgent evidence without provider validation.

## Goal

Claude, Codex, and OpenCode panes must converge to the existing `idle` state when
the provider has confirmed that the current turn ended and no active or scheduled
work remains in that pane. A pane must remain `working` and protected from idle
suspension while any provider-confirmed work remains. If the provider cannot
provide enough evidence to establish that no work remains, the system must fail
safe by retaining protection rather than guessing idle.

## Users & Context

Users running Claude Code, Codex, or OpenCode in an embedded MultiAgent PTY,
especially users who interrupt a turn with Escape, switch tabs while work runs,
or rely on the status badge and automatic idle-session suspension to represent the
live session.

The three providers share the renderer status vocabulary and suspension policy,
but their lifecycle and active-work evidence are not interchangeable. A provider
adapter may use only signals that the provider itself documents or that are
verified against the supported runtime version.

## Requirements

1. MUST report a pane as `idle` after a normal completed turn only when its
   provider-specific completion evidence confirms that no permission wait, error
   latch, active task, child session, background terminal, or scheduled wakeup
   remains in the pane. Stale in-memory tracking MUST be reconciled by a newer
   authoritative no-work snapshot rather than allowed to block idle forever.
2. MUST provide an interrupt-aware path for each supported provider when its
   provider-specific evidence confirms that an interrupted turn ended. Claude's
   path MUST NOT depend on the normal `Stop` hook, because Claude Code does not
   emit that hook for user interrupts. Codex MUST distinguish an interrupted turn
   from background terminals that continue after interruption. OpenCode MUST
   distinguish a session becoming idle from child/background work that remains
   active.
3. MUST treat provider-authoritative work snapshots as reconciliation evidence.
   An authoritative empty snapshot MUST clear stale in-memory work tracking;
   one or more active or scheduled entries MUST keep the pane `working` and
   ineligible for automatic idle suspension.
4. MUST cover every provider work type that the provider exposes as able to
   execute or wake without a new user prompt. For Claude this includes every
   `background_tasks` type and every `session_crons` entry, not only subagents.
   For Codex this includes active turns and background terminals. For OpenCode
   this includes the active session plus any provider-reported child or
   background session. A single child/subagent completion event MUST NOT make the
   parent pane idle while another work item remains.
5. MUST make repeated, delayed, duplicated, missing, or out-of-order lifecycle
   signals idempotent and turn-aware. A late event from an earlier turn MUST NOT
   demote a newer working turn to `idle`, and a completion signal MUST NOT clear
   work that belongs to a newer turn or child session.
6. MUST provide a bounded recovery path for a missing expected lifecycle signal
   when a provider-specific structured completion, interruption, idle, or no-work
   snapshot becomes available. The recovery result MUST retain machine-readable
   evidence/reason provenance so deterministic tests can distinguish an ordinary
   completion from an interrupt recovery or stale-state reconciliation.
7. MUST NOT declare a pane idle solely because terminal output is quiet, a fixed
   amount of time has passed, the process is old, no recent tool event was
   observed, or a generic text/ANSI pattern appears. A watchdog MAY trigger a
   provider-state recheck, but a timer alone MUST NOT establish idle. If no
   provider-specific no-work evidence is available, the pane remains protected.
8. MUST preserve existing precedence: permission/waiting and error states remain
   visible when they are the higher-signal current state; a new user prompt makes
   the pane `working`; confirmed active or scheduled work overrides an otherwise
   idle result; and a no-work reconciliation clears only stale work tracking.
9. MUST keep provider handling independent. Claude's missing-`Stop` and
   `background_tasks` rules MUST NOT be copied to Codex or OpenCode. Codex's
   `turn/completed` and background-terminal rules MUST NOT be assumed for Claude
   or OpenCode. OpenCode's session/plugin rules MUST NOT be assumed for either
   CLI-hook provider.
10. MUST clear transient status, turn identity, child/work tracking, and recovery
    provenance when the agent process/session is replaced, the PTY exits, or the
    application restarts. Runtime status MUST remain unpersisted in layout and
    settings.
11. MUST preserve the current automatic idle-suspension policy contract: a pane
    with confirmed active or scheduled work is ineligible; a pane recovered to
    confirmed `idle` follows the existing eligibility rules; and a pane with
    insufficient evidence remains protected.
12. MUST keep the existing user-facing status vocabulary and presentation. This
    hardening MUST NOT add an `interrupted`, `recovering`, `background`, or
    `scheduled` badge category, and MUST NOT change any provider's interrupt,
    resume, background-task, or scheduling behavior.
13. MUST keep all structured recovery evidence on the existing single lifecycle
    status path. The implementation MUST NOT add a broad terminal-output status
    parser, screen scraping, full-scrollback scanning, arbitrary assistant-text
    classification, or a second status write path.

## Non-Goals

- We will NOT change Claude Code, Codex, or OpenCode's work execution, interrupt,
  resume, background-terminal, child-session, or scheduling behavior.
- We will NOT infer completion from arbitrary assistant text, generic keywords,
  ANSI screen contents, terminal quietness, process age, or the full terminal
  scrollback.
- We will NOT reintroduce the rolled-back broad terminal-status scraper from
  `terminal-scraping-status-dots`; the existing scoped terminal-error exception
  remains the only terminal-output exception.
- We will NOT change the automatic idle-suspension timeout, default, or resume
  policy.
- We will NOT add a new badge, notification, dashboard, or per-subagent control.
- We will NOT persist live status, turn identity, or active-work state.
- We will NOT force all providers through one shared hook/event mechanism or
  declare a provider idle when its current protocol cannot prove that no work
  remains.

## Scenarios (Acceptance Criteria)

- **Given** a Claude pane is `working`, **when** the user presses Escape and
  Claude emits a provider-labeled interruption/idle signal with no active or
  scheduled work, **then** the pane becomes `idle` without requiring `Stop`.

- **Given** Claude interrupts before assistant output, **when** the exact
  provider-generated interruption evidence or the documented idle recovery
  signal becomes available and no work is active, **then** the pane becomes
  `idle`; **when** no such evidence is available, **then** the pane remains
  protected rather than becoming idle because the terminal is quiet.

- **Given** a normal Claude response completes and its structured completion
  snapshot contains no `background_tasks` and no `session_crons`, **when** stale
  active-work tracking is present, **then** the pane becomes `idle` and the stale
  tracking is cleared.

- **Given** a Claude completion snapshot contains any active background task or
  scheduled wakeup, **when** the parent turn ends, **then** the pane remains
  `working` and is not eligible for idle suspension.

- **Given** a Claude snapshot contains a shell, monitor, workflow, teammate,
  cloud, MCP, or non-subagent task, **when** that task remains active, **then**
  the pane is protected exactly as it is for an active subagent.

- **Given** two Claude work items are active, **when** one emits its completion
  event, **then** the pane remains `working`; **when** the authoritative snapshot
  becomes empty, **then** stale tracking is reconciled and the pane becomes
  `idle` unless waiting or error takes precedence.

- **Given** a Codex turn is interrupted, **when** the provider emits terminal
  `turn/completed` status `interrupted` and no background terminal remains,
  **then** the pane becomes `idle`.

- **Given** a Codex turn is interrupted or completed, **when** a background
  terminal remains, **then** the pane remains `working` and protected; the
  turn's terminal status MUST NOT be treated as proof that the pane has no work.

- **Given** Codex is running in a mode where its `Stop` hook is omitted, **when**
  no provider terminal/no-work evidence is available, **then** the pane does not
  become idle from hook absence or terminal quietness.

- **Given** an OpenCode session reports `busy` or `retry`, **when** the parent
  session has ended its visible response but a child/background session remains
  active, **then** the pane remains `working` and protected.

- **Given** an OpenCode session reports an authoritative idle or terminal
  execution state and all provider-reported child/background sessions are idle,
  **then** the pane becomes `idle`; a per-run `session.idle` event alone MUST NOT
  override a still-active child/background session.

- **Given** a provider lifecycle signal is duplicated, delayed, or out of order,
  **when** it refers to an earlier turn or child identity, **then** it cannot
  demote a newer working turn or clear newer active work.

- **Given** a normal turn's expected completion hook is lost, **when** a bounded
  recovery check obtains sufficient provider-structured no-work evidence, **then**
  the pane becomes `idle` and records the recovery provenance for deterministic
  diagnostics.

- **Given** a recovery watchdog fires without provider-structured no-work
  evidence, **then** it may recheck, but the pane remains protected and does not
  become idle.

- **Given** a pane is waiting for permission or has a latched error while child
  work completes, **when** the completion is processed, **then** the higher-signal
  waiting or error state remains visible; when that state is legitimately cleared
  and no work remains, **then** the pane returns to `idle`.

- **Given** an agent PTY exits or the application restarts, **when** the pane is
  observed before a new live session is established, **then** no prior working,
  turn, recovery, or active-work state is carried over.

- **Given** any recovered pane is eligible for automatic suspension, **when** its
  provider later reports active or scheduled work, **then** suspension is
  cancelled or prevented before that work can be interrupted.

## Open Questions

None outstanding.

## Resolved Decisions

- The scope covers Claude, Codex, and OpenCode, but only through independently
  researched provider contracts. The shared contract is the safety invariant and
  status vocabulary, not a shared assumption about hooks or event names.
- Any provider-confirmed work that can still execute or wake without a new user
  prompt counts as non-idle. This includes pending scheduled wakeups: they remain
  protected because suspending the pane could interrupt or prevent promised work.
- Claude's authoritative task reconciliation covers every current
  `background_tasks` entry and every `session_crons` entry. A single
  `SubagentStop` is never sufficient to clear the parent.
- Interrupt recovery accepts provider-labeled lifecycle evidence and exact
  provider-generated interruption records only. A comparable project's text
  marker is research input, not an accepted generic keyword heuristic. The
  implementation plan must validate the Claude 2.1.226 marker/signal and retain
  the documented `idle_prompt` path as the conservative Claude fallback.
- Codex interruption is valid only when its own terminal turn state is available;
  that state does not imply background terminals are gone. Hook-only Codex modes
  remain protected when a terminal completion/no-work signal is missing.
- OpenCode `busy`, `retry`, active execution, and provider-reported child or
  background sessions are protected. `session.idle` is usable as a per-run
  completion signal only after all child/background work is reconciled, and the
  installed OpenCode protocol version determines the exact event names.
- A watchdog can bound rechecks and recovery attempts, but time alone never
  proves idle. When provider evidence is unavailable, conservative protection is
  the correct result even if the badge remains `working`.
- Recovery provenance is internal state/test evidence. Confirmed no-work outcomes
  retain the ordinary `idle` presentation; no new visible tooltip or badge
  category is introduced.
- This remains separate from `pane-active-while-subagent-runs`: that spec prevents
  false `idle` while background work is active; this spec prevents false `working`
  after provider-confirmed work has ended or been interrupted.
- Lifecycle hooks/events remain the primary status source and the reducer remains
  the single status merge point. The repository's scoped terminal-error exception
  does not authorize broad screen or scrollback scraping.
- Live status, turn identity, recovery provenance, and active-work tracking remain
  in memory only, matching `agent-status-badges`,
  `idle-default-for-new-agent-sessions`, and
  `pane-active-while-subagent-runs`.

## Out-of-Scope Notes

- A future iteration could expose separate `interrupted`, `scheduled`, or
  `background work` details if users need more than the existing dot vocabulary.
- A future iteration could add a diagnostics view for provider capability,
  evidence latency, hook/event delivery, and stale-event counts without changing
  the pane badge vocabulary.
- A future provider protocol adapter may be added when a provider exposes a new
  authoritative work snapshot; it must follow this spec's independent-evidence
  and fail-safe rules.
