# Implementation Plan: Harden Agent Status Recovery After Interrupts and Completed Turns

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/done/067-claude-status-recovery-hardening.md` (Status: done)

## Verified Repository Facts

- `src/shared/agentStatus.ts:eventToState` is the only lifecycle reducer. The renderer
  receives raw `pane:agent-event` messages in `src/renderer/src/store/panesIpc.ts` and writes
  the result through `setPaneAgentStatus`; main does not reduce status.
- `AgentStatusState` currently carries the visible state, turn identity, timestamps, and the
  Claude-only `activeBackgroundSubagents` / `activeBackgroundSubagentIds` fields added by the
  pending spec 065 implementation. Status is runtime-only and `layoutStore.ts` strips the
  entire `agentStatus` field before persistence.
- The localhost `AgentSessionReportServer` validates the current lifecycle allow-list and
  `handlers.ts` forwards accepted reports to the owning pane. The positional IPC shape is
  currently `(ptyId, event, detail, turnId, agentId?)`.
- Claude and Codex use the managed PowerShell/shell hook assets. Claude currently installs
  `Stop`, `StopFailure`, `SubagentStop`, and a `Notification` matcher for
  `permission_prompt`; Codex currently installs `Stop` but has no `StopFailure` or
  `Notification` hook in this repository.
- The OpenCode integration is a process-scoped JavaScript plugin injected by
  `SessionSpawner.agentEnv()`. Its generic `event` handler reports session lifecycle events,
  while tool interception is reported through `tool.execute.before/after`. It currently has no
  child/background work reconciliation.
- `SessionSpawner` launches all three providers as direct PTY commands. It does not launch or
  attach to Codex App Server, so the official `turn/completed` stream is not currently a live
  source for a pane. The plan must not claim that it is. The installed Codex App Server marks
  its `ws://` listener experimental/unsupported, while its documented `unix://` transport is
  intended for local control-plane clients and is usable by `codex --remote`.
- `processSnapshot.ts` is the single platform process-table seam and
  `agentProcessSweeper.ts` uses it only for shell-pane promotion/demotion. It is not a
  provider work-state oracle and must not be repurposed as a quiet-time idle timer.
- `isIdleAgentSuspensionEligible()` already requires exact session identity, a live PTY, and
  `agentStatus.status === 'idle'`; working/waiting/error/unknown states are protected. No
  timeout-policy change is needed if the reducer remains conservative.
- PTY exit already clears the agent status in `paneTree.ts`, and session replacement paths in
  `panes.ts` seed a fresh in-memory idle state. Tests already cover those reset and
  non-persistence seams.
- Existing docs explicitly prohibit a second status path and broad terminal/screen scraping;
  the scoped `terminal_error` observer is the only terminal-output exception.

Provider facts used by this plan are recorded in the source spec and its research links:

- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Codex App Server: <https://developers.openai.com/codex/app-server/> and
  <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- OpenCode plugins/status: <https://opencode.ai/docs/plugins/>,
  <https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts>,
  and <https://github.com/anomalyco/opencode/blob/dev/packages/app/src/context/server-session.ts>
- Compatibility evidence is listed in the source spec for Codex issue #22858 and OpenCode
  issues #35540 and #40808. Those references inform validation; they do not replace a runtime
  check against the installed provider versions.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, R3, R4; S3-S6 | T1, T2, T3 | Reducer snapshot tests; Claude hook fixtures; report validation |
| R2; S1-S2, S7-S12 | T2, T3, T4 | Provider-specific fixtures; live-version gate; synthetic reducer contracts |
| R5; S13 | T1, T5 | Turn/session/child ordering and duplicate tests |
| R6; S14-S15 | T1, T5 | Provenance assertions and bounded recovery/no-evidence tests |
| R7, R13; S2, S9, S15 | T1, T2, T3, T5 | No-scraping review; fail-safe reducer and transport tests |
| R8; S6, S16 | T1, T5 | Waiting/error precedence and cleanup tests |
| R9 | T2-T4 | Separate provider payload fixtures and source allow-lists |
| R10; S16 | T1, T5 | Session replacement, PTY exit, and restart/non-persistence tests |
| R11; S17-S18 | T5 | Suspension eligibility and active-work protection/cancellation race tests |
| R12 | T1, T5 | Existing status vocabulary/UI tests remain unchanged |
| R13; S15 | T2, T3, T5, T6 | Transport boundary and docs review; no second writer introduced |

The Codex acceptance path is provider-native rather than heuristic: app-launched Codex panes
will use a pane-local App Server sidecar and the normal Codex TUI in `--remote` mode, while
the sidecar observer supplies the terminal-turn and background-work evidence. A direct-CLI
fallback remains fail-safe when the sidecar cannot start, but that fallback does not claim
Escape recovery. CLI-launched Codex sessions outside `SessionSpawner` continue to use their
independent hook-only contract.

## Architecture and Data Flow

Current path:

```text
Claude/Codex hook or OpenCode plugin
  -> localhost AgentSessionReportServer /agent-event
  -> main handlers.ts forwarding
  -> pane:agent-event IPC
  -> panesIpc.ts
  -> eventToState(prev, input, now)
  -> PaneLeaf.agentStatus
  -> idle suspension eligibility
```

Target path keeps the same ownership and adds a bounded, validated evidence envelope. For
app-launched Codex, the TUI and observer share one pane-local App Server process; no global
observer subscribes to all threads:

```text
provider-specific lifecycle + work evidence
  -> provider adapter in hook/plugin/protocol fixture
  -> validated AgentEventReport { event, turnId, agentId?, evidence? }
  -> existing main forwarder and pane:agent-event IPC
  -> existing single eventToState reducer
  -> in-memory status/work/provenance
  -> existing suspension gate
```

```text
SessionSpawner (Codex)
  -> codex app-server --listen unix://<pane-socket>
  -> codex --remote unix://<pane-socket> in the existing PTY
  -> one read-only observer via `codex app-server proxy --sock <pane-socket>`
  -> turn/completed + thread/status + background-terminal/child queries
  -> the same AgentEventReport forwarder
```

`AgentWorkSnapshot` is the normalized contract. It carries only bounded, non-secret facts:
provider authority, `completeness` (`complete` or `incomplete`), terminal state (`completed`,
`interrupted`, `failed`, `idle`, `busy`, or `retry`), active-work count, scheduled-work count,
and optional bounded child/work IDs. The hard limits are 128 KiB per report body, 64 work
items, 256 characters per identity, and 256 tracked child identities per provider adapter.
The report server rejects malformed, oversized, or unknown evidence and never forwards raw
provider payloads. Claude maps all non-empty `background_tasks` entries and all
`session_crons` entries into the counts; it does not need a provider-type allow-list to decide
that any current task is protective work. `incomplete` evidence can keep a pane protected but
can never establish idle.

The reducer treats an authoritative empty snapshot as a reconciliation operation, not as a
generic idle timer. It clears stale in-memory work tracking only when the snapshot is for the
current turn/session and its terminal state proves completion, interruption, or idle. Active
or scheduled counts keep the pane working. Waiting and error remain higher-signal visible
states. An `idle_prompt` recovery hint is accepted only when its exact `notification_type` is
`idle_prompt`, its non-empty `session_id` matches the in-memory session, the renderer has
recorded a current-session Escape/interrupt request, the request's captured turn identity and
generation still match, and no active/scheduled work is tracked. Missing session or turn
identity, a newer prompt, active work, or an incomplete snapshot leaves the pane protected.
The recovery path is event-driven and bounded by one pending interrupt generation; there is no
watchdog timer that independently declares idle. The hint is never implemented as terminal
text scraping or a timer-only transition.

Recovery provenance is an internal field on `AgentStatusState`, cleared by a new prompt,
session replacement, demotion, or PTY exit. It distinguishes ordinary provider completion,
interrupt recovery, idle-prompt recovery, and stale-work reconciliation without adding a
visible badge category or persisting runtime state.

## Implementation Tasks

### T0 - Validate provider payloads and the Codex attribution boundary (completed)

- Dependencies: none.
- Requirements/scenarios: R2, R4, R7, R9; S1, S2, S7, S9, S10, S11, S12.
- Files and symbols:
  - `specs/pending/067-claude-status-recovery-hardening.plan.md` verification notes.
  - Existing provider assets under `src/main/integration/assets/` and
    `src/main/integration/managedHookController.ts:CLAUDE_EVENTS/CODEX_EVENTS`.
  - `src/main/sessions/SessionSpawner.ts:spawnNew`, `spawnResume`, and `agentEnv` for the
    current PTY launch boundary.
- Current behavior: the source spec records Claude Code `2.1.226`; the current local tools
  report Claude Code `2.1.235`, Codex CLI `0.148.0`, and OpenCode `1.18.14`. The repository
  does not yet expose Codex App Server to a pane.
- Implementation change: record the installed versions and verify the documented fields before
  relying on them. A no-turn smoke on Codex `0.148.0` verified
  `initialize`/`initialized` over `codex app-server proxy --sock` connected to a temporary
  `unix://` listener, `thread/list` returned metadata, `thread/resume` emitted the loaded
  thread's idle status, and `codex --remote unix://...` reached the normal TUI without starting
  a turn. The same smoke showed that the `ws://` listener is labeled experimental/unsupported,
  so the implementation must use the documented Unix-socket transport rather than a direct
  WebSocket client. The implementation must additionally exercise `turn/completed`,
  `thread/backgroundTerminals/list`, and descendant `thread/list` against fakes and a no-turn
  protocol fixture; `thread/status/changed` is a server notification, not a request method.
  Capture Claude `Stop`, `SubagentStop`, and `Notification` (`idle_prompt`) fields, and
  capture OpenCode generic event shapes for busy/retry/idle, execution terminal, and
  child-session events.
- Decision record: option A (pane-local Codex App Server sidecar, remote TUI, read-only
  observer) was selected by the auto-orchestrator blind decision subagent as the least-surprising
  provider-native and reversible design. The direct PTY fallback remains protected when the
  sidecar cannot start; no process/output heuristic is permitted.
- Invariants and edge cases: use temporary provider/config locations; do not mutate real user
  configuration; do not run a real subagent in automated tests; do not accept a field based
  only on a comparable repository or an undocumented text marker.
- Verification: record exact fields/casing and version strings in the plan's verification
  section. A missing Claude interruption marker does not block the documented `idle_prompt`
  path because the renderer supplies the missing turn association through the Escape request.
  An unsupported Codex App Server method produces incomplete evidence and keeps the pane
  protected; it does not silently fall back to idle.
- Completion evidence: local version/help and Unix transport smoke evidence is recorded below
  in Verification Evidence; provider payload capture and the deterministic sidecar protocol
  fixture are covered by the implementation fixtures in T2-T4.

### T1 - Add the normalized evidence contract and reducer reconciliation (completed)

- Dependencies: T0's field names are needed for provider adapters; the offline contract can
  be implemented with the documented shapes while T0 remains unverified.
- Requirements/scenarios: R1, R3-R8, R10-R12; S3-S6, S13-S17.
- Files and symbols:
  - `src/shared/types.ts:AgentLifecycleEvent`, `AgentWorkSnapshot`, `AgentStatusInput`,
    `AgentStatusState`, and the `pane:agent-event` IPC signature.
  - New pure `src/shared/agentStatusEvidence.ts` for bounded snapshot normalization and
    provider-independent validation helpers.
  - `src/shared/agentStatus.ts:eventToState`, `clearBackgroundTracking`, and its work-state
    helpers.
  - `src/shared/agentStatus.test.ts` and new
    `src/shared/agentStatusEvidence.test.ts`.
- Current behavior: bare `stop` becomes idle; only Claude background-subagent fields are
  tracked; late/missing completion can leave that tracking working indefinitely; no recovery
  provenance or provider snapshot exists.
- Implementation change:
  - Define the exact normalized shape as
    `AgentWorkSnapshot = { provider: AgentKind; completeness: 'complete'|'incomplete';
    terminalState: 'completed'|'interrupted'|'failed'|'idle'|'busy'|'retry'; activeCount:
    number; scheduledCount: number; activeIds?: string[]; scheduledIds?: string[]; sessionId?:
    string; turnId?: string }` and `AgentEventMeta = { sessionId?: string; evidence?:
    AgentWorkSnapshot }`. Add internal `sessionId`, recovery-provenance, and
    one-pending-interrupt metadata to `AgentStatusState`; these fields remain runtime-only.
    Keep the existing Claude background identity fields as compatibility data for spec 065,
    while authoritative snapshots reconcile both those fields and the new aggregate counts.
  - Add evidence-aware lifecycle inputs/events for `work_snapshot`, `turn_interrupted`, and
    Claude-only `idle_prompt`, plus the renderer-only `interrupt_requested` reducer event;
    retain existing lifecycle names for compatibility.
  - Require provider-specific no-work evidence for a new completion/recovery transition to
    idle. A bare Codex hook `stop` with no no-work evidence remains protected; this is the
    deliberate fail-safe for direct-CLI fallback modes.
  - Make snapshots idempotent, turn-aware, and generation-safe. Empty authoritative snapshots
    clear stale work only for the current session/turn; active or scheduled counts always keep
    protection. A child completion can release only its own known identity and cannot clear a
    different turn or remaining work.
  - Make `interrupt_requested` capture the current non-empty session ID, current turn ID, and
    incremented generation without changing the visible status. The renderer creates this
    input locally from the Escape path; provider hooks never manufacture the generation.
    `idle_prompt` may transition only when its exact provider session ID matches the state and
    pending marker, the pending marker’s captured turn ID still matches the current turn, the
    generation has not been cleared, and no work is active/scheduled. Missing IDs or a newer
    `user_prompt_submit` are no-ops.
  - Add a top-level input-envelope guard before the event switch: if outer `sessionId` and
    `evidence.sessionId` are both present they must match, and if outer `turnId` and
    `evidence.turnId` are both present they must match. Any mismatch returns the previous state
    unchanged for every event, including prompt and tool events; it is never downgraded to a
    bare lifecycle event. Then add the lifecycle identity guard: for `stop`,
    `stop`, interruption, `work_snapshot`, and background-completion, the current session/turn
    identity must be present and the incoming session/turn identity must be present and equal;
    missing identity is a no-op, even when the provider historically omitted a field. Protective
    `permission_request` and `stop_failure` signals require a matching session when supplied but
    may inherit the current turn when the provider omits it; they cannot establish idle. `idle_prompt`
    is the one exact exception for the missing provider turn
    field: it requires a non-empty matching provider session ID plus the renderer’s pending
    Escape marker with the captured current turn/generation; it may not use a missing marker or
    infer a turn from the event. A complete snapshot with no identity cannot clear a newer turn.
    `user_prompt_submit` and a genuinely new `session_start` are the only provider events
    allowed to replace the session/turn identity; tool events may establish a missed newer turn
    but may never demote from an older terminal event. These guards apply equally to Claude,
    Codex, and OpenCode without sharing their provider evidence rules.
  - Preserve waiting/error precedence, terminal-error latching, the existing visible status
    vocabulary, and the existing demote/PTY-exit cleanup semantics. Clear recovery metadata on
    new prompt/session, demotion, and replacement paths.
- Invariants and edge cases: duplicate snapshots do not double-count; missing IDs never grant
  permission to clear a child; unknown or malformed snapshots leave the prior state alone;
  `incomplete` evidence can preserve work but cannot clear it; scheduled work is protective
  even when active count is zero; no timestamp/quietness/process age is used as evidence; no
  state is serialized. A same-session `session_start` cannot demote a live turn, while a
  different verified session start clears the old identity and seeds the new session safely.
- Verification: table-driven reducer tests for normal completion, interrupted completion,
  empty reconciliation, active/scheduled protection, stale/out-of-order turn IDs, duplicate
  events, stale and identity-missing `stop`/`stop_failure`/permission/snapshot events,
  conflicting outer-vs-evidence identities, waiting/error precedence, exact idle-prompt gating
  with missing/stale session and turn identity, Escape interrupt generation, and recovery
  provenance. Keep existing
  spec 032/050/065 cases green after updating their stop fixtures with explicit evidence.
- Completion evidence: focused shared tests pass and the new evidence type has no renderer or
  main-process dependency.

### T2 - Harden report transport and Claude hook evidence (completed)

- Dependencies: T1's shared types and reducer contract.
- Requirements/scenarios: R1-R9 and R13; S1-S6, S9, S13-S15.
- Files and symbols:
  - `src/main/integration/agentSessionReportServer.ts:AgentEventReport`, validation constants,
    `readBody`, and `handleEvent`.
  - New `src/main/integration/agentEventForwarder.ts:forwardAgentEvent` used by
    `src/main/ipc/handlers.ts` report-server `onEvent` callback.
  - `src/main/ipc/handlers.ts` report-server forwarding and session-binding callback.
  - `src/main/ipc/agentEventForwarder.test.ts` for the main-boundary evidence-preservation
    assertion.
  - `src/renderer/src/store/panesIpc.ts` `pane:agent-event` listener.
  - `src/shared/types.ts` IPC callback signature.
  - `src/main/integration/managedHooks.ts:injectManagedHook`, `pruneManagedHooks`, and
    `removeManagedHook`.
  - `src/main/integration/managedHookController.ts:CLAUDE_EVENTS`.
  - `src/main/integration/assets/multiagent-agent-state.ps1` and
    `src/main/integration/assets/multiagent-agent-state.sh`.
  - `src/main/integration/agentSessionReportServer.test.ts`,
    `src/main/integration/agentStateHook.test.ts`, and
    `src/main/integration/managedHookController.test.ts`.
- Current behavior: report validation knows only lifecycle fields; the hook scripts emit no
  task/schedule snapshot; Claude `Notification` is installed only for permission prompts;
  main and renderer forward only the existing five positional values; and
  `injectManagedHook()` updates the first managed matcher group under an event key, which
  would overwrite a second Claude Notification matcher.
- Implementation change:
  - Extend the existing `/agent-event` envelope with a validated optional evidence object and
    provider `sessionId`. Define the exact sixth IPC argument as
    `AgentEventMeta = { sessionId?: string; evidence?: AgentWorkSnapshot }`; the renderer
    validates this object and passes its fields into `AgentStatusInput`. The renderer-only
    `recoveryGeneration` is created by `requestAgentInterrupt` and is never accepted from a
    provider hook. Forward the typed meta object through a dedicated main forwarder; do not
    create another IPC channel or reducer. The load-bearing test must assert the exact object
    survives `/agent-event` JSON -> report-server callback -> `handlers.ts` forwarder -> sixth
    IPC argument -> `panesIpc.ts` reducer input.
  - Reconcile identities before forwarding: the outer `turnId` must equal
    `evidence.turnId` when both are present; `AgentEventMeta.sessionId` must equal
    `evidence.sessionId` when both are present; and each must be non-empty when supplied.
    A mismatch rejects the HTTP report and makes the renderer reducer a no-op for the entire
    event rather than selecting one value or downgrading it to a bare lifecycle event.
    `idle_prompt` intentionally has no
    provider turn field and therefore carries only its required session ID; the reducer’s
    pending Escape marker supplies the turn association. Every other demoting event requires
    both outer session/turn identity and any evidence identity. The reducer repeats this guard
    so a malformed internal input cannot demote a pane.
  - Enforce 128 KiB body, 64 items, 256-character IDs, 256 tracked identities, and bounded
    count limits. Reject unknown provider/event combinations, including non-Claude
    `idle_prompt`, and reject incomplete evidence when it is presented as authoritative empty.
  - Make `injectManagedHook()` matcher-aware: update only a managed group with the same
    desired matcher semantics, append a distinct group for a second matcher, deduplicate
    duplicate managed entries for the same matcher, and preserve unrelated handlers. For a
    mixed group containing foreign hooks, never rewrite the group matcher: update our entry
    only when its existing matcher already equals the desired matcher; otherwise remove only
    our stale duplicate and append a solo managed group with the desired matcher. A same-
    matcher duplicate in another mixed or solo group is removed while all foreign entries and
    their matcher are retained. Ensure prune/uninstall remove all managed groups without
    deleting foreign groups.
  - Add an exact desired-set reconciliation helper in `managedHooks.ts` used by
    `ManagedHookController.install()`: its desired keys are `(eventName, matcher semantics)`
    pairs, not event names alone. For an allowed event, remove every sentinel entry whose
    matcher is no longer in that event’s desired set, including stale entries in mixed groups;
    preserve the group and its matcher if foreign hooks remain. Then update one matching
    sentinel entry per desired pair and append a solo group for each missing pair. The existing
    event-key prune remains the lower-level orphan sweep, while controller install/uninstall use
    the matcher-aware desired-set sweep so obsolete Notification matchers cannot linger.
  - Add the Claude `idle_prompt` matcher as a separate managed Notification entry while
    preserving `permission_prompt`; controller and pure surgery tests must prove both are
    installed, idempotent, reconciled, and uninstallable.
  - On Claude Stop/SubagentStop payloads, emit normalized evidence for every non-empty
    `background_tasks` array and every non-empty `session_crons` array. PowerShell may count
    structured arrays directly; the Unix asset must distinguish a valid empty array, a valid
    non-empty array, and malformed/nested/unknown input, reporting `incomplete` rather than
    falsely empty. Do not forward raw payloads or free-text descriptions.
  - For Notification, require `notification_type === 'idle_prompt'` and a non-empty
    `session_id`; forward the provider session identity but never use `message`/`title` as
    status evidence. The renderer-side interrupt marker supplies the missing turn identity and
    generation through the reducer-local pending marker.
- Invariants and edge cases: hook failures remain non-blocking; malformed payload fields lose
  evidence rather than blocking the provider; a failed localhost post never changes status;
  legacy hooks without evidence remain accepted but cannot establish new idle recovery; two
  matcher groups under one event key remain valid JSON, obsolete managed matchers are removed,
  and foreign hooks/groups are preserved.
- Verification: real localhost report tests cover valid/invalid evidence, body limits,
  Claude-only restrictions, incomplete evidence, identity mismatches, and no raw-payload forwarding. Pure managed
  hook tests cover same/different matcher groups, mixed foreign groups, duplicates, stale
  allowed-key matchers, and matcher-preserving split/rehome behavior; controller tests cover the two Claude Notification
  entries. Hook fixtures cover valid empty/non-empty/malformed task
  and cron arrays, idle-prompt matching/missing identity, ordinary tools, background
  identities, and PowerShell/Unix parity where the host can execute both assets. The forwarder
  test proves evidence survives report callback -> main forwarding -> sixth IPC argument.
- Completion evidence: focused main/renderer/shared tests pass; no broad terminal-output
  parser or second status write path appears in the diff.

### T3 - Reconcile OpenCode session and child/background work independently (completed)

- Dependencies: T0's installed OpenCode event shapes; T1's evidence contract; T2's transport.
- Requirements/scenarios: R1-R5, R8-R9, R12-R13; S10-S13.
- Files and symbols:
  - `src/main/integration/assets/multiagent-opencode-plugin.js:MultiAgentPlugin`,
    `reportSession`, and `reportEvent`.
  - `src/main/integration/opencodePluginInstall.ts` only if the asset contract or cache
    invalidation needs an existing installer update; do not change config ownership.
  - New `src/main/integration/opencodePlugin.test.ts` fixture harness for the copied plugin,
    plus `src/main/integration/agentSessionReportServer.test.ts` for the transport boundary.
- Current behavior: the plugin maps `session.status` busy to working and `session.idle` to
  stop, but treats idle as sufficient, ignores retry, does not track child sessions, and
  assumes the older event surface documented in its header. The installed runtime is
  OpenCode `1.18.14`; the independently checked current SDK schema has exact
  `session.created`, `session.updated`, and `session.status` events, with
  `properties.info.id`/`parentID` on created/updated and
  `properties.sessionID` plus `properties.status.type` of `idle|busy|retry` on status.
  The checked schema does not expose authoritative `session.execution.*` events or a
  child-work coverage field; those names are not accepted by this adapter.
- Implementation change:
  - Keep all lifecycle handling in the generic `event` hook and support only the exact current
    `session.created`, `session.updated`, `session.status`, `session.error`, and
    `permission.updated` event names by discriminating `event.type`; do not register a
    wildcard or guessed execution lifecycle handler. Retain no idle shortcut from the
    deprecated `session.idle` event.
  - Track provider-reported `session.created/updated` `properties.info.id` and optional
    `properties.info.parentID` in a bounded map of 256 sessions. `session.status` resolves
    `properties.sessionID` through that map; a child status received before its creation record
    adds an unresolved identity and marks the snapshot incomplete/protective. Busy and retry
    report active work. Idle reports no active work for that identity but remains incomplete;
    `session.error` remains an error signal. Unknown execution-looking events are ignored.
  - Define an OpenCode snapshot as `complete` only after the root session is known, an exact
    provider child-coverage authority has been observed, every observed descendant has a known
    terminal/active state, and no child event is unresolved. The current independently checked
    `1.18.14` event surface has no child-list/count/coverage property on
    `session.created/updated` or `session.status`; therefore the current plugin must always
    emit `completeness: incomplete` for root-only idle/terminal events. It may emit a complete
    empty root snapshot only if a future installed event shape supplies a verified
    `children`/coverage payload and the adapter validates that exact shape; no inferred “all
    observed children” condition is sufficient. A child idle event updates the map but never
    emits the root `stop` by itself. `incomplete` is a concrete normalized state consumed by
    T1 and can never establish idle.
  - Preserve OpenCode's passive plugin behavior: never add a permission-decision hook, never
    mutate user/project configuration, and never treat a single per-run `session.idle` as
    finalization when child work remains.
- Invariants and edge cases: duplicate child events are idempotent; a child completion cannot
  clear a different session; plugin post failures never throw into OpenCode; version drift
  fails safe; no arbitrary terminal or assistant-text parsing is added.
- Verification: execute the asset in a mocked plugin/fetch harness with synthetic current and
  unsupported event shapes and assert exact `/agent-session`/`/agent-event` payloads plus
  incompleteness for busy, retry, idle, child creation/update, permission, errors,
  child-before-parent, missing child-coverage, and unsupported execution-looking events. Add
  regressions for a root idle event while a child remains active, a child idle event that must
  not stop the root, and root-only idle on installed `1.18.14` that must remain incomplete.
  Keep the installed-version smoke check separate from the deterministic fixture.
- Completion evidence: plugin fixture tests pass for the installed protocol shape recorded in
  T0, with unsupported shapes explicitly remaining protected.

### T4 - Launch and observe Codex through a pane-local App Server sidecar (completed)

- Dependencies: T0's Codex protocol smoke; T1's evidence contract; T2's transport.
- Requirements/scenarios: R1-R4, R7-R9, R10-R12; S7-S9, S13-S17.
- Files and symbols:
  - New `src/main/integration/codexAppServer.ts:CodexAppServerManager`, Unix-socket proxy
    frame transport, and injected process/RPC seams.
  - New `src/main/integration/codexAppServer.test.ts` for protocol normalization, sidecar
    lifecycle, attribution binding, query failure, fallback, and cleanup without a real Codex
    process.
  - `src/main/pty/PtyManager.ts:createDeferred` and its tests, adding an optional caller-owned
    PTY id with collision validation so the sidecar environment and the PTY environment share
    the same identity.
  - `src/main/sessions/SessionSpawner.ts:SessionSpawner`, `spawnNew`, `spawnResume`,
    `agentLaunchCommand`, `newSessionCommand`, `resumeSessionCommand`, and Codex argument
    helpers.
  - `src/main/sessions/SessionSpawner.test.ts` for remote launch/fallback command contracts.
  - `src/main/ipc/handlers.ts` startup wiring, report-server session binding, PTY-exit cleanup,
    PTY-error cleanup, async `pty:kill` ownership release, and application shutdown disposal.
  - `src/main/ipc/ptyControl.ts` `PtyKillDeps`/`killPtyIfAllowed` async release contract and
    `src/main/ipc/ptyControl.test.ts` ordering/error-propagation coverage.
  - `src/main/integration/agentSessionReportServer.ts` only for the existing callback boundary;
    no second renderer status writer.
- Current behavior: Codex hook `Stop` is forwarded as a bare stop and currently becomes idle;
  official App Server terminal-turn, child-thread, and background-terminal facts are not
  connected to the direct PTY. `PtyManager.createDeferred()` generates its own id internally,
  `SessionSpawner.dispose()` is a no-op, and shutdown currently calls it without awaiting any
  provider sidecar cleanup.
- Implementation change:
  - Give app-launched Codex a caller-owned allocated PTY id before creating the deferred PTY.
    Extend `PtyManager.createDeferred(..., purpose, requestedId?)` to accept that id only when
    it is absent from every reserved/pending/spawned set; otherwise throw before registering it.
    Build one sanitized provider environment from `agentEnv(agentKind, ...)` plus a shared
    handler-owned `getPaneEnv(ptyId)` callback passed into both `PtyManager` and
    `SessionSpawner`; use the same result for the sidecar and `createDeferred`. This preserves
    `MULTIAGENT_PTY_ID`/hook-port attribution without filesystem matching or a new config
    mutation. `createDeferred` validates collisions before adding the requested id, and wraps
    `getPaneEnv`/`buildEnv`/pending-entry registration in a rollback so every failure calls
    `_forgetId` and leaves no reserved/pending entry. If preparation or deferred creation fails,
    dispose the prepared sidecar and let `PtyManager` roll back the requested id. The new/resume
    command helpers accept an optional
    remote Unix address and place `--remote unix://<pane-socket>` in the Codex command while
    preserving the existing TUI flags. Claude/OpenCode command construction is unchanged.
  - Implement the explicit lifecycle `id-allocated -> sidecar-ready -> pty-created ->
    observer-bound -> disposed`. `CodexAppServerManager.prepare()` creates a unique socket
    path, starts `codex app-server --listen unix://<pane-socket>`, starts the proxy observer,
    completes the WebSocket handshake and `initialize`/`initialized`, then returns the remote
    address plus a disposable prepared handle. Only after that succeeds does SessionSpawner
    call `createDeferred(..., ptyId)` with the caller-owned id. A preparation failure disposes the sidecar
    and uses the existing direct Codex command; it never emits idle evidence.
    `SessionSpawner` receives the same `getPaneEnv` callback through its constructor; no
    handler-owned closure is reached through a hidden global.
  - Open one non-mutating, lifecycle-bound observer per pane through
    `codex app-server proxy --sock <pane-socket>` and the documented raw WebSocket
    handshake/frame stream over stdio. When the Codex `SessionStart` hook reports the same
    `ptyId`, handlers calls `bindThread(ptyId, sessionId)`; the observer then uses
    `thread/resume` without starting a turn, receives `turn/started`, `turn/completed`,
    `thread/status/changed`, and child notifications, and emits only normalized status reports.
    `thread/resume` is non-mutating for this adapter but does load/subscribe the thread, so the
    observer must send `thread/unsubscribe` before teardown. It never calls `turn/start`,
    `turn/interrupt`, approvals, archive, delete, or any other mutating RPC.
  - Wire the ownership boundaries explicitly: the report-server `onReport` callback first
    sends the existing `session:detected` notification and then calls
    `spawner.bindAgentSession(ptyId, agentKind, sessionId)` for Codex; the `PtyManager` exit
    listener calls `spawner.disposePty(ptyId)`; host-failure release calls the same cleanup;
    and the `pty:kill` release/kill path disposes before killing. `SessionSpawner.dispose()`
    becomes awaitable and cleanup awaits it before `ptyManager.destroy()`, with one idempotent
    cleanup promise per pane. `releaseHostPtys` becomes an async fan-out (the recovery event
    schedules and awaits its cleanup before routes are forgotten), and the deferred PTY error
    listener covers a sidecar prepared before the renderer ever sends its first resize.
  - Report observer transitions as `turn_interrupted`, `work_snapshot`, or provider failure
    through the existing `AgentEventReport` callback. Hook events remain independent and are
    merged by turn/session guards in T1.
  - On `turn/completed`, query `thread/backgroundTerminals/list` and descendant `thread/list`
    with the experimental capability. Follow every returned cursor until the provider reports
    exhaustion, with a 16-page/256-identity cap; a missing/unknown cursor field, cap hit before
    exhaustion, malformed page, or truncated response emits `completeness: incomplete`. Apply
    the same bounded cursor handling if the installed background-terminal response exposes
    pagination; otherwise require its validated complete `data` shape and treat any `hasMore` or
    cursor indicator as incomplete until fetched. Normalize terminal status
    (`completed|interrupted|failed`) and all active background-terminal/child identities into
    a complete snapshot. A query error, unsupported method, unresolved child, or reconnect gap
    emits `completeness: incomplete`, which keeps the pane protected. Re-query after every
    `turn/completed`, interrupted completion, status-change notification, and observer reconnect
    so a background terminal that outlives a turn cannot be cleared by a stale empty result.
  - Dispose the observer, unsubscribe the bound thread, terminate the proxy, kill the sidecar,
    and unlink the socket on PTY exit, explicit `pty:kill`, failed spawn, terminal-host failure,
    deferred-PTY error, session replacement, and app shutdown. Change
    `killPtyIfAllowed`/`PtyKillDeps.release` to return `Promise<void>` and await
    `disposePty(ptyId)` before `ptyManager.kill(ptyId)`; preserve the existing ownership and
    unroute checks. `PtyManager` `exit` and `error` listeners both call the same idempotent
    cleanup. Cleanup has a bounded process-wait fallback, always unlinks the exact socket path,
    and post-disposal frames cannot report into a reused PTY id. There is no global observer and
    no permanent subscription to unrelated threads.
  - If sidecar preparation fails before the PTY exists, fall back to the existing direct Codex
    command and retain the hook-only fail-safe. If the proxy or sidecar fails after the remote
    PTY is running, do not kill and recreate the user’s pane merely to switch transports; mark
    attribution/evidence incomplete, attempt one bounded reconnect for that pane, and otherwise
    leave the live pane protected. Never infer idle from either fallback or observer loss.
- Invariants and edge cases: Codex behavior does not inherit Claude `idle_prompt`, task-array,
  `SubagentStop`, or `StopFailure` rules; background terminals outlive turn interruption;
  observer RPCs are read-only; unknown protocol fields remain protective; sidecar credentials
  and provider config remain process-scoped and are never written to user config.
- Verification: fake proxy/frame RPC streams cover initialize, thread binding, completed and
  interrupted turns with zero/one background terminal, active/idle child threads, duplicate
  and out-of-order notifications, multi-page/cursor exhaustion, cursor truncation, cap hits,
  query failure, disconnect/reconnect, PTY exit/error, explicit kill ordering, shutdown, and
  startup fallback. SessionSpawner/PtyManager tests assert requested-id collision and
  `getPaneEnv`/`buildEnv` failure roll back every reservation; `ptyControl` tests assert the TUI
  remains the visible terminal command, cleanup is awaited before kill/destroy, sockets are
  unlinked, and sidecar
  failure does not create a false idle transition. T0's real loopback smoke remains separate
  from automated tests and does not start a model turn.
- Completion evidence: current Codex 0.148.0 sidecar/TUI protocol smoke plus focused manager,
  spawner, reducer, and transport tests. Direct CLI panes outside SessionSpawner remain an
  explicit protected limitation.

### T5 - Wire reset, suspension, persistence, and regression coverage (completed)

- Dependencies: T1-T4.
- Requirements/scenarios: R5-R12; S13-S18. (The source’s final active-work-after-recovery
  acceptance block is tracked as S18 here so the suspension race has its own load-bearing test.)
- Files and symbols:
  - `src/renderer/src/components/Terminal/index.tsx` `attachCustomKeyEventHandler` Escape branch.
  - `src/renderer/src/store/panesIpc.ts` listener validation and reducer call.
  - `src/renderer/src/store/panes.ts:seedInitialAgentStatus`, `runNewAgentSession`,
    `resumeIntoPane`, `hydrateTabRuntime`, `resumeSession`, `resumeSessionInNewTab`,
    `resumeAgentPane`, `resetAgentStatusForSessionStart`, `requestAgentInterrupt`,
    `setSessionId`, `setPaneAgentStatus`, and `markPtyExited`.
  - `src/shared/paneTree.ts:markLeafExitedByPtyId`.
  - `src/renderer/src/store/idleAgentSuspension.ts:isIdleAgentSuspensionEligible`.
  - `src/main/ipc/layoutStore.ts` normalization boundary.
  - `src/renderer/src/store/panes.test.ts`, `src/renderer/src/store/idleAgentSuspension.test.ts`,
    `src/shared/paneTree.test.ts`, and `src/main/ipc/layoutStore.test.ts`.
- Current behavior: the suspension coordinator relies on the reducer's visible idle state;
  reset/exit/non-persistence seams already exist but know nothing about new work/provenance
  fields.
  - Implementation change: make the existing `session:detected` listener pass the reported
  session identity through the same `eventToState({ event: 'session_start', sessionId })`
  path after it promotes a raced shell pane; `setSessionId` updates the leaf identity and the
  in-memory status identity together. Introduce one shared session-binding helper used by
  `seedInitialAgentStatus`, `runNewAgentSession`, `resumeIntoPane`, `hydrateTabRuntime`,
  `resumeSession`, `resumeSessionInNewTab`, and `resumeAgentPane`; every known
  `PaneLeaf.sessionId` therefore seeds `AgentStatusState.sessionId` before the first Escape can
  be pressed, including when hydration finds an already-seeded status object missing only this
  runtime identity. A same-session detection preserves live work, while a different session clears
  the old pending marker/work before seeding the new session. Use the same reducer/session-
  binding helper rather than mutating only `PaneLeaf.sessionId`. Add the
  renderer-only `requestAgentInterrupt(paneId)` store action and
  call it from the Terminal Escape branch only when Escape is not consumed by an overlay or a
  terminal binding and the pane is an agent. The action invokes `eventToState` with
  `interrupt_requested`; it never writes a second status field and does not prevent the Escape
  byte from reaching the PTY. It arms a pending marker only when the current status has a
  non-empty `sessionId` and `turnId`, capturing both plus a monotonically increasing in-memory
  generation. A later Claude `idle_prompt` report supplies the same session identity through
  the typed IPC metadata; `eventToState` accepts it only while that exact pending marker still
  matches the current turn. Missing session/turn identity, a newer prompt, or a reset makes the
  marker inert. Also accept and validate the evidence argument in the existing IPC listener;
  ensure fresh-session and PTY-exit paths clear all work/provenance/pending-marker fields; assert
  that active or scheduled counts keep suspension ineligible and that a confirmed empty
  snapshot permits the existing policy. Do not change the suspension timeout, resume flow, or
  layout schema.
  - Harden `suspendAgentPane` as a two-phase renderer action: write an in-memory suspension
    token/marker, queue the IPC kill until the next microtask, then re-read the pane and require
    the same token, exact PTY id, and `isIdleAgentSuspensionEligible(pane)` before invoking
    `pty:kill`. Any active/scheduled evidence event that arrives during the pending phase
    clears the token/marker and skips the kill. Once the IPC kill has been invoked, later events
    cannot retract it; the test boundary is explicitly “active work arrives before kill commit.”
    This preserves the existing suspension timeout and resume policy while covering the
    active-work-after-recovery race rather than pretending a reducer update can cancel an
    already-issued OS kill.
- Invariants and edge cases: evidence arriving after PTY exit cannot find/reanimate a pane;
  detached-window routing remains through the existing pty owner; runtime fields remain absent
  from layout JSON; a recovered idle pane must become protected again when active work evidence
  arrives before suspension acts.
- Verification: extend the Terminal/store/reducer seam tests for Escape that is forwarded versus
  overlay-consumed, exact session/turn/generation capture, stale `idle_prompt` rejection, the
  sixth IPC argument and complete metadata envelope, active/scheduled work, recovery cleanup,
  PTY exit, fresh session, layout stripping, and prevent/cancel suspension behavior, including
  active evidence between the suspension marker and kill commit (S18). Run
  `npm run typecheck` and the focused Vitest projects.
- Completion evidence: tests demonstrate no status state survives replacement, restart,
  serialization, or PTY exit, and no suspension-policy source change was needed.

### T6 - Document the evidence contract and operational limits (completed)

- Dependencies: T1-T5.
- Requirements/scenarios: R7, R9, R12-R13; all scenarios as implementation handoff context.
- Files and symbols:
  - `docs/session-linking-hooks.md` live-status section and event/transport tables.
  - `docs/pty-and-terminals.md` terminal-error exception and status-recovery boundary.
  - `AGENTS.md` Terminals & PTY guardrail, only if a one-line durable rule is needed; link to
    the existing mechanism document rather than adding mechanism prose.
  - `docs/testing.md` only for the provider-version/manual-fixture verification convention.
- Current behavior: docs describe hook-only status, Claude background-subagent tracking, and
  the scoped terminal-error scraper, but not normalized work snapshots, recovery provenance,
  OpenCode child reconciliation, or Codex App Server limitations.
- Implementation change: document that provider-specific authoritative empty evidence is the
  only new idle-recovery source; active/scheduled work protects; missing evidence stays
  protected; OpenCode event names are version-gated and the installed `1.18.14` plugin surface
  lacks authoritative child coverage, so root-only idle remains protected; app-launched Codex
  uses the pane-local Unix-socket App Server observer while direct-CLI fallback remains
  hook-only and protected.
  Keep the no-scraping/no-second-writer guardrails prominent.
- Invariants and edge cases: documentation must not imply that a timer, quiet terminal, or
  comparable repository is evidence; no user config mutation or new visible status category.
- Verification: cross-check every documented event and field against the final types, hook
  fixtures, and manual provider records. Do not update the spec status or move it to `done`
  from this task.
- Completion evidence: docs index and bidirectional AGENTS/docs pointers remain valid.

## Cross-Cutting Constraints

- Keep `eventToState` as the single status merge point. Main forwards; it does not reduce.
- Do not add broad terminal-output parsing, scrollback scanning, ANSI heuristics, arbitrary
  assistant-text classification, fixed-time idle transitions, or process-age rules. The
  existing `terminal_error` observer remains the only terminal-output exception.
- Treat any active or scheduled provider-confirmed work as non-idle. When evidence is unknown,
  malformed, missing, stale, or not attributable to the current session, retain protection.
- Keep provider logic independent. Do not reuse Claude task-array or idle-prompt semantics for
  Codex/OpenCode, and do not reuse OpenCode plugin semantics for the CLI-hook providers.
- Keep recovery metadata and work tracking in memory only. Do not change layout/settings
  persistence or provider/project configuration ownership.
- Preserve existing IPC ownership, multi-window PTY routing, managed-hook sentinel/reconcile
  behavior, and non-blocking hook/plugin failure handling.
- Codex App Server observation is one Unix-socket sidecar/proxy per app-launched pane, bound by
  the exact PTY id supplied to both environments; never create a global thread observer. Sidecar
  startup fallback is allowed only before the PTY exists, and observer loss after launch remains
  incomplete/protected without killing and recreating the user’s live pane.
- Automated tests use canned payloads, mocked localhost/plugin boundaries, pure reducers, and
  synthetic process/protocol records only. They must not launch a real provider, subagent,
  background terminal, or mutate a user's real provider configuration.
- Any change to requirements, provider scope, evidence authority, reducer precedence, or the
  Codex launch architecture reopens `Plan Status: review` and requires a plan/spec decision.

## Risks, Migration, and Rollback

- Claude `idle_prompt` may be delayed or semantically broader than an interruption. Bound it to
  the Claude event, current turn, no known active work, and one accepted recovery generation;
  if the T0 payload check shows it is not safe, keep the pane protected and return the marker
  choice to planning rather than adding a heuristic.
- Claude payload fields may vary between versions. Presence/empty-array parsing must fail safe,
  and unknown task types must count as protective work rather than be dropped.
- Codex App Server is not currently wired to the PTY. The reversible migration is a pane-local
  Unix-socket sidecar with a direct-CLI fallback only when preparation fails before PTY creation;
  post-launch observer loss keeps the live pane protected and does not recreate it. Awaited,
  idempotent unsubscribe/proxy/sidecar/socket cleanup is required on every ownership exit. Do
  not silently use the unsupported WebSocket listener or infer background-terminal absence.
- OpenCode event names and meanings can drift. Generic-event compatibility handling must be
  tested against the installed version; unsupported/incomplete protocol observations remain
  non-idle.
- Requiring evidence for `stop` may increase false-working states for legacy or disabled-hook
  configurations. This is an intentional safety tradeoff in the source spec; instrumenting a
  new visible state or silently idling is out of scope. Existing compatibility tests must make
  the changed contract explicit.
- Rollback is file-level and reversible: remove the new evidence fields/events and provider
  adapter branches, restore the prior managed-event set, and leave existing terminal-error
  scraping and suspension policy unchanged. Do not roll back by deleting user provider config.

## Handoff Checklist

- [x] Source spec is `Status: done`; this adjacent plan records the approved implementation,
      independent verification, and deliberate runtime limits.
- [x] T0 records Claude/Codex/OpenCode versions and exact accepted payload fields.
- [x] Codex live App Server attribution uses the verified pane-local Unix-socket sidecar and
      proxy observer, with direct-CLI fallback explicitly protected; no unsupported WebSocket
      bridge or guessed CLI attribution is approved by implication.
- [x] Every new evidence field has bounded validation, a pure reducer test, and a provider
      fixture; unknown evidence fails safe.
- [x] Claude covers every `background_tasks` entry and every `session_crons` entry; OpenCode
      covers active parent/child work; Codex keeps turn and background-terminal semantics
      separate.
- [x] Waiting/error precedence, turn ordering, duplicate/missing events, PTY exit, session
      replacement, suspension, and non-persistence are tested.
- [x] No broad scraper, second status writer, provider-config mutation, visible status category,
      timeout-policy change, or direct PTY launch change slipped into scope.
- [x] `npm run typecheck`, focused tests, and the applicable manual provider checks are recorded
      as evidence; unrun checks remain `UNVERIFIED`.

## Plan Review

The historical review notes below describe prior revisions; the fresh verdict in this section
supersedes their earlier non-approval status.

Prior verdict: CHANGES REQUESTED.

The first blind reviewer’s findings were addressed in the prior revision: T4 defines the
pane-local Codex launch/observation boundary, T2 covers matcher-aware managed-hook surgery and
the main forwarding assertion, T1/T2 define bounded Claude idle-prompt identity/generation
predicates, and T3 defines concrete OpenCode event/property mappings plus incomplete evidence
behavior. The Codex transport was narrowed further after local protocol validation: use the
documented Unix-socket transport and `app-server proxy`, not the unsupported WebSocket listener.

A second blind reviewer then found additional blocking gaps: no planned Escape marker producer,
underspecified session/generation correlation, an untyped sixth IPC argument, missing mixed-hook
group behavior, insufficient OpenCode child-coverage authority, and an incomplete Codex
attribution/fallback/cleanup state machine. This revision adds the Terminal/store producer and
exact reducer flow, `AgentEventMeta`, mixed-group surgery rules, explicit OpenCode coverage
failure behavior, caller-owned PTY identity, Codex report binding, pre/post-launch fallback
semantics, and awaited cleanup across all ownership exits.

A third blind reviewer found four further blocking details: missing terminal identity must fail
closed even when a provider omits the field, outer/evidence identities need mismatch rejection,
the synchronous kill path must await sidecar cleanup including deferred-PTY errors, and Codex
work queries need bounded pagination/truncation handling. This revision adds those contracts,
tests, and lifecycle boundaries. A fresh review is still required; no approval is claimed.

A fourth blind reviewer then found startup/resume session binding gaps, required the identity
mismatch check to be top-level for every event, and requested explicit rollback tests for
requested PTY ids when deferred creation fails. This revision routes all known-session seeds
through one binding helper, makes envelope validation precede the reducer switch, and defines
requested-id rollback/collision tests. A fresh review is still required; no approval is claimed.

Historical status before the final corrective review: awaiting a fresh independent blind
review. No approval was claimed at that point.

Reviewer independence: the prior verdict was a blind delegated review with no prior rationale
or implementation diffs. Manual items remaining for implementation are provider payload capture,
deterministic protocol fixtures, hook parity, and final typecheck/tests.

### Fresh independent review

Verdict: APPROVED.

The current code, tests, AGENTS.md, relevant docs, ready spec, and this plan were reviewed
independently. No blocking finding remains: T1 makes every outer/evidence identity mismatch a
whole-event no-op; T5 binds all known session seeds, including hydration and automatic resume,
to `AgentStatusState.sessionId`; T4 covers requested-id collision plus `getPaneEnv`/`buildEnv`
rollback; T4 wires awaited sidecar cleanup through kill, error, exit, host-failure, deferred
error, replacement, and shutdown paths; T3 keeps installed OpenCode root-only idle incomplete;
T2 reconciles stale managed matcher pairs, including mixed foreign groups; and the coverage
matrix plus focused tests cover all source scenarios and the active-work suspension race.

Blocking findings: none.

Implementation is complete. Independent post-correction review and final verification remain
the lifecycle gates before archiving.

### Final independent post-correction review

Verdict: APPROVED.

Date: 2026-08-19. Reviewer: fresh blind read-only implementation review.

The final review inspected the corrected reducer, Claude/OpenCode adapters, Codex identity/order
guards, bounded turn fail-safe, serialized session rebinding, preparation/shutdown tracking,
sidecar cleanup, provider fixtures, and the S18 suspension race test. No blocking finding
remains.

## Implementation Summary

Implemented the provider-specific fail-closed recovery boundary:

- Added bounded normalized work evidence and identity-aware reducer reconciliation. Bare or
  incomplete completion signals cannot establish idle; complete empty provider evidence clears
  stale work, while active/scheduled work and unknown coverage remain protected.
- Added Claude structured task/cron evidence, separate `permission_prompt`/`idle_prompt`
  matchers, exact Escape interrupt markers, and a single reducer path through the existing IPC.
- Replaced OpenCode's deprecated idle shortcut with current generic-event handling, bounded
  root/child attribution, retry/error/permission reporting, and conservative incomplete root-only
  snapshots.
- Added a pane-local Codex App Server Unix-socket sidecar/proxy observer for app-launched panes,
  nested turn parsing, background-terminal/descendant reconciliation, bounded reconnect and
  awaited unsubscribe/cleanup, serialized session replacement, explicit turn identity/order
  guards, and fail-safe bounded history, with direct CLI fallback only before PTY creation.
- Hardened PTY requested-id rollback/collision handling, matcher-aware hook reconciliation,
  renderer session binding, suspension commit cancellation, and runtime reset/non-persistence
  seams. Added provider fixtures, protocol fakes, reducer, transport, renderer, and cleanup tests.

## Verification Evidence

- Planning discovery (2026-08-19, Windows): `claude --version` reported `2.1.235 (Claude
  Code)`, `codex --version` reported `codex-cli 0.148.0`, and `opencode --version` reported
  `1.18.14`. The source spec’s `2.1.226` remains its historical research target and is not
  silently rewritten here.
- Codex `0.148.0` manual no-turn smoke: `codex app-server --listen
  unix://C:/Users/cdhan/AppData/Local/Temp/multiagent-codex-smoke.sock` started; a separate
  `codex app-server proxy --sock ...` completed the WebSocket handshake and
  `initialize`/`initialized`; `thread/list` returned metadata; `thread/resume` emitted
  `thread/status/changed` with `status.type = idle`; and `codex --remote unix://...` reached the
  normal TUI without a turn. The temporary sidecar was stopped afterward. A probe of the same
  CLI’s `ws://` listener reported the documented experimental/unsupported transport warning.
- `bash -n src/main/integration/assets/multiagent-agent-state.sh` passed; the host Windows
  PowerShell hook fixture passed against empty/non-empty/malformed Claude payloads and
  `idle_prompt` gating.
- `npm run typecheck` passed after the final changes.
- `npx vitest run` passed: 75 test files, 819 tests, after the final corrective changes.
- `npm run build` passed after the final changes.
- `npm run test:e2e` ran all 27 Electron tests: 26 passed; one existing Browser MCP fixture
  failed before exercising this feature because its tool-list HTTP endpoint returned `[]` while
  the app status reported 29 tools. The isolated rerun reproduced the same failure. This is
  recorded as an environment/baseline failure, not claimed as passing evidence.
- No real provider turn or background task was launched by automated tests. Codex live turn and
  background-terminal behavior remains covered by deterministic protocol fakes plus the recorded
  no-turn transport smoke; a real model-turn check is intentionally `UNVERIFIED`.

## Final Independent Verification Evidence

Date: 2026-08-19. Independent blind verifier verdict: PASS.

Requirement matrix: R1-R13 PASS. Complete provider no-work evidence reconciles stale work;
active/scheduled/incomplete/busy/retry evidence remains protected; Claude, Codex, and OpenCode
use independent researched adapters; identity/order/provenance, reset, suspension, persistence,
single-reducer, and no-scraping contracts are covered by the final code and tests.

Scenario matrix: S1-S18 PASS. This includes exact Claude Escape/idle-prompt generation, all
Claude task/cron categories, Codex interrupted/background/child behavior, OpenCode busy/retry/
child/root-only limits, duplicate and out-of-order signals, no-evidence protection, waiting/error
precedence, reset/exit/restart cleanup, existing suspension eligibility, and the active-evidence
before-kill-commit race.

Non-goals and resolved decisions: PASS. No provider execution behavior, visible vocabulary,
timeout policy, live-state persistence, broad terminal scraping, arbitrary-text inference, or
user/project config mutation was introduced. Provider-specific Unix-socket Codex observation,
exact Claude markers, OpenCode protocol limits, bounded reconnect, and process-scoped config are
implemented and documented.

Final commands: `npm run typecheck` PASS; `npm run build` PASS; `npx vitest run` PASS (75 files,
819 tests); `bash -n src/main/integration/assets/multiagent-agent-state.sh` PASS; `git diff --check`
PASS apart from normal LF/CRLF warnings. `npm run test:e2e` ran 27 tests with 26 PASS and one
unrelated Browser MCP fixture failure: its endpoint returned `[]` while the app reported 29 tools;
the failure reproduced in isolation and does not exercise this feature.

Deliberate runtime limits: Codex no-turn Unix-socket/proxy smoke is recorded PASS, but no real
model turn or background task was launched, so that behavior remains UNVERIFIED. Deterministic
provider protocol fakes cover the implementation contract. No autonomous verification repair
remained after the final blind review.
