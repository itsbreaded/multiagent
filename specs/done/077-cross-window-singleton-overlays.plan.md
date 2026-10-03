# Implementation Plan: Cross-window singleton workspace overlays

Plan Status: completed
Source spec: `specs/done/077-cross-window-singleton-overlays.md` (Status: done)

## Verified Repository Facts

- `src/shared/types.ts` is the single IPC channel/signature source and
  `src/preload/index.ts` exposes the generic typed `invoke`/`on`/`send` bridge.
- `WindowManager` owns the registered `BrowserWindow` set and its `unregister()`
  path is the authoritative native-window teardown seam. It already focuses
  windows through `BrowserWindow.focus()` and broadcasts lifecycle events.
- `registerIpcHandlers()` in `src/main/ipc/handlers.ts` owns the long-lived IPC
  registrar and wires per-window focus/lifecycle handlers. Detached windows are
  created by `WindowManager.createDetachedWindow()` and are registered before
  their renderer loads.
- `App.tsx` currently renders each overlay from renderer-local
  `sessionBrowserOpen`, `commandPaletteOpen`, and `settingsOpen` booleans. The
  `PanesStore` actions at the end of `store/panes.ts` implement exclusivity only
  within one renderer.
- `TabBar`, `App.tsx`, `Terminal`, and `CommandPalette` currently call those
  local store actions for chrome buttons, global shortcuts, terminal shortcuts,
  and command-registry actions. Settings, Session Browser, and Command Palette
  close through the same local `closeOverlays` action.
- `panesIpc.ts` is the renderer-wide listener seam and is wired once as a side
  effect after the Zustand store is initialized. Its listeners already mutate
  the store and send actual-apply acknowledgements for cross-window protocols.
- `SessionBrowser` owns query/debounce/deep-search state in component state and
  already has a query-generation guard, but its in-flight generation currently
  ends with the component instance and has no singleton ownership lifecycle.
  `CommandPalette` owns query/selection state in component state and resets on
  mount. `SettingsPanel` uses an `autoFocus` search input and settings changes
  persist through the existing settings stores; Jira token access remains
  main-owned and restricted by the existing IPC policy.
- There is no standalone Search component or Search shortcut in this checkout.
  Search is the summary/deep search surface inside Session Browser; the search
  icon in the existing chrome is the Command Palette. The implementation will
  reserve a typed `search` coordinator kind without adding a new UI.
- The current focused tests pass before this change with the correct Vitest
  invocation: 4 files, 18 tests. The existing detached-window E2E coverage only
  proves that a detached renderer can use local controls; it does not request
  the same overlay from both windows or assert global uniqueness. The initial
  attempted `--runInBand` flag is not a repository-supported Vitest option and
  is not verification evidence.
- The current source-level reproduction is deterministic: open an overlay in
  the primary, open a detached window, then click the same chrome control or
  use its shortcut in the detached window. Each renderer's local action flips
  its own boolean, and `App.tsx` mounts both instances because no main request
  or cross-window revocation exists. A real Electron regression test will
  capture this behavior before the implementation task is considered complete.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, R2; S1-S3 | T1, T2 | Coordinator tests, typed IPC checks, renderer action tests, E2E owner/focus assertions |
| R3; S4 | T1, T2 | Close-ack ordering test and E2E cross-kind switch |
| R4; S5, S9 | T2 | Renderer denial/revocation/generation tests and E2E close/reopen paths |
| R5; S6 | T1, T2 | WindowManager/coordinator native-close tests and E2E detached close cleanup |
| R6; S7-S8 | T2 | Session stale-result and palette reset tests; settings persistence/handoff test |
| R7 | T1, T2, T3 | Typed reserved Search kind plus Session Browser search behavior/source inspection |
| R8; S10 | T3 | Focused suite and a real primary+detached Electron scenario |
| Non-goals | T1-T3 | Diff/source review and documentation assertions |

## Architecture and Data Flow

The main process will own one mutually-exclusive active overlay record. The
record contains the requested kind, owner `BrowserWindow` id, a monotonic
generation, and a request token. A renderer sends a typed `overlay:request`
invoke for `open` or `toggle`. Main serializes requests, focuses an existing
same-kind owner, or asks the current owner to close and waits for an actual
`overlay:closed` acknowledgement before granting the next generation to the
requesting window. Main sends `overlay:close` for revocation and
`overlay:focus` for reveal/focus; renderer sends `overlay:closed` after clearing
its local state. A typed `overlay:release` invoke is accepted only from the
current owner and matching generation.

`WindowManager` will host the coordinator (or its lifecycle-facing methods),
call it before removing a native window, and provide the normal restore/focus
path. `handlers.ts` will validate the sender `BrowserWindow` and register the
typed request/release/ack channels through the existing registrar. The
preload bridge remains generic but gets its channel membership from
`shared/types.ts`.

The renderer store remains a rendering cache, never global authority. Its
overlay actions request main approval and only apply an `approved` result. The
store tracks the approved kind and generation, so `App.tsx` renders only the
approved local instance. `panesIpc.ts` clears matching local state on revoke,
ignores stale generations, and acknowledges close. All existing callers keep
using store actions, but those actions become the one IPC-backed request path;
no button, shortcut, command, or close path may directly flip the overlay
booleans.

## Implementation Tasks

### T1 - Add the main-owned overlay coordinator and typed IPC protocol (complete)

- Dependencies: none; preserve the current detached-window lifecycle changes.
- Requirements/scenarios: R1-R3, R5, R7; S1-S6.
- Files and symbols:
  - `src/shared/types.ts`: add `OverlayKind`, request/result/close payloads,
    `IPCChannels` entries, and the correct invoke/event/send channel unions.
  - `src/main/window/OverlayCoordinator.ts`: add the serialized ownership,
    monotonic generation/token, same-kind focus, cross-kind close-ack handoff,
    owner-only release, stale-ack rejection, and window-release logic.
  - `src/main/window/OverlayCoordinator.test.ts`: exercise both opening orders,
    repeated open/toggle requests, exclusive switching, stale generations,
    close timeouts/fail-closed behavior, focus activation, and owner teardown.
  - `src/main/window/WindowManager.ts` and `.test.ts`: expose the normal
    focus-by-id seam and release coordinator ownership from `unregister()`;
    prove a detached native close leaves no owner record.
  - `src/main/ipc/handlers.ts`: register request/release/close-ack handlers
    with sender-window validation and route main notifications through the
    coordinator.
- Current behavior: all overlay actions mutate renderer-local state; native
  window teardown knows nothing about overlay ownership.
- Implementation change: main becomes the only authority for approval,
  transfer ordering, focus, generation validation, and cleanup. Requests are
  serialized so a duplicate click or interleaved handoff cannot mount two
  owners. If the old renderer never acknowledges close, the new request fails
  closed rather than mounting over a possibly visible old instance.
- Invariants and edge cases:
  - At most one active record exists because current behavior is mutually
    exclusive across kinds.
  - A same-kind request from a non-owner focuses/reveals and never toggles off.
  - A same-owner toggle closes only the matching generation.
  - Late close/release acknowledgements are harmless after replacement or
    native close. Destroyed/minimized owner windows are handled through the
    same normal focus path and are never focused after teardown.
  - Main must not depend on renderer local state or a polling loop.
- Verification: focused coordinator/WindowManager tests assert exact owner,
  generation, sends, focus calls, acknowledgement order, stale-message
  rejection, and post-close reopen success.
- Completion evidence: tests pass and the plan records the concrete test names.

### T2 - Route every renderer entry/close path through approved ownership (complete)

- Dependencies: T1 typed protocol and handlers.
- Requirements/scenarios: R2-R7; S1-S5, S7-S10.
- Files and symbols:
  - `src/renderer/src/store/panes.ts`: add approved overlay kind/generation,
    focus nonce, approval/revocation actions, and make the existing toggle/open/
    close actions invoke the typed main coordinator.
  - `src/renderer/src/store/panesIpc.ts`: listen for close/focus notifications,
    clear only matching local generations, send actual close acknowledgements,
    and keep stale events from touching newer state.
  - `src/renderer/src/App.tsx`: render an overlay only for the locally approved
    kind/generation and preserve detached renderers as eligible owners.
  - `src/renderer/src/components/TabBar/index.tsx`, `App.tsx`,
    `components/Terminal/index.tsx`, and `commands/registry.ts`: ensure chrome
    buttons, global/terminal shortcuts, palette commands, and close calls use
    the store's IPC-backed actions with no direct boolean writes.
  - `components/SettingsPanel/index.tsx`, `SessionBrowser/index.tsx`, and
    `CommandPalette/index.tsx`: focus the existing input on coordinator reveal;
    invalidate Session Browser query generations on unmount/close; preserve
    Settings persistence boundaries; and keep palette query/selection local to
    each approved mount.
  - Relevant existing renderer tests plus new focused store/IPC/component tests.
- Current behavior: a renderer can mount any local boolean and its close path
  does not notify other windows; Command Palette and Session Browser state are
  component-local; direct terminal handlers bypass the App handler.
- Implementation change: all opens/toggles go through one store-backed request
  helper, and all closes release the current kind/generation before clearing
  local state. Denied/revoked renderers clear without mounting. Same-kind focus
  increments a local focus nonce so the owner reveals its existing input.
- Invariants and edge cases:
  - `App.tsx` must not render from an unapproved legacy boolean alone.
  - Store approval must atomically close the other local booleans and reset
    transient settings section/query state as appropriate.
  - Session search cleanup must prevent a deferred result from updating a later
    instance. Command Palette must not retain query/selection across an actual
    close and reopen, while a same-kind focus request preserves the existing
    instance.
  - Existing Jira token restrictions and settings-store persistence remain
    unchanged; handoff unmount must not introduce a renderer credential cache.
- Verification: renderer tests simulate approved/denied/revoked generations,
  all entry points, close paths, deferred search responses, settings edit
  persistence, and palette reset/context. Existing component tests are updated
  only where their calls now return through the typed mock IPC.
- Completion evidence: targeted renderer suite passes and source search shows
  no production direct calls to local overlay booleans outside the coordinator
  store/IPC implementation.

### T3 - Add real detached-window coverage and durable subsystem guidance (complete)

- Dependencies: T1 and T2.
- Requirements/scenarios: R8; S1-S10; all non-goals.
- Files and symbols:
  - `e2e/startup.spec.ts`: add one stable, semantic-selector scenario that
    creates a detached window, exercises Settings, Session Browser/search, and
    Command Palette from both windows, switches kinds, checks no global
    duplicate, asserts owner-window focus/activation, tests Escape/backdrop/
    close-button reopen, and closes the detached native window while it owns an
    overlay before reopening from primary.
  - Existing E2E helpers/selectors in `startup.spec.ts`: add only stable
    `role`, `title`, `placeholder`, or explicit `data-testid` hooks if a stable
    semantic selector is missing; do not use timing sleeps or CSS-only identity.
  - `docs/multi-window-and-layout.md`: document the main-owned singleton
    overlay lifecycle, exclusive policy, generation/ack ordering, and native
    close behavior.
  - `AGENTS.md`: add one terse durable multi-window guardrail and a docs-index
    pointer if the mechanism is not fully covered by the existing document.
- Current behavior: existing E2E proves detached local controls but has no
  cross-window uniqueness/focus assertions.
- Implementation change: regression coverage proves the user-visible protocol
  with one primary and one detached renderer and records evidence for the
  current pre-change reproduction and post-change behavior.
- Invariants and edge cases: E2E must wait on visible/hidden semantic state or
  Electron window state, not arbitrary sleeps; it must tolerate the repository's
  minimized E2E mode while still testing main focus calls through observable
  owner/visibility signals.
- Verification: run the targeted E2E scenario first, then the required full
  checks (`npm run typecheck`, `npm run test`, `npm run build`, `npm run
  test:e2e`, and `git diff --check`). Record any environment limitation as
  `UNVERIFIED` rather than claiming runtime coverage.
- Completion evidence: E2E result and docs diff are recorded in the plan and
  verification evidence.

## Cross-Cutting Constraints

- Keep Settings, Session Browser, Command Palette, and current Session Browser
  Search behavior mutually exclusive, as required by the existing store.
- Do not touch PTY routing, session linking, MCP injection, Jira credential
  ownership, or unrelated tab-transfer behavior.
- Do not introduce a second command registry, polling, filesystem scan, or
  renderer-only focus mechanism.
- Treat renderer overlay booleans as a local projection of main approval, not a
  global source of truth.
- Keep IPC channels typed in `shared/types.ts`; preload requires no untyped
  escape hatch.

## Risks, Migration, and Rollback

- A renderer that fails to acknowledge close could block a handoff. The
  coordinator fails closed for that request and retains/cleans the old record
  deterministically, so no second visible instance is mounted.
- Existing component tests often render an overlay directly and use a no-op IPC
  mock. Their direct component behavior remains testable; store integration
  tests must return explicit approved results where mounting is expected.
- The implementation is in-memory and has no layout migration. Rollback is
  limited to removing the new IPC/coordinator/store wiring and the docs/tests;
  no user data or agent configuration is changed.
- The current Search interpretation is deliberately documented. A future
  independent Search overlay requires a separate behavioral decision/UI spec,
  not an untyped alias or local state path.

## Handoff Checklist

- [ ] Main coordinator tracks kind, owner, generation, and request token.
- [ ] Close-before-mount handoff and stale-generation checks are covered.
- [ ] WindowManager native close releases overlay state.
- [ ] Every open/toggle/close entry point uses the typed coordinator path.
- [ ] Renderer only mounts approved ownership and resets denied/revoked state.
- [ ] Search/current Session Browser semantics, settings persistence, and palette
      reset/context behavior are covered.
- [ ] Focused unit/renderer tests and a real detached-window E2E scenario pass.
- [ ] Multi-window docs and AGENTS guardrail are updated.
- [ ] Full required checks and `git diff --check` are green or explicitly
      recorded as `UNVERIFIED`.

## Plan Review

Completed by `review-plan`: verdict **APPROVED**.

Coverage checked against the ready spec: all eight requirements, all acceptance
scenarios, the mutual-exclusion decision, the reserved Search interpretation,
the listed non-goals, native-window lifecycle, stale-generation races, and the
required unit/renderer/Electron verification are mapped to T1-T3. Repository
checks confirmed that the named IPC, WindowManager, renderer store/listener,
component, command-registry, documentation, and E2E seams exist in the current
checkout.

Falsification pass: the plan explicitly fails closed when an old owner does not
acknowledge close, serializes interleaved requests, validates sender and
generation on release/ack, releases ownership before WindowManager teardown,
and prevents App rendering from an unapproved local boolean. It does not add a
new Search product or modify unrelated PTY/session/MCP/Jira/transfer behavior.

No blocking or important findings remain. Routine implementation details such
as the exact coordinator helper names and test fixture shape remain bounded by
the existing IPC/store seams and do not change the behavioral contract.

Reviewer limitation: no separate delegation/subagent capability was available
for a blind independent pass in this session, so this is a same-session
repository re-read rather than an independently authored review. The
limitation is recorded for verify-spec; runtime behavior still requires the
planned tests and E2E evidence.

## Implementation Summary

- Added `OverlayCoordinator` as the main-owned, serialized authority. It tracks the
  mutually-exclusive active kind, BrowserWindow owner, monotonic generation, and
  request token; focuses same-kind owners, waits for `overlay:closed` before
  handoff, rejects stale release/ack messages, and releases native-close owners.
- Added typed `overlay:request`, `overlay:release`, `overlay:close`,
  `overlay:focus`, and `overlay:closed` channels through `shared/types.ts`,
  `handlers.ts`, and the existing generic preload bridge.
- Converted the renderer overlay actions to approval-backed projections. Existing
  TabBar, App, Terminal, command-registry, Escape, backdrop, and programmatic
  close callers continue through those actions; `App.tsx` only mounts an
  approved kind/generation. Renderer request tokens and generation checks reject
  delayed approvals/revocations, and focus notifications reveal the owner input.
- Invalidated Session Browser deep-search work on unmount and kept Command
  Palette query/selection state instance-local. Existing Settings persistence and
  Jira credential rules were left unchanged.
- Added main/coordinator, WindowManager, renderer store/component, and Electron
  coverage. All E2E app launches assert `MULTIAGENT_E2E_MINIMIZED=1` behavior;
  overlay focus preserves minimized/background test execution while the owner
  renderer still receives its reveal notification.
- Documented the exclusive singleton policy, close-ack ordering, native-close
  cleanup, current Search/Session Browser scope, and the minimized E2E contract.

## Verification Evidence

- Requirements/scenarios: PASS. `OverlayCoordinator.test.ts` covers both owner
  opening orders, same-owner toggle, same-kind focus, exclusive close-before-
  mount handoff, stale generation rejection, timeout-safe behavior, and native
  owner release. `WindowManager.test.ts` covers detached native close followed by
  a successful next request. Renderer store/component tests cover approved-only
  mounting, non-owner clearing, delayed approval rejection, stale close
  protection, Session Browser unmount result invalidation, Command Palette reset,
  and existing Settings persistence. The new Electron scenario exercises primary
  and detached buttons/shortcuts, repeated opens, focus/reveal, cross-kind
  switching, a committed Settings edit surviving a handoff, Session Browser
  search, Escape close/reopen, and detached native close cleanup while asserting
  one visible dialog globally. The latest targeted rerun of that scenario passed
  in 29.7s after the final Settings-handoff assertion was added.
- Search scope: PASS. Source inspection found no independent Search component or
  shortcut in this checkout; the spec and docs preserve the current Session
  Browser summary/deep search surface and reserve the typed `search` kind for a
  future entry point.
- Non-goals/dependencies: PASS. No PTY routing, session linking, MCP injection,
  Jira credential ownership, polling, file scanning, duplicate registry, or
  unrelated tab-transfer protocol was added by this implementation. IPC channel
  typing and the existing preload bridge type-check cleanly.
- `npm run typecheck`: PASS.
- `npm run test`: PASS, 89 files / 949 tests. The final renderer projection
  fix also covers approvals that arrive after a local close and generations
  revoked by the main-process handoff event.
- `npm run build`: PASS (final run after implementation and test additions).
- `npm run test:e2e`: PASS, 37 tests in 9.2 minutes. Every E2E app launch and
  detached-window creation passed the minimized/background assertion; the
  singleton scenario passed in the final run.
- `git diff --check`: PASS (line-ending normalization warnings only; no
  whitespace errors).
- Independence: four bounded blind-review agents were launched for a source
  audit, but none returned a report before the review attempts were shut down.
  The local audit found and repaired the delayed-approval race recorded above;
  verification relies on the concrete current test/build/E2E evidence, not on
  an unreturned reviewer status.
