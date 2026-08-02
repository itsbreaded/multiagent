# Implementation Plan: Idle Default for New Agent Sessions

Plan Status: completed
Source spec: `specs/done/063-idle-default-for-new-agent-sessions.md` (Status: done)

## Verified Repository Facts

- `PaneLeaf.agentStatus` is renderer-only in-memory state. Layout serialization strips it,
  so startup restoration must seed it after sanitizing saved panes.
- `spawnPaneCore` already seeds newly spawned agent leaves with `idle` through
  `seedInitialAgentStatus`.
- `resumeSession` and `resumeSessionInNewTab` already seed their newly created agent leaves
  with `idle`.
- `applyLayout` seeds the ordinary restored-agent return path, but its recoverable pending,
  recovered-session, and failed-detection returns bypass that seed and can render a missing
  status as `unknown`.
- `resumeAgentPane` clears the PTY and starts resume without resetting `agentStatus`, so a
  prior working, waiting, error, or missing status can survive into the resumed session.
- `startNewAgentInPane` clears the prior session metadata and starts a new session without
  resetting `agentStatus`, so the prior session's status can survive into the replacement.
- `hydrateTabRuntime` resumes restored agent panes that have session identity and no PTY. It
  relies on the state produced by `applyLayout` and does not currently repair a missing
  status before runtime hydration.
- Cross-window and transfer entry points (`initDetached`, `receiveTab`, `syncDetachedTabs`,
  `addPaneToTab`, `insertPaneAtSplit`, and `replacePaneById`) can receive agent leaves whose
  renderer-only status was omitted from a transfer snapshot. They must preserve an explicit
  status and seed an absent one before the incoming pane is rendered.
- The current `seedInitialAgentStatus` helper is an absent-only seed: it preserves any
  existing status. Session replacement/resume needs a separate unconditional reset operation;
  changing the seed helper's existing-status behavior would violate transfer/layout
  preservation.
- `promoteShellPaneToAgent` intentionally seeds `working` from the synthetic `promote` event
  because it is based on an observed live CLI process; this is not a new-session default.
- `PaneHeader` and `Sidebar/TabSections` currently pass `pane.agentStatus?.status ??
  'unknown'` to `StatusDot`. This is the presentation fallback that can expose an absent
  initial state as `status-unknown`.
- `eventToState(undefined, { event: 'session_start' })` already produces `idle`, and fresh
  lifecycle events continue to drive the reducer after initialization.
- The disconnected projection in `StatusDot` is independent of lifecycle color and already
  takes precedence when an agent has no live PTY or has suspension/disconnection markers.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1-R4; new panes, new tabs, layout restore, startup hydration | T1, T3 | Store tests for creation/restore/hydration and UI fallback tests |
| R5-R6; replacement and explicit/automatic resume reset | T2, T3 | Store tests with stale working/waiting/error/missing state |
| R7; no missing initial status renders unknown | T1, T3 | PaneHeader and Sidebar assertions for missing agent status |
| R8-R9; fresh events and error clearing remain intact | T2, T3 | Existing reducer/event tests plus reset-before-event tests |
| R10; disconnected icon remains separate | T1, T3 | Existing 062 disconnected tests and status-without-PTY assertions |
| R11; shell and observed promotion unchanged | T2, T3 | Existing promotion/demotion tests and shell presentation tests |
| R12; every initial path is covered | T1, T2, T3 | Path matrix in store tests plus focused/full verification |
| Startup, explicit resume, new session, replacement, retry, and disconnected scenarios | T1-T3 | Given/When/Then cases represented by named regression tests |
| R2/R12; explicit resume into existing pane and new tab | T2, T3 | Deterministic tests for both `resumeSession` and `resumeSessionInNewTab`, asserting idle before resume IPC/hydration completes |
| R3; automatic resume | T2, T3 | Existing coordinator test file extended with an active-tab suspended-pane resume using fake timers and deferred `session:resume` IPC |

## Architecture and Data Flow

Agent lifecycle state is owned by the renderer's `usePanesStore` on each
`PaneLeaf`. New leaves are created by `spawnPaneCore` or the session-browser
resume actions. Saved layouts are sanitized by `applyLayout`; inactive restored
tabs are later runtime-hydrated by `hydrateTabRuntime`. Existing-pane resume
and replacement flows mutate the leaf in place before invoking the main-process
session operations. Hook and terminal-error events enter through the store and
are reduced by the shared `eventToState` function.

The invariant will be enforced at three boundaries:

1. Every store path that creates or reinitializes an agent session writes a
   fresh `idle` state, never retaining the old session's state.
2. Every saved-layout agent outcome that remains an agent is seeded before it
   becomes visible, including pending and failed recovery placeholders.
3. The two status presentation callers use `idle` when an agent status object
   is absent, so an uninitialized agent cannot expose an implementation-detail
   `unknown` badge. An explicit `unknown` state remains distinguishable for
   non-initial diagnostic behavior and remains protected by idle suspension.

The disconnected projection remains orthogonal: a no-PTY agent can have an
underlying `idle` state while `StatusDot` renders the hollow disconnected icon.

The implementation must keep two intentionally different operations distinct:

- An absent-only initial seeder (the existing `seedInitialAgentStatus`, or a
  clearly named replacement) is used by layout hydration and transfer/create
  boundaries. It preserves an explicit status, including `unknown`.
- An unconditional session-start reset (a new named helper) is used only when
  `resumeAgentPane` or `startNewAgentInPane` replaces/restarts the session. It
  deliberately replaces any prior status with fresh `idle` before async work.

## Implementation Tasks

### T1 - Enforce idle at all initial-state and presentation boundaries (completed)

- Dependencies: None.
- Requirements/scenarios: R1-R4, R7, R10, R12; new-pane, new-tab, saved-layout,
  pending-recovery, failed-recovery, inactive-tab, and no-PTY scenarios.
- Files and symbols:
  - `src/renderer/src/store/panes.ts`: absent-only `seedInitialAgentStatus` (or its clearly
    named equivalent),
    `hydrateTabRuntime`, every agent branch in `applyLayout`/`sanitizeNode`, and incoming
    tab/pane boundaries `initDetached`, `receiveTab`, `syncDetachedTabs`, `addPaneToTab`,
    `insertPaneAtSplit`, and `replacePaneById`.
  - `src/renderer/src/components/PaneHeader/index.tsx` and
    `src/renderer/src/components/Sidebar/TabSections.tsx`: status fallback passed to
    `StatusDot`.
  - `src/renderer/src/components/PaneHeader/StatusDot.tsx` and
    `src/shared/types.ts`: comments documenting the initial-state contract.
- Current behavior: ordinary creation and ordinary layout restore seed `idle`, but
  recoverable layout branches and cross-window/transfer snapshots can return an agent
  without a status object; both visual callers then pass `unknown` to `StatusDot`.
- Implementation change: keep the absent-only initial seeder unchanged in its core contract;
  make all layout branches that retain an agent pass through that boundary; seed absent status
  on incoming tab/pane boundaries without
  overwriting explicit status; ensure hydration cannot expose a missing initial state; change
  the agent-only presentation fallback to `idle`. Keep shell fallback and explicit status
  values unchanged. Update stale comments that describe missing hook events as the normal
  initial display.
- Invariants and edge cases:
  - Do not seed legacy unresumable agent records that are deliberately converted to shells.
  - Do not overwrite an explicit live status during hydration; repair only an absent initial
    status.
  - Keep the disconnected predicate and tooltip precedence unchanged.
  - Keep `unknown` available as an explicit state and continue treating it as protected by
    automatic suspension.
- Verification: add/extend store tests for ordinary agent creation and each retained-agent
  `applyLayout` outcome (normal saved session, recovered pending session, and failed/pending
  placeholder), plus `initDetached`, `receiveTab`, `syncDetachedTabs`, and incoming-pane
  insertion/replacement, asserting absent status becomes `idle` while explicit status is
  preserved. Add separate header/sidebar fixtures: missing status + live PTY produces the
  `Idle` tooltip/color; missing or idle status + no PTY produces the disconnected icon and
  `Disconnected` tooltip.
- Completion evidence: implemented absent-only seeding across layout, hydration, detached
  window, and incoming-pane boundaries; both shared status surfaces use idle for absent agent
  state. Focused store/component tests pass.

### T2 - Reset lifecycle state when an existing pane starts or resumes a session (completed)

- Dependencies: T1's initial-state helper/contract.
- Requirements/scenarios: R5-R6, R8-R9, R11; replacement, explicit resume, automatic
  resume, retry failure, fresh-event, promotion, and shell non-goal scenarios.
- Files and symbols:
  - `src/renderer/src/store/panes.ts`: `resumeAgentPane`, `startNewAgentInPane`, and the
    shared resume/new-session call boundaries (`resumeIntoPane`, `runNewAgentSession`).
  - `src/renderer/src/store/panes.test.ts`: existing resume/suspension and lifecycle tests.
- Current behavior: existing-pane resume and new-session replacement clear PTY/session
  metadata but leave `agentStatus` untouched. Automatic policy resume calls the same
  existing-pane resume action, so it inherits the stale state.
- Implementation change: add/use a distinct unconditional session-start reset helper that
  writes a fresh `idle` state atomically with the existing PTY/session reset before invoking
  resume or new-session work. Ensure every retry follows the same reset path and that failure
  metadata does not replace the idle lifecycle state. Do not weaken the absent-only seed
  helper or use it as a substitute for this reset.
- Invariants and edge cases:
  - Reset before any asynchronous IPC or spawn call so the UI cannot display the old
    session's status while the new session is disconnected.
  - Do not reset a shell pane or a shell-to-agent promotion; promotion remains a live
    `working` observation.
  - Preserve automatic resume de-duplication and suspension markers/metadata behavior.
  - A fresh lifecycle event may immediately replace `idle`; late events must continue to use
    the existing reducer semantics.
- Verification: add tests that plant stale working, waiting, error, and absent statuses,
  invoke existing-pane resume and new-session replacement, and assert idle immediately after
  the reset and after both success and failure. Add deterministic tests for both
  `resumeSession` and `resumeSessionInNewTab` with deferred resume IPC, asserting idle before
  hydration completes. Extend `src/renderer/src/store/idleAgentSuspension.test.ts` with an
  active-tab policy-suspended pane, fake timers, and deferred `session:resume` IPC; assert the
  coordinator starts exactly one resume and the pane is idle while it is in flight. Retain
  the current promotion test.
- Completion evidence: explicit and automatic resume plus new-session replacement reset to idle
  before async work; the in-flight guard is registered before that reset to prevent coordinator
  re-entry. Focused store and idle-policy tests pass.

### T3 - Complete behavioral regression matrix and update lifecycle documentation (completed)

- Dependencies: T1 and T2.
- Requirements/scenarios: R8-R12 and all remaining acceptance scenarios.
- Files and symbols:
  - `src/shared/agentStatus.ts` and `src/shared/agentStatus.test.ts`: comments and
    regression coverage for idle session-start semantics.
  - `docs/session-linking-hooks.md` and `docs/pty-and-terminals.md`: authoritative lifecycle
    badge descriptions that currently describe absent initial events as `unknown`.
  - `src/renderer/src/store/panes.test.ts`: cross-path state matrix, explicit resume variants,
    and incoming transfer boundaries.
  - `src/renderer/src/store/idleAgentSuspension.test.ts`: coordinator resume and explicit
    unknown protection.
  - `src/renderer/src/components/PaneHeader/index.test.tsx` and
    `src/renderer/src/components/Sidebar/TabSections.test.tsx`: both presentation surfaces.
  - `e2e/startup.spec.ts`: extend the existing inactive-tab hydration scenario only if a
    user-visible startup assertion can observe the idle/disconnected separation without
    weakening the existing 062 coverage.
- Current behavior: reducer semantics already seed idle on `session_start`, but comments and
  tests still describe an absent state as the normal cold-start rendering.
- Implementation change: align source comments and authoritative docs/tests with the new
  invariant and add a compact path
  matrix proving fresh events transition from idle to working/waiting/error/idle while the
  disconnected icon remains independent. Add explicit assertions that a live-PTY pane with
  status `unknown` still renders `Status unknown` and remains ineligible for idle suspension;
  test that explicit `unknown` survives `applyLayout` and at least one incoming transfer
  boundary, while the unconditional session reset intentionally replaces it with `idle`.
  Do not broaden the feature into event-reducer redesign or new provider behavior.
- Invariants and edge cases:
  - Explicit terminal error remains latched until the existing clear event/process-exit
    rules; a new session reset starts cleanly at idle.
  - The end-to-end test must not depend on timing-sensitive hook arrival to prove the default;
    use deterministic store/component tests for the core invariant.
  - Preserve ordinary shell status and all existing 061/062 policy and disconnected rules.
- Verification: focused Vitest suites, `npm run typecheck`, `npm run test`, `npm run build`,
  `npm run test:e2e`, and `git diff --check`; map each result to the spec matrix during
  verification.
- Completion evidence: reducer/source comments and authoritative lifecycle docs describe the
  idle default; focused/full tests, typecheck, build, startup E2E, and diff checks pass. No
  remaining agent presentation fallback uses unknown for an absent status.

## Cross-Cutting Constraints

- `agentStatus` is in-memory only; do not persist lifecycle state into layout files.
- The initial `idle` state is a logical lifecycle default, not evidence of a live PTY. Keep
  the 062 disconnected visual projection for no-PTY agents.
- Do not change the automatic suspension eligibility rule: only a connected, explicitly idle
  agent with exact session identity is eligible; unknown/missing status remains protected.
- Do not change provider launch commands, hook installation, session validation, or shell
  promotion/demotion behavior.
- Preserve atomic reset-before-async behavior and existing resume in-flight de-duplication.

## Risks, Migration, and Rollback

- Risk: a broad fallback change could hide a genuinely invalid explicit unknown state.
  Mitigation: only replace an absent status object with idle; preserve explicit `unknown` and
  its protected policy behavior.
- Risk: resetting status too late could briefly show stale working/error state.
  Mitigation: include the fresh idle state in the same synchronous metadata reset as PTY and
  session clearing.
- Risk: pending layout placeholders may be converted to shells accidentally while touching
  sanitization. Mitigation: preserve the existing recoverable-pending branches and test all
  retained-agent outcomes.
- Migration: no persisted schema migration is needed because lifecycle state is not saved;
  the next renderer initialization seeds the in-memory default.
- Rollback: revert the renderer store/component/comment/test changes; layout format and main
  process behavior are unchanged.

## Handoff Checklist

- [ ] Confirm implementation uses the ready spec as the only product contract.
- [ ] Confirm all retained-agent `applyLayout` branches seed idle.
- [ ] Confirm cross-window and incoming-pane boundaries seed only absent agent status.
- [ ] Confirm existing-pane resume and new-session replacement reset idle before async work.
- [ ] Keep absent-only seeding separate from unconditional session-start reset.
- [ ] Confirm both explicit resume actions and the automatic coordinator are tested before IPC resolves.
- [ ] Confirm both status surfaces use idle only for absent agent state.
- [ ] Confirm shell promotion remains working and shell panes are unchanged.
- [ ] Confirm disconnected icon remains independent of lifecycle idle.
- [ ] Add deterministic regression coverage for all path categories and failure/retry.
- [ ] Run the required focused and full verification commands.

## Plan Review

First blind review verdict: CHANGES REQUESTED.

Findings recorded from the independent repository pass:

- Blocking: explicit resume into an existing pane and a new tab were not named as
  deterministic tests, and automatic coordinator resume lacked a concrete test seam.
- Important: explicit `unknown` preservation/protection needed direct coverage; idle fallback
  and disconnected presentation needed separate fixtures; cross-window and incoming-pane
  boundaries needed explicit treatment.

Corrections made: T1 now covers all incoming tab/pane boundaries and separates live-PTY idle
presentation from no-PTY disconnected presentation; T2 names deterministic deferred-IPC tests
for `resumeSession`, `resumeSessionInNewTab`, and the fake-timer automatic-resume coordinator;
T3 adds explicit unknown presentation and eligibility assertions; the coverage table and
handoff checklist were expanded accordingly. A fresh blind re-review is required before
execution.

Second blind review verdict: CHANGES REQUESTED.

Findings recorded from the independent re-review:

- Blocking: the plan did not distinguish absent-only initial seeding from the unconditional
  reset required for a new or resumed session.
- Important: two authoritative lifecycle documents still described absent initial events as
  `unknown`, and explicit `unknown` needed boundary-preservation coverage in addition to UI
  and suspension tests.

Corrections made: the architecture section now defines separate absent-only and unconditional
reset contracts and T1/T2 name their distinct call-site responsibilities; T3 now includes
`docs/session-linking-hooks.md` and `docs/pty-and-terminals.md`, plus explicit layout/transfer
preservation and session-reset replacement assertions.

Final blind review verdict: APPROVED.

The reviewer confirmed the helper split, path coverage, deterministic test seams, authoritative
documentation scope, and absence of remaining blocking or important gaps. The review was
independent and performed against the current repository; no implementation or runtime
verification was part of this gate.

## Implementation Summary

Implemented requirements R1-R12. Added absent-only idle seeding for all retained agent entry
boundaries, unconditional idle reset for new/resumed sessions, idle presentation fallback,
explicit unknown preservation, and regression coverage. Preserved disconnected-icon, shell
promotion, reducer, and suspension eligibility semantics.

## Verification Evidence

Passed:

- Focused renderer/shared suites: 5 files, 114 tests.
- `npm run typecheck`.
- `npm run test`: 69 files, 749 tests.
- `npm run build`.
- `npx playwright test e2e/startup.spec.ts`: 21/21 passed, including startup hydration and
  automatic resume scenarios.
- Final `npm run test:e2e`: 26/26 passed. An earlier full run had one transient browser-MCP
  async-fixture timeout; the immediate rerun passed the same test and the complete suite.
- `git diff --check` (no whitespace errors).

### Requirement and Scenario Matrix

| Item | Verdict | Evidence |
| --- | --- | --- |
| R1-R4; creation, new tab, layout restore, hydration | PASS | `spawnPaneCore`, both session-browser constructors, `applyLayout`, and hydration seeding; `panes.test.ts` idle-entry tests; startup E2E 21/21. |
| R5-R6; replacement, explicit resume, automatic resume reset | PASS | Unconditional reset helper before async work; deferred IPC tests and fake-timer coordinator test. |
| R7; absent status never renders unknown | PASS | PaneHeader and Sidebar use idle fallback; both component tests assert `Idle`. |
| R8-R9; fresh transitions and error latch | PASS | `agentStatus.test.ts`, pane event tests, stale error replacement/retry tests. |
| R10; disconnected projection independent | PASS | StatusDot disconnected predicate and both component suites; startup inactive-tab E2E. |
| R11; shell behavior unchanged | PASS | Existing promotion/demotion tests assert observed `working` and shell preservation. |
| R12; all initial/transfer paths | PASS | Store tests cover layout, hydration, detached init, receive, sync, add, insert, replace, explicit resume variants, replacement, and automatic resume. |
| Acceptance scenarios: restore, create, explicit/automatic resume, replacement, retry failure | PASS | Deterministic store/component tests plus startup E2E. |
| Acceptance scenarios: event transitions, shell promotion, disconnected idle | PASS | Shared reducer/pane-event tests, promotion tests, both visual suites, and startup E2E. |
| Non-goals and resolved decisions | PASS | No reducer ordering, shell promotion, suspension eligibility, disconnected precedence, persistence schema, or future-provider state was changed; full test/type/build/E2E matrix is green. |

### Verification Limitations

No remaining behavior is unverified. The first full E2E invocation had a transient unrelated
browser-MCP timing failure; the final complete invocation passed 26/26, so it is recorded as a
recovered test-run flake rather than an outstanding limitation.
