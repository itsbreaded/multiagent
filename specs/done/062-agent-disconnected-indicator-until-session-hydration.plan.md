# Implementation Plan: Show Agent Disconnected State Until Session Hydration

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/pending/062-agent-disconnected-indicator-until-session-hydration.md` (Status: review)

## Verified Repository Facts

- `PaneLeaf` carries the live `ptyId`, in-memory `agentStatus`, explicit
  `agentDisconnected` metadata, and the policy `agentSuspension` marker.
- `applyLayout` strips stale PTY identity from restored leaves and
  `seedInitialAgentStatus` assigns an in-memory `idle` state to restored agent
  panes. This is why a restored inactive agent can currently have no PTY,
  `idle` status, and no disconnected marker at the same time.
- `hydrateTabRuntime` resumes agent leaves only when their tab is hydrated;
  `PaneGrid` does not mount unhydrated inactive tab pane content. The primary
  sidebar still renders inactive tab metadata and its leaves, so the sidebar
  is the observable surface for the startup/inactive-tab gap.
- `PaneHeader` and `Sidebar/TabSections` both render the shared `StatusDot`.
  Both call sites currently pass `disconnected` only for
  `agentDisconnected` or `agentSuspension`, not for an agent with no live
  `ptyId`.
- `StatusDot` already renders the required hollow grey circle and
  `Disconnected` tooltip when its `disconnected` prop is true. No new icon or
  text label is needed.
- Existing lifecycle and automatic-suspension eligibility already require a
  live PTY, so visualizing a no-PTY agent as disconnected will not make it
  eligible for suspension. The implementation must not alter
  `agentStatus`, `hydratedTabIds`, hydration, resume, or recovery transitions.
- Ordinary shell panes do not render `StatusDot` in either surface.

## Scope and Coverage

| Requirement / scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, R2, R6; S1, S5, S7 | T1 | Shared disconnected predicate feeds both existing `StatusDot` call sites; component tests and startup E2E assert no-PTY agent presentation. |
| R3; S2 | T1, T2 | No-PTY visual override is separate from `agentStatus`; test asserts seeded idle remains unchanged while tooltip is `Disconnected`. |
| R4; S3 | T1, T2, T3 | Live-PTY status remains normal in component tests; startup E2E activates the inactive tab and confirms normal hydration/resume behavior remains. |
| R5; S4 | T1, T2 | Existing recovery/resume state paths remain untouched; failure-marker and disconnected UI tests assert recoverable presentation. |
| R7; S6 | T2 | Shell-pane component tests continue to assert no agent status dot. |
| R8; S1, S7 | T3 | Cold-start layout fixture includes an agent in an inactive tab with no PTY and observes its sidebar tooltip before activation. |
| Non-goals and resolved decisions | T1–T3 | Diff inspection and regression suite verify no policy, hydration, shell, persistence, or dialog behavior changes. |

## Architecture and Data Flow

On restore, the renderer sanitizes every saved agent leaf to `ptyId: undefined`
and seeds its in-memory lifecycle status to `idle`. Only the active tab is
hydrated immediately; inactive tabs remain metadata-only until activation. The
primary sidebar renders those metadata-only agent leaves through
`TabSections -> StatusDot`, while hydrated pane content renders through
`PaneGrid -> PaneContainer -> PaneHeader -> StatusDot`.

The presentation decision should be centralized as the exact pure predicate
`isAgentPaneDisconnected(pane: Pick<PaneLeaf, 'paneType' | 'ptyId' |
'agentDisconnected' | 'agentSuspension'>): boolean` at the shared status-dot
boundary. A PTY is live only when `ptyId` is a non-empty, non-whitespace
string. The predicate is:

`agent pane && (no live ptyId || agentDisconnected || agentSuspension)`
  -> `StatusDot(disconnected=true)`

Otherwise, the existing `agentStatus` and detail are passed unchanged. The
predicate is visual-only. It must not write lifecycle state, mark a pane as
unexpectedly disconnected, invoke hydration/resume, or alter automatic idle
eligibility. A later PTY attachment naturally makes the predicate false and
restores the normal status dot.

## Implementation Tasks

### T1 - Centralize no-live-process agent presentation (completed)

- Dependencies: none; use the existing `StatusDot` API and `PaneLeaf` shape.
- Requirements/scenarios: R1–R6, S1–S5, S7.
- Files and symbols:
  - `src/renderer/src/components/PaneHeader/StatusDot.tsx` — add the exported
    `isAgentPaneDisconnected` predicate over the minimum `PaneLeaf` fields.
  - `src/renderer/src/components/PaneHeader/index.tsx` — pass the predicate's
    result to the existing `StatusDot` call.
  - `src/renderer/src/components/Sidebar/TabSections.tsx` — use the same
    predicate for sidebar rows.
- Current behavior: both surfaces mark only explicit unexpected-disconnect or
  policy-suspension metadata as disconnected; restored no-PTY agent leaves
  fall through to their seeded lifecycle status.
- Implementation change: treat an agent with no non-empty live `ptyId` as
  disconnected in addition to the two existing explicit markers. Keep the
  existing shared hollow-grey rendering and tooltip. Do not change shell
  branches or any store action.
- Invariants and edge cases:
  - `ptyId` must be treated as live only when it is a non-empty string.
  - Explicit markers remain disconnected even if a stale PTY value exists.
  - A live PTY with `idle`, `working`, `waiting`, or `error` continues to use
    the existing colored status dot and tooltip.
  - No call to hydration, resume, kill, recovery, or IPC may be introduced.
- Verification: add/update component tests in T2; inspect that the only
  behavior change is the `StatusDot` prop computation.
- Completion evidence: `isAgentPaneDisconnected` is shared by both call sites,
  no store or IPC lifecycle code changed, and no-PTY agent cases render
  `Disconnected`.

### T2 - Cover visual state transitions and shell isolation (completed)

- Dependencies: T1.
- Requirements/scenarios: R1–R7, S1–S6.
- Files and symbols:
  - `src/renderer/src/components/PaneHeader/index.test.tsx` — change the
    existing no-hook-event agent case to expect `Disconnected` when it has no
    PTY; add an explicit no-PTY pane with `agentStatus: { status: 'idle' }`
    asserting the lifecycle object remains idle, add a live-PTY idle case
    asserting `Idle`, and retain policy-suspended and shell coverage.
  - `src/renderer/src/components/Sidebar/TabSections.test.tsx` — add the same
    explicit seeded-idle/no-PTY case, a live-PTY status case, a stale-PTY
    explicit-marker case, and preserve shell/unexpected-disconnect coverage.
- Current behavior: the no-hook-event fixtures omit `ptyId` but expect the
  `Status unknown` tooltip, which encodes the bug for both visual surfaces.
- Implementation change: update those expectations to the new contract and
  add assertions that the pane's `agentStatus` object is unchanged by
  rendering and that `isIdleAgentSuspensionEligible` remains false without a
  live PTY. Assign a non-empty PTY ID to every existing working-status fixture
  so it continues to test the normal live-status branch. Parameterize the
  no-PTY predicate coverage across Claude, Codex, and OpenCode. Where
  practical, assert the rendered element has no forbidden `Offline`/
  `Disconnected` text label beyond its tooltip.
- Invariants and edge cases: policy-suspended and unexpected markers remain
  disconnected; a live PTY prevents the visual fallback; shell panes still
  render no status dot.
- Verification: run the two focused Vitest files and the full `npm run test`.
  Source-check `Terminal/index.tsx`'s existing error/recovery branches to
  confirm the visual prop does not open a dialog; record that as a regression
  check because this presentation-only change does not touch Terminal.
- Completion evidence: focused component tests pass (20 tests), covering
  seeded-idle/no-PTY, live-PTY, stale explicit markers, all three providers,
  and shell branches in both consumers.

### T3 - Add a cold-start inactive-tab acceptance check (completed)

- Dependencies: T1 and T2.
- Requirements/scenarios: R1, R2, R4, R5, R8; S1, S3, S7.
- Files and symbols:
  - `e2e/startup.spec.ts` — add a test fixture or test-local layout rewrite
    that gives an inactive saved tab an agent leaf with provider, cwd, and
    session identity but no `ptyId`; assert its sidebar status tooltip before
    activating the tab, then activate it and verify the existing hydration
    path remains usable.
  - Reuse the existing isolated Electron user-data setup and deterministic
    fake-agent command; do not change production startup or hydration behavior.
- Current behavior: the cold-start fixture restores tabs but does not include
  an inactive no-PTY agent leaf, so the exact user-visible gap is not covered
  end to end.
- Implementation change: add only the representative fixture/assertions. The
  test must expand the inactive tab's sidebar section by clicking its chevron
  toggle (not its title, which would activate the tab), prove the tab remains
  unhydrated while its metadata row is visibly disconnected, and then activate
  it to verify normal hydration remains usable.
- Invariants and edge cases: do not force inactive hydration solely for the
  test; avoid asserting a fixed PTY ID; preserve existing fixture teardown and
  unrelated startup checks.
- Verification: run the focused startup test, then `npm run test:e2e` (or
  rerun any unrelated flaky case individually and record it).
- Completion evidence: the focused real Electron acceptance test passes in
  4.5s; the sidebar shows `Disconnected` before activation and the inactive
  tab remains active-tab metadata until normal activation/hydration.

### T4 - Complete checks and handoff (completed)

- Dependencies: T1–T3.
- Requirements/scenarios: all requirements, scenarios, non-goals, and
  resolved decisions.
- Files and symbols: adjacent plan and spec lifecycle fields only; production
  code changes are complete before this task.
- Current behavior: the ready spec has no implementation evidence yet.
- Implementation change: record exact focused/full test results, typecheck,
  build, E2E results, any transient runtime limits, and the independent review
  verdict. Move the spec to `review` only after checks pass; `verify-spec` owns
  the final matrix and archive.
- Invariants and edge cases: do not mark the spec done from source inspection
  alone; distinguish transient unrelated E2E failures from feature evidence;
  preserve unrelated worktree changes.
- Verification: `npm run typecheck`, `npm run build`, `npm run test`, focused
  component tests, and `npm run test:e2e` where applicable.
- Completion evidence: T1–T3 are checked off, project checks are green, the
  plan records implementation evidence, and the source spec is `review` for
  independent verification.

## Cross-Cutting Constraints

- Keep the lifecycle default `agentStatus: idle` unchanged; visual connectivity
  is an independent projection of live PTY state.
- Do not introduce a second disconnected icon, text label, notification, or
  modal. Reuse `StatusDot`'s existing hollow-grey treatment and tooltip.
- Do not make no-PTY panes eligible for idle suspension or automatically resume
  them merely because they render disconnected.
- Do not hydrate inactive tabs earlier, mutate saved layout/session metadata,
  or change explicit resume, recovery, policy suspension, or shell behavior.
- Preserve the existing React/Zustand ownership model and avoid per-pane IPC or
  polling for a presentation-only decision.

## Risks, Migration, and Rollback

- Risk: a transient pre-PTY state during a normal new-session or resume flow
  may briefly show disconnected. This is intentional under the contract and
  disappears as soon as `ptyId` is attached; no recovery dialog is tied to the
  visual prop.
- Risk: a stale truthy PTY value could hide the fallback. Existing restore
  sanitation clears stale PTYs, and the predicate will require a non-empty
  string; explicit disconnected markers remain authoritative.
- Migration: none. No serialized shape, IPC channel, setting, or session data
  changes.
- Rollback: revert the shared predicate and the two call-site prop changes,
  plus their focused/E2E assertions. Existing lifecycle and suspension code is
  unaffected.
- Technical limitation: no dedicated detached-window E2E fixture is required
  for this presentation-only predicate. `App.tsx` renders the same
  `TabSections` component in detached and primary windows, and `TabSections`
  has no detached-mode branch around `StatusDot`; the shared component tests
  plus this source-path check cover both consumers. The inactive-primary-tab
  E2E specifically covers the startup metadata case.

## Handoff Checklist

- [x] Spec is `ready`, scoped to no-live-process agent presentation, and has no
  unresolved product questions.
- [x] Verified repository facts, exact boundaries, task ordering, invariants,
  tests, risks, and rollback are documented.
- [x] Every requirement and acceptance scenario has an implementation task and
  concrete verification.
- [x] Independent blind review has approved this plan.
- [x] No implementation has started before plan approval.

## Plan Review

`review-plan` first returned `CHANGES REQUESTED`. After the plan author added
explicit seeded-idle/no-PTY state and eligibility tests, live PTY IDs to
existing status fixtures, stale-marker and Claude/Codex/OpenCode coverage,
inactive-sidebar chevron expansion, the corrected detached-window rationale,
exact predicate semantics, and the review lifecycle gate, the same independent
reviewer returned `APPROVED` with no remaining blocking or important findings.
Manual limitation: the reviewer did not run tests or modify files.

## Implementation Summary

Implemented `isAgentPaneDisconnected` at the shared status-dot boundary and
used it in PaneHeader and Sidebar/TabSections. The predicate treats an agent
as visually disconnected when its PTY is absent/blank or either existing
disconnect marker is present; it does not mutate lifecycle state or invoke
hydration/resume. Added provider-parameterized seeded-idle/live-PTY/stale-marker/
whitespace component coverage and a cold-start inactive-tab Electron acceptance
test.

Checks completed:

- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run test` passed: 69 files, 736 tests.
- Focused PaneHeader/Sidebar tests passed: 22 tests.
- `npm run test:e2e` passed: 26 tests, including the new inactive-tab case and
  the existing idle suspension/resume scenario.
- `git diff --check` reported no whitespace errors.

Known limit: Terminal recovery/dialog behavior was source-checked and remains
unchanged; this presentation-only change does not add a Terminal test seam.

## Verification Evidence

The fresh blind requirements/scenario pass found no product contradiction. It
requested stronger explicit evidence for seeded idle, whitespace PTYs, visible
text labels, and the shared detached-window path; those are covered by the
component tests and source checks recorded below. It did not modify files or
run commands, so its findings are treated as review input rather than test
evidence.

### Requirement matrix

| Item | Verdict | Evidence |
| --- | --- | --- |
| R1 | PASS | `isAgentPaneDisconnected` is used by both PaneHeader and Sidebar/TabSections; component tests cover no-PTY agents, and the full Electron acceptance test shows the inactive-tab sidebar state. An unhydrated inactive pane has no mounted header; the header branch is covered once the pane mounts. |
| R2 | PASS | Existing `StatusDot` supplies the hollow grey circle and `Disconnected` title; focused tests assert the title and assert no visible `Disconnected` text node. |
| R3 | PASS | Seeded `agentStatus: idle` remains unchanged in both component suites; `isIdleAgentSuspensionEligible` is false without a live PTY; no store/lifecycle mutation is present in the predicate. |
| R4 | PASS | Live-PTY idle tests assert the normal `Idle` dot; the E2E test activates the previously inactive tab and observes a PTY attachment. Existing startup, explicit-resume, and new-session paths are unchanged and covered by the full regression suite. |
| R5 | PASS | The visual predicate does not open dialogs, resume, or mutate recovery state. `Terminal/index.tsx` source inspection confirms recovery actions remain tied to existing error metadata; full unit/E2E regression checks pass. |
| R6 | PASS | Explicit `agentDisconnected`, policy `agentSuspension`, and stale-PTY policy-marker cases all render the same shared disconnected indicator; the prior intentional/unexpected lifecycle tests remain green. |
| R7 | PASS | Shell branches do not render `StatusDot`; focused shell tests pass, and no hydration/store/PTY behavior was changed. |
| R8 | PASS | The real cold-start E2E fixture shows an inactive saved agent row as disconnected without activating it, then confirms activation attaches the session; the shared predicate applies to every agent row. |

### Acceptance scenario matrix

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| S1 | PASS | 26-test Electron suite, including `shows an inactive unhydrated agent as disconnected until its tab is activated`. |
| S2 | PASS | PaneHeader and Sidebar tests assert seeded idle remains idle and visual output is `Disconnected`; eligibility remains false without PTY. |
| S3 | PASS | Focused Electron acceptance test observes Beta's PTY after activation; live-PTY component tests assert normal status presentation. |
| S4 | PASS | Visual predicate has no recovery/resume side effects; existing Terminal error/recovery path is source-checked and regression suite is green. |
| S5 | PASS | Explicit unexpected-disconnect, policy-suspension, and stale-PTY marker component cases use the same `Disconnected` tooltip. |
| S6 | PASS | Shell component tests continue to assert no status dot. |
| S7 | PASS | Cold-start E2E restores active and inactive tab metadata, asserts inactive no-PTY agent presentation, and confirms inactive tab remains unactivated until selected. |

### Non-goals and decisions

- NG1–NG6: PASS. The diff changes only the shared visual predicate, its two
  consumers, focused tests, and the startup acceptance fixture; it does not
  alter suspension settings/rules, hydration timing, shell behavior, saved
  session data, or introduce labels/dialogs.
- D1: PASS. Lifecycle `idle` remains in-memory and independent from the visual
  disconnected projection, proven by seeded-idle tests.
- D2: PASS. Scope covers both existing visual consumers and all supported agent
  kinds; ordinary shells remain excluded.
- D3: PASS. Existing hydration, resume, recovery, and suspension paths were
  not changed; the full unit and Electron suites remain green.
- D4: PASS. The existing shared hollow-grey circle and `Disconnected` tooltip
  are reused without a new label or icon.
- Dependency `automatic-idle-agent-session-suspension-and-resume`: PASS. The
  archived dependency spec and implementation already require live PTYs for
  suspension and retain explicit marker/recovery distinctions; this change
  only projects the no-PTY state visually.
- No open questions remain.

### Commands and runtime limits

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run test`: PASS, 69 files and 736 tests.
- Focused PaneHeader/Sidebar tests: PASS, 22 tests.
- `npm run test:e2e`: PASS, 26 tests, including the new inactive-tab case.
- `git diff --check`: PASS; only line-ending normalization warnings were
  reported. No debug/TODO markers were found in changed feature paths.
- Manual/runtime limit: no separate detached-window E2E was added. `App.tsx`
  renders the same `TabSections` component in detached and primary windows,
  and the component has no detached-specific status branch; this shared path
  was source-checked and covered by the component tests.
- Autonomous repair during verification: added explicit empty/whitespace PTY
  tests and mandatory no-visible-text assertions after the blind pass called
  out those evidence gaps; the affected and full unit suites were rerun.
