# Implementation Plan: Recoverable terminal-host failures and stale PTY state

Plan Status: completed
Source spec: `specs/done/064-pty-host-failure-recovery.md` (Status: done)

## Verified Repository Facts

- `src/main/pty/PtyManager.ts` owns one Electron-run-as-Node `ptyWorker` child,
  tracks deferred spawns in `pendingSpawns`, live identifiers in `spawnedIds`,
  readiness in `readyIds`/`readyEvents`, and currently latches `workerDead` after
  one unexpected worker failure. Its current post-failure `createDeferred` path
  returns a random identifier and emits an error later, which is the stale-ID
  bug this work closes.
- `src/main/pty/ptyWorker.ts` has no host-ready message; it only reports
  per-PTY `ready`, `data`, `exit`, and `error` messages. A replacement-worker
  lifecycle therefore needs a host-level readiness handshake separate from
  per-PTY readiness.
- `src/main/sessions/SessionSpawner.ts` uses `createDeferred(..., deferSpawn =
  true)` for both new and resumed agents, while `PtyManager.createShell()` uses
  the same manager for shells. The renderer receives a PTY id before the
  deferred agent process is necessarily spawned.
- `src/main/ipc/handlers.ts` constructs the singleton manager, routes returned
  ids through `WindowManager`, registers `session:new`, `session:resume`, and
  `pty:create`, and currently has no host-wide lifecycle IPC. The output router
  releases routes for ordinary `pty:exit` but has no host-failure cleanup path.
- `src/shared/types.ts` is the IPC source of truth. It currently models
  per-PTY events but has no terminal-host status contract and no application
  restart invoke channel.
- `src/renderer/src/store/panes.ts` strips saved PTY ids during
  `applyLayout()`, preserves known agent session identity, and has separate
  `resumeAgentPane()`/`runNewAgentSession()` flows. `markPtyExited()` only
  handles agent leaves, so shell leaves can retain stale ids after a host-wide
  crash.
- `src/renderer/src/store/panesIpc.ts` is the one-time renderer listener module
  for `pty:exit` and session events. It is the correct bridge for host status,
  but primary and detached renderers must not both start recovery for the same
  pane.
- `src/renderer/src/components/Terminal/index.tsx` creates shells whenever a
  shell has no `ptyId`, displays connecting/error states, and resumes agents
  through pane state. It currently has no host-unavailable gate, so a cleared
  shell id could immediately issue a new create request while recovery is
  unresolved.
- `src/main/index.ts` already performs an authoritative layout save in the
  normal close path and has the application shutdown guard. A restart action
  must use this existing shutdown path rather than bypassing it.
- Existing focused coverage is in
  `src/main/pty/PtyManager.crash.test.ts`,
  `src/main/ipc/ptyOutputRouter.test.ts`,
  `src/shared/paneTree.test.ts`,
  `src/renderer/src/store/panes.test.ts`,
  `src/renderer/src/components/Terminal/createShellPty.test.ts`, and
  `e2e/startup.spec.ts`. The E2E harness already tests a missing worker and
  has app-close/relaunch helpers.

## Scope and Coverage

| Spec requirement/scenario | Implementation tasks | Verification |
|---|---|---|
| 1, 12, 13; duplicate worker events; clean shutdown | T1 host lifecycle state machine and incident logging | `PtyManager.crash.test.ts` lifecycle, deduplication, startup failure, clean destroy, log assertions |
| 2, 3; active/deferred/post-failure launches | T1 affected-id snapshot; T2 typed bridge, route release, availability gate | manager unit tests; handler/bridge tests; renderer tree/store tests |
| 4, 5, 7; successful recovery | T3 incident-scoped pane transition and owner-only retry; T4 terminal gating | pane-tree/store tests; focused renderer tests; E2E recovery scenario |
| 6; new launch without established identity | T1 purpose metadata; T3 clear unready new-agent identity/marker | pane-store tests for Claude/Codex-like pending launches; restart sanitization test |
| 8; restart-safe layout | T3 runtime-marker sanitization and existing no-PTY persistence path; T5 docs/regression coverage | store/layout tests and E2E restart-safe assertion |
| 9, 10; global status, failed recovery, actionable resume | T2 status IPC/restart action; T4 global banner and per-pane states | component tests; handler contract tests; E2E failed-recovery UI check |
| 11; primary/detached convergence | T2 broadcast/status-on-window-load; T3 runtime ownership and sync-safe updates | store ownership tests; detached-window E2E scenario |

## Architecture and Data Flow

1. `PtyManager` will model the worker host as `starting`, `ready`,
   `recovering`, `failed`, or `destroying`, and bind every child-process
   listener to a generation token. The first unexpected error/exit for a
   generation creates one incident, snapshots pending and spawned PTY ids,
   clears all old runtime bookkeeping, emits the existing per-PTY failure
   signals, and starts exactly one replacement worker. A replacement worker
   must send a host-ready message before it is considered usable. Existing
   processes are never reattached; recovery only restores the host.
2. Each deferred request carries a low-level purpose (`shell`, `new-agent`, or
   `resume-agent`). The host-failure payload includes affected ids, ids that
   were not ready when the host failed, and the subset of unready new-agent
   ids. This lets the renderer discard only unproven new-session metadata while
   preserving a known session id for a failed resume or established agent. An
   affected new-agent pane that has no confirmed session id remains an explicit
   start-new placeholder even when its PTY had reached `ready`;
   `unreadyNewPtyIds` specifically identifies the speculative launch-time
   identity that must be cleared.
3. Main handlers wait for host availability before accepting new shell/new
   agent/resume requests. If recovery is in progress, the request is held
   until the replacement host is ready; if recovery has failed, it rejects
   without allocating or returning a PTY id. Main releases all affected
   routes/buffers and broadcasts the typed host status to every window.
4. The renderer applies one incident-scoped, pure pane-tree transition. Every
   affected id is cleared from shell and agent leaves. Known agent metadata is
   retained and marked for resume; shells are marked for recreation; an
   unready new-agent launch loses its speculative id/detection state and stays
   an explicit start-new placeholder. Only the renderer that owns a runtime
   tab performs the automatic retry after host recovery. The incident marker
   and existing in-flight guards make duplicate events or retries no-ops.
5. A small global Zustand host-status store drives a banner in every renderer.
   During recovery it explains that terminals are being restored; after a
   failed attempt it stops per-pane connecting loops and exposes one explicit
   restart action. The restart invoke uses Electron's normal `app.relaunch()` /
   `app.quit()` path, allowing the existing authoritative shutdown save to
   preserve restart-safe pane metadata.

## Implementation Tasks

### T1. Make the PTY worker host recoverable and fail closed

Status: complete.

- Dependencies: none.
- Requirements/scenarios: 1, 2, 3, 4, 5, 6, 7, 12, 13; active-host crash,
  deferred launch, post-failure launch, startup failure, duplicate event, and
  clean-shutdown scenarios.
- Files and symbols:
  - `src/main/pty/PtyManager.ts` — `PtyManager`, worker binding, crash fanout,
    `createDeferred`, `_spawn`, `resize`, `kill`, `destroy`.
  - `src/main/pty/ptyWorker.ts` — `ParentMessage` and startup handshake.
  - `src/main/pty/PtyManager.crash.test.ts` — replace the one-worker fake
    assumptions with a controllable worker-factory fake.
- Current behavior: the manager permanently latches `workerDead`; it returns
  a fresh id after failure, emits only a later error, has no host readiness,
  and old child listeners are not generation-scoped.
- Implementation change:
  - Add a host-level `host-ready` worker message emitted once after
    `ptyWorker` has loaded its PTY dependency and installed its message
    handler. Add `waitForHost()`/equivalent availability waiting for the main
    handlers and an explicit unavailable rejection after recovery failure.
  - Replace the one-shot `workerDead` latch with an incident state machine and
    one worker-generation binder. Ignore late `message`, `error`, or `exit`
    events from a superseded worker; make `destroy()` suppress all recovery and
    incident emission.
  - On the first unexpected worker error/exit, snapshot the union of
    `pendingSpawns` and `spawnedIds`, classify `unready` from `readyIds`, record
    the purpose of each affected id, cancel deferred timers, clear pending/
    ready/runtime maps, and emit the existing per-PTY `error`/`exit` events
    exactly once. Emit one host-failure event with a fresh incident id and
    numeric exit/startup code (`null` normalized to the documented fallback).
  - Start one replacement worker. Resolve availability only after its
    `host-ready`; emit host-recovered for the same incident. If the replacement
    fails before readiness, or fails during the recovery window, emit one
    terminal recovery-failed event and reject all waiters. Do not start a second
    replacement for that incident.
  - Make `_send` and `_spawn` refuse unavailable generations. `createDeferred`
    must never manufacture a successful post-failure launch id; callers that
    need a launch must wait through `waitForHost()`. A race after the wait must
    fail through the normal error path without adding a dead id to a live map.
  - Add a purpose parameter/metadata path used by `createShell`,
    `SessionSpawner.spawnNew`, and `SessionSpawner.spawnResume`; clean it on
    normal PTY exit, error, kill, and host failure. Do not alter deferred first
    sizing, command construction, environment construction, resize, or output
    flow-control behavior.
  - Emit one structured local diagnostic per incident containing the incident
    id and host failure code only; do not include output, environment, command,
    credential, or transcript data.
- Invariants and edge cases:
  - A per-PTY normal exit remains a single-pane event and never starts host
    recovery. A worker exit after `destroy()` is clean shutdown. A worker
    `error` followed by `exit` is one incident.
  - The replacement worker owns no old PTY ids; all old ids are stale by
    construction. A host failure with no affected panes still follows the
    same one-attempt state machine so startup failures are visible and
    subsequent calls cannot silently hang.
- Verification:
  - Extend focused manager tests for host-ready gating, initial startup
    failure/recovery, active crash fanout, pending/deferred classification,
    no dead id after recovery failure, late old-worker events, exactly one
    replacement, purpose snapshots, normal per-PTY exit, clean destroy, and
    one diagnostic per incident.
  - Run the focused Vitest file before handing T1 off.
- Completion evidence: test names/output and the final manager state-machine
  diff recorded in this plan's Verification Evidence section after execution.

### T2. Bridge host lifecycle to every window and gate all launch handlers

Status: complete.

- Dependencies: T1.
- Requirements/scenarios: 2, 3, 9, 10, 11, 12; post-failure requests,
  failed recovery, and primary/detached behavior.
- Files and symbols:
  - `src/shared/types.ts` — host status/payload types, `IPCChannels`,
    `EventChannels`, and restart invoke membership.
  - `src/main/ipc/handlers.ts` — manager/router construction, window-load
    initialization, `session:new`, `session:resume`, `pty:create`, cleanup.
  - `src/main/ipc/ptyOutputRouter.ts` — host-failure route/buffer release.
  - `src/main/sessions/SessionSpawner.ts` — pass launch purpose to the manager.
  - `src/main/ipc/handlers.test.ts` or a focused new main IPC seam test, if the
    existing Electron registrar harness cannot exercise the full handler.
- Current behavior: handlers immediately accept manager-created ids and route
  them; the router only cleans up per-PTY exits; no host state is broadcast or
  queryable by a newly loaded detached window.
- Implementation change:
  - Define a single typed host-status event contract carrying incident id,
    state (`recovering`, `recovered`, or `failed`), failure code, affected ids,
    unready ids, and unready new-agent ids as appropriate. Keep the payload
    free of terminal contents and secrets.
  - Subscribe once to manager host events. On failure, release every affected
    route and output/scraper buffer, remove affected `ptyAgentKind` entries,
    and broadcast the same incident to all windows. On recovery/failure,
    broadcast the corresponding status. Make repeated manager notifications
    idempotent at the bridge.
  - Await manager availability at the start of `session:new`,
    `session:resume`, and `pty:create`. This allows requests during recovery to
    wait for the replacement host and makes requests after terminal failure
    reject before a PTY id is returned. Preserve existing provider/linking and
    sender-routing checks.
  - Add a typed `app:restart` invoke. It must request the ordinary Electron
    relaunch/quit sequence only after the existing close/before-quit shutdown
    save path remains in control; do not add a second layout writer or bypass
    cleanup.
  - Send the current host status during `did-finish-load` for newly registered
    windows so a detached window created during recovery does not miss the
    global state transition.
- Invariants and edge cases:
  - Existing per-PTY `pty:exit` and pending-spawn error output may still be
    delivered for diagnostics, but they cannot leave routes, scraper state, or
    renderer PTY ids live. Route cleanup is safe when a route was never
    established.
  - A request that waited through recovery receives only a fresh id from the
    replacement worker. A rejected request never receives a placeholder id.
  - Host status is one global incident stream; handlers must not start a
    renderer-specific recovery attempt.
- Verification:
  - Test payload typing/registrar registration and manager-to-window fanout
    with a fake manager/window manager. Assert affected routes are released,
    availability is awaited/rejected correctly, status is replayed to a newly
    loaded window, and restart calls the approved Electron lifecycle seam.
  - Extend `ptyOutputRouter.test.ts` for host-failure release and ensure normal
    exit tests remain unchanged.

### T3. Add incident-scoped renderer pane transitions and owner-only recovery

Status: complete.

- Dependencies: T2.
- Requirements/scenarios: 2, 4, 5, 6, 7, 8, 10, 11; active crash,
  successful recovery, unready new agent, restart, duplicate event, and
  detached ownership scenarios.
- Files and symbols:
  - `src/shared/types.ts` — in-memory terminal-host recovery marker on
    `PaneLeaf`, if needed by the pure transition contract.
  - `src/shared/paneTree.ts` and `src/shared/paneTree.test.ts` — add a pure
    host-failure transform that can clear shell and agent PTY ids while
    preserving unrelated leaves.
  - `src/renderer/src/store/panes.ts` — store actions/interface, hydration,
    `setPtyId`, `resumeAgentPane`, `runNewAgentSession`, and `applyLayout`.
  - `src/renderer/src/store/panesIpc.ts` — host-status listener and ownership
    dispatch.
  - `src/renderer/src/store/panes.test.ts` — transition, retry, persistence,
    and detached ownership tests.
  - New `src/renderer/src/store/terminalHost.ts` — global host status and
    restart action, wired once like `store/updater.ts`.
- Current behavior: `markPtyExited()` only clears agent ids; shell creation
  retries whenever its id is absent; agent launch metadata is patched before
  deferred process establishment; no incident marker prevents duplicate
  recovery.
- Implementation change:
  - Add an incident marker/action that atomically processes only affected ids
    still owned by the current incident. Clear every affected `ptyId`, retain
    `agentKind`/cwd/known session id for resumed or established agents, and
    set a visible no-live-process marker. Keep ordinary `markPtyExited()` logic
    unchanged.
  - For `unreadyNewAgentPtyIds`, remove the speculative new session id and
    pending/detected marker, leaving an explicit agent placeholder with its
    existing start-new action. Any affected new-agent pane without a confirmed
    session id is also a placeholder, whether or not its PTY had reached
    `ready`. Never use cwd/time/output matching in this transition. For known
    sessions, preserve identity and make resume remain available.
  - On `recovered`, only the runtime owner of each marked tab acts. Shell
    markers clear into one normal shell create; known-agent markers invoke the
    existing guarded resume path once. New-agent placeholders do not auto-start
    a new session. Clear the marker only when the incident action is accepted
    or a newer PTY assignment supersedes it.
  - On `failed`, retain metadata, convert marked panes to a terminal-host
    failure state, and prevent Terminal effects from issuing endless creates or
    resumes. A manual resume/start-new remains an explicit user action and
    must preserve identity when one exists.
  - Ensure duplicate status events, a manual action racing automatic recovery,
    a newer PTY assignment, and primary/detached copies are all guarded by
    incident id, current `ptyId`, in-flight maps, and existing detached runtime
    ownership conventions.
  - Strip the in-memory marker and all runtime PTY ids from layout snapshots;
    preserve the existing agent session/detection sanitization rules so restart
    sees known agents as normal resumable panes and shells as normal shells.
- Invariants and edge cases:
  - A host event must not mutate an unrelated new PTY created on the
    replacement host. Primary metadata for a detached tab may transition, but
    only its detached runtime owner invokes a resume/create.
  - If the host fails again during an automatic resume, the existing pane
    identity remains and the failed global state stops further automatic loops.
  - Existing session validation and hook-based linking semantics remain
    untouched.
- Verification:
  - Pure tree tests cover shell + agent clearing, known identity preservation,
    unready new identity removal, unrelated/newer id protection, and duplicate
    incident no-ops.
  - Store tests cover successful shell recreation, exactly-once known resume,
    failed recovery/manual resume, no phantom restart resume, and primary vs
    detached runtime ownership.

### T4. Expose recovery state in the terminal UI

Status: complete.

- Dependencies: T3.
- Requirements/scenarios: 2, 9, 10, 11; recovery progress, failed recovery,
  actionable resume, and detached windows.
- Files and symbols:
  - New `src/renderer/src/components/TerminalHostRecoveryBanner.tsx` and
    corresponding test.
  - `src/renderer/src/App.tsx` — render the global banner in the existing
    chrome/banner region for primary and detached renderers.
  - `src/renderer/src/components/Terminal/index.tsx` — gate shell creation and
    agent connecting UI on the pane host marker; render a clear no-live-host
    message and preserve available actions.
  - `src/renderer/src/styles/theme.ts` or the existing theme constants — use
    the repository's overlay/banner colors without introducing raw component
    hex values.
- Current behavior: UpdateBanner is the only global status banner; Terminal
  shows generic connecting/error states and would retry shell creation as soon
  as `ptyId` is cleared.
- Implementation change:
  - Add a compact global banner with `recovering` and `failed` copy, incident
    failure context without sensitive details, and one `Restart MultiAgent`
    button in the failed state. The button invokes the typed store action and
    cannot create a PTY itself.
  - Add explicit terminal-pane host-unavailable/recovery copy for shells and
    agents. During recovery, suppress automatic shell creation until the
    recovered transition clears its marker; after failure, do not leave a pane
    in a perpetual connecting state. Keep agent Resume/Start New affordances
    available according to preserved metadata.
  - Follow the existing dark overlay/banner language, theme constants, image
    icon/button conventions, and detached-window layout without adding a
    second agent-status write path.
- Invariants and edge cases:
  - Banner state is global and identical in every window; it is not duplicated
    once per pane. A detached window loaded mid-incident receives the replayed
    main status.
  - The UI never claims a PTY is live based solely on a returned id; it waits
    for the normal ready path after the recovery action.
- Verification:
  - Component tests assert recovering copy, failed copy/restart action,
    no-connect loop, and preserved resume/start-new controls.
  - Run renderer typecheck and focused component/store tests.

### T5. Add durable documentation and end-to-end regression coverage

Status: complete with an unrelated E2E limitation recorded below.

- Dependencies: T1–T4.
- Requirements/scenarios: all, especially active multi-pane recovery,
  failed recovery, restart safety, and detached convergence.
- Files and symbols:
  - `docs/pty-and-terminals.md` — add the host lifecycle/recovery mechanism,
    generation/id invalidation, one-shot replacement policy, and pane retry
    ownership rules.
  - `AGENTS.md` — add one terse PTY guardrail pointing to the existing PTY doc:
    host failure clears every affected PTY id, permits one replacement-host
    attempt, and preserves only verified agent session identity.
  - `e2e/startup.spec.ts` — add a deterministic worker-crash/recovery scenario
    using the existing Electron test harness and extend the missing-worker case
    for the failed-recovery/restart affordance where practical.
  - Relevant test files from T1–T4 for any regression harness helpers.
- Current behavior: E2E only verifies that a missing initial worker surfaces a
  terminal error; it does not verify replacement-worker recovery, stale shell
  ids, known-agent resume, or detached convergence.
- Implementation change:
  - Add a test-only worker failure seam or deterministic child-process trigger
    that kills the PTY worker without killing Electron, then assert the global
    recovery state, fresh shell/agent PTY assignments, no old-id control, and
    exactly one automatic attempt.
  - Add a failure variant that makes the replacement worker unavailable and
    asserts no connecting loop plus the explicit restart action. If the full
    app-restart assertion is too disruptive for the shared fixture, verify the
    typed invoke and durable layout state in unit tests and record the E2E
    limitation as `UNVERIFIED` rather than implying it passed.
  - Exercise a detached tab where feasible and assert both windows converge
    without competing spawns. Keep the existing missing-worker test's cleanup
    robust and restore any renamed worker fixture in `finally`.
- Invariants and edge cases:
  - E2E tests must not depend on real provider credentials or transcript text;
    use existing test agent commands/fixtures and inspect only IDs/status/UI.
  - Never weaken the existing worker-missing regression while adding the
    recovery path.
- Verification:
  - Run focused tests, then `npm run typecheck`, `npm run test`, `npm run build`,
    and `npm run test:e2e` from the documented commands. Record exact commands,
    results, and any environment-limited checks below.

## Cross-Cutting Constraints

- Preserve the one shared PTY worker architecture, direct output relay,
  no-flow-control policy, deferred first-size handshake, shell/agent launch
  commands, environment/PATH rules, and existing normal per-PTY exit behavior.
- Do not reattach old processes, retry the host more than once per incident,
  infer session ids from output, mutate user/project agent configuration, or
  add a second agent lifecycle/status reducer.
- All renderer state transitions must be incident-scoped and safe under
  primary/detached ownership. Main remains authoritative for PTY routing and
  host status; renderer remains authoritative for pane presentation and
  recovery action dispatch.
- No diagnostic may include terminal bytes, transcript content, credentials,
  environment values, or command arguments.
- Use `apply_patch` for source/spec/doc edits, preserve unrelated worktree
  changes, and do not archive or claim verification until the required checks
  actually run.

## Risks, Migration, and Rollback

- Worker replacement adds asynchronous startup states and can expose races
  between host-failure broadcast, renderer layout sync, and a user retry. The
  generation token, incident id, and current-PTY checks are the rollback-safe
  boundaries.
- A returned deferred PTY id remains a reservation until the normal `ready`
  event; host failure must invalidate that reservation before UI recovery. The
  purpose metadata is internal and does not alter IPC launch signatures.
- Restart uses the existing shutdown save path. If the Electron restart seam
  cannot be safely exercised in-process, keep the action behind the typed main
  handler and verify persistence separately; do not create a second shutdown
  implementation.
- Rollback is file-local: remove the host recovery event/state/UI additions
  while retaining the pre-existing crash fanout tests and behavior. Do not
  revert unrelated sidebar/theme work in the worktree.

## Handoff Checklist

- [x] T1 worker lifecycle and focused tests complete.
- [x] T2 typed IPC, route cleanup, launch gating, and restart seam complete.
- [x] T3 renderer incident transition, persistence sanitization, and ownership complete.
- [x] T4 banner and per-pane host-unavailable UI complete.
- [x] T5 docs and E2E coverage complete.
- [x] Focused tests pass.
- [x] `npm run typecheck` passes.
- [x] `npm run test` passes.
- [x] `npm run build` passes.
- [ ] `npm run test:e2e` passes — `UNVERIFIED` for the unrelated browser-MCP case documented below; all spec-064 startup cases pass.
- [ ] Spec is moved to `specs/done/` only after verify-spec accepts the evidence.

## Plan Review

Verdict: APPROVED

Completed by review-plan: 2026-08-07.

Coverage and repository checks performed:

- Re-read the ready source spec, `AGENTS.md`, `docs/writing-specs.md`,
  `docs/writing-plans.md`, and the relevant PTY, session, and multi-window
  architecture docs.
- Checked the named manager, worker, session spawner, IPC handler/router,
  shared type, pane-tree, renderer store, Terminal, app lifecycle, unit-test,
  and E2E harness paths against the current repository.
- Mapped all 13 requirements, all acceptance scenarios, the non-goals, and the
  resolved one-shot/all-callers/no-phantom-identity decisions in the coverage
  table and task contracts.
- Falsification pass covered startup failure, worker error/exit duplication,
  deferred launches, stale shell ids, replacement-worker generation races,
  post-failure requests, failed recovery, manual retry races, restart save,
  primary/detached ownership, ordinary PTY exit, and clean shutdown.

Findings:

- No blocking or important findings remain. The pre-review clarification in
  the architecture and T3 explicitly handles a new-agent pane with no
  confirmed session id even when its PTY reached `ready`.
- Editorial/runtime limitation: the exact worker-crash E2E trigger remains an
  execution task, not a plan gate; T5 requires a deterministic seam or an
  explicitly recorded `UNVERIFIED` result rather than an assumed pass.

Required corrections: none.

Reviewer limitation: no separate delegation capability was available in this
session. This approval is an explicit same-session blind re-read of the spec,
plan, repository facts, and falsification cases, not an independent second
reviewer. Implementation and runtime evidence remain pending execute/verify.

## Implementation Summary

Implemented the one-shot terminal-host recovery contract across the shared worker, main IPC,
renderer pane state, primary/detached ownership, persistence sanitization, and terminal UI. The
worker now has host readiness and generation-scoped recovery; affected PTY ids are fail-closed,
known agent identities survive, unready new launches become placeholders, shells and known agents
recover exactly once, and failed recovery exposes an application restart action. Added focused unit,
component, and Electron startup coverage plus the PTY guardrail/mechanism documentation.

## Verification Evidence

Passing checks:

- `npm run typecheck`
- `npm run build`
- `npm run test` — 70 files, 761 tests passed.
- `npx playwright test e2e/startup.spec.ts -g "missing PTY worker|recreates a shell PTY"` — 2 passed.
- An initial unisolated E2E run reached 26 passed / 1 failed. All 22 startup/layout tests, including both
  spec-064 cases, passed. The unrelated existing
  `e2e/browserMcp.spec.ts` async-fixture tool-list assertion failed twice with the MCP endpoint
  returning the tool list while `mcp:get-status` still reported `[]`; no browser-MCP files were
  changed. This was an environment-only mismatch caused by the developer profile's disabled
  built-in browser-MCP setting, not a spec-064 failure.
- `git diff --check` passed.

Implementation limitations for verify-spec:

- The initial unisolated full E2E run was not green because the developer profile disabled the
  built-in browser-MCP tools; the affected behavior is outside spec 064.

## Verification Matrix

Verification date: 2026-08-07. The verifier performed a blind requirements/scenario re-read;
separate delegation was unavailable in this session.

Requirement matrix:

| Item | Verdict | Evidence |
|---|---|---|
| R1: classify once, exclude clean shutdown, one recovery | PASS | `PtyManager.crash.test.ts`: worker error/exit deduplication, clean `destroy()`, replacement readiness, and no second retry tests pass. |
| R2: clear every affected PTY and release routes | PASS | `markLeavesForTerminalHostFailure` tests; manager fan-out tests; renderer host-failure store test; host-failure handler releases routes after the status transition. |
| R3: fail closed for deferred and post-failure shell/new/resume launches | PASS | Manager post-crash `createDeferred` test rejects without a dead id; deferred pending-spawn error test passes; launch gating is covered by the manager/renderer suite. |
| R4: preserve known agent metadata and resume once | PASS | `panes.test.ts` host-failure identity test and exactly-once known-agent recovery test pass. |
| R5: preserve shell type/cwd and recreate once | PASS | Pane-tree/store recovery tests plus `e2e/startup.spec.ts` `recreates a shell PTY after one terminal-host failure` pass with a fresh PTY id. |
| R6: no phantom new-agent identity/marker | PASS | Pane-tree test clears an unready new-agent id; store coverage exercises pending recovery placeholders; layout sanitization removes runtime recovery markers. |
| R7: idempotent recovery/retry and newer-id protection | PASS | Manager incident latch and duplicate-event tests; renderer incident/owner guards and detached-primary no-recovery test pass. |
| R8: restart-safe runtime state | PASS | `layoutStore.ts` strips in-memory host markers; existing layout hydration strips PTY ids; pane tests retain known session identity for normal resume. |
| R9: global status, per-pane state, explicit restart fallback | PASS | `TerminalHostRecoveryBanner.test.tsx` covers recovering and failed/restart states; missing-worker E2E observes `Terminal host recovery failed` and `Restart MultiAgent`. |
| R10: actionable resume failure while unavailable | PASS | Host-failure pane transition retains known session metadata and failed/recovery UI keeps the retry action; store and banner tests pass. |
| R11: primary/detached convergence and one owner | PASS | `panes.test.ts` verifies a primary renderer does not recover detached runtime state; IPC broadcasts status and replays it on window load. |
| R12: one local diagnostic without contents/secrets | PASS | Manager logs one incident id/code line; crash test asserts one log; implementation payloads contain ids/status only and no terminal output or environment values. |
| R13: ordinary PTY exit and clean shutdown unchanged | PASS | Existing per-PTY exit test verifies only one id is cleaned; clean-destroy crash test verifies no host-failure fan-out. |

Acceptance-scenario matrix:

| Scenario | Verdict | Evidence |
|---|---|---|
| Active shell + multiple agents fail together | PASS | Manager fan-out, pane-tree/store transition, and host-status wiring tests pass. |
| Successful recovery creates fresh shells/resumes known agents | PASS | Replacement host-ready manager test, exactly-once agent store test, and shell recovery E2E pass. |
| Failed recovery stops connecting and offers restart | PASS | Replacement-start failure manager test and missing-worker E2E/banner tests pass. |
| Deferred agent launch fails without usable id | PASS | Pending deferred-spawn failure test and unready new-agent pane-tree test pass. |
| Post-failure shell/new-agent request is rejected or held safely | PASS | Post-crash create rejection test and host-availability gate inspection/tests pass. |
| Unconfirmed new-agent launch remains a placeholder across save/restart | PASS | New-agent purpose metadata, pane-tree/store placeholder tests, and runtime-marker layout sanitization pass. |
| Known-session resume retains identity while host unavailable | PASS | Store host-failure transition retains session id and failure UI remains actionable. |
| Failed new launch does not resume a phantom session | PASS | Unready new-agent transition clears speculative identity/marker; restart-safe layout path strips runtime-only state. |
| Known agent metadata survives save/restart | PASS | Pane hydration/store tests and existing startup-resume path preserve `agentKind`, cwd, and known session id. |
| Normal single PTY exit affects only its pane | PASS | Existing manager per-PTY exit regression test passes. |
| Clean shutdown emits no host incident | PASS | `destroy()` crash-suppression regression test passes. |
| Duplicate host notifications produce one transition/prompt | PASS | Manager error-then-exit and repeated-exit tests pass; incident-scoped renderer transition is covered. |
| Detached and primary renderers converge | PASS | Detached ownership store test plus typed broadcast/replay path pass; no competing retry is started. |

Non-goal and dependency checks:

| Item | Verdict | Evidence |
|---|---|---|
| No reattachment to dead PTYs | PASS | Recovery clears old ids and waits for replacement host readiness; shell E2E asserts a fresh id. |
| No more than one automatic host recreation | PASS | Manager recovery latch and replacement-failure/no-retry test pass. |
| No transcript/index/provider changes | PASS | Diff is limited to host lifecycle, pane state/UI, tests, docs, and IPC; no session storage/provider code was changed. |
| No deferred-size, resize, flow-control, PATH, or launch-command redesign | PASS | Existing PTY guardrails remain intact; changes only gate host availability and preserve the existing deferred handshake. |
| No user/project agent config mutation | PASS | No config writes were added; recovery uses existing process-scoped launch paths. |
| No output-based session-id inference | PASS | Recovery metadata is sourced from pane/session state and purpose tags; no terminal-output scanner was added. |
| No second agent-status lifecycle source | PASS | Host status is a separate host-health channel only; agent badges continue through the existing pane lifecycle path. |
| Existing crash-fanout and clean-shutdown dependencies available | PASS | `PtyManager.crash.test.ts` regression tests pass. |

Mechanical checks:

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm run test` — PASS; 70 files and 761 tests passed.
- `npx playwright test e2e/startup.spec.ts -g "missing PTY worker|recreates a shell PTY"` — PASS; 2 passed.
- `MULTIAGENT_E2E_USER_DATA_DIR=<temporary isolated profile> npm run test:e2e` — PASS; 27 tests
  passed, including all browser-MCP and both spec-064 startup cases. The isolated profile was
  removed after the run.
- `git diff --check` — PASS.

Decision: PASS. All spec-064 requirements, scenarios, non-goals, dependencies, and mechanical
checks have passing evidence. No autonomous product repair was made during verification; the
only environment correction was running the existing E2E suite with its required isolated
profile so the developer's persisted MCP settings could not affect the result.
