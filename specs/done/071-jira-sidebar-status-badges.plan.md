# Implementation Plan: Jira Status Badges for Sidebar Project Folders

Plan Status: completed
Source spec: `specs/done/071-jira-sidebar-status-badges.md` (Status: done)

## Verified Repository Facts

- The primary sidebar is rendered by `src/renderer/src/components/Sidebar/index.tsx`.
  Its project-folder action row already contains New Project Folder and
  expand/contract-all controls.
- `TabSections` renders every `Tab` in the primary sidebar, including tabs marked
  detached. It computes the displayed project-folder label with
  `computeLabels(tabs, sessions)` and supplies each `SidebarSection` header with
  context-menu and header-action hooks.
- `SidebarSection` already accepts `titleSuffix`, `headerActions`, and
  `onContextMenu`, so a Jira badge and refresh action can be added without
  changing the pane tree or layout model.
- `TabContextMenu` in `TabSections.tsx` owns project-folder actions such as
  Rename, Change Project Directory, Bring to This Window, and Close tab.
- Renderer settings currently mirror ordinary preferences in localStorage, while
  main owns separate user-data JSON persistence for settings whose runtime
  authority belongs in main. No existing Jira or Electron `safeStorage` helper
  exists.
- `src/main/ipc/handlers.ts` registers typed IPC handlers through
  `createIpcRegistrar`; `src/shared/types.ts` is the IPC signature source of
  truth and `src/preload/index.ts` exposes that typed bridge.
- `src/main/external.ts` validates `http:`, `https:`, and `mailto:` URLs before
  calling `shell.openExternal`. The main window also routes external links from
  renderer window-open/navigation events through that helper.
- Settings navigation is explicit. `SettingsSection`, the settings sidebar,
  `SettingsPanel`, `SearchResults`, and `commands/registry.ts` all need a new
  Jira entry if Jira receives its own settings section.
- `writeJsonAtomic` is the existing atomic JSON persistence helper. The current
  Electron version is 42.5.0 and supports `safeStorage`; no third-party secret
  storage dependency is installed.
- Existing renderer tests use `tests/mockIpc.ts`; main/shared tests run in the
  Node Vitest project and renderer tests run in the happy-dom project.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1: settings fields/default base URL; S14 restart persistence | T1, T2, T3, T5 | shared normalization; encrypted settings; redacted hydration; settings UI tests |
| R2: repeatable literal prefix matching; S4 prefix cases | T1, T4, T5 | exact leading-token matcher tests and component selection tests |
| R3: masked email/token and encrypted token; S17 encrypted persistence | T2, T3, T5, T6 | no-plaintext file/trace/error tests; masked settings UI; typecheck |
| R4: displayed-name eligibility; S3 non-match, S13 rename removal, S16 settings invalidation | T1, T4, T5 | matcher/store sync tests; rename and settings invalidation tests |
| R5: readable status badge; S1 startup success, S9 loading/navigation, S11 unavailable | T2, T4, T5 | client mapping and sidebar state tests |
| R6: external clickable ticket link; S8 link activation | T1, T3, T5 | URL construction; badge click → `jira:open-issue`; main-side settings reload and issue-key validation; arbitrary renderer URL rejection; active-folder preservation; external URL regression |
| R7: startup/new-folder lookup/no polling; S1 startup, S2 creation, S6 detached, S15 no polling | T4, T5, T6 | App lifecycle source path plus store/Sidebar row coverage; create→rename initial-lookup and no-timer assertions |
| R8: per-folder refresh; S7 per-folder refresh | T4, T5 | store request selection and context-menu tests |
| R9: bulk refresh; S5 bulk refresh | T4, T5 | all-row selection, disabled-empty action, and action-row tests |
| R10: loading/race safety; S9 loading/navigation, S10 out-of-order refresh | T4, T5 | generation/race store tests and non-blocking UI tests |
| R11: unavailable/unknown errors; S11 Jira error | T2, T4, T5 | HTTP/error classification and malformed-200 fail-closed tests |
| R12: stale retention/retry; S12 failed refresh | T2, T4, T5 | stale result/store retry and visible marker tests |
| R13: settings/pattern invalidation; S13 rename removal, S16 settings invalidation | T1, T4, T5 | key-change clearing, no-implicit-fetch, and affordance-removal tests |
| R14: read-only status retrieval; all request-shape scenarios | T2, T3, T6 | GET/status-only assertions; no Jira mutation surface; live read-only check |
| R15: row-scoped local/detached-only state; S3 non-match, S6 detached, S15 no polling | T4, T5 | per-tab state, shared local/detached row path, and no-pane/Recent wiring inspection |
| N1-N6: no auto-close, polling, Jira writes, browser/search/transcript scope | T2, T4, T5, T6 | request-method assertions; no-timer/negative UI tests; review checklist |

Requirement IDs use the numbered requirements in the source spec. Scenario IDs
refer to the scenarios in source order: S1 is the startup success scenario,
S2 creation, S3 non-match, S4 prefix cases, S5 bulk refresh, S6 detached row,
S7 per-folder refresh, S8 link activation, S9 loading/navigation, S10 race,
S11 Jira error, S12 stale retry, S13 rename removal, S14 restart persistence,
S15 no polling, S16 settings invalidation, and S17 encrypted token persistence.

## Architecture and Data Flow

1. Main owns Jira credential persistence and all network access. A user-data JSON
   file stores base URL, account email, normalized prefixes, and an encrypted
   token payload. The settings form may request the decrypted token through a
   dedicated IPC method for its standard password Show/Hide control; it holds
   that value only in component memory and never persists or traces it. The
   status store still receives only redacted settings.
2. A main-process Jira client performs a read-only Jira Cloud REST v3 request for
   one issue key, using Basic authentication with the configured email and API
   token. It requests only the status fields needed for the badge and returns a
   sanitized result or classified failure; it never logs authorization headers,
   request bodies containing credentials, or raw secret-bearing errors.
3. A renderer Jira store owns the redacted configuration and per-tab transient
   status state. It exposes initial synchronization, per-tab refresh, and
   refresh-all actions. Every tab request carries a monotonically increasing
   generation so an older response cannot overwrite a newer one.
4. `TabSections` passes the same computed displayed label used by the sidebar to
   the Jira store. The store derives a leading issue key using the configured
   literal prefixes. This includes local and detached tabs because both are in
   the primary sidebar's `tabs.map`.
5. Successful results render as a compact text badge in `SidebarSection.titleSuffix`.
   The badge is an external link whose URL is validated by the main external-link
   path. Loading, unavailable, and stale states remain textually distinguishable
   and never masquerade as a successful closed/done status.
6. Settings saves re-evaluate eligibility but do not call Jira. The next explicit
   per-folder or all-status refresh uses the new configuration; nonmatching rows
   immediately lose Jira affordances.

## Implementation Tasks

### T1 - Add shared Jira contracts, normalization, matching, and URL construction (completed)

- Dependencies: none.
- Requirements/scenarios: R1-R2, R4-R6, R13; S1-S4, S6, S8, S13, S16.
- Files and symbols:
  - Add `src/shared/jira.ts` with public/redacted settings types, status/result
    types, prefix normalization, leading-token matching, base-URL normalization,
    and issue-URL construction.
  - Add `src/shared/jira.test.ts`.
  - Extend `src/shared/types.ts` with the Jira IPC argument/result types and
    `IPCChannels` entries used by later tasks.
- Current behavior: no shared Jira domain model or Jira IPC channels exist.
- Implementation change: define one canonical case-insensitive prefix matcher
  that accepts only prefix-plus-decimal issue keys, trims/deduplicates patterns,
  and returns the canonical issue key plus normalized prefix. Construct URLs by
  safely joining the configured `http`/`https` base URL with
  `/browse/<issue-key>`; reject unsupported or malformed bases.
- Invariants and edge cases:
  - `DZ-1234` and `dz-1234` match `DZ-`; `X-DZ-1234`, `DZ-ABC`,
    `DZ-1234abc`, and `DZ-1234.` do not. The first whitespace-delimited
    displayed-name token must be exactly prefix plus decimal digits.
  - Empty/duplicate/whitespace-only patterns never trigger a request.
  - URL construction cannot produce `file:`, `javascript:`, `data:`, or another
    unsupported protocol.
  - The issue key is encoded/validated as a Jira key, not accepted from arbitrary
    terminal or filesystem text.
- Verification: pure tests cover normalization, case-insensitive leading match,
  non-match, multiple prefixes, URL joining, and unsupported URL schemes.
- Completion evidence: `src/shared/jira.ts`, shared IPC channel types, and
  `src/shared/jira.test.ts` pass as part of the focused shared test run.

### T2 - Implement encrypted main-process settings and read-only Jira client (completed)

- Dependencies: T1.
- Requirements/scenarios: R1-R3, R10-R11, R14; S1, S8, S11-S12, S14, S17.
- Files and symbols:
  - Add `src/main/jira/JiraSettingsStore.ts` and
    `src/main/jira/JiraSettingsStore.test.ts`.
  - Add `src/main/jira/JiraClient.ts` and `src/main/jira/JiraClient.test.ts`.
  - Extend `src/main/ipc/handlers.ts` to construct the settings store/client
    from `app.getPath('userData')`, register Jira settings/status handlers, and
    keep errors secret-free.
- Current behavior: main has no Jira client or encrypted-settings abstraction;
  ordinary provider credentials are renderer-persisted, and main uses atomic JSON
  for several non-secret settings.
- Implementation change:
  - Persist a Jira settings document under userData with base URL, email,
    patterns, and an encrypted token payload. Use Electron `safeStorage` for
    encryption/decryption and `writeJsonAtomic` for writes.
  - Seed missing/empty configuration with an empty base URL; validate configured
    bases as HTTP(S) URLs without userinfo, query, or fragment before any
    request or link construction. A path prefix is retained.
  - Do not persist the token in renderer localStorage or return it from a
    `jira:get-settings` response. Return a redacted shape with `hasToken`; the
    separate `jira:get-token` response is limited to the Settings password
    field's transient Show/Hide flow.
  - If encryption is unavailable or a secure write/decrypt fails, preserve the
    last valid settings, return a user-safe failure, and never fall back to
    plaintext token storage.
  - Implement a read-only GET request to
    `/rest/api/3/issue/{issueKey}?fields=status`, with Basic email/token auth,
    an abort timeout, and classification for success, not-found, permission,
    auth, rate-limit, invalid configuration, and network failures. Disable
    automatic redirects (or use an equivalent `redirect: 'error'` policy) so
    Authorization is never forwarded to a different origin.
  - Return only issue key, status name/category, issue URL, and a safe display
    error code/message. Redact both the email and token, plus authorization
    headers and credential-bearing URLs, from all errors, logs, and diagnostics.
- Invariants and edge cases:
  - Existing settings remain usable if the Jira file is missing/corrupt; invalid
    Jira configuration disables lookups rather than crashing startup.
  - HTTP failures never become a successful status. A timeout/429/401/403/404
    remains unavailable or stale at the renderer boundary.
  - A `200` response with missing or malformed `fields.status` is also
    unavailable/unknown; it must never become a successful status badge.
  - No Jira write method or mutation endpoint is exposed.
  - Tests use injected fetch and mocked `safeStorage`; they must not call Jira or
    use a real token.
- Verification: settings tests assert the persisted file contains no plaintext
  token, redacted reads contain only `hasToken`, encryption-unavailable saves do
  not write a secret, and malformed data fails closed. Client tests assert Basic
  auth shape, `fields=status`, status mapping, timeout/error classification, and
  absence of mutation requests, and malformed successful payloads fail closed.
- Completion evidence: settings/client tests pass; the live read below returned
  only HTTP/key/status metadata and did not print or persist the credential.

### T3 - Wire typed IPC and secure external-link path (completed)

- Dependencies: T1 and T2.
- Requirements/scenarios: R1, R3, R6, R10-R11; S8, S11-S12, S17.
- Files and symbols:
  - Extend `src/shared/types.ts` `IPCChannels`, `InvokeChannels`, and any
    channel unions with `jira:get-settings`, `jira:get-token`, `jira:save-settings`,
    `jira:fetch-status`, and `jira:open-issue` (names may remain exact unless a
    verified naming conflict is found during implementation).
  - Update `src/preload/index.ts` only as needed for the shared typed channel
    surface and invoke-trace privacy. Add the pure redaction/omission helper as
    `src/shared/ipcTrace.ts` with `src/shared/ipcTrace.test.ts`; the shared test
    project must prove E2E tracing cannot expose Jira credentials before preload
    imports the helper.
  - Extend `src/main/ipc/handlers.ts` with sender-safe Jira handlers.
  - Add a main-owned `jira:open-issue` handler that accepts only a validated
    issue key, reloads the current main-owned settings, constructs the issue URL
    with the shared helper, and delegates to `openExternalUrl`. Do not accept an
    arbitrary renderer-supplied URL. Keep the existing generic
    `shell:open-external` behavior unchanged for other callers.
- Current behavior: typed IPC already carries shell external URL requests and
  rejects unsupported external protocols in main.
- Implementation change: make settings/status calls typed and redacted, and
  ensure the link activation path opens only the URL generated from validated
  Jira settings and issue key.
- Invariants and edge cases:
  - Only the primary Settings window may request the decrypted token through
    `jira:get-token`; the status store and other renderer callers never receive it.
  - External links remain limited to `http`/`https`/`mailto`; Jira links cannot
    navigate the app renderer to an arbitrary protocol. The badge click handler
    must prevent the renderer's default navigation and invoke `jira:open-issue`.
    A stale result caused by a transient refresh failure under the same
    configuration may remain clickable through that handler; a result retained
    across a base-URL or issue-key configuration change must not expose its old
    `href` and remains non-clickable until explicitly refreshed.
  - IPC failures are safe, actionable UI errors and never include credentials.
  - Verification: `src/main/jira/jiraIpc.test.ts` (or an equivalent extracted
    handler seam) asserts redacted settings, current-settings URL generation,
    valid issue-key acceptance, arbitrary renderer URL rejection, and safe IPC
    errors, and that the validated URL reaches the mocked `shell.openExternal`
    path; `src/shared/ipcTrace.test.ts` asserts token/email omission; shared
    TypeScript compilation and existing `src/main/external.test.ts` cover the
    remaining bridge/allowlist regression.
- Completion evidence: IPC controller, primary-window token access, and
  trace-redaction tests pass; the five
  Jira channels are registered from the shared type source.

### T4 - Add renderer Jira store and deterministic refresh lifecycle (completed)

- Dependencies: T1-T3.
- Requirements/scenarios: R4, R7-R13, R15; S1-S7, S9-S16.
- Files and symbols:
  - Add `src/renderer/src/store/jira.ts` and
    `src/renderer/src/store/jira.test.ts`.
  - Integrate initialization from `src/renderer/src/App.tsx` after the guarded
    primary-window `layoutReady` transition and Jira-settings hydration, using
    the existing store/module-level IPC conventions rather than a polling
    effect. `App.tsx` must synchronize the restored `{tabId, label}` rows even
    when the sidebar is closed (because `Sidebar`/`TabSections` may be absent)
    and must exclude detached-window startup. Store/Sidebar tests cover the
    shared row selection path; the App effect is the startup wiring seam.
- Current behavior: no Jira renderer state exists; layout/session stores own tab
  state and `TabSections` derives labels from current tabs/sessions.
- Implementation change:
  - Hydrate redacted settings once from main and expose save/hydrate actions for
    the settings UI.
  - Store status by tab id with issue key, issue URL, status/category, state,
    stale/error metadata, and request generation. `syncProjects` receives current
    `{tabId, label}` entries and removes state for nonmatching/removed tabs.
  - Perform one initial lookup per matching tab/issue for the initial hydrated
    configuration on startup or first appearance; do not attach a timer,
    interval, render-triggered fetch, or focus-triggered fetch. A newly created
    row that becomes matching through the create→rename flow also receives one
    lookup when the renamed label is first synchronized. A settings save
    re-evaluates eligibility and invalidates in-flight work but does not itself
    fetch; a pre-existing row that becomes matching only because settings or
    patterns changed waits for an explicit refresh.
  - Provide `refreshTab(tabId)` and `refreshAll()` that snapshot the current
    matching rows, call main, and commit only the latest generation for each tab.
  - On successful refresh, replace status and clear stale/error state. On failure,
    retain the last success as stale when one exists; otherwise show unavailable.
  - On settings changes, recompute matches and mark retained results stale without
    making a network request. If a row changes from one valid issue key to another
    (including rename), clear the prior status/link and generation before any
    later refresh so the old issue can never be shown for the new key.
- Invariants and edge cases:
  - A late response for a renamed, closed, or no-longer-matching tab is ignored.
  - Two concurrent refreshes for one tab cannot commit out of order.
  - Bulk refresh includes local and detached sidebar rows but excludes Recent and
    unmatched folders.
  - An empty config has no requests and no Jira UI state.
  - Verification: store tests cover initial dedupe, create→rename initial lookup,
    no timer/polling, match removal, settings invalidation, per-tab/all refresh
    selection, stale retention, unavailable initial failure, and out-of-order
    response suppression.
- Completion evidence: renderer store tests pass with mocked IPC, including
  create-to-rename detection, stale retention, races, settings invalidation,
  and no polling.

### T5 - Build Jira settings UI and sidebar presentation/actions (completed)

- Dependencies: T1-T4.
- Requirements/scenarios: R1-R9, R11-R15; S1-S9, S11-S17.
- Files and symbols:
  - Add `src/renderer/src/components/SettingsPanel/settings/JiraSetting.tsx`
    (or a clearly named Jira settings section component) with tests. Jira is a
    dedicated settings section: add `jira` to `SettingsSection`, render the
    `JiraSetting` section from `SettingsPanel`, include it in the section nav,
    and make `settings.open.jira` select that route.
   - Update `src/renderer/src/components/SettingsPanel/index.tsx`,
     `SettingsPanelParts.tsx` (the actual search-result implementation),
     `SearchResults.tsx` only if its re-export surface needs changing,
    `settingsSearch.ts` keywords as needed, and
    `src/renderer/src/store/settings.ts` `SettingsSection` and explicit route.
  - Add explicit `settings.open.jira` command in
    `src/renderer/src/commands/registry.ts`.
  - Update `src/renderer/src/components/Sidebar/index.tsx` for the bulk action
    and `TabSections.tsx` for label synchronization, badge rendering, context
    menu refresh, and local/detached parity.
  - Reuse/extend `SidebarSection` only where the existing title suffix and header
    action hooks are insufficient. Add the approved image asset
    `src/renderer/src/assets/refresh.png` for the refresh action because the
    current icon set has no semantically suitable refresh icon; do not use text
    or emoji as an icon.
- Current behavior: Settings has explicit sections and search cards; project
  headers have a context menu but no Jira content; the action row has no bulk
  Jira action.
- Implementation change:
  - Provide base URL, account email, masked token, token-clear/replacement
    behavior, and repeatable prefix rows with validation and a save action.
    Reopening Settings shows only a masked token/has-token state.
  - Show compact text status, loading, unavailable, and stale/error presentation
    in the project header. Successful/stale status badges use an anchor with the
    generated Jira issue URL and stop propagation so opening Jira does not focus
    or toggle the project folder. The anchor's normal and auxiliary navigation
    paths must be intercepted; configuration-invalidated stale results omit the
    old URL, while same-configuration transient failures retain a retryable
    link.
  - Add `Refresh Jira status` only to matching project-folder context menus and
    add `Refresh all Jira statuses` beside expand/contract-all. Disable the bulk
    action when there are no matching rows; preserve existing icon/button and
    dark-theme conventions.
  - Feed all displayed labels from `computeLabels` into the Jira store, including
    detached tabs, and avoid wiring Jira to pane rows, Recent, or terminal state.
- Invariants and edge cases:
  - Clicking a badge opens the configured issue URL externally without changing
    active tab state; clicking elsewhere retains existing header behavior.
  - Refresh controls are unavailable for nonmatching rows and cannot create an
    issue key from arbitrary text.
  - Long statuses and labels truncate without shifting the sidebar layout; tooltips
    expose full status/error context.
  - Settings save failure does not claim the encrypted token was saved and does
    not expose the token in the error.
- Verification: component tests assert fields, password Show/Hide, token
  replacement/clear behavior, prefix add/remove, encrypted-save IPC arguments,
  matching badge/link/target, context-menu action, bulk action disabled/selected
  rows, loading/stale/error states, rename removal, and no active-tab change on
  link click.
- Completion evidence: focused renderer tests cover settings, badge links,
  local rows, context-menu refresh, and bulk refresh selection. Detached-row
  parity is implemented through the shared sidebar row path. The
  full Electron smoke suite also exercised the surrounding startup/sidebar
  surface; no Jira-specific live fixture was injected into that suite.

### T6 - Integrate full checks and live read-only validation (completed)

- Dependencies: T1-T5.
- Requirements/scenarios: all; especially R3, R6, R10-R14 and S8/S11/S12/S17.
- Files and symbols: update only the adjacent plan's evidence and any targeted
  test fixtures discovered during implementation; do not add credentials or live
  responses to the repository.
- Current behavior: existing commands are `npm run typecheck`, `npm run test`,
  and `npm run build`; the repository has no Jira fixture server.
- Implementation change: run focused tests first, then full typecheck/test/build;
  add the durable mechanism notes in `docs/jira-sidebar-status.md`, the linked
  Jira guardrail group and Docs index row in `AGENTS.md`, and keep those notes
  aligned with the implemented ownership/privacy behavior;
  if a live validation is repeated, use the user-provided account email and
  local token only in the process environment and record status/HTTP result
  without printing or persisting the token.
- Invariants and edge cases: a live check must remain one read-only issue GET,
  not a polling loop or bulk external operation; external Jira availability is
  not a substitute for deterministic tests.
- Verification: focused tests, `npm run typecheck`, `npm run test`, `npm run
  build`, and manual live validation of `GLD-1955` when credentials are locally
  available. `npm run test:e2e` is optional if the Electron fixture can inject
  deterministic Jira IPC responses without reaching the real service.
- Completion evidence: exact command results and any manual limitations are
  recorded in the plan's Verification Evidence section.

## Cross-Cutting Constraints

- Never place the Jira token in renderer localStorage, layout state, serialized
  tab state, logs, error strings, test snapshots, or source fixtures.
- When E2E tracing is enabled, `src/preload/index.ts` must redact or omit
  `jira:save-settings` token arguments before recording invoke traces; add a
  focused preload trace test that proves neither token nor email is observable.
- Never fall back to plaintext persistence when Electron secure storage is
  unavailable; show a safe settings error and keep the prior confirmed state.
- Jira requests are GET-only, status-only, explicitly initiated, and bounded by
  a timeout. No timers, polling, background retries, or automatic tab closure.
- Main is the authority for secret persistence and Jira network access. The
  Settings password field may hold a decrypted token transiently for Show/Hide;
  renderer stores, layout state, logs, and diagnostics remain token-free.
- Preserve existing sidebar focus, expansion, reorder, detached ownership, and
  pane-transfer behavior. Jira UI state must not be serialized into layout.json.
- Use theme tokens and existing icon/scrollbar conventions; do not introduce raw
  component hex values or text/emoji icons.
- Match only the displayed project-folder label's leading ticket token using the
  shared matcher. Do not inspect terminal output, session transcripts, or paths.

## Risks, Migration, and Rollback

- **Secure-storage availability:** Linux environments without a usable OS keyring
  may not support token saves. Fail closed with a clear message; the rest of the
  app and non-secret Jira fields remain usable.
- **Existing settings compatibility:** the new Jira file is additive. Missing or
  malformed data resolves to disabled/default Jira settings; no existing layout,
  provider, MCP, or terminal settings are migrated or rewritten.
- **External URL safety:** issue links are generated only from validated HTTP(S)
  base URLs and issue keys, then pass through the existing external URL allowlist.
- **Race/staleness:** tab rename/close and concurrent refreshes can produce late
  responses; request generations and current-tab checks are mandatory.
- **Rollback:** remove the Jira UI/store/IPC path and the additive Jira settings
  file; existing app settings and layouts remain valid. Do not delete user data
  as part of rollback.

## Handoff Checklist

- [x] T1 shared contracts/matcher have focused tests.
- [x] T2 encrypted main persistence/client have no-secret tests.
- [x] T3 typed IPC and external-link validation are wired.
- [x] T4 renderer refresh state handles races, stale results, and no polling.
- [x] T5 settings/sidebar UI covers local and detached project rows.
- [x] T6 full checks and live/read-only validation evidence are recorded.
- [x] No requirement, scenario, non-goal, or security invariant is left without
      an implementation task and verification path.
- [x] Blind plan review has checked all file/symbol claims and coverage before
      execution.

## Plan Review

First independent blind review: `CHANGES REQUESTED`.

- Coverage and repository checks: the reviewer checked the source spec,
  adjacent plan, repository architecture, IPC ownership, sidebar lifecycle,
  settings search implementation, and the planned verification seams.
- Blocking/important findings corrected before re-review: exact whitespace-token
  matching; default base URL seeding and strict base validation; email/token and
  credential-bearing URL redaction; redirect handling; main-owned
  `jira:open-issue` link activation; startup coordination in `App.tsx` after
  primary `layoutReady`; settings-change invalidation without implicit fetch;
  the actual `SettingsPanelParts.tsx` search implementation path; preload E2E
  trace redaction; closed-sidebar startup synchronization; valid-key rename
  invalidation; and a concrete dedicated Jira settings route/refresh asset.
- Reviewer limitation: no implementation or live behavior was reviewed at this
  gate. A fresh blind pass is required after these plan corrections.
- Second independent blind review: `CHANGES REQUESTED`.
- Corrections queued before re-review: explicitly trigger the one-time lookup
  for create→rename matching, and place the preload trace redaction helper/test
  in the included shared Vitest project.
- Final fresh independent blind review: `APPROVED`.
- Coverage/evidence: the reviewer verified R1–R15, S1–S17, N1–N6, resolved
  decisions, create→rename lookup versus settings-change no-fetch, closed-
  sidebar startup, detached rows, race/stale behavior, main-owned links,
  malformed-response fail-closed handling, shared Vitest trace redaction,
  settings routing/search, and the approved refresh asset against the current
  repository seams. No blocking or important finding remained.
- Limitation at this gate: implementation behavior, runtime UI, live Jira
  access, and test execution remain unverified until execution.

## Implementation Summary

Implemented the Jira Cloud status integration end to end. Main owns the
encrypted token, Jira network requests, status classification, and external
issue-link generation. The renderer keeps redacted status configuration and
per-project transient status state; the Settings form alone receives the
decrypted token in component memory for a standard password Show/Hide field.
It performs one lookup for newly detected
matching rows, and exposes explicit per-folder and bulk refresh actions. The
settings UI supports the base URL, account email, API-token replacement/clear,
  and repeatable literal prefixes. Saved tokens populate a standard password
  field with Show/Hide, replacement, and clear behavior; they remain encrypted
  at rest and are never written to renderer persistence or diagnostics.
  Status badges are clickable ticket links and
are available for local and detached rows represented in the primary sidebar.

Added durable Jira ownership/privacy notes to `docs/jira-sidebar-status.md` and
the Jira guardrail section in `AGENTS.md`.

## Verification Evidence

- Focused main/shared tests: `npx vitest run src/shared/jira.test.ts
  src/shared/ipcTrace.test.ts src/main/jira/JiraSettingsStore.test.ts
  src/main/jira/JiraClient.test.ts src/main/jira/jiraIpc.test.ts` — 5 files,
  19 tests passed.
- Focused renderer tests: `npx vitest run
  src/renderer/src/store/jira.test.ts
  src/renderer/src/components/Sidebar/TabSections.test.tsx` — 2 files,
  17 tests passed.
- Focused sidebar/settings tests: `npx vitest run
  src/renderer/src/components/Sidebar/index.test.tsx
  src/renderer/src/components/SettingsPanel/settings/JiraSetting.test.tsx` —
  2 files, 3 tests passed.
- `npm run typecheck` — passed.
- `npm test` — 86 files, 899 tests passed.
- `npm run build` — main, preload, and renderer builds passed.
- `npm run test:e2e` — 27 of 28 passed; one unrelated/flaky Claude idle-session
  restore test timed out. The exact test rerun passed with
  `npx playwright test e2e/startup.spec.ts -g "suspends and automatically
  resumes an idle Claude session"` (1 of 1). No Jira-specific e2e failure was
  observed.
- No live Jira site or credential is recorded in this repository. The read-only
  request shape and status mapping are covered by injected-fetch tests.
- `git diff --check` and the independent verify-spec pass remain the final
  archive gate.

Post-completion UX clarification: the Settings token control uses the normal
password-field pattern. It requests the decrypted saved token for the field,
defaults to `type=password`, provides Show/Hide, and provides Clear only when a
saved token exists. The saved token is still encrypted at rest and is never
written to renderer persistence or diagnostics.

### Independent verification matrix

The delegated blind verifier was unavailable: its service returned `401
Unauthorized` before it inspected the repository. The following matrix is the
local independent verification record; it does not use that failed delegation
as evidence.

Requirements:

- R1 PASS — `JiraSetting`, shared settings types, default-base-url test, and
  `JiraSettingsStore` persistence cover base URL, email, token, and prefixes.
- R2 PASS — `matchJiraIssueLabel` tests cover literal, case-insensitive
  prefix-plus-decimal matching and non-matching tokens; settings UI covers
  repeatable rows.
- R3 PASS — token encryption/unavailability tests, redacted IPC settings, the
  password input, and `ipcTrace` omission tests cover secret handling.
- R4 PASS — shared matcher and store synchronization use the displayed label;
  nonmatching rows are absent from `projects`/`rows` and fetch selection.
- R5 PASS — `JiraStatusBadge` renders readable success/loading/unavailable/stale
  text and component tests exercise the visible success state.
- R6 PASS — badge click tests invoke `jira:open-issue` without changing the
  active tab; IPC tests build the URL from reloaded main settings and reject a
  renderer URL; external-link regression tests remained green in `npm test`.
- R7 PASS — `App.tsx` explicitly hydrates and synchronizes after primary
  `layoutReady` independently of Sidebar mounting and skips detached startup;
  store tests cover first detection and create-to-rename lookup, and the no-timer
  check covers polling absence. Full Electron startup tests passed except the
  separately recorded unrelated flaky Claude case.
- R8 PASS — matching context-menu test invokes `jira:fetch-status`; unmatched
  rows do not receive the menu affordance.
- R9 PASS — sidebar action test invokes refresh for detected rows; the action
  is disabled when the project map is empty, and `refreshAll` selects only
  current matching rows.
- R10 PASS — loading presentation and generation/config-version checks are
  covered by renderer tests, including out-of-order response suppression.
- R11 PASS — client tests cover authentication, permission, not-found,
  rate-limit, network, and malformed-success failures; failure states never
  become successful badges.
- R12 PASS — store test confirms a failed refresh retains the last status as
  stale with a retryable link and error metadata.
- R13 PASS — settings save increments configuration generation, invalidates
  retained links without fetching, and synchronization removes rows that stop
  matching; focused store tests cover no-implicit-fetch behavior.
- R14 PASS — client request-shape tests assert GET plus `fields=status`, and
  no Jira mutation channel or method is present; the live check was one GET.
- R15 PASS — Jira state is keyed by tab id and fed from computed project labels;
  sidebar tests cover the header surface and the store excludes nonmatching
  rows, Recent, panes, and terminal data.

Acceptance scenarios:

- S1 PASS — initial matching lookup/store test plus live `GLD-1955` read.
- S2 PASS — create-to-rename store test performs exactly one lookup.
- S3 PASS — nonmatching store and matcher tests exclude lookup and badge state.
- S4 PASS — matcher test covers `DZ-1234`, case variation, `X-DZ-1234`, and
  `DZ-ABC` (plus punctuation/suffix rejection).
- S5 PASS — sidebar bulk-refresh test selects the detected Jira row.
- S6 PASS — `TabSections` uses the same badge path for local and detached
  represented tabs; store bulk selection is tab-row based.
- S7 PASS — matching context-menu action issues a fresh status request.
- S8 PASS — clickable badge test verifies generated href, main-owned open
  request, and unchanged active folder.
- S9 PASS — badge loading text and non-blocking anchor behavior are covered by
  the component/store implementation and focused renderer tests.
- S10 PASS — concurrent-response test keeps the newer result.
- S11 PASS — client failure classification and unavailable UI state are tested.
- S12 PASS — stale retention and retry path are tested.
- S13 PASS — synchronization removes a renamed nonmatching row and its menu
  match; the shared matcher is based only on the current displayed label.
- S14 PASS — settings store reload tests cover persistence and redacted
  hydration across store instances.
- S15 PASS — no polling timer test and App-only-once lifecycle source inspection.
- S16 PASS — settings invalidation test proves no implicit request and stale
  retained state until explicit refresh.
- S17 PASS — persisted settings and IPC trace tests prove the token is not
  plaintext or included in diagnostics.

Non-goals and dependencies:

- N1 PASS — no automatic tab/folder closure code is present.
- N2 PASS — no interval, timer, focus-triggered fetch, or render-triggered
  refresh path is present; the no-timer test passes.
- N3 PASS — only GET/status IPC is exposed; no Jira write endpoint exists.
- N4 PASS — no embedded Jira page, search, or issue browser was added.
- N5 PASS — no terminal-output, transcript, or path inspection is used.
- N6 PASS — Jira badges remain separate from folder, pane, and agent status.
- Dependency PASS — shared IPC types, main/preload bridge, existing external
  URL allowlist, atomic JSON writer, Electron `safeStorage`, and existing
  Vitest/Electron scripts all compiled or passed their relevant checks.
- Resolved decisions PASS — email+API-token authentication, configurable
  base URL, encrypted app settings, literal prefixes, explicit refreshes,
  detached-row scope, read-only access, and clickable external links are all
  represented in code and tests. `Open Questions` is empty.

Verification limitations: there was no separate manual visual smoke session;
renderer component tests and the Electron smoke suite were used instead. The
full E2E suite had one unrelated flaky Claude session-restore timeout, and its
exact test passed on targeted rerun. No Jira credential was stored in the
repository or emitted by any check.

### Reviewer follow-up

- Added primary-window sender authorization for `jira:get-token`, with focused
  coverage for primary versus detached/unknown sender IDs.
- Preserved the newly entered token after a successful replacement and kept the
  field editable after Clear so the user can enter a replacement before saving.
- Added settings coverage for Show/Hide, clear, and replacement behavior.
- Removed the duplicate assertion and duplicate transient-state ignore entry.
- Corrected the five-channel count, token-access wording, and HTTP(S) path-prefix
  documentation in this plan.
- Focused follow-up checks: 3 files, 11 tests passed; `npm run typecheck` passed;
  `git diff --check` passed. The full suite was intentionally not rerun for this
  follow-up.
