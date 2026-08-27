# Implementation Plan: Recover Claude Foreground Idle Status After Missed Completion

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/pending/069-claude-foreground-idle-recovery.md` (Status: review)

## Verified Repository Facts

- Claude lifecycle hooks are installed by `CLAUDE_EVENTS` in
  `src/main/integration/managedHookController.ts`. The existing
  `Notification` matcher for `idle_prompt` is already installed, so this
  change does not require a new managed-hook configuration key.
- The Windows and Unix managed hook assets read provider JSON, post
  `/agent-event` reports, and exit successfully on all failures. Both assets
  currently emit `idle_prompt` with a session id but drop any turn identity;
  both currently treat only `error_type`/`message` as StopFailure detail.
- Claude's current hook reference documents `prompt_id` as a common field,
  `stop_hook_active` on Stop, `error`/`error_details` on StopFailure, and
  `idle_prompt` as a delayed provider notification. Notification payloads do
  not include the Stop work arrays, so idle_prompt cannot independently prove
  empty background work. The plan uses provider fields when present and keeps
  suspension fail-closed when complete empty-work evidence is absent.
- `AgentSessionReportServer` validates and forwards `idle_prompt` as a
  Claude-only event. Its report and IPC types already allow an optional
  `turnId`, so no new event channel is required.
- The renderer's `pane:agent-event` listener is the only status write path. It
  invokes the pure `eventToState` reducer with the pane's previous state,
  provider kind, session id, turn id, and evidence before storing the result.
- `eventToState` currently accepts Claude `idle_prompt` only when a matching
  renderer-side interrupt marker exists. Claude `stop` with missing or bare
  evidence is fail-closed; a complete empty snapshot produces `idle`.
- `isIdleAgentSuspensionEligible` currently derives eligibility from the
  visible `idle` status alone. The new recovery case needs an in-memory
  suspension-protection marker so a recovered foreground badge can be idle
  while unknown background coverage remains protected.
- The queued suspension kill in `src/renderer/src/store/panes.ts` repeats
  several eligibility checks but currently checks only `status === 'idle'` at
  the final microtask. Any new protection marker must be rechecked at that
  commit boundary, after the pane may have received a lifecycle event.
- Active/scheduled work is represented in the in-memory status state and
  prevents idle recovery. Background subagent/team accounting is owned by
  `pane-active-while-subagent-runs` and is not redesigned here.
- Idle suspension eligibility is derived from `agentStatus.status === 'idle'`,
  so no suspension-policy change is needed if the reducer preserves protected
  states correctly.
- Runtime status is not persisted in layout. Existing hook installation is
  marked, reversible, and refreshes the materialized hook asset when its
  content changes.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1 foreground active state | T2 | reducer lifecycle tests |
| R2 provider-confirmed foreground completion becomes visible idle | T2, T3 | reducer and integration tests |
| R3 missed completion recovers through idle_prompt | T1, T2, T3 | Windows/Unix hook fixtures and reducer path test |
| R4 no quiet/time/process/text-only idle | T2 | source inspection and negative reducer tests |
| R5 ambiguity/work remains suspension-protected | T2, T4 | reducer, suspension, and integration tests |
| R6 waiting/error precedence | T2 | reducer tests |
| R7 identity/order/duplicate safety | T1, T2, T3 | all turn-bound events, delayed, duplicate, and boundary tests |
| R8 malformed/version-drifted payload safety | T1, T3 | hook fixtures and report validation tests |
| R9 Windows/macOS/Linux consistency | T1, T4 | both hook asset test paths plus project checks |
| R10 other providers unchanged | T2, T3 | Codex/OpenCode regression tests and source inspection |
| S1 complete empty Stop | T2 | existing and expanded reducer assertions |
| S2 silent tool stop then idle_prompt | T1, T2, T3 | end-to-end event sequence test |
| S3 Escape recovery | T2 | existing interrupt tests retained and expanded |
| S4 active/scheduled work | T2 | active-work negative tests |
| S5 incomplete/malformed/stale evidence | T1, T2, T3 | negative fixtures and reducer assertions |
| S6 Stop continuation | T1, T2 | `stop_hook_active` fixture produces working |
| S7 waiting precedence | T2 | reducer interleaving test |
| S8 error precedence | T1, T2 | StopFailure and delayed recovery tests |
| S9 out-of-order events | T2 | newer-turn and duplicate tests |
| S10 delayed prior-turn idle_prompt | T1, T2 | mismatched `prompt_id` test |
| S11 provider payload drift | T1, T3 | missing-field and unknown-field fixtures |

## Architecture and Data Flow

The existing path remains the single status pipeline:

```text
Claude Notification/Stop JSON
        -> managed hook asset
        -> POST /agent-event
        -> AgentSessionReportServer validation
        -> main pane:agent-event forwarding
        -> renderer eventToState(previous pane state)
        -> badge and idle-suspension eligibility
```

The hook assets will preserve the provider's `prompt_id` on `idle_prompt`
reports. The reducer will treat a matching current-session/current-turn
`idle_prompt` as a foreground recovery event when the pane is still working and
has no known active or scheduled work. Because Notification has no work
snapshot, this transition may set the visible badge to `idle` while also
setting an in-memory suspension-protection marker. The existing interrupt
marker remains valid for Escape recovery only when the provider supplies the
matching current turn identity; a session-only notification is ignored because
it could belong to an older turn.

Complete empty-work evidence from Stop/work reconciliation clears the
suspension-protection marker and makes the normal idle badge eligible for
suspension. A known active or scheduled item continues to force `working`.

Stop payloads with `stop_hook_active` will be represented as continuation/
busy evidence rather than a completed turn. This keeps the provider event in
the existing reducer and avoids a second status writer. StopFailure detail will
use the current provider field names while retaining defensive fallback for
older payload shapes.

No timer, transcript observer, terminal classifier, new status category,
managed hook event, persisted field, or Codex/OpenCode path is introduced.

## Implementation Tasks

### T1 - Preserve Claude recovery identity and terminal metadata in managed hooks (completed)

- Dependencies: none.
- Requirements/scenarios: R3, R7, R8, R9; S2, S3, S6, S8, S10, S11.
- Files and symbols: `src/main/integration/assets/multiagent-agent-state.ps1`
  and `.sh`; the Claude `idle_prompt`, `stop`, and `stop_failure` dispatch
  branches; existing hook fixture tests in
  `src/main/integration/agentStateHook.test.ts`.
- Current behavior: both assets discard `prompt_id` on `idle_prompt`; Stop
  always labels its snapshot `completed`; StopFailure reads legacy detail
  fields only.
- Implementation change: forward the provider turn id with `idle_prompt` when
  present; apply this Stop truth table: boolean `true` -> busy/continuing,
  boolean `false` -> normal completion candidate, absent or any non-boolean ->
  unknown/incomplete and never an idle candidate. Read current `error` and
  optional `error_details`, with defensive legacy fallback; keep the short
  provider error authoritative when details exceed the report limit.
- Invariants and edge cases: missing JSON, missing identity, malformed arrays,
  unknown fields, old Claude payloads, and HTTP failures still exit 0 and do
  not fabricate idle evidence. The hook command shape and existing managed
  config remain unchanged.
- Verification: run the existing host-platform hook harness with fixtures for
  matching/missing `prompt_id`, `stop_hook_active: true`, `false`, absent, and
  malformed values, current StopFailure fields, legacy fields, oversized
  `error_details`, malformed payloads, and empty/nonempty work arrays. Add
  syntax/fixture coverage for the non-host script where the host cannot run
  it, and record CI/manual cross-platform coverage separately.
- Completion evidence: Windows PowerShell and Unix/Git Bash fixture paths pass. The
  assets now forward `prompt_id`, include snapshot session/turn identity, classify
  `stop_hook_active` conservatively, and prefer bounded current StopFailure fields.

### T2 - Add identity-safe ordinary idle_prompt recovery to the reducer (completed)

- Dependencies: T1's report shape is required for the matching-turn path, but
  the reducer can be developed against direct typed inputs first.
- Requirements/scenarios: R1, R2, R3, R4, R5, R6, R7, R8, R10; S1 through
  S10.
- Files and symbols: `src/shared/agentStatus.ts`, especially
  `idlePromptCanRecover`, the terminal-event guard, and the `idle_prompt` /
  `stop` cases; `src/shared/types.ts` for the in-memory protection marker;
  `src/shared/agentStatus.test.ts`.
- Current behavior: a Claude `idle_prompt` is rejected unless an exact Escape
  interrupt marker is pending. A complete empty Claude Stop snapshot idles;
  missing/bare Stop remains unchanged.
- Implementation change: permit ordinary visible foreground recovery when the
  current state is a working Claude turn, the incoming session and turn
  identity match, no known active or scheduled work is tracked, and neither
  waiting nor error/latch precedence applies. A recovered idle_prompt sets
  `suspensionBlocked` unless the state already contains a
  complete empty-work snapshot for the same session and turn. Complete empty
  Stop/work evidence clears that marker. Treat a matching idle_prompt as
  idempotent after the first transition; reject missing, stale, conflicting,
  or older-turn identity, including the Escape path. Ensure Stop
  busy/continuation evidence remains working and does not clear a newer turn.
  Add a shared turn-identity guard for
  turn-bound `pre_tool_use`, `post_tool_use`, `permission_request`, and
  `stop_failure` events so a same-session older event cannot overwrite a newer
  turn. Background-subagent lifecycle events are the explicit cross-turn
  exception: a start or completion may carry an older parent turn only when
  its session matches the pane and its child identity is present. Child events
  must preserve the newer foreground session/turn identity and must not replace
  its foreground event metadata. Known starts deduplicate by child identity;
  known completions remove only that identity. Keep a bounded in-memory set of
  completed child identities so a delayed duplicate start after completion is a
  no-op, including completion-before-start reordering. An anonymous start may
  be accepted only as a same-session conservative protection slot (it never
  authorizes a completion), while a different-session start is rejected.
- Invariants and edge cases: active background/scheduled tracking always
  protects the pane and forces working; missing/untracked work evidence may
  block suspension even when the foreground badge is idle; a newer
  `user_prompt_submit` wins over a delayed prior notification; waiting/error
  remain authoritative; `demote`, fresh `session_start`, and session
  replacement clear recovery state; Codex and OpenCode branches remain
  unchanged; no timer or terminal text is consulted.
- Verification: add direct reducer sequences for normal prompt/tool activity
  followed by matching idle_prompt, missing/mismatched turn id, delayed prior
  turn, duplicate notification, known active/scheduled work, absent/untracked
  work coverage, waiting/error, Stop continuation, Escape recovery, and stale
  same-session tool/permission/failure events after a newer turn. Include a
  valid same-session older-turn child start, duplicate known start, different-
  session start, anonymous same-session start, known cross-turn completion,
  completion-before-start reordering, duplicate start after completion, and
  anonymous/unknown completion. Assert exact state objects preserve the newer
  foreground turn/event, retain the tombstone, keep `suspensionBlocked`, and
  preserve suspension eligibility for recovered-idle and protected states.
- Completion evidence: reducer, suspension eligibility, queued-kill race, stale-event,
  provider-isolation, child cross-turn, tombstone, and current-turn snapshot tests pass.

### T3 - Verify report forwarding and document the revised Claude contract (completed)

- Dependencies: T1 and T2.
- Requirements/scenarios: R2, R3, R7, R8, R9, R10; S2, S5, S8, S9, S11.
- Files and symbols: `src/main/integration/agentSessionReportServer.ts` and
  its tests; `src/main/integration/agentEventForwarder.ts` if boundary
  assertions reveal a missing field; `src/renderer/src/store/panesIpc.ts` and
  `src/renderer/src/store/panes.test.ts`; `src/renderer/src/store/idleAgentSuspension.ts`
  and its tests; `src/renderer/src/store/panes.ts` suspension commit path;
  `docs/session-linking-hooks.md` status
  and event mapping sections.
- Current behavior: the report route already allows Claude idle_prompt and
  optional turn identity, and the renderer already forwards event metadata to
  the shared reducer. The documentation says idle_prompt is Escape-only.
- Implementation change: preserve/confirm turn identity and evidence through
  the localhost report boundary, add only the validation needed for the new
  contract, update suspension eligibility to honor `suspensionBlocked`, and
  make the final queued suspension-kill commit recheck the same protection
  marker and exact identity/intent conditions after any intervening event, and
  update the mechanism documentation to describe ordinary delayed idle_prompt
  recovery, identity requirements, continuation handling, and fail-closed
  limits.
- Invariants and edge cases: non-Claude reports cannot use Claude-only
  recovery; malformed or oversized reports remain rejected; main remains a
  forwarder; renderer remains the sole reducer owner; no persisted status or
  new IPC channel is added.
- Verification: exercise real localhost report POSTs for valid/mismatched/
  missing identity and provider fields, run the renderer listener regression
  through `src/renderer/src/store/panes.test.ts`, run direct eligibility tests
  for recovered idle with and without the protection marker, and add a
  microtask race test proving the final kill commit is canceled when the
  marker arrives after suspension scheduling. Inspect the documentation
  against the final reducer and hook behavior. Include one composed hook ->
  report -> renderer-listener -> reducer test for S2.
- Completion evidence: localhost report-boundary, composed hook -> report -> renderer
  listener -> reducer, eligibility, and suspension commit tests pass; `AGENTS.md` and
  `docs/session-linking-hooks.md` describe the split visible-idle/suspension contract.

### T4 - Run project-wide and runtime-appropriate checks (completed)

- Dependencies: T1 through T3.
- Requirements/scenarios: all requirements and scenarios; specifically the
  cross-platform and no-regression claims.
- Files and symbols: no new production boundary; inspect the final diff and
  test fixtures. Use the scripts defined in `package.json`.
- Current behavior: the implementation and focused/whole-project checks cover the
  current contract, including ordinary missed-completion recovery and separate
  suspension protection.
- Implementation change: no additional product behavior; consolidate the
  verification evidence required for handoff.
- Invariants and edge cases: preserve clean hook installation, no debug output,
  no changes to Codex/OpenCode behavior, and no generated artifacts in source
  control.
- Verification: run `npm run typecheck`, `npm run build`, `npm run test`,
  `npm run test:e2e`, and `git diff --check`. The hook fixture runs only the
  host platform; use repository CI or a second-platform syntax/fixture run for
  the R9 cross-platform claim. If a live Claude turn cannot be executed in the
  available environment, record that runtime limitation explicitly rather
  than treating fixture coverage as live-provider proof.
- Completion evidence: `npm run typecheck` passed; `npm run build` passed; `npm run test`
  passed with 77 files and 847 tests; `git diff --check` passed. The host-platform hook
  fixture passed for PowerShell and the added Unix/Git Bash parity fixture passed. The
  full `npm run test:e2e` run completed 27/28: the one failure is the pre-existing
  browser-MCP tool-list ordering assertion (`e2e/browserMcp.spec.ts:188`), reproduced by
  the isolated test and unrelated to this status change. No live Claude turn was
  available; provider behavior remains fixture-verified and web-researched, not live
  runtime verified.

## Cross-Cutting Constraints

- The existing fail-closed identity and work-evidence rules remain intact:
  incomplete/missing/conflicting evidence cannot establish suspension
  eligibility. A current-turn idle_prompt can establish visible foreground
  idle but cannot establish complete empty background work.
- `idle_prompt` is provider-derived recovery, not terminal scraping. Quietness,
  elapsed time, process existence, and generic text are never sufficient alone.
- Active or scheduled background work remains protected; its accounting belongs
  to `pane-active-while-subagent-runs`.
- A `suspensionBlocked` marker is in-memory only and is cleared by complete
  empty-work reconciliation, fresh session lifecycle, or other normal recovery
  transitions as specified; it is never serialized.
- Completed child identities are bounded, session-scoped, in-memory tombstones
  used only for duplicate/out-of-order background lifecycle delivery; they are
  cleared on a fresh session/demotion and never persisted.
- A lifecycle event for an older turn must not mutate same-session foreground
  status when the event carries a conflicting turn id. Background completion
  and start events are explicit same-session cross-turn exceptions because a
  child identity, not the parent turn, authorizes known updates. Anonymous
  starts can only add an over-protective slot and never authorize completion;
  different-session events are rejected.
- The queued suspension kill must recheck the protection marker and exact
  identity/intent conditions immediately before invoking PTY termination.
- `waiting`, `error`, and the terminal-error latch retain precedence over
  delayed completion-like events.
- Status remains in memory only. Layout persistence, session linking, PTY
  routing, and automatic suspension configuration are unchanged.
- Hook handlers remain non-blocking from Claude's perspective: all failure
  paths exit successfully and no hook output blocks or changes Claude's turn.
- The change is Claude-only. Existing Codex/OpenCode reducer behavior and hook
  sets must remain unchanged.

## Risks, Migration, and Rollback

- Older Claude versions may omit `prompt_id` from Notification payloads. Both
  ordinary and Escape idle_prompt recovery then remain protected because a
  session-only notification cannot be safely attributed to the current turn.
- A delayed notification can race with a new prompt. Turn identity matching,
  session checks, and the provider's input-idle timing are all required; a
  missing or conflicting identity must not clear the new turn.
- `stop_hook_active` and StopFailure field names can drift across provider
  versions. Defensive parsing must preserve safe status behavior even when
  detail is unavailable.
- The provider may continue to omit the completion hook entirely. This change
  promises eventual visible foreground recovery only through the provider idle
  notification, not immediate recovery or recovery when every provider signal
  is absent. Automatic suspension still waits for complete empty-work evidence.
- No persisted-data migration is required. Reverting the reducer and bundled
  hook asset restores the previous behavior; the managed hook configuration
  command remains stable and the materialized asset refresh is reversible.

## Handoff Checklist

- [x] Every requirement and scenario maps to a task and verification.
- [x] No task introduces a new product decision beyond the ready spec.
- [x] Both hook assets and their fixture coverage agree.
- [x] Turn/session identity and precedence guards cover delayed events.
- [x] Background work remains protected and is not redesigned here.
- [x] Codex/OpenCode behavior is unchanged.
- [x] Full project checks and any manual Claude limitation are recorded.
- [x] `review-plan` independently approved this plan before execution.

## Plan Review

Initial independent review: CHANGES REQUESTED. The blind reviewer identified
that Notification `idle_prompt` has no background work arrays, so the plan
needed to separate visible foreground idle from suspension eligibility; it also
required an explicit `stop_hook_active` truth table, direct suspension-policy
test coverage, the real renderer test seam, bounded StopFailure details, and a
clear host-versus-CI cross-platform limitation. The spec was reopened and
revised through brainstorm; this plan now incorporates those corrections and
must receive a fresh independent approval before execution.

Second independent review: CHANGES REQUESTED. The reviewer identified same-
session stale foreground events and the missing final pre-kill protection
recheck; those corrections are represented in T2/T3 and the cross-cutting
constraints.

Third independent review: CHANGES REQUESTED. The reviewer identified the
unsafe no-turn-id Escape exception and the need to make background start events
explicit cross-turn exceptions; the spec and plan were revised accordingly.

Final delta re-review: CHANGES REQUESTED. The reviewer found that the
cross-turn background-start exception lacked exact child/session guards and
reducer coverage. The current plan now defines same-session known-child
starts/completions, duplicate and different-session handling, and anonymous
over-protective slots with explicit tests. This re-review was not a fresh
independent reviewer because the collaboration thread limit prevented another
spawn; a final gate decision is still required.

Latest delta re-review: CHANGES REQUESTED. The reviewer required cross-turn
child events to preserve the newer foreground turn metadata and required
duplicate/out-of-order child starts to be idempotent after completion. The plan
now adds those invariants, a bounded in-memory completion tombstone set, and
the corresponding reducer sequences. This was a reassessment by an existing
reviewer, not a fresh independent spawn.

Final gate: APPROVED. The existing blind reviewer reassessed the current plan
after the latest corrections and found no blocking findings. The collaboration
thread limit prevented a fresh spawn for this final pass; the limitation is
recorded, and three earlier independent blind review passes supplied the
preceding findings that were repaired here.

Second independent review: CHANGES REQUESTED. The reviewer identified two
additional blocking gaps: same-session stale permission/error/tool events were
not covered by a general turn guard, and the queued suspension kill rechecked
only visible `idle` rather than the new protection marker. Those corrections
are now added to T2/T3 and their verification coverage; a fresh review is
required.

Third independent review: CHANGES REQUESTED. The reviewer identified that the
no-turn-id Escape exception could accept a delayed prior-turn notification
after a newer turn began, and that `bg_subagent_started` was not explicitly
covered by the turn guard. The spec was reopened and revised through
brainstorm to require turn identity for every idle_prompt recovery. The plan
now treats background start and completion as explicit child-lifecycle
exceptions and must receive a fresh approval.

Independent verification: CHANGES REQUESTED. The verifier found that cross-turn
child starts could overwrite foreground turn metadata, child completions lacked
an explicit same-session guard, Claude snapshots omitted identity, the stale-turn
guard was not provider-scoped, fresh `session_start` retained protection/tombstones,
and the composed hook-to-renderer test was missing. These findings were repaired
in the reducer, both hook assets, session-start reset path, and renderer test
suite; the Unix asset now also runs through the available Git Bash fixture.

Independent verification reassessment: PASS. The verifier confirmed the same-session
child guards, foreground metadata preservation, identity-bearing snapshots, exact
current-turn empty-work checks, Claude-only stale-turn handling, fresh-session reset,
and the composed hook -> report -> renderer -> reducer coverage. No blocking items
remain.

## Implementation Summary

Implemented the conservative Claude foreground recovery contract. `idle_prompt`
now carries `prompt_id` through both managed hook assets and can clear a matching
working foreground badge without inventing background-work evidence. The new
in-memory `suspensionBlocked` marker keeps automatic suspension fail-closed until
complete empty work evidence for the same session/turn arrives. Stop continuation,
stale foreground events, provider isolation, cross-turn child lifecycle delivery,
and bounded completion tombstones are covered. The report/IPC path remains the
existing single renderer reducer path, and the durable guardrail/docs now describe
the split visible-idle versus suspension-eligibility policy.

## Verification Evidence

Focused reducer, hook, report-server, renderer, and suspension tests pass. The
full unit/integration suite passes with 77 files and 852 tests. Typecheck, build,
and `git diff --check` pass. The host PowerShell fixture and the added Unix/Git
Bash parity fixture pass. `npm run test:e2e` completed 27/28; the only failure is
the unrelated existing browser-MCP tool-list ordering assertion at
`e2e/browserMcp.spec.ts:188`, reproduced in an isolated run. No live Claude turn
was available, so live provider verification is UNVERIFIED; current hook behavior
is fixture-verified and documented against the researched Claude hook contract.
