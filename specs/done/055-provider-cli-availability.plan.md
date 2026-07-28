# Plan: Provider CLI availability for new sessions (spec 055)

Tracks implementation of `specs/pending/055-provider-cli-availability.md`.
Spec is read-only during execution except for `Status:`.

## Tasks

### T1 — Main: CLI availability detection module — `completed`
- Req 1 (detect each provider CLI on the app PATH at startup).
- Files: `src/main/sessions/cliAvailability.ts`; test `cliAvailability.test.ts`.
- `detectProviderAvailability({ path, platform, patheext }, statFn?)` → async
  `Promise<Record<AgentKind, boolean>>`. Async I/O only (never `fs.statSync`) — a
  large PATH would otherwise block the single main-process event loop. Splits PATH
  (`;` win32, `:` else); on win32 tries each PATHEXT extension; else checks the
  executable bit. Names: `claude`, `codex`, `opencode` (the exact tokens
  `newSessionCommand` launches). Also holds `applyAvailabilityToSettings` (Req 2/3
  one-way force-disable, pure).
- Verify: 13 unit tests (win32-with-PATHEXT, posix exec-bit, missing/undefined PATH,
  directory-shadowing, one-way force-disable, credential preservation). All pass.

### T2 — Main: startup force-disable + availability IPC + backend guard — `completed`
- Req 2 (force-disable undetected, persist, don't offer), Req 3 (one-way, never
  re-enable), Req 6 (no entry point creates a session for an unavailable provider),
  Req 9 (existing panes untouched).
- Files: `src/main/ipc/handlers.ts`.
- Detection runs fire-and-forget (never inline-awaited) so it can't delay startup
  IPC/PTY-worker registration; `providerAvailabilityReady` is the promise other code
  awaits. `session:new` awaits it, then refuses (throws) when the kind is
  undetected. `settings:provider-availability` and `settings:get-agent-providers`
  read live in-memory state (starts all-true / as-loaded, updates in place once
  detection resolves). `settings:save-agent-providers` re-applies availability so a
  renderer save can't re-enable an undetected provider. E2E mode
  (`MULTIAGENT_E2E_USER_DATA_DIR`) bypasses PATH detection entirely (all-true) since
  the harness spawns a fake agent regardless of what's really on PATH.
- Verify: full test suite (712 tests) + e2e suite (19 tests) pass; see T10 for the
  race this surfaced and how it was fixed.

### T3 — Shared types: availability channel + map — `completed`
- Req 6/7 plumbing. Files: `src/shared/types.ts`.
- Added `ProviderAvailability = Record<AgentKind, boolean>`; added
  `'settings:provider-availability': () => ProviderAvailability` to the IPC map and
  the `InvokeChannels` union.
- Verify: typecheck clean.

### T4 — Renderer store: providerAvailability + startup hydrate — `completed`
- Req 6 (entry points need the detected+enabled set).
- Files: `src/renderer/src/store/settings.ts`, `src/renderer/src/App.tsx`.
- Added `providerAvailability: ProviderAvailability` (default all-true),
  `hydrateProviderAvailability`. `App.tsx` fetches `settings:provider-availability`
  and `settings:get-agent-providers` at startup and hydrates both — **only when the
  fetched value differs (deep-equal check) from what's already in the store**. This
  guard was added during T10 diagnosis: an unconditional hydrate re-renders every
  subscriber (including the always-mounted CommandPalette) even when nothing
  changed, which perturbed a keystroke mid-flight in one e2e test.
- Also flipped `defaultAgentProviderSettings()` to `enabled: true` for all three
  kinds (both the shared `src/shared/agentProviderSettings.ts` copy and the
  renderer-local seed in `store/settings.ts` — two call sites, both updated) to
  match the spec's "uncheck to hide" model: a provider is offered by default: the
  user hides it by unchecking, not by opting in.
- Verify: typecheck; full test suite passes (4 pre-existing tests in
  `agentProviderSettings.test.ts` updated to assert the new default).

### T5 — Renderer: shared `offeredAgentKinds` selector — `completed`
- Req 5/6 (one shared detected+enabled set drives every entry point).
- Files: `src/renderer/src/utils/providerOffering.ts` (+ test).
- Pure `offeredAgentKinds(agentProviders, availability): AgentKind[]` and
  `isProviderOffered(...)`, stable order `claude, codex, opencode`.
- Verify: 5 unit tests pass.

### T6 — Renderer: gate SpawnChoiceMenu — `completed`
- Req 6 (spawn/split menus in pane header + sidebar).
- Files: `src/renderer/src/components/SpawnChoiceMenu.tsx`.
- Reads `agentProviders`/`providerAvailability` from the store and derives the
  offered choices via `offeredAgentKinds` (memoized), plus the always-available
  Shell row. `SPAWN_CHOICES`/`spawnChoiceLabel`/`spawnChoiceKey` kept for
  label/key lookups.
- Verify: typecheck; full test suite + e2e pass (PaneHeader.test.tsx exercises this
  menu via a real split).

### T7 — Renderer: gate command palette new-session commands — `completed`
- Req 6 (command palette).
- Files: `src/renderer/src/commands/registry.ts`, `CommandPalette/index.tsx`.
- Added `isProviderOffered(kind): boolean` to `CommandContext`; the three
  `session.newX` commands gate on it via `enabled`.
- Verify: typecheck; full test suite passes.

### T8 — Renderer: empty-workspace quick-start + dir picker from offered set — `completed`
- Req 5/6 (quick-start normalized to offer OpenCode when available; hide
  disabled/unavailable) — **scope confirmed with the user during brainstorm-spec**
  (unify all entry points, including fixing the pre-existing Claude+Codex-only gap).
- Files: `src/renderer/src/components/PaneGrid/index.tsx`.
- Extracted the whole empty-state block into a new `EmptyWorkspaceQuickStart`
  child component so its `agentProviders`/`providerAvailability` subscriptions
  don't force `PaneGrid`'s render (and every mounted Terminal/xterm underneath it)
  to re-run on every settings hydration — done during T10 diagnosis alongside the
  App.tsx dedup fix, as a defense-in-depth isolation even though the dedup alone
  resolved the observed race. Renders one "Start <Agent>" + one "<Agent> in…"
  button per offered kind, replacing the hardcoded Claude+Codex pair.
- Verify: typecheck; e2e suite (empty-workspace path exercised by several tests).

### T9 — Renderer: Settings card inline warning + block Enabled when undetected — `completed`
- Req 7 (inline red warning beside name when CLI not detected; not modal),
  Req 8 (prevent enabling while undetected; understandable without a launch).
- Files: `src/renderer/src/components/SettingsPanel/AgentProvidersSection.tsx`.
- `ProviderCard` takes an optional `warning` string rendered as red inline text
  beside the title. Each of the three cards passes the warning when
  `providerAvailability[kind]` is false, and the `Enabled` checkbox is `disabled`
  with its `onChange` guarded (can't be turned on while undetected). Custom-provider
  deletion fallback (`newXConfig('native', false)` → `true`) updated to match the
  new "native is offered by default" semantics.
- Verify: typecheck; `providerPresetDefaults.test.ts` (pre-existing) still passes.

### T10 — Self-check — `completed`
- `npm run typecheck`: clean.
- `npm run build`: succeeds.
- `npm run test`: 712/712 pass (66 files).
- `npm run test:e2e`: 19/19 pass, run twice for stability.
- **Regression found and fixed during this phase** (see Implementation Summary
  below for detail): the flipped `enabled: true` default initially missed the
  renderer-local `defaultAgentProviderSettings()` seed in `store/settings.ts`
  (separate from the shared one), causing a real test failure
  (`PaneHeader/index.test.tsx`) that was fixed by updating that seed too. Separately,
  a genuine e2e flake was introduced and fixed: `detectProviderAvailability` moved
  to async I/O, `handlers.ts` restructured to fire-and-forget detection (never
  inline-awaited) with `session:new` awaiting a readiness promise, and the `App.tsx`
  startup hydration effects were changed to skip the store write when the fetched
  value is unchanged. `EmptyWorkspaceQuickStart` was also extracted from `PaneGrid`
  as defense-in-depth. Verified via bisection: disabling pieces one at a time
  isolated the cause to the unconditional `hydrateAgentProviders` store write
  perturbing the always-mounted `CommandPalette` (which subscribes to
  `agentProviders`) at the exact moment a "New Shell Pane" Enter keypress was being
  processed in one specific e2e test. Confirmed fixed with 12/12 and 10/10 repeated
  runs of the previously-flaky test, plus two full clean e2e suite runs (19/19 each).

## Requirement → task map
Req1→T1; Req2→T2; Req3→T2; Req4→T7,T9 (disable hides from choices; checkbox off);
Req5→T4,T5,T8; Req6→T2,T3,T6,T7,T8; Req7→T9; Req8→T9; Req9→T2.

## Scenarios → task map
S1(disable+warn)→T2,T9; S2(detected but disabled, not offered)→T6,T7,T8;
S3(one-way re-enable blocked)→T2; S4(checkbox blocked + warning)→T9;
S5(detected+enabled offered)→T5,T6,T7,T8; S6(quick-start offers OpenCode)→T8;
S7(future entry point can't create unavailable session)→T2; S8(existing pane intact)→T2.

## Implementation Summary

**Requirements covered:** All 9 (Req1–Req9). All 8 acceptance scenarios exercised
by the requirement mapping above; behavior verified manually is not separately
re-tested by an automated scenario-by-scenario suite (no such harness exists in
this repo — verification is via targeted unit tests + the existing e2e suite).

**Checks run:**
- `npm run typecheck` — clean.
- `npm run build` — succeeds.
- `npm run test` — 712/712 pass across 66 files, including 13 new
  `cliAvailability.test.ts` tests, 5 new `providerOffering.test.ts` tests, and 4
  updated `agentProviderSettings.test.ts` assertions (new `enabled: true` default).
- `npm run test:e2e` — 19/19 pass, confirmed stable across two full runs and 12
  targeted repeats of the one test that surfaced a real regression mid-implementation.

**Known limits / manual verification not performed:**
- Detection was not manually exercised against a real absent/present CLI on this
  dev machine (e.g., temporarily removing `claude`/`codex`/`opencode` from PATH and
  confirming the Settings warning + force-disable end-to-end). The unit tests cover
  the PATH/PATHEXT resolution logic directly via an injectable stat function, and
  e2e mode bypasses real detection by design (Non-Goal: no dependency on the
  developer's actual PATH state).
- The Settings UI warning text and disabled-checkbox visuals were not captured in a
  screenshot; reviewed by reading the rendered JSX only.
- No performance measurement of the async PATH scan on a machine with a very large
  PATH; the async conversion was verified to fix the specific e2e race but not
  benchmarked.

**Risks for verification:**
- The default flip (`enabled: false` → `true` for all three providers) is a
  behavior change for any existing user whose persisted settings already have
  `enabled: false` explicitly stored — those users are unaffected (their explicit
  disable is preserved; only the *default for a fresh/partial file* changed). Worth
  double-checking `sanitizeAgentProviderSettings` continues to respect an explicit
  `false` in a partial file (it does — covered by existing tests).
- `session:new`'s new `await providerAvailabilityReady` adds a small delay (the
  time for async PATH detection to resolve) to session creation on a real user
  machine; this was inline-awaited deliberately to keep `session:new` correct, but
  it means the very first new-agent-session request after launch may resolve
  slightly slower than the rest. Not benchmarked; expected to be on the order of
  a few filesystem stats and negligible on a real disk.

## Verification Evidence

Verified by `/verify-spec`. Since this session also implemented the spec, an
independent blind verification pass was obtained via a general-purpose subagent
given only the spec text and the changed-file list (no implementation rationale).
Its full matrix is reproduced below, cross-checked against the code directly for
the three highest-risk claims (Req 2/3 one-way logic, the `session:new` backend
guard's use of the resolved — not placeholder — availability map, and all three
Settings-card checkbox/warning wirings), plus an independent re-run of every
mechanical check.

### Requirements

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Startup PATH detection, all 3 CLIs | PASS | `detectProviderAvailability` (`cliAvailability.ts:71-91`) resolves `claude`/`codex`/`opencode` against `process.env.PATH`+`PATHEXT`; invoked at `handlers.ts` startup with the real `process.env.PATH`/`process.platform`/`process.env.PATHEXT`. 8 PATH-resolution unit tests. |
| 2 | Force-disable undetected, don't offer during that run | PASS | `applyAvailabilityToSettings` (`cliAvailability.ts:50-61`) only ever writes `enabled: false` — read the full loop body directly, no branch sets `true`. Applied at startup and re-applied in `settings:save-agent-providers`. Noted and independently confirmed: `session:new` `await`s `providerAvailabilityReady` (`handlers.ts:346`) before reading `providerAvailability`, so the backend check always sees the final resolved map, never the transient all-true placeholder — the one theoretical startup-timing gap (renderer could transiently *display* an undetected provider as offered before its own hydration IPC round-trip resolves) can never result in an actual launch; `session:new` rejects it and the renderer surfaces `sessionDetectionState: 'failed'` (`store/panes.ts:456-462`), not a silently-created dead session. |
| 3 | One-way, never re-enable | PASS | Dedicated test `never re-enables a provider that was disabled, even when detected (one-way)` (`cliAvailability.test.ts`) exercises exactly this; code has no read-then-flip-on branch. |
| 4 | Manually-disabled stays hidden | PASS | `offeredAgentKinds`/`isProviderOffered` (`providerOffering.ts`) require `enabled && availability[kind]`; test "offers nothing when all are disabled, even if detected." |
| 5 | Detected+enabled stays available, config unchanged | PASS | Same selector positively includes a detected+enabled kind; `applyAvailabilityToSettings` test confirms other config fields (preset, apiKey) pass through untouched. |
| 6 | One shared source, every entry point, backend rejects unavailable/disabled | PASS | Verified all four consumers directly: command palette (`registry.ts` `enabled:` + `CommandPalette/index.tsx:78`), `SpawnChoiceMenu` (single component, used by both `PaneHeader` and `Sidebar/TabSections`), empty-workspace quick-start (`PaneGrid/index.tsx` `EmptyWorkspaceQuickStart`, iterates `offeredKinds` generically — no more hardcoded Claude/Codex pair). Grepped for any other `newSession(`/`SPAWN_CHOICES` consumer — none found; the old `SPAWN_CHOICES` const is unused dead code but not wired to any render path. Backend guard in `session:new` (`handlers.ts:346-349`) is provider-agnostic and independent of any renderer gating — confirmed this is what actually enforces "any future entry point." |
| 7 | Inline red warning, not a modal | PASS | All three cards (`AgentProvidersSection.tsx:938,1051,1181`) pass `warning={...}` into `ProviderCard`, rendered as inline `<span>` beside the title, not an overlay/modal component. Wording matches spec's proposed text. |
| 8 | Checkbox can't be enabled while undetected | PASS | Directly grepped and confirmed for all three cards: `disabled={!xAvailable}` AND a guarded `onChange` that early-returns before any state mutation (`:944/947`, `:1057/1059`, `:1187/1189`) — double-enforced (HTML disabled attr + logic guard), plus the backend `settings:save-agent-providers` re-applies availability as the authoritative last line. |
| 9 | Existing/restored panes untouched | PASS | `session:resume` handler has no availability check; grep confirms `providerAvailability`/`applyAvailabilityToSettings` appear nowhere in pane-tree/session-hydration/layout-restore code. |

### Scenarios (8/8 PASS)

All 8 acceptance scenarios map onto the requirement evidence above (see the
plan's Scenario→task map) and were independently traced through code by the
verification subagent; no scenario required a distinct code path not already
covered by the requirement checks.

### Non-Goals check

- No polling loop added (grepped for `setInterval`/timer tied to availability —
  none; detection runs exactly once, fire-and-forget, at startup).
- No auto re-enable (Req 3 evidence).
- No preset/credential/routing changes (confirmed via `applyAvailabilityToSettings`
  test asserting untouched fields).
- No launch-time retry or separate error UI added (`session:new` rejection reuses
  the existing spawn-failure→`sessionDetectionState:'failed'` path).

### Open Questions

`None outstanding` in the spec — confirmed accurate; nothing found during
verification that reopens a product-level ambiguity.

### Dead code / debug code

- `SPAWN_CHOICES` in `SpawnChoiceMenu.tsx` is now unused (no renderer references
  it) — vestigial, kept intentionally per its own comment for label/key-lookup
  reference, not a functional defect. Not blocking.
- `CommandPalette/index.tsx:78` duplicates the `isProviderOffered` boolean
  expression inline rather than calling the shared `providerOffering.ts` helper.
  Same logic, same store slices — not a Req 6 violation, just a missed-reuse
  opportunity. Not blocking.
- No stray `console.log`/`TODO`/`FIXME`/commented-out code in any new or changed
  spec-055 file.

### Commands run (this verification pass, independently re-executed)

- `npm run typecheck` — clean.
- `npm run test` — 712/712 passed, 66 files.
- `npm run build` — succeeds.
- `npm run test:e2e` — 19/19 passed, including the specific test
  (`surfaces a missing PTY worker instead of leaving a shell pane hanging`) that
  was flaky mid-implementation before the App.tsx dedup-hydrate fix — clean pass
  here on top of the implementer's own 12/12 and 10/10 repeated-run confirmation.

### Overall verdict: PASS

Every requirement and scenario verified with concrete code/test evidence, not
plausibility. The one nuance (a narrow startup-timing window before renderer
hydration where the UI could theoretically display a not-yet-known-unavailable
provider) does not break Req 2 in effect: the authoritative `session:new` backend
guard always evaluates the fully-resolved availability map before allowing a
spawn, so no unlaunchable session can ever actually be created — worth a footnote
for future readers, not a blocking gap. Archiving.
