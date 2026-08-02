# Implementation Plan: Automatic Idle Agent Session Suspension and Seamless Resume

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/pending/061-automatic-idle-agent-session-suspension-and-resume.md` (Status: review)

## Current contract and repository evidence

- The spec is `review`; this plan is the only execution/resume artifact. The
  spec itself remains read-only except for its eventual verification transition.
- `PaneLeaf` already persists provider, `cwd`, `sessionId`, layout identity,
  and recovery metadata. `agentStatus` is intentionally in-memory and is
  stripped from layout persistence.
- `pty:kill` is already an invoke channel and the existing `pty:exit` path
  drives unexpected-disconnect recovery. Policy suspension must mark intent
  before ending the PTY so that exit handling cannot misclassify it.
- `hydrateTabRuntime` resumes saved agent panes when a tab is hydrated, and
  `window:became-active`/`activeWindowId` already provide the cross-window OS
  focus signal. Detached renderers own their live tab runtime while the
  primary renderer keeps synchronized metadata copies.
- Settings are persisted in the renderer settings store/localStorage and the
  main process already broadcasts cross-window events. The new policy will
  use the same persistence convention plus a main-mediated live change event
  so all owning renderers reevaluate open tabs immediately.

## State model and invariants

1. Add a serialized `agentSuspension` marker to `PaneLeaf` with the policy
   reason and timestamp (not a new session type). It is present only after a
   policy suspension and remains alongside `agentKind`, `sessionId`, `cwd`,
   transcript/layout metadata, and any resume error. It is cleared only when
   that pane successfully resumes, starts a replacement session, or closes.
2. A pane is policy-eligible for suspension only when it is an agent, has a
   supported provider, has a live `ptyId`, has the exact identity tuple
   `(agentKind, sessionId, cwd)`, and its current `agentStatus.status` is
   exactly `idle`. `working`, `waiting`, `error`, `unknown`, missing status,
   missing identity, and already-no-PTY panes are protected from another
   suspension attempt. New and restored live panes are seeded to in-memory
   `idle`; the first protected lifecycle event immediately replaces that seed.
3. Track inactivity per owning tab, not per pane or globally. A tab is
   unfocused when it is not the owning renderer's active tab or its renderer's
   `activeWindowId` is another OS window. Do not evaluate synchronized detached
   copies in the primary renderer. The first observed state is a baseline when
   prior focus is unavailable; known prior inactivity is retained across
   policy setting changes.
4. Policy suspension is a distinct persisted intent from `agentDisconnected`.
   The transition is guarded per pane: persist the policy marker while the
   live `ptyId` and exact identity are still present, then issue `pty:kill`.
   The `pty:exit` handler must consume that marker whether the exit arrives
   before or after the kill invoke resolves, clear the live `ptyId`, and never
   create unexpected-disconnect recovery for that intentional exit. A failed
   attempt rolls back the marker or leaves the live pane intact and records no
   automatic retry.
5. Automatic resume is allowed only for policy-marked panes in an eligible
   active tab whose owning window is OS-focused. Startup/hydration must skip
   every policy-marked no-PTY pane unless it is in the active tab; unexpected
   no-PTY panes keep the existing recovery path. One in-flight promise per
   pane prevents duplicate resumes; once started, it is allowed to finish even
   if focus leaves. A failed resume retains the marker, the exact identity
   tuple, pane/layout, and recoverable existing error actions.

## Dependency-ordered tasks

| Status | Requirements / scenarios | Files or subsystem | Isolated verification |
| --- | --- | --- | --- |
| completed | 1-2, 22; disabled default, 30-minute default, minute-range sanitization | `src/renderer/src/store/settings.ts`, shared settings constants/types | Unit tests for missing, malformed, non-finite, fractional, below-minimum, above-maximum, and valid persisted values |
| completed | 3; live setting changes and known-inactivity semantics | settings store, main IPC registration, `src/shared/types.ts`, settings IPC listener | Store/coordinator and main broadcast implementation; coordinator reevaluates on settings changes |
| completed | settings UI for 1-2 | `src/renderer/src/components/SettingsPanel/settings/`, settings panel index/search | Component test toggles opt-in and edits a whole-minute timeout, asserting clamping and persisted store actions |
| completed | 4-5; owning-window/tab focus and independent timers | pure eligibility module plus `panes.ts` coordinator | Fake-clock tests cover active tab, inactive tab, detached ownership, unknown OS focus baseline, and independent tab clocks |
| completed | 6, 7; exact eligibility and protected statuses | coordinator, `shared/agentStatus.ts`, pane status updates | Eligibility decision tests require live PTY, exact identity, and explicit idle; protected statuses cannot qualify |
| completed | 8-10; current status, protected-to-idle reevaluation, initial idle seed | pane creation/restoration/hydration and lifecycle event reducer/store | Initial idle seeding and live lifecycle updates feed the coordinator; protected-to-idle updates trigger reevaluation |
| completed | 11-13; graceful resumable end and metadata/layout preservation | pane store, existing `pty:kill` path, layout normalization/save | Policy-kill race tests prove marker-before-kill, both exit orderings, and metadata retention |
| completed | 14-15; silent normal startup/resume presentation | `Terminal`, `PaneHeader`, automatic-resume path | Policy panes use startup/resume rendering and bypass the unexpected-disconnect modal |
| completed | 16-18, 26; activation/focus resume, grouping, de-duplication | coordinator, tab activation, OS-focus IPC, resume helper | Grouped `Promise.all` resume and per-pane in-flight guard are covered by store tests and the acceptance e2e |
| completed | 19, 23; recoverable failure and no disruptive retry loop | resume helper and terminal recovery UI | Retry-resume action added; failed automatic suspension clears intent and is blocked from repeated retries until return/focus |
| completed | 20-21, 24; unexpected exit distinction, disable semantics, missing identity | `panes.ts`, pane actions, settings transition logic | Policy-marked exits remain intentional; ordinary exits retain recovery; missing identity never qualifies |
| completed | 25; shared hollow-grey disconnected indicator and tooltip | `PaneHeader/StatusDot`, `PaneHeader`, `Sidebar/TabSections`, terminal presentation | Component tests assert hollow grey circle + `Disconnected` tooltip for policy and unexpected no-PTY states |
| completed | 27-28; startup active-tab-only resume and non-staggered grouping | `App.tsx`, `hydrateTabRuntime`, activation path, e2e fixtures | Hydration skips policy markers; active returned tab resumes together without artificial staggering |
| completed | end-to-end actual process lifecycle scenario | `e2e/startup.spec.ts` and existing fake Claude fixture | Acceptance e2e observed original PTY suspension and exact-session resume with a new PTY |

## Planned implementation boundaries

- Keep eligibility and identity rules in a pure helper module. The renderer
  store owns state mutation and persistence; the coordinator owns the one-second
  scheduling loop and in-flight guards. Pure eligibility/focus tests use fixed
  snapshots, while the coordinator test uses fake timers.
- Reuse `resumeIntoPane` and the existing validation/recovery actions instead
  of creating a second resume implementation. Add an automatic-resume wrapper
  that checks policy ownership/focus and shares the existing per-pane guard.
- Extend existing pane IPC exit handling rather than adding a second PTY exit
  listener. An expected policy exit must never set `agentDisconnected`; an
  unexpected exit must retain its current recovery behavior.
- Make the startup distinction explicit in `hydrateTabRuntime`: policy-marked
  no-PTY panes are not resumed by generic hydration; only the active-tab
  startup/activation path invokes grouped automatic resume. Existing
  unexpected-disconnect panes retain their current recovery semantics.
- Treat exact identity as the provider/agent kind, non-empty `sessionId`, and
  `cwd` together. Automatic actions must validate the same tuple they preserve
  and resume; no replacement session may be inferred from transcript data.
- Thread a no-live-PTY/disconnected presentation signal into the shared
  `StatusDot` call sites in both the pane header and sidebar. Lifecycle
  `unknown` must not be used as a substitute for the required hollow grey
  disconnected icon.
- Use the existing cross-window focus broadcasts and tab ownership metadata.
  The primary's synchronized detached-tab copy is not a second scheduler.
- Do not add notifications, session deletion, ordinary-shell handling,
  per-pane exemptions, staggered work, or provider-specific policy behavior.

## Handoff Checklist

- [x] State model, ownership boundary, kill/exit race handling, startup
  hydration ordering, and test strategy are described.
- [x] Every task is completed with concrete evidence in the task table below.
- [x] Project checks and required runtime/e2e checks are green; the full e2e
  runs had only transient browser-MCP/SQLite fixture failures, and every failed
  test passed on an individual rerun. The feature acceptance e2e passed.
- [x] Independent verification has recorded a complete PASS matrix below.

## Plan Review

Delegated reviewer `019fc0d5-34c2-74f0-b6fe-2b6e41f96463` reviewed the amended
plan after the five identified corrections were applied and returned explicit
`GO-AHEAD`; it identified no remaining essential correction. The corrections
were: require a live PTY for suspension, persist intent before `pty:kill`, make
`pty:exit` consume the marker in either ordering, skip marked panes during
generic hydration except for the active-tab path, preserve exact identity
`(agentKind, sessionId, cwd)`, and thread the disconnected-dot prop through
header/sidebar call sites.

## Implementation Summary

Implementation is complete and the source spec is ready for independent
verification. The implementation covers opt-in persisted settings, cross-window
policy updates, tab/window ownership and independent inactivity clocks, exact
idle eligibility, policy markers with kill/exit race handling, grouped focus
resume, startup hydration protection, recoverable resume failure, and the shared
hollow-grey disconnected indicator.

Focused evidence:

- Shared normalization, pure eligibility/focus/grouping, settings UI, pane
  header/sidebar status, and pane-store race/duplicate-resume tests pass.
- `npm run typecheck`, `npm run build`, and `npm run test` pass (69 files, 725
  tests on the completed full run).
- The new startup acceptance e2e passes: it observes a policy-marked original
  PTY disappear while preserving the exact session identity, then observes a
  different PTY after returning to the tab. The two initially flaky unrelated
  e2e cases also pass on individual reruns.

Remaining independent-verification scope: audit the complete requirements and
scenario matrix, especially detached-window ownership and any provider-specific
PTY lifecycle assumptions, before archiving the spec.

## Verification Evidence

The blind delegated pass by `019fc0ef-01d7-7463-b004-69e2763e6a92` found no
implementation failure because it was intentionally given only the contract and
plan; it correctly identified that this evidence section and the independent
matrix were still required. Its concerns about seeding, intentional-exit races,
disable semantics, startup focus, normalization, and identity are resolved by
the spec's resolved decisions plus the source checks below. No open question
remains in the spec.

### Requirements

| Item | Verdict | Evidence |
| --- | --- | --- |
| R1 | PASS | `DEFAULT_IDLE_AGENT_SUSPENSION` is disabled; settings store/localStorage and main JSON persistence wire the opt-in setting; shared normalization tests pass. |
| R2 | PASS | Shared constants enforce shipped 30-minute default and 1–1,440 whole-minute range; `idle agent suspension settings` tests and Settings UI test pass. |
| R3 | PASS | Settings store subscription reevaluates the live coordinator; main IPC broadcasts `settings:idle-agent-suspension-changed`; coordinator test and acceptance e2e exercise live policy use. |
| R4 | PASS | `isTabFocused` checks active tab plus `activeWindowId`; coordinator skips primary copies of detached tabs; focused/unfocused and detached branches are covered by helper/coordinator tests and source inspection. |
| R5 | PASS | `tabUnfocusedSince` is keyed by tab ID and is cleared only for the focused tab; coordinator uses independent tab iteration. |
| R6 | PASS | `isIdleAgentSuspensionEligible` requires enabled policy at evaluation, elapsed owning-tab timeout, explicit `idle`, supported provider, exact identity, and live PTY; parameterized Claude/Codex/OpenCode helper tests pass. |
| R7 | PASS | Eligibility is equality to `agentStatus.status === 'idle'`, so working, waiting, error, unknown, and missing states are protected; lifecycle reducer source inspection confirms updates replace the seed. |
| R8 | PASS | No transcript/output/terminal-quiet signal participates in eligibility; only current in-memory lifecycle state is read. |
| R9 | PASS | Pane Zustand subscription reevaluates on lifecycle/tab changes, and the coordinator scans protected panes on every tick without requiring tab activation. |
| R10 | PASS | `seedInitialAgentStatus` seeds new/restored panes to idle and existing lifecycle events overwrite it; pane-store lifecycle tests pass. |
| R11 | PASS | Policy intent is written before existing `pty:kill`; the real startup acceptance e2e observes the original process ending, a responsive retained pane, and a resumable exact session. |
| R12 | PASS | `agentSuspension` is serialized on the existing leaf; kill/exit race test and acceptance e2e retain pane identity/layout/session metadata. |
| R13 | PASS | Suspension only patches marker/status/PTY metadata; no session, transcript, tab, or pane deletion path is called. |
| R14 | PASS | Policy exit clears disconnect state and uses no notification/modal path; acceptance e2e returns without the disconnected dialog. |
| R15 | PASS | Policy-marked panes skip generic hydration, use normal resume rendering, and do not set `agentDisconnected`; Terminal/PaneHeader tests and acceptance e2e pass. |
| R16 | PASS | Focused-tab/window coordinator collects all policy-marked panes and launches grouped resumes; acceptance e2e covers tab return and main focus IPC wiring covers window regain. |
| R17 | PASS | Resume branch requires `isTabFocused(...) === true`; inactive policy-marked panes are skipped on every evaluation. |
| R18 | PASS | `automaticResumeInFlight` deduplicates pane resumes; `deduplicates resume attempts and clears policy intent only after success` passes. |
| R19 | PASS | `resumeAgentPane` retains marker/identity on failure and Terminal exposes retry, repair, new-session, and close actions; recovery path is source-verified and existing terminal recovery tests remain green. |
| R20 | PASS | `markPtyExited` only suppresses disconnect recovery when the policy marker exists; ordinary exit handling remains unchanged and pane-store tests pass. |
| R21 | PASS | Disabled policy gates only new suspension; the focused resume branch does not require `policy.enabled`, preserving automatic return for already marked panes. |
| R22 | PASS | Main and renderer both normalize malformed, missing, non-finite, fractional, and out-of-range settings; shared normalization tests pass. |
| R23 | PASS | Kill failure rolls back intent for a still-live PTY and records `automaticSuspensionFailed` to prevent a retry loop; stale-exit ordering is guarded by the marker test and source inspection. |
| R24 | PASS | Exact identity helper rejects absent/blank session ID or cwd before any suspension attempt. |
| R25 | PASS | Shared `StatusDot` renders hollow grey with `Disconnected`; PaneHeader and Sidebar tests cover intentional and unexpected no-PTY presentation. |
| R26 | PASS | Returned-tab path uses one `Promise.all` over every exact-identity policy pane; collection and grouped-resume tests pass. |
| R27 | PASS | `hydrateTabRuntime` skips policy markers; App starts the coordinator after layout restore, whose initial focused-tab pass resumes only the active tab. |
| R28 | PASS | Suspension loops all eligible leaves in one evaluation and resume uses one `Promise.all`, with no stagger timer or delay. |

### Acceptance scenarios

| Scenarios | Verdict | Evidence |
| --- | --- | --- |
| S1–S3 | PASS | Policy gate, all three provider eligibility, and live suspension are covered by shared/provider tests, coordinator test, and the real Claude acceptance e2e. |
| S4–S8 | PASS | Current-state equality, missing/unknown protection, protected-to-idle reevaluation, and missing identity are implemented in the pure predicate/coordinator and pane lifecycle source paths; full unit suite is green. |
| S9–S11 | PASS | Live setting subscription, timeout arithmetic, focus reset, and per-tab inactivity map are covered by coordinator tests and source inspection. |
| S12–S13 | PASS | Detached ownership branch and OS focus comparison are covered by the helper/coordinator tests and existing cross-window focus IPC path. |
| S14–S18 | PASS | Startup/resume presentation, active-window return, inactive-tab protection, deduplication, and grouped resume are covered by pane-store tests, UI tests, and acceptance e2e. |
| S19–S20 | PASS | Startup active-tab-only hydration is source-verified; resume failure keeps the marker and existing Terminal recovery actions. |
| S21–S22 | PASS | Unexpected exit preserves recovery; both no-PTY states render the shared hollow-grey icon and tooltip in PaneHeader/Sidebar tests. |
| S23 | PASS | Initial idle seeding and immediate protected lifecycle overwrite are source-verified and covered by pane lifecycle tests. |
| S24 | PASS | Real Electron acceptance e2e starts the fake external Claude, observes original PTY termination, preserves the pane, and observes a different PTY for the same session after return. |

### Non-goals, dependencies, and checks

- NG1–NG7: PASS. No deletion, ordinary-shell scheduling, quietness/process-age
  heuristic, per-pane scheduler, identity-less resume, notification, or
  unrelated manual workflow change was added; the changed files and coordinator
  boundaries were inspected.
- D1–D5: PASS. Existing `pty:kill`/`pty:exit`, `resumeIntoPane`, provider
  session spawn/resume, settings persistence/IPC, and cross-window focus wiring
  are present and reused by the feature.
- Commands: `npm run typecheck` PASS; `npm run build` PASS; `npm run test` PASS
  (69 files, 727 tests); focused idle-suspension test PASS (6 tests); feature
  acceptance e2e PASS; full e2e runs were 22/24 and 24/25 due to transient
  unrelated browser-MCP/SQLite fixture failures, and each failed case passed
  on its individual rerun. `git diff --check` reported no whitespace errors.
- Autonomous repair: expanded the provider eligibility test to parameterize
  Claude, Codex, and OpenCode after the blind review identified provider
  coverage as an evidence gap; affected and full unit suites were rerun.
- Runtime limit: no dedicated multi-detached-window acceptance fixture exists;
  detached ownership, OS focus, and duplicate-scheduler prevention are
  source-verified and unit-tested. Provider lifecycle dispatch is shared and
  parameterized at the eligibility boundary; the end-to-end fixture is Claude.
