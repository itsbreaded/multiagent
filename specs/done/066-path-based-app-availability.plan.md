# Implementation Plan: Reliable PATH-Based Application Availability

Plan Status: completed
Source spec: `specs/done/066-path-based-app-availability.md` (Status: done)

## Verified Repository Facts

- `src/main/ipc/handlers.ts` currently starts one cached VS Code probe inside
  `registerIpcHandlers` with `execFile('code', ['--version'], { shell: true,
  timeout: 3000 })`; the handler `shell:vscode-available` returns that promise.
- `src/renderer/src/App.tsx` invokes `shell:vscode-available` once during
  startup and stores the boolean in the pane store. `PaneHeader` and the
  command registry use that boolean only to gate the existing
  `shell:open-vscode` URI action.
- `src/main/sessions/cliAvailability.ts` already performs asynchronous PATH /
  PATHEXT metadata checks for `claude`, `codex`, and `opencode`. Its private
  `binaryExists` helper returns only a boolean and probes every candidate
  concurrently; its injected `StatLike` seam makes cross-platform behavior
  unit-testable.
- `src/main/ipc/handlers.ts` invokes `detectProviderAvailability` with the
  main process `PATH`, `process.platform`, and `PATHEXT`; provider availability
  is already asynchronous and awaited only by the provider-availability IPC
  path and new-session gating.
- Agent launch commands remain bare tokens and inherit the app PATH, per
  `src/main/sessions/SessionSpawner.ts` and the PTY/PATH guardrails. Existing
  provider behavior must therefore remain boolean-compatible after the helper
  is generalized.
- `src/shared/types.ts` exposes `shell:vscode-available` as a boolean-returning
  invoke channel; no IPC signature change is required.
- Existing focused tests are in
  `src/main/sessions/cliAvailability.test.ts`. Project checks are
  `npm run typecheck`, `npm run build`, `npm run test`, and `npm run test:e2e`.
- The relevant durable mechanism documentation is `docs/sessions.md`; the
  concise non-negotiable belongs in the Sessions & MCP guardrail group in
  `AGENTS.md`.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, R2; PATH/PATHEXT resolution and first-match behavior | T1 | Resolver unit tests for Windows/POSIX, precedence, extension, missing/inaccessible entries |
| R3, R4; no launch/health probe and async checks | T1, T2 | Resolver has only injected async stat I/O; handler/source inspection; focused tests and typecheck |
| R5; VS Code no longer waits for CLI exit and URI behavior remains | T2 | Handler wiring inspection, resolver `code.cmd` regression test, full unit/build/E2E checks |
| R6; reusable result for future commands | T1 | Public generic resolver tests and provider migration |
| R7, R8; unavailable semantics and inherited environment | T1, T2 | Empty/missing PATH tests; handler passes process PATH/PATHEXT; no fixed-path fallback |
| R9; provider and existing-pane behavior unchanged | T1, T2 | Existing provider suite, handler diff inspection, full test/E2E checks |
| S1–S6; normal, slow-exit, missing, directory, precedence, PATHEXT | T1, T2 | Resolver and integration wiring evidence |
| S7; large PATH remains asynchronous | T1 | Deferred/stat seam test plus full test suite |
| S8; future target reuse | T1 | Generic command-name tests beyond provider names |
| S9–S10; provider and running-pane compatibility | T1, T2 | Existing provider tests and unchanged pane/runtime paths |

## Architecture and Data Flow

The main process will own one generic command resolver. It receives a bare
command name and the environment visible to MultiAgent, expands PATH entries
and Windows PATHEXT candidates according to the existing platform rules, and
returns the first matching candidate path or `null`. It performs metadata-only
async filesystem checks and never starts the candidate.

Provider availability will call this resolver for each supported provider and
map the resolved path to the existing boolean `ProviderAvailability` shape.
The VS Code handler will create one cached promise from the same resolver for
the bare `code` command. The renderer and URI opener remain unchanged.

The resolver's return path is intentionally available to future PATH-based
launchers, while this change only consumes its boolean result for providers
and VS Code. No command-launch API is introduced here.

## Implementation Tasks

### T1 - Extract a reusable PATH command resolver and preserve provider behavior (completed)

- Dependencies: Ready spec; no external dependency required.
- Requirements/scenarios: R1–R4, R6–R9; S1, S3–S10.
- Files and symbols:
  - `src/main/sessions/cliAvailability.ts`: extract a public
    `resolveCommandOnPath`-style helper from the existing candidate/stat logic;
    keep `detectProviderAvailability` as the provider-specific boolean adapter.
  - `src/main/sessions/cliAvailability.test.ts`: extend the injected-stat
    fixtures for resolved paths, precedence, platform extension handling,
    directories, inaccessible files, empty PATH, POSIX execute bits, and a
    generic command name.
- Current behavior: provider detection has the correct broad PATH/PATHEXT
  boolean behavior but cannot return a path; candidate construction and stat
  semantics are private to provider detection.
- Implementation change: make command resolution the shared primitive. Preserve
  the current Windows PATHEXT fallback when the variable is absent, use the
  inherited extension order when present, reject non-files, retain POSIX
  execute-bit checks, and select the earliest valid candidate in PATH/extension
  order. Keep all filesystem operations asynchronous and injectable. Update the
  environment field naming consistently at the call sites without changing the
  environment values or PATH policy.
- Invariants and edge cases:
  - A bare Windows command must match PATHEXT candidates such as `.CMD` and
    `.EXE`; an explicit extension must not gain a duplicate extension.
  - A directory with the command name is not a match.
  - Missing or inaccessible candidates are treated as misses.
  - Empty or undefined PATH returns no match.
  - The resolver must not recursively enumerate PATH directories or execute a
    candidate.
  - Existing provider results and one-way settings behavior remain unchanged.
- Verification: focused `cliAvailability.test.ts` assertions cover each branch;
  `npm run typecheck` covers exported types and all call sites.
- Completion evidence: `npx vitest run src/main/sessions/cliAvailability.test.ts` passed
  with 20 tests; `npm run typecheck` passed.

### T2 - Replace the VS Code process probe with PATH resolution and document the invariant (completed)

- Dependencies: T1.
- Requirements/scenarios: R3–R5, R7–R9; S1, S2, S9, S10.
- Files and symbols:
  - `src/main/ipc/handlers.ts`: remove the VS Code `execFile`/promise probe and
    wire `shell:vscode-available` to a cached resolver promise using the main
    process PATH/PATHEXT/platform.
  - `docs/sessions.md`: add the mechanism and rationale for metadata-only PATH
    availability, including the distinction between resolution and health
    checks.
  - `AGENTS.md`: add one concise Sessions & MCP guardrail pointing to the
    sessions documentation.
- Current behavior: the app waits for `code --version` process exit, times out
  slow-to-reap VS Code CLI processes, and turns that timeout into unavailable;
  the actual open action uses `vscode://file/...` independently.
- Implementation change: resolve `code` through T1 once during handler setup,
  expose the resulting boolean promise through the existing IPC channel, and
  leave renderer gating and URI launching unchanged. Remove now-unused
  child-process imports from the handler.
- Invariants and edge cases:
  - The result uses only `process.env.PATH`, `process.env.PATHEXT`, and
    `process.platform` from the main process.
  - No known-installation-directory fallback or shell-profile loading is added.
  - A slow or failed `code --version` process is no longer part of the path.
  - Existing provider detection remains on its current async startup path.
- Verification: source inspection confirms no VS Code process probe remains;
  focused resolver tests cover `code.cmd`; run `npm run test`, `npm run build`,
  and `npm run test:e2e` because startup/IPC/UI gating changed.
- Completion evidence: `src/main/ipc/handlers.ts` now resolves `code` through the
  shared metadata resolver and no longer imports or invokes `child_process` for
  VS Code availability; `AGENTS.md` and `docs/sessions.md` record the invariant;
  `npm run typecheck` passed.

## Cross-Cutting Constraints

- Preserve the PTY no-PATH-rewrite guardrail: detection and app-launched
  sessions see the same inherited PATH.
- Do not add a shell invocation, version probe, timeout, registry mutation, or
  fixed installation path search to answer availability.
- Keep the existing IPC channel names and shared type signatures.
- Keep detection out of the renderer and avoid synchronous filesystem calls in
  the main process.
- Do not alter provider settings persistence, session spawning, pane state, or
  the URI used to open VS Code.

## Risks, Migration, and Rollback

- **PATH semantics risk:** a custom resolver could diverge from Windows shell
  extension order. Mitigation: preserve PATHEXT order and test `.CMD`, `.BAT`,
  and `.EXE` candidates; the resolver remains limited to metadata resolution.
- **Environment risk:** a desktop-launched app may inherit a stale PATH.
  This remains intentional and is documented; the change does not re-read user
  profiles or invent installation paths.
- **False-positive risk:** a file can exist but fail at launch. Availability is
  explicitly only PATH resolvability; launch failure is out of scope. The old
  health probe was not a reliable substitute because it treated slow teardown
  as absence.
- **Rollback:** restore the previous VS Code probe wiring if needed; the generic
  resolver and provider adapter can remain isolated or be reverted together.

## Handoff Checklist

- [x] Resolver returns an ordered matching candidate or `null` with platform tests.
- [x] Provider availability uses the resolver without behavior drift.
- [x] VS Code availability no longer executes `code --version`.
- [x] Existing URI open behavior and IPC types are unchanged.
- [x] Documentation records the metadata-only availability invariant.
- [x] Focused tests, typecheck, build, unit tests, and affected E2E checks are run.
- [x] No debug output or unrelated changes remain.

## Plan Review

Verdict: APPROVED

Coverage and repository checks performed: re-read the ready spec, this plan,
`AGENTS.md`, `docs/writing-specs.md`, `docs/writing-plans.md`,
`docs/sessions.md`, `package.json`, the current handler/provider resolver,
the renderer VS Code consumers, and the existing resolver tests. Every
requirement and acceptance scenario maps to T1 or T2; the plan also calls out
the provider dependency, pane non-impact, PATH/PATHEXT precedence, missing and
inaccessible entries, asynchronous I/O, and the required startup/E2E checks.

Findings: one editorial inconsistency in the handoff checklist said “absolute
match” even though the environment contract does not add a current-directory
parameter; it was corrected to “ordered matching candidate.” No blocking or
important finding remains.

Reviewer limitation: delegation is unavailable, so this is a same-session
blind re-read rather than an independent reviewer. The plan is approved for
technical execution; no unapproved product, security, privacy, cost, or
destructive decision is introduced.

## Implementation Summary

Implemented the reusable asynchronous PATH/PATHEXT resolver in
`src/main/sessions/cliAvailability.ts`, migrated provider availability to use
it, and replaced the VS Code `code --version` process probe in
`src/main/ipc/handlers.ts`. The existing VS Code URI opener and IPC types are
unchanged. Added resolver coverage for Windows precedence/PATHEXT, explicit
extensions, POSIX execute bits, missing/directory candidates, and generic
future command names. Documented the invariant in `AGENTS.md` and
`docs/sessions.md`.

Checks completed:

- `git diff --check` — passed.
- `npx vitest run src/main/sessions/cliAvailability.test.ts` — 20 passed.
- `npm run typecheck` — passed.
- `npm test` — 71 files / 785 tests passed.
- `npm run build` — passed.
- `npx playwright test e2e/startup.spec.ts` — 22 passed.
- `npm run test:e2e` — 26/27 passed; the only failure was the unrelated
  browser-MCP tool-list assertion in `browserMcp.spec.ts`. The same test was
  rerun in isolation and reproduced; no changed file is in the browser-MCP
  path. The affected startup suite passed independently.

## Verification Evidence

Independent verification limitation: no delegated reviewer is available in
this environment. I performed a blind requirements pass from the spec and
plan, then checked the current implementation and evidence below.

### Requirements

| Item | Verdict | Evidence |
| --- | --- | --- |
| R1 | PASS | `resolveCommandOnPath` uses the supplied PATH and Windows PATHEXT; resolver tests cover Windows and POSIX. |
| R2 | PASS | Resolver returns the ordered first candidate; `isUsableCommandFile` requires `isFile()` and treats stat failures as misses; precedence tests pass. |
| R3 | PASS | Resolver source contains only async stat-based metadata checks; handler no longer imports child process or runs `code --version`; source audit confirmed. |
| R4 | PASS | Resolver and provider checks are async; `npm run typecheck`, full unit tests, and startup E2E pass. |
| R5 | PASS | Handler resolves `code`; explicit `code.CMD` test passes; `vscode://file/` action remains present; startup E2E passes. |
| R6 | PASS | Public generic resolver is used by provider adapter and tested with `my-editor`. |
| R7 | PASS | Missing, inaccessible, and directory candidates return unavailable; no health probe remains. |
| R8 | PASS | Handler passes `process.env.PATH`/`PATHEXT`/`platform`; no fixed install-path or profile search was added. |
| R9 | PASS | Existing provider tests and the 22-test startup E2E suite pass; no pane/session code changed. |

### Acceptance scenarios

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| S1 code.cmd present | PASS | Explicit VS Code `code.CMD` resolver test. |
| S2 slow CLI exit | PASS | The old process probe is absent; availability is stat-only, so exit latency cannot affect it. |
| S3 no match | PASS | Resolver returns `null` for missing candidates. |
| S4 directory candidate | PASS | Resolver rejects `isFile() === false`; test passes. |
| S5 PATH precedence | PASS | Ordered Windows candidate test passes. |
| S6 PATHEXT | PASS | PATHEXT order and explicit-extension tests pass. |
| S7 large PATH/asynchronous behavior | PASS | All filesystem calls are async; provider detector retains async startup flow; full unit/typecheck checks pass. |
| S8 future generic target | PASS | `my-editor` resolver test passes. |
| S9 provider compatibility | PASS | 71 test files / 786 unit tests and startup provider E2E pass. |
| S10 existing pane compatibility | PASS | No pane/runtime path changed; startup E2E pane restoration scenarios pass. |

### Non-goals and decisions

- PASS — no installation, update, authentication, configuration mutation,
  registry search, fixed-path fallback, polling, profile loading, or new URI
  behavior was added.
- PASS — resolver uses inherited PATH/PATHEXT and does not launch or health
  check candidates.
- PASS — resolved candidate path is exposed by the shared primitive while the
  current VS Code consumer continues to use a boolean and the URI opener.
- PASS — provider availability remains one-way and existing provider settings
  behavior is covered by the full unit suite.

### Commands and limits

- PASS: `git diff --check`.
- PASS: `npm run typecheck`.
- PASS: `npm run build`.
- PASS: `npm test` — 71 files, 786 tests.
- PASS: `npx playwright test e2e/startup.spec.ts` — 22 tests.
- LIMITATION: `npm run test:e2e` completed 26/27 tests; the sole failure is
  `browserMcp.spec.ts`'s unrelated tool-list assertion. The failing test was
  rerun in isolation and reproduced. The changed files do not touch the
  browser-MCP implementation, and the affected startup E2E suite is green.

No autonomous repair was needed during verification.
