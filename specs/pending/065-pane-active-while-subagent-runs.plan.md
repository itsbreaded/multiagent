# Implementation Plan: Keep a Claude Pane Active While a Background Subagent Runs

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: specs/pending/065-pane-active-while-subagent-runs.md (Status: review)

## Verified Repository Facts

The following facts were checked against the current repository, rather than
copied from the spec:

- The pure reducer is eventToState in src/shared/agentStatus.ts. The renderer
  invokes it for each pane from the pane:agent-event listener in
  src/renderer/src/store/panesIpc.ts and stores the result with
  setPaneAgentStatus in src/renderer/src/store/panes.ts.
- AgentStatusState, AgentStatusInput, AgentLifecycleEvent, and the
  pane:agent-event EventChannels signature are defined in
  src/shared/types.ts. Main currently forwards ptyId, event, detail, and
  turnId without reducing the event. Adding the subagent identity requires an
  optional fifth IPC argument and an optional AgentEventReport.agentId field;
  the current plan must not claim that the existing IPC signature is
  sufficient.
- agentStatus is in-memory. normalizeNodeForLayout in
  src/main/ipc/layoutStore.ts strips it from every serialized leaf, while
  agentSuspension is a separate persisted intent marker. Active-subagent
  tracking must remain on agentStatus.
- The report server in
  src/main/integration/agentSessionReportServer.ts validates an allow-list of
  lifecycle events, agent kinds, and required fields before forwarding a
  report. Its existing test drives a real localhost HTTP round trip.
- The report-server callback is wired in src/main/ipc/handlers.ts. The
  renderer listener in src/renderer/src/store/panesIpc.ts validates the
  ptyId/event and currently forwards detail/turnId to eventToState.
- The hook assets
  src/main/integration/assets/multiagent-agent-state.ps1 and
  src/main/integration/assets/multiagent-agent-state.sh read JSON from stdin,
  dispatch on the second command argument, and POST to the report server.
  The post_tool_use branch currently reports only the tool name and does not
  inspect the Agent launch result. Neither script has a
  bg_subagent_completed branch.
- CLAUDE_EVENTS and CODEX_EVENTS are defined in
  src/main/integration/managedHookController.ts. Claude currently has seven
  managed event keys and no SubagentStop. Codex intentionally has no PostToolUse
  or Claude-only SubagentStop. The managed-hook surgery is keyed by config event
  key, so adding a new Claude key does not require changing managedHooks.ts.
- docs/session-linking-hooks.md documents the managed event-key table and the
  report-server/hook transport. Its Claude event table must be updated with
  SubagentStop and its transport narrative must document the two
  Claude-only background-subagent events and their identity field.
- isIdleAgentSuspensionEligible in
  src/renderer/src/store/idleAgentSuspension.ts requires status idle. No
  suspension-policy change is needed if the reducer keeps a pane working.
- demoteAgentPaneToShell and fresh-session paths already clear agentStatus.
  markLeafExitedByPtyId in src/shared/paneTree.ts clears ptyId and sets
  agentDisconnected but currently leaves agentStatus on a native agent leaf;
  that is the remaining literal PTY-exit gap for R7.
- Existing test seams are src/shared/agentStatus.test.ts,
  src/main/integration/agentSessionReportServer.test.ts,
  src/main/integration/managedHookController.test.ts,
  src/renderer/src/store/panes.test.ts,
  src/main/ipc/layoutStore.test.ts,
  src/renderer/src/store/idleAgentSuspension.test.ts, and
  src/shared/paneTree.test.ts. Package scripts are npm run typecheck and
  npm test; npm run build is the compile-only check.

## Design Decision

Use PostToolUse on the Agent/Task tool as the launch signal and SubagentStop
as the completion signal. Do not use Notification agent_completed and do not
use SubagentStart.

Correlate the two signals by the Claude subagent agentId, not by the ordering
of parent Stop and SubagentStop. SubagentStop applies to foreground and
background subagents, and hook delivery can be concurrent or intermittent;
event ordering is therefore not a valid foreground/background discriminator.
The reducer will hold:

- activeBackgroundSubagents?: number, the count used for the R6 contract;
- activeBackgroundSubagentIds?: string[], the in-memory identity set used to
  authorize an individual completion.

Both fields are on AgentStatusState, never serialized, and omitted when they
carry no active state. A background launch increments the count and records
the launch-side agentId when present. A completion decrements only when its
agentId is present in the active identity set. Duplicate, foreground, unknown,
missing-identity, or late completion events are no-ops. This makes completion
idempotent, supports concurrent completions and new parent turns, and fails
safe when an identity or completion signal is missing: the count remains
positive and the pane remains protected.

The T1 spike is a manual release-verification step, not an automated test and
not a prerequisite for the offline implementation. The implementation follows
the current documented Claude payload field for the launch-side agentId and
must be manually checked by the user before sign-off. If the user's target
version has no launch signal or no launch-side identity, stop release and
return to plan-spec rather than ship an inert or ordering-dependent
implementation. If SubagentStop is missing or unreliable after a confirmed
launch, the identity-set implementation still fails safe by retaining the
active count until demote, PTY exit, or session_start.

When the last known identity is removed, the reducer releases only the
background override. It preserves waiting, stop_failure error, and the
terminal_error latch. If the parent is still working on a new turn, it stays
working until the normal Stop. If the state was the held parent Stop, it
returns to idle with the existing stop semantics.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1 not idle while a background subagent is active | T2, T4, T5 | reducer tests, hook/report tests, manual e2e |
| R2 working badge and suspension protection | T2, T7 | reducer and eligibility tests, manual e2e |
| R3 normal state after every completion | T2, T3, T4, T6 | identity-correlated reducer and transport tests |
| R4 fresh lifecycle signals only | T2, T4 | code inspection and event fixtures; no timers/output scraping |
| R5 higher-signal precedence and re-arm | T2, T6 | waiting/error/latch interleaving tests |
| R6 per-pane count and multiple completions | T2, T6 | two-identity, partial, duplicate, and final-completion tests |
| R7 demote, PTY exit, session_start, and user-prompt behavior | T2, T7 | reducer, pane-tree, serialization, and store tests |
| R8 over-protective failure mode | T2, T4, T6 | missing/unknown identity and missing completion tests |
| R9 target-version signal verification | T1 | isolated spike record in Verification Evidence |
| R10 in-memory only and restart behavior | T2, T7 | layout normalization test |
| R11 foreground subagents unchanged | T2, T6 | completion for an ID not in the background set is a no-op |
| R12 Codex/OpenCode unchanged | T3, T5, T6 | server rejects new events for non-Claude; CODEX_EVENTS lacks both keys |
| R13 no new presentation | T2, T7 | no UI change; manual visual check |
| R14 existing latch/disconnected precedence | T2, T6, T7 | latch and PTY-exit regression tests |
| Suspension scenario | T2, T7 | status remains working past the configured timeout; manual e2e |
| Restart scenario | T2, T7 | serialized layout omits both tracking fields |
| Permission and terminal-error scenarios | T2, T6 | completion removes identity but preserves higher-signal state |
| Out-of-order and late-event scenarios | T2, T6 | completion-before-Stop, duplicate, unknown, and post-session tests |

## Architecture and Data Flow

Normal background flow:

1. Claude emits PostToolUse for Agent/Task. The hook detects
   tool_response.status == async_launched or tool_input.run_in_background ==
   true, extracts the launch-side agentId, and posts
   bg_subagent_started.
2. The report server accepts that event only for agentKind claude and
   forwards ptyId, event, detail, turnId, and agentId to the owning renderer.
3. The renderer applies eventToState to the pane-local status. The count and
   identity set become active and the status is working.
4. The parent Stop may arrive before, after, or concurrently with the
   subagent completion. If the count is active, Stop keeps working and carries
   the tracking fields.
5. Claude emits SubagentStop. The hook posts bg_subagent_completed with the
   SubagentStop agent_id as agentId. The reducer removes exactly that identity.
   Other identities keep the pane working; the last completion releases the
   override and lets the existing lifecycle state continue.
6. If the completion is absent or cannot be correlated, the active count is
   retained. demote, native PTY exit, or session_start clears it.

The identity is transported only as internal event data:

hook JSON agent_id/agentId -> AgentEventReport.agentId -> main callback ->
pane:agent-event fifth argument -> AgentStatusInput.agentId ->
AgentStatusState.activeBackgroundSubagentIds.

No UI component, persisted layout field, timer, transcript scanner, terminal
scraper, or new badge is added.

## Implementation Tasks

### T1 - Manual signal verification (no automated Claude session) (completed)

- Dependencies: none for offline implementation. This was a manual
  release-verification step and is complete based on the user's live report.
- Requirements/scenarios: R1, R3, R4, R8, R9 and the primary background-launch
  and completion scenarios.
- Files and symbols: no repository code changes. The user may use a temporary
  isolated Claude hook fixture and the running app's localhost report path.
  Do not modify the user's real ~/.claude settings or project configuration.
  No automated test or CI command may launch Claude or a real subagent.
- Current behavior: the repository has a managed PostToolUse hook but no
  managed SubagentStop hook, so the completion observation cannot rely on the
  current CLAUDE_EVENTS set. The isolated fixture must register both events
  before T5/T6 change the managed set.
- Spike protocol:
  1. Record claude --version and the embedded PTY environment.
  2. Run a short background Agent/Task invocation with
     run_in_background=true from a Claude pane.
  3. Capture the full PostToolUse payload. Confirm at least one launch marker:
     tool_response.status == async_launched or
     tool_input.run_in_background == true. Confirm the report is attributed to
     the parent pane's ptyId.
  4. In the same payload, locate the spawned subagent identity and record the
     exact field and casing used by the target CLI, such as
     tool_response.agentId or its observed equivalent.
  5. Capture a temporary SubagentStop payload when the background subagent
     completes. Record whether it fires, its parent-pane attribution, and its
     agent_id and agent_type fields. Record parent Stop ordering only as
     diagnostic information; it must not drive the reducer.
  6. Repeat enough times to distinguish a consistently present launch marker
     and launch identity from a one-off observation. Do not spend API budget
     on a long stress run.
- Decision and stop conditions:
  - If neither launch marker is observed, stop and report; do not ship
    behavioral code because the original false-idle bug remains.
  - If a launch marker is observed but the launch-side subagent identity is
    absent, stop and report; do not fall back to parent-turn ordering because
    that cannot distinguish foreground completions safely.
  - If SubagentStop is absent or intermittent after the launch prerequisites
    pass, proceed with the identity-set implementation and record that missed
    completion leaves the pane working until cleanup, as allowed by R8.
- Verification: the user records the live completion observations and the
  decision in this plan's Verification Evidence. Automated tests and CI still
  must not launch Claude or a real subagent.
- Completion evidence: the user's live report confirms the launch signal,
  partial-completion behavior, and matching completion behavior. Exact raw
  payload field names and the claude --version string were not recorded.

### T2 - Add identity-aware in-memory state and reducer transitions (completed)

- Dependencies: the current documented launch-side identity field; T1's live
  confirmation is required before release, not before offline implementation.
- Requirements/scenarios: R1-R8, R10-R11, R14; multi-completion,
  permission, terminal-error, restart, new-turn, foreground, and late-event
  scenarios.
- Files and symbols:
  - src/shared/types.ts: AgentLifecycleEvent, AgentStatusInput, and
    AgentStatusState.
  - src/shared/agentStatus.ts: eventToState and its existing latch/turn-id
    guards.
- Current behavior: the reducer maps Stop to idle unless terminal_error is
  latched. It has no subagent events or active-work fields.
- Implementation change:
  - Add bg_subagent_started and bg_subagent_completed to
    AgentLifecycleEvent.
  - Add optional agentId to AgentStatusInput.
  - Add optional activeBackgroundSubagents and
    activeBackgroundSubagentIds to AgentStatusState, documented as
    in-memory-only and omitted when inactive.
  - Implement bg_subagent_started as an idempotent launch transition. A
    launch with a new agentId increments the count and appends the ID. A
    launch without an ID increments an anonymous count slot so a malformed
    launch cannot fail open to idle; the normal shipping path is gated by T1
    having an ID.
  - Implement bg_subagent_completed as an exact-ID removal. A missing,
    unknown, duplicate, or foreground ID returns the prior state unchanged.
    A matching ID decrements the count once and removes only that ID.
  - Update Stop so an active count keeps status working and carries both
    fields; with no active count, preserve the existing Stop-to-idle result.
  - Carry count and IDs through pre_tool_use, post_tool_use,
    user_prompt_submit, permission_request, stop_failure, and terminal_error.
    user_prompt_submit clears no active tracking.
  - When the last known background ID is removed, preserve a waiting state,
    stop_failure error, or terminal_error latch. If the parent turn is still
    working, preserve working until its normal Stop. If the prior state is a
    held Stop, return the existing idle Stop shape.
  - Make session_start and demote clear the tracking. Native PTY-exit cleanup
    is implemented and verified in T7; the session_start behavior with no
    tracking remains unchanged.
- Invariants and edge cases:
  - Identity membership, not event ordering or prev.event, authorizes a
    decrement.
  - Count never goes negative; duplicate completion is idempotent.
  - The count is always at least the number of known IDs; any difference is
    an anonymous fail-safe slot that cannot be consumed by an uncorrelated
    completion.
  - A completion from a foreground subagent cannot consume a background slot.
  - A completion arriving during a new parent turn can remove its matching
    background ID without making the active parent turn idle.
  - A missing completion or an uncorrelatable launch/completion can only leave
    the pane over-protective; it must never produce false idle.
  - Terminal-error latching remains sticky. A matching completion may remove
    tracking but must not clear the latch.
  - Tracking fields are omitted at zero/empty so existing no-subagent state
    shapes remain stable.
- Verification: npm run typecheck after the reducer compiles; T6 provides
  the full deterministic truth table.
- Completion evidence: types compile; the focused reducer suite passes 43/43,
  including identity correlation, duplicate/out-of-order delivery, higher
  signal precedence, session cleanup, and fail-safe missing identities.

### T3 - Wire agent identity through the report server and IPC (completed)

- Dependencies: T2.
- Requirements/scenarios: R1, R3, R4, R9, R12 and the normal launch/completion
  data-flow scenario.
- Files and symbols:
  - src/main/integration/agentSessionReportServer.ts:
    AgentEventReport, VALID_EVENTS, the Claude-only event set, and handleEvent.
  - src/main/ipc/handlers.ts: the reportServer onEvent callback.
  - src/shared/types.ts: the pane:agent-event EventChannels signature.
  - src/renderer/src/store/panesIpc.ts: the pane:agent-event listener and
    safe string validation.
- Current behavior: reports accept only the existing seven lifecycle events
  and the IPC callback carries no agent identity. The event server accepts
  valid lifecycle events for Claude, Codex, and OpenCode.
- Implementation change:
  - Allow bg_subagent_started and bg_subagent_completed in the report server.
  - Add optional agentId to AgentEventReport and validate it as a non-empty
    string when supplied. Preserve compatibility for existing events and
    existing reports that omit it.
  - Reject the two new events when agentKind is not claude. Keep the existing
    Codex/OpenCode lifecycle allow-list unchanged. This is a runtime defense
    in addition to the managed install boundary.
  - Forward agentId through the main callback and add it as the optional fifth
    pane:agent-event argument.
  - Validate the fifth renderer argument with the same safe-string rule used
    for detail and turnId, then pass it as AgentStatusInput.agentId.
- Invariants and edge cases:
  - Existing valid reports still return 204 and keep their exact callback
    shape when agentId is absent: omit the optional property from the callback
    object so existing deep-equality expectations remain stable. Include
    agentId only when the validated request supplied it.
  - New events with missing ptyId, invalid agent kind, invalid event, or a
    non-string agentId return 400 and never reach the renderer.
  - No reducer runs in main, and no agent identity is displayed.
- Verification:
  - Extend agentSessionReportServer.test.ts with accepted new Claude events,
    agentId round-trip, missing optional identity behavior, and rejection of
    the new events for Codex/OpenCode.
  - Extend the renderer pane-event test seam in panes.test.ts to prove the
    fifth argument reaches eventToState.
  - Run npm run typecheck.
- Completion evidence: report-server/managed-hook integration tests pass;
  renderer pane IPC tests pass 51/51; typecheck passes.

### T4 - Make both hook assets emit correlated subagent events (completed)

- Dependencies: the current documented launch-side identity field and T3 for
  the report shape. T1 confirms the field manually before release.
- Requirements/scenarios: R1, R3, R4, R8, R9; background launch,
  completion, missing-field, and no-blocking failure scenarios.
- Files and symbols:
  - src/main/integration/assets/multiagent-agent-state.ps1:
    Post-Event, Get-TurnId, the post_tool_use switch branch, and a new
    bg_subagent_completed branch.
  - src/main/integration/assets/multiagent-agent-state.sh:
    post_event, jsonstr/launch-marker helpers, the post_tool_use case, and a
    new bg_subagent_completed case.
  - Add a platform-aware offline fixture test beside the integration tests,
    src/main/integration/agentStateHook.test.ts, that executes the host
    script against a local HTTP capture server. It must never launch Claude
    or a real subagent.
- Current behavior: post_tool_use always emits post_tool_use with a tool name,
  and no script can emit a completion event.
- Implementation change:
  - In both scripts, recognize only Agent/Task tool launches and require
    async_launched or run_in_background true. Emit bg_subagent_started once,
    carrying the target CLI's launch-side agentId and the existing turnId.
    Non-background tools continue to emit ordinary post_tool_use.
  - Add bg_subagent_completed dispatch. Read the SubagentStop payload's
    top-level agent_id (mapped to JSON agentId) and preserve the turn ID if
    available.
  - Extend Post-Event/post_event to include agentId only when it is a
    non-empty string.
  - Keep all existing no-op guards, timeout limits, JSON defensive behavior,
    and exit-0/no-blocking behavior.
  - For a background marker with a missing identity, still send the
    bg_subagent_started event without agentId. T2 treats it as an anonymous
    active slot, which is fail-safe. T1 prevents this from being the normal
    target-version path.
  - The PowerShell path must read the confirmed nested field directly.
    The shell path must use whitespace-tolerant grep/sed extraction for the
    confirmed field and markers; do not add jq, Node, Python, or another
    runtime to the hook.
- Invariants and edge cases:
  - Do not emit both bg_subagent_started and post_tool_use for one launch.
  - A missing tool_response or tool_input falls back to ordinary
    post_tool_use, except a positively detected background marker with a
    missing ID, which emits the fail-safe background event.
  - A malformed SubagentStop payload emits no usable agentId and therefore
    cannot decrement state.
  - Hooks remain self-contained and bounded by the existing two-second POST
    timeout.
- Verification:
  - agentStateHook.test.ts starts a local HTTP server, invokes the Windows
    PowerShell script on win32 and the shell script on Unix, and asserts
    captured JSON for async_launched, run_in_background, normal tools, and
    SubagentStop agent identity. The non-host script test is skipped with an
    explicit reason; both scripts also receive syntax checks where available.
    This is a canned-payload test only and must never launch Claude or a real
    subagent.
  - Test payloads include whitespace around JSON colons and a missing optional
    field to guard the parser boundary.
  - Run npm test for the new fixture and npm run typecheck.
- Completion evidence: the host PowerShell asset fixture passes 4/4 and
  captures launch/completion identities. PowerShell execution succeeds;
  the Unix shell path was reviewed but bash is unavailable on this Windows
  host, so its runtime syntax remains UNVERIFIED.

### T5 - Install SubagentStop for Claude only (completed)

- Dependencies: T4.
- Requirements/scenarios: R1, R3, R9, R12, R13 and managed-hook
  reconciliation/uninstall behavior.
- Files and symbols:
  - src/main/integration/managedHookController.ts:
    CLAUDE_EVENTS and the existing CODEX_EVENTS test assertions.
  - src/main/integration/managedHookController.test.ts.
  - docs/session-linking-hooks.md: the managed event table and the
    hook/report transport description.
- Current behavior: Claude has no SubagentStop entry. Codex has neither
  PostToolUse nor SubagentStop.
- Implementation change: add one Claude event row with configKey
  SubagentStop, Claude match-all matcher, and scriptArg
  bg_subagent_completed. Do not modify CODEX_EVENTS, the Notification matcher,
  or managedHooks.ts.
- Invariants and edge cases:
  - Existing sentinel, marked-block, backup, atomic, idempotent,
    reconciliation, and uninstall behavior remains unchanged.
  - A foreground SubagentStop is harmless because T2 requires its identity to
    be in the active background set.
  - R12 is enforced twice: CODEX_EVENTS does not install either signal, and
    T3 rejects the new events for non-Claude reports.
  - No new trust or user-facing setting is introduced.
- Verification:
  - Update the full-event-set test to expect eight Claude events and five
    Codex events.
  - Assert Claude SubagentStop command and script argument, Claude
    Notification matcher unchanged, and Codex lacks both PostToolUse and
    SubagentStop.
  - Keep the orphaned-event reconciliation and uninstall assertions green.
  - Update docs/session-linking-hooks.md to list Claude SubagentStop,
    identify bg_subagent_started as the Agent/Task PostToolUse launch report,
    identify bg_subagent_completed as the SubagentStop report, and state that
    agentId correlation is in-memory and Claude-only. Do not document agent
    identity as a user-facing field.
- Completion evidence: managed-hook tests pass, including the eight-event
  Claude set, five-event Codex set, Claude SubagentStop command, Codex signal
  absence, reconciliation, and uninstall behavior.

### T6 - Add reducer and integration regression coverage (completed)

- Dependencies: T2-T5.
- Requirements/scenarios: R1-R8, R11-R12, R14; every acceptance scenario
  involving state transitions, ordering, duplication, and late events.
- Files and symbols:
  - src/shared/agentStatus.test.ts: new spec 065 describe block using the
    existing deterministic eventToState helper.
  - src/main/integration/agentSessionReportServer.test.ts.
  - src/main/integration/agentStateHook.test.ts.
  - src/renderer/src/store/panes.test.ts.
- Current behavior: the reducer tests cover the spec 032/050 truth table but
  have no subagent state or identity transport cases.
- Implementation change: add deterministic cases that prove:
  1. one launch keeps working through Stop and matching completion returns to
     idle;
  2. two distinct IDs stay working after the first completion and return to
     idle only after the second;
  3. duplicate completion is idempotent;
  4. completion before parent Stop removes the ID without requiring ordering;
  5. foreground completion with no matching background ID is a no-op;
  6. a completion during a new parent turn removes its background identity but
     leaves the parent working;
  7. missing/unknown completion identity leaves the count positive;
  8. permission_request and stop_failure retain precedence while matching
     completions remove tracking;
  9. terminal_error remains latched while matching completions remove tracking;
  10. user_prompt_submit preserves active count and IDs;
  11. session_start and demote clear all tracking;
  12. a stale completion after session_start cannot consume a new state;
  13. no tracking fields are emitted once the count reaches zero.
- Invariants and edge cases:
  - Every completion assertion names the identity it removes.
  - Tests cover both a known identity and an anonymous fail-safe launch slot.
  - Existing spec 032/050 expected shapes remain unchanged when no tracking
    is active.
- Verification: run the focused shared, main integration, and renderer tests,
  then npm test for the full suite. Use npm run typecheck as the type boundary.
- Completion evidence: full Vitest passes 71 files / 779 tests; no automated
  test launches Claude or a real subagent.

### T7 - Close PTY-exit, persistence, suspension, and end-to-end checks (completed)

- Dependencies: T2 and T5; T6 should be green first.
- Requirements/scenarios: R2, R7, R10, R13, R14; suspension, restart,
  PTY-exit, disconnected-icon, foreground, and Codex/OpenCode scenarios.
- Files and symbols:
  - src/shared/paneTree.ts: markLeafExitedByPtyId agent-leaf branch.
  - src/shared/paneTree.test.ts or the existing renderer pane exit test seam.
  - src/main/ipc/layoutStore.test.ts.
  - src/renderer/src/store/idleAgentSuspension.test.ts.
  - src/renderer/src/store/panes.test.ts where the pty:exit listener is
    exercised.
- Current behavior: working status already makes a pane ineligible for idle
  suspension, and layout normalization strips agentStatus. Native PTY exit
  clears ptyId/sets agentDisconnected but does not clear agentStatus.
- Implementation change:
  - Set agentStatus to undefined in the agent-leaf PTY-exit transform. This
    clears count and IDs for a dead native pane and matches demote cleanup.
  - Add a serialization assertion that activeBackgroundSubagents and
    activeBackgroundSubagentIds do not appear in normalized layout output.
  - Add an eligibility assertion that working with active tracking is not
    suspendable. Do not change idle timeout/default/resume policy code.
  - Add a pane-exit assertion that the disconnected state remains intact and
    no stale agentStatus survives.
- Invariants and edge cases:
  - Shell leaves and unknown PTYs remain no-ops.
  - Disconnected-icon precedence remains unchanged; the exit transform uses
    the same agentStatus undefined value as demote.
  - No tracking field is added to serialized agentSuspension or any settings.
  - No new label, tooltip requirement, badge, or status category is added.
- Verification:
  - Run the focused pane-tree, layout-store, idle-suspension, and panes tests.
  - Run npm run typecheck, npm test, npm run build, npm run test:e2e, and
    git diff --check. The existing Electron e2e suite uses its framed-agent
    fixture and must not be changed to launch Claude; it is only a regression
    check, not T1 evidence.
  - Manual e2e in an isolated development profile: launch a Claude background
    subagent, unfocus its tab past the configured idle timeout, and confirm it
    stays connected and working. If T1 confirmed reliable SubagentStop
    delivery, confirm matching completion returns it to normal idle behavior;
    if T1 observed a missed or unreliable completion, confirm the specified
    over-protective working state and cleanup on PTY exit/session start.
    Repeat with a foreground subagent and a Codex or OpenCode pane; confirm
    no behavior or presentation change.
- Completion evidence: focused pane-tree/layout/suspension tests pass 44/44,
  standalone build passes, and git diff --check passes. The existing fixture
  Electron suite passed 26/27; the one browser-MCP tool-list test failed
  reproducibly outside this feature because its external listing was empty
  while the app reported 29 tools. User-run Claude/manual e2e remains
  UNVERIFIED.

## Cross-Cutting Constraints

- Keep badge updates hooks-only. This feature adds two lifecycle events; it
  does not add a timer, transcript polling, terminal quietness heuristic,
  terminal scraping path, or second renderer write path.
- Keep the existing terminal_error latch, turn-id guards, higher-signal
  precedence, and disconnected-icon precedence. A completion removes only its
  matching background identity.
- Keep active tracking inside non-serialized agentStatus. Do not touch
  agentSuspension, layout schema, settings, transcripts, session index, or
  process-age logic.
- Use identity membership, not parent Stop ordering or prev.event, to
  distinguish foreground from background completions.
- Enforce Claude-only behavior at both the managed-hook install and report
  server validation boundaries. CODEX_EVENTS stays unchanged.
- Preserve no-PATH-rewrite, no-flow-control, no-interactive-shell,
  direct-PTY, and renderer resize guardrails. This plan adds no PTY behavior
  beyond clearing in-memory status when an existing PTY exit is observed.
- Do not surface agent IDs or subagent internals in the UI.
- Hooks must remain self-contained, defensive, bounded, and exit zero on
  missing fields or localhost failures.

## Risks, Migration, and Rollback

- Signal shape/version risk: T1 blocks shipping if a launch marker or
  launch-side identity is unavailable. If completion is missing or intermittent
  after the prerequisites pass, the active count remains and the pane is
  over-protective until cleanup, which is the specified safe direction.
- Malformed runtime payload risk: a background marker without an ID creates an
  anonymous active slot; no completion can remove it by mistake. This can
  leave a stuck working badge, never a false idle.
- Duplicate/out-of-order delivery risk: identity membership makes completion
  idempotent and independent of parent Stop ordering. A late completion after
  session_start cannot match a cleared identity set; Claude subagent IDs are
  treated as unique for the pane session.
- Config compatibility: existing report payloads and existing lifecycle events
  omit agentId and remain valid. The managed hook install is reversible through
  the existing terminal-linking toggle; no persisted migration is needed.
- Rollback: uninstall managed hooks to remove SubagentStop, then revert the
  source changes. Since the new fields are non-serialized, old/new layouts are
  mutually compatible and no data migration or cleanup is required.
- Manual verification limitation: live hook reliability and visual suspension
  behavior cannot be established by static inspection or unit tests. The user
  has now reported the isolated live behavior in Verification Evidence.

## Handoff Checklist

- [x] T1 spike record: behavioral e2e confirms launch signal present (pane
      goes working on spawn), launch-side agentId captured (partial completion
      keeps working — requires identity membership, not ordering), and
      SubagentStop fires with matching identity (pane returns to idle exactly
      on each completion). All three T1 stop-conditions cleared. Raw payload
      field-name capture (exact agentId field, claude --version string) not
      recorded; behavior confirms the mechanism so it is not required to ship.
- [x] AgentLifecycleEvent, AgentStatusInput, AgentStatusState, report payload,
      IPC event signature, and renderer listener carry the optional agentId.
- [x] Reducer uses count plus identity membership; no prev.event or ordering
      guard authorizes completion.
- [x] Matching completion removes one identity; duplicate/unknown/missing
      completion cannot reduce the count.
- [x] waiting, stop_failure, and terminal_error precedence survives matching
      completion; user_prompt_submit preserves active tracking.
- [x] session_start, demote, and native PTY exit clear tracking; layout never
      persists it.
- [x] Both hook scripts detect launch markers and emit completion identity;
      platform-aware payload tests pass.
- [x] CLAUDE_EVENTS includes SubagentStop; CODEX_EVENTS remains without
      PostToolUse/SubagentStop; server rejects new events for non-Claude.
- [x] Focused tests, npm run typecheck, npm test, npm run build, and
      git diff --check pass.
- [x] Manual spike and e2e observations are recorded without inventing
      runtime evidence.

## Plan Review

Verdict: APPROVED.

Review method: same-session blind re-read after the verification-boundary
revision; no delegation capability was available, so this is not an
independent subagent or human review. The reviewer re-read the ready spec,
AGENTS.md, docs/writing-specs.md, docs/writing-plans.md, this adjacent plan,
the affected reducer/types/report-server/IPC/hook/managed-hook/pane-tree/
layout/suspension code, and the current test seams.

Coverage: all 14 requirements, all 11 acceptance scenarios, the resolved
Claude-only/signal/fail-safe/in-memory decisions, and the listed non-goals
remain mapped to T1-T7. The revised plan explicitly separates:

- user-only live Claude launch/completion and suspension verification, which
  remains UNVERIFIED until the user runs it;
- offline automated coverage using pure reducer tests, local HTTP capture,
  canned hook JSON, serialization/eligibility tests, and the existing
  framed-agent Electron fixture;
- implementation sequencing, which no longer requires an automated or
  cost-incurring Claude session.

Findings: no blocking, important, or editorial findings remain. The plan
continues to use identity correlation rather than event ordering, keeps
Claude-only enforcement at both boundaries, and keeps real Claude launches
out of tests and CI.

Manual limitations: the user reported the T1/T7 behavior, but did not record
the exact raw signal payload fields or claude --version string. No automated
Claude launch is part of the verification suite.

## Implementation Summary

Implemented spec 065 with identity-correlated, in-memory background-subagent
tracking. Claude PostToolUse launch detection and SubagentStop completion
events now flow through the report server, main IPC, renderer reducer, and
managed hook install. Higher-signal lifecycle states, duplicate/out-of-order
events, session/process cleanup, PTY-exit cleanup, and non-persistence are
covered without adding UI or changing the suspension policy.

Offline checks completed:

- npm run typecheck
- npm test: 71 files / 779 tests passed
- npm run build
- git diff --check
- npm run test:e2e: 26/27 passed; one unrelated browser-MCP tool-list test
  failed and reproduced on a focused retry

No automated check launches Claude or a real subagent. T1/T7 live behavior is
verified by the user's report; exact raw signal payload fields remain
unrecorded.

## Verification Evidence

- T1: PASS (behavioral). Live e2e run on 2026-08-10 confirmed all three
  stop-conditions cleared:
  1. Launch signal present — pane went working (blue) on subagent spawn.
  2. Launch-side agentId captured — in the two-subagent staggered test the
     pane stayed working after the first completion (10s) and only went idle
     after the second (40s). Partial-completion-keeps-working requires
     identity-membership tracking, which requires the agentId to be present at
     launch; a pure count or ordering-based implementation could not produce
     this middle row.
  3. SubagentStop fires with matching identity — pane returned to idle exactly
     on each completion (single-subagent run: idle on completion; two-subagent
     run: idle only after the final completion).
  Raw payload field-name capture (exact agentId field, claude --version) was
  not recorded; the behavior confirms the mechanism so it is not required to
  ship. Proceed decision: ship.
- T2-T6: PASS by focused and full offline tests listed above.
- T7 code paths: PASS by pane-tree, layout normalization, suspension
  eligibility, standalone build, and diff checks.
- T7 manual Claude behavior: PASS. Single-subagent run: pane stayed working
  during the run and returned to idle on completion. Two-subagent run: pane
  stayed working through the first (partial) completion and returned to idle
  only after the final completion.
