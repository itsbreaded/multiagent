# Implementation Plan: Detached-window lifecycle and parity hardening

Plan Status: completed
Source spec: `specs/done/075-detached-window-lifecycle-and-parity.md` (Status: done)

## Verified Repository Facts

- `WindowManager.unregister()` is invoked from each registered
  `BrowserWindow`'s `closed` event. It cancels pending tab transfers, clears
  detached tab ownership, removes PTY routes whose owner is the closing
  renderer, notifies the primary with `tab:closed`, and invokes a configured
  detached-close cleanup callback.
- The detached-close callback in `src/main/ipc/handlers.ts` currently releases
  output/status state, awaits `SessionSpawner.disposePty()`, and only then
  calls `PtyManager.kill()`. `SessionSpawner.disposePty()` delegates to
  `CodexAppServerManager.disposePty()`.
- `CodexAppServerManager` owns one stdio app-server observer per requested
  Codex PTY. It binds a discovered thread/session id, calls
  `thread/resume` for observation, and disposes by awaiting its binding,
  requesting `thread/unsubscribe`, closing the JSON-RPC transport, killing the
  sidecar, and waiting up to one second for exit. It has no session-keyed
  cleanup barrier consumed by a later `spawnResume()`.
- `SessionSpawner.spawnResume()` prepares a new Codex observer and PTY from the
  supplied session id/cwd. `handlers.ts` routes the new PTY to the calling
  renderer and the existing `sessions:validate` scanner checks transcript
  identity/cwd; neither path currently waits on a prior same-session observer
  teardown.
- `WindowManager` stores detached tab ownership and PTY routes separately.
  `prepareTabTearOff()` stores original PTY routes and a pending token;
  `cancelPendingTabTransfer()` restores only routes still owned by the target,
  but currently sends rollback only to the target renderer and does not resolve
  ownership waiters when the target closes.
- The primary renderer receives `tab:closed` and removes the synchronized
  detached copy through `removeClosedDetachedTab()`. That action does not yet
  clear focus targets for the closed window or dispose any primary-side xterm
  registry entries for the removed proxy.
- `App.tsx` installs the keyboard dispatcher in every renderer, including
  detached windows, and `toggleCommandPalette()` is window-local. However,
  `App.tsx` renders `CommandPalette` only when `!isDetachedWindow`, and
  `TabBar` omits its chrome button cluster entirely for detached windows.
- `CommandPalette` already scopes pane/tab actions to the current renderer and
  filters settings/session-browser commands with `isDetachedWindow`. Settings,
  Session Browser, Jira credential access, update UI, and primary layout save
  are intentionally main-owned. Directory pickers in Sidebar/TabSections,
  pane grid/terminal interactions, sidebar movement, and transfer IPC are
  window-local or ownership-routed.
- Existing specs 072, 073, and 074 are archived and must not be rewritten.
  Their current guardrails require sidebar-only navigation, per-window owned
  rows, terminal preservation across explicit transfers, and terminal detached
  close instead of implicit return.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1-R6; detached close, process/provider cleanup, no return, resumability | T1, T2 | WindowManager/provider unit tests, deterministic lifecycle regression, E2E close/resume fixture |
| R7-R9; command palette and window-local dispatch/sidebar behavior | T3, T4 | renderer component/store tests and detached-window E2E |
| R10-R13; panes, terminals, sessions, overlays, IPC/listener cleanup | T1-T4 | existing focused tests plus parity matrix and full suite/E2E |
| R14-R16; regression coverage, reproduction, mandated checks | T4, T5 | baseline failing regression, fixed regression, typecheck/test/build/e2e/diff/status evidence |
| Non-goals and archived 072/073/074 semantics | T2-T5 | source audit, transfer/close tests, documentation/evidence review |

## Detached Parity Audit

The following is the pre-change classification based on repository inspection;
the plan records the result durably and tests every item that is claimed to
work.

| Behavior | Classification | Action/evidence |
| --- | --- | --- |
| Ctrl+Shift+P/configured command palette opens visibly in detached window | broken and requiring a fix | T3 + detached E2E/component regression |
| Other window-local keyboard shortcut dispatch and active-pane command context | supported and working | T3 tests preserve the existing per-renderer dispatcher/context |
| Sidebar navigation, selection, reorder, individual close | supported and working | existing 074 coverage plus focused detached assertions |
| Explicit sidebar move/return and cross-window ownership | supported and working | existing 074 transfer tests; T2 closes target-cancel gap |
| Detached native close closes owned tabs rather than returning them | supported for shell/UI rows, broken for complete lifecycle cleanup | T2 lifecycle tests and E2E regression |
| Pane focus and cross-window focus acknowledgements | supported and working | preserve generation/ack path; targeted tests |
| Pane drag/drop and split/swap across windows | supported and working | preserve MIME/ack paths; existing 074 E2E and focused tests |
| Pane/grid resizing | supported and working | preserve Allotment/terminal resize path; existing tests/E2E |
| Terminal input/output, resize, clipboard, context menu, title/CWD | supported and working | preserve PTY route/output paths; existing terminal/E2E checks |
| Agent launch and live status updates in detached panes | supported and working | preserve renderer routing and Codex observer binding; focused tests |
| Agent/session close and session refresh | supported for explicit sidebar close, incomplete for native close cleanup | T1/T2 and refresh evidence |
| Codex close followed by same-session resume | broken and requiring a fix | T1/T4 deterministic reproduction and E2E/manager evidence |
| Directory picker and pane/sidebar-local overlays | supported and working | preserve TabSections ownership; focused detached action test |
| Settings, provider credentials, Jira settings, update UI | intentionally main-window-only | retain guards and record safe main-window ownership |
| Session Browser/global session indexing UI | intentionally main-window-only | retain primary ownership; verify session IPC remains app-global |
| IPC listeners and subscriptions after window close | supported at renderer-context teardown, broken for provider/ownership cleanup race | T2/T4 cleanup/idempotence tests |
| Top tab strip | intentionally absent by archived design | explicit non-goal; no restoration |

## Architecture and Data Flow

1. Native close becomes a single idempotent lifecycle transition in
   `WindowManager`: mark the window closing, cancel pending transfers and
   notify both surviving/source renderers, resolve ownership waiters, mark
   tab tombstones/generations, capture all PTYs still attributable to the
   closing detached window, then remove routes/maps and run cleanup once.
   Repeated `closed`/late IPC events must be no-ops.
2. Detached PTY attribution will remain separate from provider session
   identity. WindowManager may retain a bounded window-to-PTY association for
   pending/owned detached tabs so a missing/stale route cannot leave a live
   PTY uncleaned, but it must never kill a PTY whose current route has already
   moved to another live window.
3. Provider teardown will use Codex's existing supported unsubscribe/disconnect
   sequence, close the JSONL transport, and terminate the sidecar. A
   session-keyed cleanup result/barrier will be registered synchronously when a
   bound observer begins disposal. `spawnResume()` awaits that barrier before
   preparing a new observer; an RPC/sidecar timeout or failed exit resolves as
   a protective failure and `spawnResume()` rejects without creating a second
   provider owner.
4. Main detached-close cleanup will terminate the user-facing PTY promptly and
   then await provider observer disposal, while retaining idempotent disposal
   for PTY exit events and renderer `pty:kill` calls. Transcript files and
   `SessionIndex` rows are never deleted.
5. Renderer close notification will remove the primary's detached proxy,
   dispose proxy-only xterm/focus state, and reject stale sync/focus/transfer
   updates by the existing ownership generation/tombstone checks.
6. Detached command palette is a renderer-local overlay. It will be rendered
   for detached windows and exposed through a detached-local chrome button or
   the existing local keyboard shortcut; settings/session-browser commands
   remain filtered out by their deliberate primary ownership.

## Implementation Tasks

### T1 - Serialize Codex cleanup with same-session resume (completed)

- Dependencies: none.
- Requirements/scenarios: R3, R5, R10, R13-R16; Codex close/resume, provider
  cleanup failure, no orphaned observer, transcript preservation.
- Files and symbols:
  - `src/main/integration/codexAppServer.ts`: `CodexAppServerManager`,
    `PaneObserver`, `disposePty`, `dispose`, observer transport lifecycle.
  - `src/main/sessions/SessionSpawner.ts`: `spawnResume`, provider options.
  - `src/main/ipc/handlers.ts`: detached close cleanup callback and PTY kill
    ordering; retain the existing app-global provider manager.
  - `src/main/integration/codexAppServer.test.ts` and
    `src/main/sessions/SessionSpawner.test.ts`.
- Current behavior: observer disposal is PTY-keyed and asynchronous; a new
  resume with the same Codex session id can prepare/bind before the old
  observer/sidecar has fully unsubscribed and exited. Detached close kills the
  user PTY only after awaiting observer cleanup.
- Implementation change: add a bounded, session-keyed cleanup barrier/result
  that is registered before the first await, returns only the current prior
  cleanup, and is awaited by Codex resume before creating a new observer. Keep
  `thread/unsubscribe`, JSONL close, sidecar termination, and `disposePty`
  idempotent; ensure an observer that never answers still receives the kill
  attempt, and report a protective failure if the sidecar does not exit within
  the bounded policy. Kill the user PTY promptly during detached close, then
  await provider disposal, while allowing the existing exit hook to call
  disposal again safely. A rejected barrier must propagate through resume, not
  be swallowed by the fallback launch path.
- Invariants and edge cases: same-session resume cannot overlap provider
  disposal; different sessions are not serialized unnecessarily; a cleanup
  failure never deletes transcript/history or emits a fake completion; a
  concurrent second `disposePty` awaits the first; preparation failure cleans
  sidecars and barriers.
- Verification: fake stdio provider records `thread/unsubscribe`, transport
  close, and sidecar kill; a delayed unsubscribe reproduces the pre-fix
  overlapping-resume failure and passes only after resume waits. Tests assert
  concurrent disposal shares one promise and transcript/session validation is
  untouched.
- Completion evidence: the pre-fix deterministic `SessionSpawner` reproduction
  failed with `['prepare','pty']` instead of cleanup-first ordering; after the
  barrier it passes, fail-closed cleanup rejects before prepare, fake stdio
  records unsubscribe/sidecar teardown, and the focused Codex/SessionSpawner
  suites pass.

### T2 - Make detached WindowManager teardown complete, cancelable, and idempotent (completed)

- Dependencies: T1 for cleanup callback/barrier semantics.
- Requirements/scenarios: R1-R6, R12, R14-R16; native close, pending transfer
  cancellation, no orphan route/process, repeated cleanup, no stale primary row.
- Files and symbols:
  - `src/main/window/WindowManager.ts`: ownership maps, `unregister`,
    `cancelPendingTabTransfer`, `waitForTabOwnership`, PTY attribution helpers.
  - `src/main/window/WindowManager.test.ts`.
  - `src/main/ipc/transferHandlers.ts`: rollback notification/timer interaction
    only where the WindowManager contract requires it.
  - `src/renderer/src/store/panesIpc.ts` and `src/renderer/src/store/panes.ts`:
    close notification and focus/runtime cleanup.
  - `src/shared/types.ts` only if a typed close/cleanup event needs a signature
    update; do not invent a second transfer path.
- Current behavior: close cleanup gathers PTYs only from the current
  webContents route; pending target close can leave the source transfer token
  waiting; ownership waiters and sync-version data are not explicitly
  resolved/cleared; primary proxy cleanup does not clear all focus/xterm state.
- Implementation change: capture pending/owned detached PTY attribution with
  current-owner checks; cancel every affected transfer once, restore only
  routes still attributable to that token, notify the surviving source and/or
  target renderer of rollback, resolve ownership waiters with null, and clear
  detached maps/tombstones/generations/sync state in an idempotent order. Keep
  `tab:closed` (not `tab:return`) for owned detached tabs. Preserve explicit
  absorb/return route and generation checks. Ensure late state sync, detached
  ready, and focus requests cannot recreate closed ownership.
- Invariants and edge cases: a PTY transferred to another live window is not
  killed by the old window's close; an unowned PTY previously attributed only to
  the closing detached window is cleaned; close called twice has no second
  notification/kill; source-close and target-close rollback do not overwrite a
  newer route; an empty detached window still unregisters cleanly.
- Verification: expand WindowManager tests for route/attribution cases,
  source rollback notification, ownership waiter resolution, repeated
  unregister, pending transfer close, and no `tab:return`; add renderer store
  tests for stale focus/proxy/xterm cleanup and ensure existing 074 transfer
  tests remain green.
- Completion evidence: focused WindowManager/store tests pass; target-close
  rollback notifies the source and resolves waiters; repeated unregister calls
  do not duplicate cleanup; Electron native detached close removes the primary
  row and kills the shell PTY. The closed-event fallback uses only the
  detached-window PTY attribution map when webContents has already gone away.

### T3 - Repair detached command-palette parity without broadening ownership (completed)

- Dependencies: none; may land independently of T1/T2.
- Requirements/scenarios: R7-R12, command-palette and overlay classification.
- Files and symbols:
  - `src/renderer/src/App.tsx`: detached overlay render conditions and local
    keyboard behavior.
  - `src/renderer/src/components/TabBar/index.tsx`: detached chrome controls.
  - `src/renderer/src/components/CommandPalette/index.tsx` and
    `src/renderer/src/commands/registry.ts`: preserve current-window command
    context and deliberate main-only command filters.
  - `src/renderer/src/components/TabBar/index.test.tsx`, command-palette tests,
    and a focused App/renderer test seam if needed.
- Current behavior: `useGlobalKeyboard()` runs in detached windows, but App
  suppresses `CommandPalette`; detached TabBar suppresses the button cluster,
  so Ctrl+Shift+P can only mutate invisible state.
- Implementation change: render the command palette in both window types,
  expose only safe window-local palette/chrome affordances in detached chrome,
  and keep settings/session-browser/Jira credential actions main-owned and
  filtered/guarded. Do not enable detached sidebar collapse or restore tabs.
- Invariants and edge cases: focus goes to the detached palette input; Escape
  closes it locally; command execution uses the detached store's active tab and
  focused pane; opening one overlay closes other local overlays; primary chrome
  behavior and top-tab absence remain unchanged.
- Verification: component tests assert detached palette visibility/focus,
  local command context, safe command filtering, and no restored top strip;
  update the detached TabBar expectation. E2E presses Ctrl+Shift+P in a
  detached window and runs a representative local command.
- Completion evidence: detached TabBar/component tests pass, `CommandPalette`
  renders in detached App instances, settings/session-browser remain filtered,
  and Electron Ctrl+Shift+P opens and Escape closes the detached-local palette.

### T4 - Add end-to-end and regression coverage for close/resume and parity (completed)

- Dependencies: T1-T3.
- Requirements/scenarios: all scenarios, especially R14-R16.
- Files and symbols:
  - `src/main/integration/codexAppServer.test.ts`,
    `src/main/window/WindowManager.test.ts`,
    `src/renderer/src/store/panes.test.ts`,
    `src/renderer/src/components/Sidebar/TabSections.test.tsx`,
    `src/renderer/src/components/TabBar/index.test.tsx`.
  - `e2e/startup.spec.ts` and only deterministic fixture/helper changes needed
    to observe detached close, process death, resume, sidebar movement, and
    palette focus.
- Current behavior: E2E covers shell detached-close process termination and
  explicit sidebar transfer, but not native detached-window close followed by
  Codex resume, same-session provider cleanup, target-close rollback, or
  detached Ctrl+Shift+P.
- Implementation change: add a deterministic provider/observer lifecycle
  reproduction that fails on the pre-fix ordering and passes after the barrier;
  add Electron coverage for native detached close, no primary stale row,
  process/PTY ownership cleanup, later resume, palette opening, representative
  sidebar selection/reorder/move/return, and terminal input/output. Use test
  traces/IPC probes only in isolated E2E user data; never add production
  credential or transcript deletion behavior.
- Invariants and edge cases: tests distinguish explicit return from close,
  preserve saved transcript/session fixtures, tolerate detached auto-close after
  its last tab is removed, and assert no duplicate ownership rows after late
  sync/rollback.
- Verification: run targeted tests after each coherent task; run the complete
  required commands at handoff. Record any native/provider limitation as
  `UNVERIFIED` rather than claiming runtime success.
- Completion evidence: baseline provider-owner ordering reproduction failed
  before the fix and passes after it; fake stdio Codex lifecycle tests verify
  unsubscribe/transport/sidecar cleanup and same-session resume serialization;
  Electron verifies native detached close/process death, palette parity,
  sidebar transfer/return, pane drag/drop, and PTY output. A live external
  Codex CLI conversation was not used in this isolated E2E profile and remains
  `UNVERIFIED`; no claim of live-provider reproduction is made.

### T5 - Document the audit and complete mechanical verification (completed)

- Dependencies: T1-T4.
- Requirements/scenarios: R8-R16, all non-goals and intentional main-only
  behavior.
- Files and symbols:
  - `docs/multi-window-and-layout.md` for lifecycle/ownership mechanics;
  - `docs/sessions.md` and/or `docs/pty-and-terminals.md` only for the
    provider/PTY cleanup barrier if the mechanism belongs there;
  - `AGENTS.md` only for a terse new guardrail if the lesson is a durable
    decision-time rule; update the docs index only if a new doc is created;
  - adjacent spec/plan evidence as the authoritative parity classification.
- Current behavior: archived 074 documents explicit transfer infrastructure,
  but not complete native-close provider barriers or detached palette parity.
- Implementation change: document the actual ownership/cleanup sequence,
  fail-closed resume behavior, idempotence/race invariants, parity matrix, and
  intentional primary-only surfaces. Keep mechanism in docs/plan and only
  short guardrails in AGENTS.md.
- Invariants and edge cases: do not rewrite archived specs; do not document
  unverified runtime behavior as complete; retain the top-tab prohibition and
  explicit move/return distinction.
- Verification: run `npm run typecheck`, `npm run test`, `npm run build`,
  `npm run test:e2e`, relevant focused tests, `git diff --check`, and
  `git status --short`. Re-read the spec/plan and audit `rg` results for stale
  close-return paths and hidden detached overlays.
- Completion evidence: the parity matrix above records working, intentional
  main-only, and fixed behavior; `AGENTS.md`, the multi-window mechanism doc,
  and PTY mechanism doc record the cleanup/barrier invariants. All required
  commands pass; the only stated limit is the live external Codex CLI profile
  noted under T4.

## Cross-Cutting Constraints

- Preserve sidebar-first navigation, per-window ownership, detached sidebar
  visibility, and no top tab strip from specs 072-074.
- Close is terminal for detached-owned tabs; explicit return/absorb remains a
  separate committed transfer. Never send `tab:return` from native detached
  close.
- Main remains authoritative for PTY routing and provider lifecycle. Renderer
  notifications are best effort during teardown and must be generation/tombstone
  guarded.
- Never delete or rewrite provider transcript history, mutate user/project
  provider configuration, or fabricate completion/idle events as cleanup.
- Preserve no-flow-control/no-PATH-rewrite terminal behavior, direct Codex CLI
  sessions, stdio app-server observation, and existing resize/input/clipboard
  paths.
- A plan approval is a technical gate only; this work contains no release,
  publish, credential extraction, or destructive history operation.

## Risks, Migration, and Rollback

- Provider cleanup could stall or race a new resume. Mitigate with a
  session-keyed barrier, bounded RPC/sidecar disposal, fail-closed resume, and
  tests with delayed/missing responses.
- Close may kill a PTY that has already moved. Mitigate with current-route
  ownership checks and token/generation validation before cleanup.
- Late detached sync or rollback could resurrect a closed row. Mitigate with
  tombstones, generation bumps, waiter resolution, and renderer focus/proxy
  cleanup tests.
- Showing a detached command button could expose global actions. Render only
  the safe local command-palette affordance and keep global settings/session
  surfaces primary-owned.
- No persisted schema migration is expected. Reverting the change restores
  source behavior but also restores the bug; no transcript/session data is
  modified by rollback.

## Handoff Checklist

- [ ] Every requirement and acceptance scenario maps to a task and evidence.
- [ ] Existing dirty work is preserved; archived specs 072-074 are untouched.
- [ ] Pre-fix lifecycle reproduction is captured before the fix is claimed.
- [ ] Provider, PTY, WindowManager, renderer, transfer, and resume state paths
      are tested for races and idempotence.
- [ ] Parity classifications and intentional primary-only behavior are durable.
- [ ] Full typecheck, unit, build, Electron E2E, diff, and status checks are
      run and truthfully recorded.

## Plan Review

Verdict: APPROVED

Coverage: the plan maps all 16 requirements, the lifecycle/parity acceptance
scenarios, the archived sidebar/transfer non-goals, and the fail-closed
cleanup decision to T1-T5. Repository checks confirmed the named
WindowManager, transfer handlers, Codex observer, SessionSpawner, handlers,
renderer store, App, TabBar, CommandPalette, tests, and E2E seams are present
and current.

Falsification pass: T1 explicitly prevents a same-session resume from
preparing a second provider observer until unsubscribe/transport/sidecar
cleanup is confirmed, and treats a non-exiting sidecar as protective failure.
T2 checks current PTY ownership before killing, notifies surviving transfer
sources on target close, resolves waiters, and preserves the no-return close
rule. T3 keeps global settings/session surfaces primary-owned while repairing
only detached-local command-palette visibility. T4 requires a pre-fix failing
reproduction and post-fix evidence rather than source plausibility.

Findings: no blocking or important finding remains after tightening the
provider barrier failure behavior above. Routine implementation details remain
bounded to the approved architecture and do not introduce a second transfer
protocol, persisted schema, provider-config mutation, or product decision.

Reviewer limitation: the blind delegated reviewer was unavailable after three
bounded waits and was shut down. This is a documented same-session fallback
review, not independent reviewer evidence; the fallback repository/path and
race falsification pass found no blocking issue.

## Implementation Summary

Implemented complete detached-window teardown and parity hardening. Main now
tracks detached PTYs through pending and committed ownership, cancels pending
transfers/timers and resolves ownership waiters on close, retains only safe
closed-window tombstones, and kills all still-attributable user PTYs exactly
once. The closed-event path handles Electron webContents disappearing before
the `closed` callback while leaving PTYs already moved to another live window
alone. Renderer proxy xterms and focus targets are cleared when a detached tab
is closed.

Codex observer disposal now publishes a session-keyed cleanup barrier,
unsubscribes the bound thread, closes stdio transport, kills the sidecar, and
fails closed if bounded exit cannot be confirmed. `SessionSpawner.spawnResume`
waits on that barrier before preparing a replacement observer; transcript and
index data are untouched. Detached App instances render the local command
palette and retain only intentional primary-owned surface restrictions.

## Verification Evidence

- Pre-fix reproduction: `npx vitest run
  src/main/sessions/SessionSpawner.test.ts` — FAIL before the implementation,
  with the expected cleanup-first assertion observing `['prepare','pty']`.
- Focused post-fix lifecycle/parity suites: `npx vitest run
  src/main/window/WindowManager.test.ts src/main/sessions/SessionSpawner.test.ts
  src/main/integration/codexAppServer.test.ts
  src/renderer/src/components/TabBar/index.test.tsx
  src/renderer/src/store/panes.test.ts src/main/ipc/ptyControl.test.ts` — PASS,
  6 files / 83 tests; final WindowManager rerun: 6 tests including detached-source attribution preservation.
  fix.
- Full unit suite: `npm run test` — PASS, 88 files / 932 tests.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm run test:e2e` — PASS, 35 tests. This includes native detached-window
  close with owned-tab removal and PTY process death, detached Ctrl+Shift+P,
  sidebar movement/return, detached-to-detached transfer, pane drag/drop,
  terminal I/O, host recovery, and agent resume coverage.
- `git diff --check` — PASS; `git status --short` inspected. Git emitted only
  expected LF/CRLF conversion warnings.
- No provider transcript/history deletion, user/project agent-config mutation,
  release, publish, or external side effect was performed. Live external Codex
  CLI/provider conversation behavior is explicitly `UNVERIFIED`; the provider
  lifecycle was exercised through deterministic fake stdio and the failing
  pre/post race harness.

## Final Independent Verification Evidence

- A blind delegated verifier was started with only spec 075 and this adjacent
  plan, but returned no result after three bounded waits and was shut down.
  No independent-agent approval or runtime observation is claimed.
- Same-session fallback verification re-read the final source and tests,
  confirmed that native close uses the detached PTY attribution map when
  `webContents.id` is unavailable, confirmed pending source/target rollback
  preserves only the current owner's attribution, confirmed no native-close
  path emits `tab:return`, and confirmed the detached palette remains local
  while settings/session-browser remain primary-only.
- Final commands after the last source change: `npm run typecheck` PASS,
  `npm run test` PASS (88 files / 933 tests), `npm run build` PASS,
  `npm run test:e2e` PASS (35 tests), `git diff --check` PASS, and
  `git status --short` inspected.
