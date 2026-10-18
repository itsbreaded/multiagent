# Implementation Plan: Jira Unanswered Mentions

Plan Status: completed
Source spec: `specs/done/080-jira-unanswered-mentions.md` (Status: done)
Prepared: 2026-10-16
Execution: Completed after the user explicitly invoked execute-spec on 2026-10-16.

Lifecycle status was reconciled on 2026-10-17 after the S08 brainstorm follow-up:
implementation tasks were already complete, so the source spec returned to
`review` and this plan to `completed` before independent verification.

## Verified Repository Facts

- `src/main/jira/JiraSettingsStore.ts` owns `jira-settings.json`, atomic writes,
  encrypted token storage, and decrypted credentials. Its persisted version is
  1. `src/shared/jira.ts` contains sanitized settings/results and URL validation.
  Additive mention preferences must preserve old files and existing badge settings.
- `JiraClient.fetchStatus()` and `testConnection()` use injected `fetch`, Basic
  authentication, timeouts, and `redirect: 'error'`. The current response seam
  lacks headers. `jiraIpc.ts` wraps settings/status/link operations; the actual
  registration and lifecycle owner is `src/main/ipc/handlers.ts`.
- `SessionIndex` currently opens `session-index.db`, sets WAL/busy timeout,
  migrates session/FTS/cwd tables, and uses shared `user_version = 1`. Its
  `create()` catches every initialization error and moves/recreates the whole
  database; the backup helper can unlink files if rename fails. This behavior
  cannot remain once Jira tables share that file.
- Session migration also normalizes legacy single-key session tables and
  rebuilds FTS. Preserve those branches inside the coordinated migration.
  There is no existing general shared migration coordinator to reuse.
- `handlers.ts` constructs the session index unconditionally, then the session
  poller and `DeepSearcher`. Many session handlers and shutdown call the index.
  Recoverable database startup failure therefore needs guarded initialization
  and handlers, not merely a new catch inside Jira.
- `src/main/sessions/sessionPoll.ts:createSessionPoller()` already coalesces
  session scans; it is separate from the proposed Jira refresh coordinator.
  `SessionSpawner` does not depend on the session database, so PTY launch can
  remain available when database-backed features report an error.
- `AppChrome` renders `TabBar`, which is controls-only. Sidebar `TabSections`
  renders project tabs and owns local reorder plus the existing cross-window
  tab transfer MIME. `Tab` means a project pane tree; no feature destination exists.
- `App.tsx` owns layout restore/save/shutdown responses and renders `PaneGrid`.
  `applyLayout()` hydrates the active project; `PaneGrid` keeps hydrated inactive
  terminals mounted. Conditional unmounting of `PaneGrid` would lose that property.
- `layout:save`, its types, `layoutStore.performShutdownSave()`, and renderer
  responses currently carry project tabs and sidebar sizes only. Cwd repair
  rewrites known project data while preserving other layout fields.
- Commands are explicit in `commands/registry.ts`; `CommandPalette/index.tsx`
  builds the context. Pane hotkeys live in `App.tsx:useGlobalKeyboard()`.
  Keeping a hidden project's active tab without guarding these callers would
  let a Jira-view shortcut close or modify a hidden terminal.
- `src/shared/ipcTrace.ts:traceInvokeArgs()` currently omits only settings save
  and connection-test calls. Extend this for comment text and structured drafts.
- Real stores are used in renderer tests; `tests/mockIpc.ts` supplies IPC mocks.
  Vitest's main project runs under Node. `better-sqlite3` is rebuilt for Electron,
  so real SQLite checks need an Electron-run temporary-database harness, not a
  native-module rebuild that changes the developer's installed ABI.
- Read-only live probes recorded in the spec verified identity, enhanced search,
  and comment pagination. A bounded broad query returned 2,000 issues before its
  deliberate stop; 58 inline comment containers were incomplete. A separate
  11-issue candidate sample yielded eight recent incoming mentions/four unanswered.
  This is endpoint/shape evidence, not proof of complete site recall or live writes.
- Existing design references are `docs/prototypes/jira-mentions/02-sidebar-feature.html`
  and the separate `02-real-ticket-context.html` with its JS/CSS. The real-data
  fixture under `local-data/` is ignored and must not become a test dependency.
  Use synthetic fixtures for committed tests. Existing screenshot edits predate
  implementation and are not feature verification.

## Scope and Coverage

R numbers refer to numbered requirements; S numbers are stable acceptance IDs.
Task associations below are the execution verification contract, not completed tests.

| Requirements | Tasks | Principal proof |
|---|---|---|
| R1 | T4, T8 | Authenticated `myself` identity; two synthetic accounts |
| R2 | T4, T8 | Cross-project search with no folder/prefix/JQL settings filter |
| R3Ã¢â‚¬â€œR4 | T3 | Structured identity and same-issue chronological reply matrix |
| R5 | T3, T6, T11 | Count/sort projections, internal selection, validated Open in Jira |
| R6Ã¢â‚¬â€œR7 | T9, T10 | Sidebar reorder/restore, feature view, terminal preservation |
| R8 | T5, T11 | Loading/empty/stale/partial/auth/network/rate-limit states |
| R9 | T3, T4, T5 | Seven-day anchor, old edits, complete issue/comment pagination |
| R10 | T4, T7, T8 | Main ownership, one explicit write path, trace redaction |
| R11 | T5, T7, T8 | Generation/identity/older-refresh race fixtures |
| R12 | T1, T2, T5 | Single database and atomic snapshot/checkpoint publication |
| R13Ã¢â‚¬â€œR15 | T1, T2 | Fresh/legacy/failed/newer schemas and scoped clear/rebuild |
| R16 | T5, T8 | Shared triggers, polling validation and disabled scheduling |
| R17Ã¢â‚¬â€œR18 | T2, T6, T11 | Independent actions and offline absolute-time wake-up |
| R19 | T3, T4, T12 | All returned ticket users, inline insertion/ADF round trip |
| R20 | T7, T12 | Explicit send, no duplicate in-flight request, memory-only drafts |
| R21Ã¢â‚¬â€œR22 | T7, T12 | Confirmed/unknown sends, audience preservation and safe fallback |
| R23 | T8, T10Ã¢â‚¬â€œT12 | Prototype-aligned compact UI, concise labels/state/errors, matching text-field focus treatment |
| R24Ã¢â‚¬â€œR25 | T4, T11 | Context metadata, safe ADF display, full-height chronological comments without nested scrollbars |
| R26 | T2Ã¢â‚¬â€œT5, T7 | Retained evidence, coherent page sets and recomputation |
| R27 | T11 | Reply composer follows attachments, precedes full-height history, and returns to view on selection |

| Acceptance scenarios | Tasks / check family |
|---|---|
| S01Ã¢â‚¬â€œS03 | T11: detail, safe rendering, reply placement, full comment history and compact controls |
| S04 | T6: exact quick snoozes, Monday calculation and timezone persistence |
| S05 | T5, T8: triggers, coalescing, disable/cancel |
| S06 | T8: trace/log/token privacy assertions |
| S07 | T2, T5, T8: access loss, credential removal, malformed rows |
| S08 | T4, T5: constrained candidates, complete pagination, and direct rechecks of known issue IDs |
| S09Ã¢â‚¬â€œS10 | T3Ã¢â‚¬â€œT5: initial boundary, later edits, restart persistence |
| S11 | T2, T3, T6: restored context, evidence and actions |
| S12Ã¢â‚¬â€œS13 | T3, T5: original edit versus reply edit/deletion |
| S14 | T4, T5: pagination consistency and no false removal |
| S15 | T3, T6, T11: group newest-first/comments oldest-first |
| S16 | T4, T8: account identity independent of display name |
| S17Ã¢â‚¬â€œS22 | T3, T4: exact matching, ordering, authors, issue and project boundaries |
| S23 | T4, T5: all required pages or explicit incomplete state |
| S24Ã¢â‚¬â€œS26 | T5, T11: empty/error/late response |
| S27 | T8, T11: internal selection and main-owned external link |
| S28Ã¢â‚¬â€œS30 | T9, T10: counted button/sidebar destination/reorder/restart |
| S31Ã¢â‚¬â€œS33 | T2, T5, T8: cached restart, interrupted scan and identity isolation |
| S34Ã¢â‚¬â€œS37 | T1, T2: migration, preservation and scoped operations |
| S38 | T5, T8: polling validation/off/background count |
| S39Ã¢â‚¬â€œS40 | T2, T6, T11: snooze/dismiss/restore, expiry offline |
| S41 | T3, T7, T12: exact posted ADF and confirmed resolution |
| S42Ã¢â‚¬â€œS43 | T3, T4, T12: cursor placement, dedupe, ambiguous names, draft identity |
| S44Ã¢â‚¬â€œS45 | T5, T7, T12: duplicate/uncertain send and older refresh |
| S46 | T4, T7, T12: unsupported audience opens Jira, never broadens visibility |
| S47 | T3, T5: ambiguous old edited mention included without audit history |
| S48 | T11: composer follows attachments; full comment context uses natural height and selection returns to the top |
| S49Ã¢â‚¬â€œS50 | T4, T7, T12: unrestricted and Service Desk comment audiences are preserved and verified |
| S51 | T11: earlier and later comments are visible at natural height |
| S52 | T11: search and reply fields match the app's existing focus treatment |

Non-goals and decisions: T3/T4 exclude description/plain-text/assignment-based
requests and all project/status filters. T7 exposes only explicit comment creation;
no transitions, edits, deletion, webhooks, or offline sends. T11 omits labels and
attachment downloads. T12 omits rich-text controls/global user search/iframes.
T1/T2 retain the historical database filename and unencrypted cache with encrypted
credentials elsewhere. T9/T10 preserve project transfer ownership and no top tabs.
All tasks preserve the agreed seven-day/refresh/sort/snooze/edit/reply rules.
No other pending spec is a prerequisite; current subsystem behavior is verified
in the source boundaries above rather than assumed from completed specs.

## Architecture and Data Flow

### Main-owned services

Open one application database before constructing `SessionIndex` and a new
`JiraMentionsRepository`. A shared database owner controls migration and final
close; repositories borrow the handle. Keep `SessionIndex`'s existing public
operations and injectable temporary-path seam, but remove its independent
schema-version ownership and blanket whole-file replacement.

A main-owned `JiraMentionsService` owns identity, refresh coalescing, network
concurrency, polling, snooze timers, settings generation, staged publication,
and reply coordination. Renderer windows receive sanitized projections and
request actions through typed IPC; no renderer fetches Jira or stores credentials.
Use small bounded concurrency (initially four issue fetches) and stage complete
issue snapshots so a large search does not accumulate an entire site in memory.
Do not hold a SQLite transaction across HTTP awaits.

### Discovery and classification

1. Scope durable data by normalized site + the `accountId` verified through
   `/rest/api/3/myself`. On restart, unchanged credentials with the durable
   binding below may immediately restore that context's cached/stale snapshot
   and local snooze timers while catch-up verification runs. Changed/unbound
   credentials must hide prior data until identity verification succeeds.
2. Persist `tracking_started_at = initial scan start` and
   `history_from = tracking_started_at - 7 days` once per context. Retrying an
   interrupted first scan does not move either boundary. Cache clear retains
   these anchors and local actions but resets completed coverage/checkpoints.
3. Authoritative discovery uses enhanced search with a fixed lower bound and the
   account-ID comment term:
   `updated >= "<lower bound>" AND comment ~ "<authenticated accountId>" ORDER BY updated ASC, key ASC`
   across all accessible projects. The account ID comes from `/myself`; never
   substitute the display name or enumerate every recently updated issue.
   Initial/full lower bound is `history_from`; incremental lower bound is
   `max(history_from, lastSuccessfulScanStart - 10 minutes)`. Omit a mutable
   upper issue-update filter; commit the scan's start as the checkpoint so updates
   during the scan are revisited. Follow `nextPageToken` to exhaustion and dedupe
   stable issue IDs. Verify candidates against structured ADF before publication.
   No production 2,000-issue cap.
4. Format the JQL time in the verified account timezone when available; round
   down to a minute. If unavailable, broaden the search date by two UTC days
   to cover timezone offsets, and enforce exact comment eligibility locally.
   Never let local timezone interpretation silently narrow history coverage.
5. Request `updated,comment,project` for discovery. The account-ID comment clause
   is a mandatory candidate bound, not the mention classifier: structured ADF
   identity remains authoritative. JQL comment search may index only the most
   recent 1,000 comments on larger histories; this is a documented recall limit
   to track explicitly and is not a reason to fall back to all-updated-issue
   discovery. An inline container is usable
   only when its start/length/total demonstrate a complete visible history.
   Otherwise GET `/rest/api/3/issue/{id}/comment` with `startAt`, `maxResults`,
   and `orderBy=created`, following the server's actual page lengths to total.
   Inspect all pages, including on issues whose first page has no self mention.
6. For actual mention-bearing issues, fetch selected detail fields and available
   user-valued custom fields. GET `/rest/api/3/field` once per configuration
   generation to identify user/array-of-user schemas; select only those custom
   IDs alongside the agreed standard fields. Collect user IDs from field values,
   comment authors and all structured mention nodes; do not query a user directory.
   Permission-limited field discovery leaves available standard/comment users
   usable and does not invent missing users.
7. Explicitly re-fetch every issue with an unanswered state, including snoozed
   and dismissed requests. On incremental scans include changed known answered
   issues; daily/manual full rechecks also directly revisit all known mention
   issues, even if search no longer returns them. Search absence is never proof
   of deletion/access loss. These checks catch edited/deleted reply evidence.
8. When assembling paginated histories, compare issue update/count markers
   before/after, dedupe IDs, and reject gaps, changing totals or conflicting
   versions. Retry one unstable issue once, then mark the run partial. Markers
   do not provide a server snapshot guarantee; preserve old evidence whenever
   coherence cannot be established. Do not remove unseen rows from a partial set.
9. Classify via a pure account-ID/ADF traversal. Eligible incoming comments are
   from another account, mention self, and were created since `history_from`,
   have a known later mention-added transition, or were first observed as an
   old mentioned comment with `updated >= tracking_started_at`. Persist eligibility
   and retain it on recomputation; a known previously mentioned, excluded comment
   does not become eligible on every unrelated edit. No comment audit API required.
10. Traverse complete histories in reverse creation-time groups, maintaining
    later self-reply evidence per mentioned author. Process equal-time comments
    as a group so ties never establish 'later'. A reply must be on the same issue
    and mention the incoming author. An incoming-source edit does not reset its
    creation time; edited/deleted reply evidence can reopen it. Unknown author
    IDs cannot prove resolution. Keep answered/source evidence and display safe
    unavailable identities without name-based matching.
11. Stage complete results; publish fetched rows, mentions, derived states and
    successful checkpoint atomically only when required discovery/checks finish.
    Partial/error/cancel keeps the committed snapshot and successful time, with
    stale/partial feedback. Authoritative permission loss can purge content
    immediately without advancing global coverage. Resetting cache cancels runs.

Search is eventually consistent. Overlap and a daily full recheck mitigate lag;
they are not a claim of instantaneous discovery. Account-ID comment JQL is the
new-issue discovery boundary; do not add an all-recently-updated fallback or
claim exhaustive recall beyond Jira's comment-text index. Full runs directly
recheck known mention issues by ID even when JQL omits them. Do not add a
comment-download cap based on the accepted 1,000-comment index boundary.

### Durable identity binding for cached startup

Extend the existing main-owned `jira-settings.json` with optional private
`mentionsVerifiedIdentity` metadata: context ID, normalized site URL, self account
ID, verified-at instant, and a credential-record key. The key is a SHA-256 digest
of a canonical encoding of the normalized site, stored account email, and exact
encrypted-token ciphertext. It binds the existing encrypted record, not a
plaintext token hash; no credential/email copy or digest is stored in SQLite
or returned by `getSettings`/IPC. Use the encrypted record already owned by
`JiraSettingsStore`, never renderer input, to calculate this internal key.

At startup, require usable secure-storage credentials, a matching key/site, and
a valid referenced SQLite context with that account/site. Then immediately
restore cached data/count/actions and schedule snooze expiry without waiting
for HTTP. A failed offline catch-up leaves this snapshot explicitly stale.
Legacy settings without the binding need one successful verification before
their cache can be bound; no user-specific identity setting is introduced.

Credential/base URL/email changes or token removal invalidate the binding in
the same atomic settings write; poll/prefix/enablement changes preserve it.
Re-encryption/token replacement can conservatively require re-verification.
Capture the old bound context before credential removal so its Jira data can
be deleted after the successful settings save, without relying on erased metadata.
Clear visible/draft state and invalidate in-flight generations immediately on a
successful credential change. Explicit removal must never retain a usable binding.

When `/myself` succeeds, compare the captured service generation AND credential-
record key with the current settings before committing context verification or
publishing data. Persist/validate the SQLite context first, then atomically save
the binding through `JiraSettingsStore` using a compare-current-key operation.
The settings-store write must preserve current credentials/preferences and must
not race by writing an old settings snapshot. Recheck generation/key before any
subsequent broadcast. A delayed old `/myself` response cannot bind new credentials.
If interrupted between the database commit and binding save, restart simply has
no usable binding and re-verifies; it never guesses the previous identity. A
binding-save error is recoverable and must not be reported as durable offline
restoration support. No cross-file atomic transaction is assumed.

### Posting and race ownership

Serialize drafts to ADF in the renderer, then validate again in main against
the current context, issue, selected source and fetched account IDs. Do not
accept arbitrary issue URLs, raw credentials, arbitrary visibility, or raw HTML.
Before sending, revalidate the selected source's visibility with current data.
Standard group/role restrictions must be copied exactly when supported. For
Jira Service Management internal/public audiences or other cases whose audience
cannot be established/preserved through this path, disable posting and offer
Open in Jira; never default an unknown audience to public.

Record an attempt before the only write, POST `/rest/api/3/issue/{id}/comment`.
The service permits one in-flight send per context/issue across windows.
Confirmed response comments enter the same classification path and bump the
fetched generation without advancing discovery checkpoint. A staged refresh
based on an older generation must refetch affected issues before publication
or discard/retry; it cannot overwrite confirmed reply evidence. Local actions
are read at projection time, so a long scan cannot undo a later dismissal.

For explicit HTTP rejection retain the draft and safe error. A transport timeout,
unparseable success response, or interruption after send becomes `unknown`.
On restart, unfinished `sending` attempts become `unknown`; drafts are not restored
from disk. Recheck comments before enabling a new manual send, display uncertainty
if proof is unavailable, and never auto-retry. Hash/text/name similarity is not
authoritative proof of delivery. Known returned comment IDs can be reconciled
directly. This is not an offline queue or a promise of server-side exactly-once POST.

### Navigation and layout

Keep existing project `Tab` and pane-transfer payloads intact. Add a discriminated
workspace destination (`project` or feature ID) and a mixed sidebar order of
project/feature references to the panes/navigation state. `activeTabId` may retain
the last selected project for compatibility, but feature selection is the visible
destination and must gate focused-pane queries, pane actions and drop handlers.
Project selection/focus transitions atomically select its project destination.
Use a narrow feature registry with just `jira-mentions`, not dummy pane trees.

Persist the mixed order, feature-entry visibility, and active destination as
optional layout fields. Older layouts derive project order from their tab array;
ignore invalid/missing references and dedupe feature rows. Restore a feature-only
layout even when `tabs` is empty. If Jira is disabled, use the existing project or
empty workspace as the destination without deleting the saved feature position.

The top-left button toggles visibility of the Jira sidebar entry, matching the
prototype; clicking the entry selects the inbox. If hiding the selected feature,
return to the last existing project/empty workspace. Feature rows reorder in the
same list but do not carry project pane MIME, accept pane drops, or trigger project
tear-off/absorb. Existing project cross-window transfers continue unchanged;
calculate project transfer indices from project references, not mixed-list indices.
Each renderer's feature navigation is local; main data/count/actions are shared.
Only the primary layout is cold-restored, preserving existing detached-window policy.
Include new fields in ordinary save and primary shutdown collection. Detached
project snapshots must not overwrite the primary feature selection/order.

Keep `PaneGrid` mounted under a hidden/inert layer while the feature view is
selected. Prevent hidden terminal focus, shortcuts, quick-start UI, pane drops
and zoom overlays from intercepting the inbox. Restore the project and fitted
terminal sizes when returning. A feature-only cold restore must not hydrate an
inactive project or spawn a terminal. New Project remains available; pane/session
creation commands are disabled while a feature is selected until a project is
chosen, rather than silently modifying the hidden project.

### Draft, display and local actions

`useJiraMentionsStore` projects sanitized main data, request states, selection,
compact search/filter, and memory-only drafts keyed by context + issue. Drafts
use text/mention tokens with stable IDs, not persisted HTML; clearing/changing
credentials invalidates drafts and late responses. Within the runtime, navigation
or failed posting retains draft tokens. Keep description height per issue in
runtime memory, independent of collapse, using a full-width pointer/keyboard grip.

Derive active count and group order from unanswered state plus current actions.
Groups sort by maximum active source creation time descending, then stable ID;
comments sort creation time ascending with stable ID ties. Snoozed/Dismissed
views restore per-comment actions; a different new comment remains active.
Main schedules the next snooze expiry independently of network polling and
recalculates at startup/resume. 'Next Monday' is the next calendar Monday at
09:00 local time (if today is Monday, use the following Monday); save the UTC
instant and show the actual local wake-up time.

## Planned Persistence Layout

The spec's logical table contract is authoritative. This DDL is the planned
storage shape and index-validation fixture; it is not an installed migration.
JSON envelopes below contain the selected fields enumerated in the spec, with
runtime validation on write/read. T1 can adjust incidental column naming without
changing ownership, uniqueness, retained evidence or migration semantics.
All persisted instants below use INTEGER UTC epoch milliseconds; opaque IDs use TEXT.

```sql
CREATE TABLE jira_cache_contexts (
  context_id TEXT PRIMARY KEY, site_url TEXT NOT NULL, self_account_id TEXT NOT NULL,
  tracking_started_at INTEGER NOT NULL, history_from INTEGER NOT NULL,
  identity_verified_at INTEGER NOT NULL, rule_version INTEGER NOT NULL,
  discovery_version INTEGER NOT NULL, committed_generation INTEGER NOT NULL DEFAULT 0,
  initial_scan_started INTEGER NOT NULL DEFAULT 1 CHECK(initial_scan_started IN (0,1)),
  UNIQUE(site_url, self_account_id)
);
CREATE TABLE jira_cached_issues (
  context_id TEXT NOT NULL, issue_id TEXT NOT NULL, issue_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  jira_updated_at INTEGER, metadata_fetched_at INTEGER NOT NULL,
  comment_snapshot_at INTEGER, comment_count INTEGER,
  access_state TEXT NOT NULL CHECK(access_state IN ('visible','partial','unavailable')),
  generation INTEGER NOT NULL, PRIMARY KEY(context_id, issue_id),
  FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
);
CREATE TABLE jira_comments (
  context_id TEXT NOT NULL, issue_id TEXT NOT NULL, comment_id TEXT NOT NULL,
  author_account_id TEXT, author_name TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  excerpt TEXT NOT NULL, visibility_json TEXT NOT NULL CHECK(json_valid(visibility_json)),
  body_hash TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('visible','removed','unavailable')),
  generation INTEGER NOT NULL, PRIMARY KEY(context_id, issue_id, comment_id),
  FOREIGN KEY(context_id, issue_id) REFERENCES jira_cached_issues(context_id, issue_id) ON DELETE CASCADE
);
CREATE TABLE jira_comment_mentions (
  context_id TEXT NOT NULL, issue_id TEXT NOT NULL, comment_id TEXT NOT NULL,
  mentioned_account_id TEXT NOT NULL,
  PRIMARY KEY(context_id, issue_id, comment_id, mentioned_account_id),
  FOREIGN KEY(context_id, issue_id, comment_id) REFERENCES jira_comments(context_id, issue_id, comment_id) ON DELETE CASCADE
);
CREATE TABLE jira_issue_users (
  context_id TEXT NOT NULL, issue_id TEXT NOT NULL, account_id TEXT NOT NULL,
  display_name TEXT, avatar_url TEXT, active INTEGER,
  sources_json TEXT NOT NULL CHECK(json_valid(sources_json)), generation INTEGER NOT NULL,
  PRIMARY KEY(context_id, issue_id, account_id),
  FOREIGN KEY(context_id, issue_id) REFERENCES jira_cached_issues(context_id, issue_id) ON DELETE CASCADE
);
CREATE TABLE jira_mention_state (
  context_id TEXT NOT NULL, issue_id TEXT NOT NULL, incoming_comment_id TEXT NOT NULL,
  author_account_id TEXT, source_created_at INTEGER NOT NULL, source_updated_at INTEGER NOT NULL,
  source_hash TEXT NOT NULL, first_observed_at INTEGER NOT NULL, eligible_edit_at INTEGER,
  eligibility TEXT NOT NULL CHECK(eligibility IN ('initial','new','edit','ambiguous_edit','excluded')),
  state TEXT NOT NULL CHECK(state IN ('unanswered','answered','removed','unknown')),
  resolving_comment_id TEXT, resolving_created_at INTEGER,
  rule_version INTEGER NOT NULL, computed_at INTEGER NOT NULL, generation INTEGER NOT NULL,
  PRIMARY KEY(context_id, issue_id, incoming_comment_id),
  FOREIGN KEY(context_id, issue_id, incoming_comment_id) REFERENCES jira_comments(context_id, issue_id, comment_id) ON DELETE CASCADE,
  FOREIGN KEY(context_id, issue_id, resolving_comment_id) REFERENCES jira_comments(context_id, issue_id, comment_id)
);
CREATE TABLE jira_mention_actions (
  context_id TEXT NOT NULL, issue_id TEXT NOT NULL, incoming_comment_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('dismissed','snoozed')),
  snooze_until INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY(context_id, issue_id, incoming_comment_id),
  FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE,
  CHECK((disposition='dismissed' AND snooze_until IS NULL) OR (disposition='snoozed' AND snooze_until IS NOT NULL))
);
CREATE TABLE jira_sync_runs (
  context_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  lower_bound INTEGER NOT NULL, scan_started_at INTEGER NOT NULL, ended_at INTEGER,
  base_generation INTEGER NOT NULL, config_generation INTEGER NOT NULL, rule_version INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('running','success','partial','failed','interrupted')),
  discovery_complete INTEGER NOT NULL DEFAULT 0, expected_issues INTEGER NOT NULL DEFAULT 0,
  completed_issues INTEGER NOT NULL DEFAULT 0, safe_error_code TEXT,
  PRIMARY KEY(context_id, run_id),
  FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
);
CREATE TABLE jira_sync_state (
  context_id TEXT PRIMARY KEY, last_attempt_run_id TEXT, last_success_run_id TEXT,
  last_success_started_at INTEGER, last_success_ended_at INTEGER, last_full_at INTEGER,
  checkpoint INTEGER, coverage_from INTEGER, coverage_through INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
  retry_not_before INTEGER,
  FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
);
CREATE TABLE jira_sync_issue_work (
  context_id TEXT NOT NULL, run_id TEXT NOT NULL, issue_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pending','complete','failed','access_lost')),
  fetched_at INTEGER, snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
  PRIMARY KEY(context_id, run_id, issue_id),
  FOREIGN KEY(context_id, run_id) REFERENCES jira_sync_runs(context_id, run_id) ON DELETE CASCADE
);
CREATE TABLE jira_reply_attempts (
  context_id TEXT NOT NULL, attempt_id TEXT NOT NULL, issue_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT NOT NULL CHECK(outcome IN ('sending','confirmed','rejected','unknown')),
  body_hash TEXT NOT NULL, mentioned_ids_json TEXT NOT NULL CHECK(json_valid(mentioned_ids_json)),
  returned_comment_id TEXT, safe_error_code TEXT, reconciled_at INTEGER,
  PRIMARY KEY(context_id, attempt_id),
  FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
);
CREATE INDEX jira_issues_updated ON jira_cached_issues(context_id, jira_updated_at);
CREATE INDEX jira_comments_created ON jira_comments(context_id, issue_id, created_at, comment_id);
CREATE INDEX jira_comments_author ON jira_comments(context_id, issue_id, author_account_id, created_at);
CREATE INDEX jira_mentions_target ON jira_comment_mentions(context_id, mentioned_account_id, issue_id, comment_id);
CREATE INDEX jira_states_active ON jira_mention_state(context_id, state, source_created_at DESC, issue_id);
CREATE INDEX jira_states_reply ON jira_mention_state(context_id, issue_id, resolving_comment_id);
CREATE INDEX jira_actions_expiry ON jira_mention_actions(context_id, disposition, snooze_until);
CREATE INDEX jira_runs_outcome ON jira_sync_runs(context_id, outcome, scan_started_at);
CREATE INDEX jira_work_outcome ON jira_sync_issue_work(context_id, run_id, outcome);
CREATE INDEX jira_attempts_outcome ON jira_reply_attempts(context_id, issue_id, outcome);
```

Representative planned query paths: incoming states filter `(context_id,state)`;
comment chronology filters `(context_id,issue_id)` and orders `(created_at,comment_id)`;
self replies add `author_account_id`; target mentions filter `(context_id,mentioned_account_id)`;
pending wake-ups filter `(context_id,disposition)` and order `snooze_until`;
actions join incoming rows by the full context/issue/comment primary key.
There is no independently persisted badge count to drift.

`last_*_run_id` are validated same-context metadata pointers, not cascade FKs:
bounded run cleanup must not delete authoritative sync state. Stage `snapshot_json`
contains fetch versions/count/completeness as well as selected issue/comments/users.
Enforce the `complete` result invariant in repository validation. Context deletion
cascades Jira data; fetched-cache clear explicitly removes states before comments
and issues, preserving contexts, actions and unresolved send metadata. When removing
a source/reply, use tombstones and recompute/clear resolution references before
physical deletion; do not let a reply FK block an ordinary complete refresh.

## Implementation Tasks

### T1 Ã¢â‚¬â€ Coordinate the shared database and preserve startup (completed)

- Dependencies: none. Covers R12Ã¢â‚¬â€œR15, S34Ã¢â‚¬â€œS37. These four requirements form one
  coupled migration/recovery boundary and should be reviewed together.
- Existing files/symbols: `src/main/sessions/SessionIndex.ts` constructor,
  `create`, `migrate`, `close`, backup helper; `src/main/ipc/handlers.ts`
  initialization/session handlers/cleanup; `src/shared/types.ts` IPC declarations.
  New boundaries: `src/main/database/ApplicationDatabase.ts` for ownership and
  migrations, `src/renderer/src/components/DatabaseStatusBanner/index.tsx` for
  recoverable status, mounted in `App.tsx`.
- Change: move legacy session migration into the single versioned coordinator;
  add Jira schema transactionally after version 1 (schema version 2), then add
  the durable initial-scan marker in version 3. Enable foreign keys, WAL and existing
  busy timeout. Existing public `SessionIndex` path-based construction can own a
  connection for tests; production repositories borrow the application handle.
  Close each handle exactly once, after Jira work stops.
- Reject unsupported newer schemas before DDL/version writes. On migration/open
  failure preserve the file and sidecars, report sanitized database status and
  start remaining app functions. Guard index/poller/DeepSearcher initialization
  and every dependent handler: list/search returns an empty collection with a
  visible database error; mutation/repair returns its existing failure shape;
  deep search reports its structured error. Do not perform partial cwd-layout
  repair when the required database repair is unavailable. Session detection
  may still return verified scanner matches without writing an unavailable index.
- Remove blanket rename/unlink/recreate. Actual corruption reports a recovery
  error and preserves original files; no broad recovery framework is required.
  Scoped session/FTS rebuild is the only rebuild path and preserves cwd overrides
  and Jira rows. Do not create another on-disk database.
- Verification: real temporary SQLite under Electron: new creation; populated
  current v1 and supported legacy fixtures; repeated open; failure midway through
  migration with version/data rollback; newer-version bytes unchanged; session
  rebuild keeps Jira and overrides. Simulate database failure during app startup
  and prove shell/project navigation still works with recoverable feedback.
- Completion evidence: migration/recovery fixture results and handler/startup
  regression tests recorded; no production user database used for these checks.

### T2 Ã¢â‚¬â€ Persist fetched evidence, actions and synchronization (completed)

- Dependencies: T1. Covers R12/R17/R26 storage and S07/S11/S31Ã¢â‚¬â€œS33/S37/S39.
- New boundary: `src/main/jira/JiraMentionsRepository.ts`; consumes the borrowed
  database handle. Current application has no Jira cache repository.
- Implement context lookup/verification, validated selected JSON, complete issue
  snapshots, all eleven tables, derived-state storage, staged runs, atomic commit,
  action updates, attempt metadata and sanitized projections. Retain initial
  coverage anchors across retries/rebuild; rule-version recomputation keeps local
  actions keyed by stable site/account/comment identity. Retain excluded mention
  evidence as needed to distinguish known old comments from first discovery.
- Abandoned running scans become interrupted; sending attempts become unknown.
  Clear fetched data/staging independently of local actions/send safety metadata;
  remove all context data when credentials are explicitly removed. Purge forbidden
  content after confirmed access loss; transient failures do not delete it.
  Invalid cached Jira rows trigger a scoped rebuild/stale state, not database wipe.
- Verification: reopen fixture reproduces detail/suggestions/reply evidence;
  crash before commit leaves old snapshot/checkpoint; commit updates both;
  identity A/B collisions cannot cross joins; clear cache preserves actions and
  unknown attempts/session/cwd data; credential removal clears relevant context;
  invalid JSON cannot crash terminal startup. Resolve only the exact context
  named by a matching verified binding, and reject a dangling/site/account-mismatched
  binding. EXPLAIN representative lookup paths.
- Completion evidence: repository fixture results, migration constraints and query
  plans, with no credential or comment content in recorded diagnostic output.

### T3 Ã¢â‚¬â€ Extract structured mentions and classify replies (completed)

- Dependencies: shared DTO definitions may precede T2; integrate storage after T2.
  Covers R3/R4/R26 and classification portions of R5/R9/R19.
- Pure DTO/ADF traversal and identity extraction/eligibility/resolution live in
  `src/shared/jiraMentions.ts`, which is shared by main and renderer. Do not add a
  rich-text library for this scope.
- Implement structured traversal, account-ID dedupe, eligibility described above,
  timestamp-grouped reverse reply matching, source/reply edit behavior and retained
  evidence. Select account IDs without relying on names/email. Plain text remains
  plain; multiple occurrences count once; self-authored mentions are not requests.
- Verification: table-driven S09Ã¢â‚¬â€œS13/S16Ã¢â‚¬â€œS22/S47 with unrelated self comments,
  multiple authors/requests, cross-issue replies, matching names/different IDs,
  missing author, equal timestamps, closed issues, source removal, edited/deleted
  replies, earlier qualifying alternative, ambiguous edited old comment, seven-day
  boundary inclusive/exclusive instants, and source edits that must stay answered.
  Include a synthetic >1,000-comment history so no accidental cap can pass.
- Completion evidence: pure tests prove behavior independent of transport/store/UI.

### T4 Ã¢â‚¬â€ Add paginated, selected-field Jira reads (completed)

- Dependencies: T3 DTOs; repository integration after T2. Covers R1/R9/R25 and
  returned-user extraction for R19 (coupled to the same fetched issue shape).
- Existing: `JiraClient.ts`, `JiraClient.test.ts`, shared `jira.ts`. Add a separate
  mentions client boundary `src/main/jira/JiraMentionsClient.ts`, reusing/extracting
  only the common authenticated request helper from `JiraClient` when useful.
- Provide identity, enhanced search, complete comment history, selected issue detail
  and user-field schema reads. Extend injectable response headers for Retry-After;
  keep status badge calls GET-only with no new scheduling. Search may use POST as
  a read operation. Treat IDs as opaque and use validated current-site URLs.
  Follow page tokens/actual page lengths, detect non-advancing pages, and support
  abort/config generations. Do not fetch all fields, attachment bytes or avatars
  simply because URLs appear in the response.
- Validate source audience metadata for T7. Service-desk/unknown audience falls
  back to Jira unless the supported path can establish and preserve it.
- Verification: mocked transport checks exact route/body/field selection, two
  issue pages, >20 inline comments, >100 comment pagination, no mention on first
  page, malformed/non-advancing pages, schema-limited user fields, dedupe, timeout,
  auth/404/403/429 and redirect refusal. Use sanitized synthetic payloads only.
- Completion evidence: deterministic client tests and bounded read-only smoke
  evidence; no real POST comment needed to validate read behavior.

### T5 Ã¢â‚¬â€ Coordinate refresh, consistency and polling (completed)

- Dependencies: T2Ã¢â‚¬â€œT4. Covers R8/R11/R16 plus R9/R26 consistency; these are one
  coupled refresh lifecycle, not independent renderer effects.
- New boundary: `src/main/jira/JiraMentionsService.ts`; construction/lifecycle in
  `handlers.ts`. Inject clock/timer/client/repository seams for deterministic checks.
- Implement startup/manual/open-if-stale/background/full triggers, one shared
  operation, incremental/full bounds, four-worker fetch queue, independent known
  issue checks, coherent staging/commit, safe partial/stale errors and cached
  restore. Manual full recheck is explicit; daily full runs at first refresh after
  24h and does not add an independent always-on timer when polling is disabled.
- Save retry-not-before and honor Retry-After (seconds or HTTP date) across manual
  triggers/restart; missing header uses bounded backoff, no busy retry loop.
  Settings/site/account changes cancel work and invalidate publication. A manual
  full request during an incremental run queues one full pass rather than silently
  reporting the incremental pass as a full result. Track fetched revisions separately
  from projection/action changes. Abort/close before database shutdown.
- Verify S05/S07Ã¢â‚¬â€œS10/S12Ã¢â‚¬â€œS14/S23Ã¢â‚¬â€œS26/S31Ã¢â‚¬â€œS33/S38/S45/S47 using delayed promises and
  fake clocks: overlap, scan-start checkpoint, full-at-24h, simultaneous windows,
  disabled polling, failed final page/transaction, access purge, changed account,
  mid-page edit/count change, request-budget partial status, interrupted restart,
  Retry-After, known answered issue absent from candidates, and no complete-empty
  claim after a failure. Also verify offline relaunch restores results/count and
  expired snoozes immediately with an unchanged bound credential record, while an
  offline same-site account/token change hides all old content. Delay `/myself`,
  change settings again, then resolve the old response: no old binding or result
  may publish. A zero-count fresh install must distinguish 'not checked'.
- Completion evidence: service tests assert both durable state and broadcasts,
  not just request counts. No live mutation required.

### T6 Ã¢â‚¬â€ Project counts, ordering and local dispositions (completed)

- Dependencies: T2/T3/T5. Covers R5/R17/R18 (coupled inbox projection).
- Implement service/repository actions and pure projection/time helpers in
  `src/shared/jiraMentions.ts` or a focused sibling. Persist dismissal/snooze by
  incoming comment; derive count/group order, filtered views and restoration.
  Schedule nearest expiry independently of refresh and recompute on app resume.
- Verification: S04/S11/S15/S39/S40; multiple comments on one issue; new author
  not suppressed by another's action; expiry offline/across restart; Monday before
  and after 09:00, DST boundary, timezone change; unanswered-but-suppressed remains
  directly rechecked; answered item cannot be revived merely by snooze expiry.
- Completion evidence: fake-clock assertions and shared-window projection results.

### T7 Ã¢â‚¬â€ Post replies with confirmation and audience checks (completed)

- Dependencies: T2Ã¢â‚¬â€œT5. Covers R20Ã¢â‚¬â€œR22, S41/S44Ã¢â‚¬â€œS46.
- Extend mentions client/service only; existing status client/controller remain
  read-only. Implement explicit send with main validation, per-issue in-flight
  lock, source audience recheck, before-send attempt record, ADF POST and confirmed
  ingestion. Keep rejected/unknown outcomes distinct and never auto-resend.
  Preserve drafts in renderer on failure; use main attempt metadata after restart.
- Confirmed result must contain usable identity/time/body/comment ID; otherwise
  delivery is unknown. Bump fetched generation on confirmed result/access purge
  so T5 cannot commit older staged evidence. Recheck before offering a subsequent
  manual send after uncertainty; do not resolve based solely on body similarity.
- Retain Jira's group visibility identifier as well as its display value, and
  confirm the created comment returns the same audience before reporting success;
  a mismatch is an uncertain delivery.
- Verification: mocked 201 response with ID-bearing ADF; missing mentions leaves
  source unanswered; other-author requests remain; one POST for simultaneous
  windows/double clicks; 400/401/403/429/timeout/malformed success; unknown after
  crash; stale refresh after POST; visibility changed before send; standard role/
  group restriction preserved; service-desk/unknown audience sends no POST.
- Completion evidence: exact serialized request, pre-send audience recheck,
  response-audience confirmation, and durable outcome tests. A live write is
  optional only on an explicitly designated disposable Jira issue.

### T8 Ã¢â‚¬â€ Wire typed IPC and configurable Jira settings (completed)

- Dependencies: T1/T5Ã¢â‚¬â€œT7; shared types can be introduced earlier for compilation.
  Covers R2/R10/R11 and settings/identity portions of R1/R16.
- Existing files: `src/shared/types.ts` IPCChannels/InvokeChannels/EventChannels;
  shared `jira.ts`; `JiraSettingsStore.ts`; `jiraIpc.ts`; `handlers.ts` registration/
  cleanup/window load; `src/shared/ipcTrace.ts`; `src/preload/index.ts` typed bridge;
  renderer `store/jira.ts`, `SettingsPanel/settings/JiraSetting.tsx` and
  `SettingsPanel/settingsSearch.ts`. New projection store: `store/jiraMentions.ts`.
- Add sanitized get-state/changed, refresh(mode), get-issue-detail, local-action,
  clear-cache and explicit reply IPC contracts. Main validates context/issue/source/
  recipient inputs against current data; a renderer cannot supply fetch URLs or
  credentials. Require a live registered application window for inbox operations.
  Preserve existing settings-token sender restriction and external-link allowlist.
- Extend persisted settings additively: mentions enabled default false, polling
  default false, interval default 15 whole minutes; validate 5Ã¢â‚¬â€œ240 in main and UI.
  Preserve untouched token and old settings on save; invalid interval drafts must
  not be persisted by unmount autosave. Use the existing form draft/save lifecycle
  and concise labels. Clear cache and full recheck are explicit actions, not scope
  filters. Settings changes broadcast to all windows, cancel stale generations,
  and clear sensitive state on credentials/site/account changes as specified.
- Implement the private durable binding and compare-current-key save described
  above in `JiraSettingsStore`, keeping sanitized settings DTOs unchanged by that
  private metadata. Non-credential saves retain the binding; credential changes
  atomically invalidate it. Test first verification, legacy unbound settings,
  unchanged offline reopen, changed/removed credentials, failed binding save,
  dangling SQLite context, and old verification completing after a newer save.
  Assert no plaintext token, duplicate email or credential key enters SQLite,
  renderer state or diagnostics. A token remains encrypted in the existing file.
- Add metadata-only `database:get-status`/`database:status-changed` for T1's error
  presentation. Never put paths, raw exceptions or content in its payload.
  Omit full reply/comment-bearing calls from IPC trace; response projections are
  not logged. No plaintext token in new stores, layout, DB or diagnostics.
- Verification: S05Ã¢â‚¬â€œS07/S16/S26/S27/S33/S38; persisted v1 settings upgrade/defaults,
  invalid interval/failed save keeps last valid values, disabling cancels polling,
  old identity late payload ignored, detached shares data without duplicate work,
  trace uses secret/body sentinels and proves both absent. Existing status/settings/
  connection/link tests stay green and status lookups acquire no polling/writes.
- Completion evidence: typed channel checks, real-store IPC tests and redaction
  assertions, not logs containing sample credentials/comment bodies.

### T9 Ã¢â‚¬â€ Persist feature destinations beside project navigation (completed)

- Dependencies: shared types; usable data after T8. Covers R6/R7, S28Ã¢â‚¬â€œS30.
- Existing: `store/panes.ts` active/focus/create/close/reorder/applyLayout actions,
  `src/shared/types.ts` layout types, `App.tsx` restore/save/shutdown effects,
  `src/main/ipc/layoutStore.ts` save/load/final merge. New pure boundary:
  `src/shared/workspaceNavigation.ts` for mixed-reference normalization/reordering.
- Add the destination/order model described above without changing project Tab,
  rootNode or transfer ownership. Normalize missing/duplicate/unknown references,
  project creation/deletion/transfer and hidden feature row positions. Only
  project navigation hydrates terminal runtime. Update save dependencies, final
  shutdown state response and main merge, not just ordinary `layout:save`.
- Verify old layout compatibility, feature-only layout restore, active Jira with
  inactive unhydrated project, reordered folder/feature references, close last
  project, disabled feature fallback and primary shutdown while detached project
  snapshots arrive. `layoutStore` cwd repair and `.bak` preserve extra fields.
- Completion evidence: pure navigation, real panes-store and layout-store tests;
  no PTY spawn for feature-only restore and no duplicate terminal hydration.

### T10 Ã¢â‚¬â€ Render counted sidebar navigation and gate terminal actions (completed)

- Dependencies: T8/T9. Covers R6/R7/R23, S28Ã¢â‚¬â€œS30 and terminal preservation.
- Existing: `TabBar/index.tsx`, `Sidebar/index.tsx`, `Sidebar/TabSections.tsx`,
  `App.tsx:useGlobalKeyboard()`/content/drop handlers, `PaneGrid/index.tsx`,
  `CommandPalette/index.tsx`, `commands/registry.ts`, `styles/theme.ts`.
- Render counted top-left launcher and feature row mixed with project folders;
  use existing theme tokens, shared scrollbars and PNG assets. Use the supplied
  `notifications.png` bell for Jira mentions in both locations; keep `book.png`
  for the Session Browser. Do not implement prototype text/emoji icons.
- Keep terminal layers mounted/inert while Jira occupies workspace. Gate pane
  keyboard/palette actions, project-only focus queries and pane drops using the
  active destination. Existing project focus/transfer acknowledgements remain
  atomic. Add explicit commands for opening Jira, refresh/full recheck, cache clear
  and relevant selected-comment actions; pass selection/context through
  `CommandContext`, with enabled predicates. Keep `settings.open.jira`.
- Verify count/entry toggle/selection/no top tabs, first/middle/last drag placement,
  project transfer with interleaved feature row, pane drag rejection, hidden project
  Close/Split/New Shell safety, returning to unchanged terminal/scrollback and
  feature-only startup. Settings/Session Browser/Palette remain existing singletons.
- Completion evidence: real-store component tests plus isolated Electron navigation
  smoke. No duplicate pane mounting or PTY ownership change due to feature selection.

### T11 Ã¢â‚¬â€ Build the inbox list and connected issue detail (completed)

- Dependencies: T6/T8/T10. Covers R5/R23Ã¢â‚¬â€œR25; these are one agreed detail surface.
- New boundaries: `src/renderer/src/components/JiraMentions/index.tsx`,
  `IssueDetail.tsx`, `AdfContent.tsx`, using existing theme/scrollbar patterns.
  Treat prototype CSS/JS as visual/interaction reference, not production transport.
- Render compact search/view/refresh row, last check/error/partial state, grouped
  comments and selected detail. Provide explicit Open in Jira through main IPC.
  Show agreed optional metadata and all fetched context comments at natural
  height; omit labels. Place the reply composer directly after attachments and
  before comment history. Reset the detail pane to its top when selection changes
  so the composer stays in view. Keep Snooze/Dismiss beside the source comment header.
  Keep the description as a flat section with top/bottom rules; unwrap ADF
  panel content rather than introducing a generic card. Let it size to its
  content within the smaller of 35% of the detail viewport or 360 px, then
  scroll internally. Keep its full bottom edge draggable; manual resizing
  removes the automatic max-height. Give the selected mention body its own
  full-width resize handle and unbounded manual height, separate from the
  reply editor. Color status by Jira category, use the prototype's neutral issue-type
  chip and gold priority, and keep assignee plain.
- ADF is React-rendered via an allowlisted node/mark renderer, never raw HTML.
  Unknown nodes fall back to safe text; links must be validated before main opens
  them. Do not auto-load remote media/avatar/attachment URLs. Extend the existing
  main external-link controller for explicitly clicked validated links, with no
  credential URL or renderer `window.open` bypass.
- Verification: S01Ã¢â‚¬â€œS03/S15/S24Ã¢â‚¬â€œS25/S27/S39Ã¢â‚¬â€œS40; available/missing values; malicious
  ADF/link payload; 100+ visible comments with no horizontal page overflow; actions
  update count/order; left/center/right bottom drag keeps width; collapse/scroll;
  concise labels/no helper paragraphs. Check actual Electron pointer resize and
  keyboard behavior, since DOM layout emulation alone is insufficient.
- Completion evidence: renderer assertions plus checked-in synthetic Electron
  screenshots of the populated inbox, permission-error/empty inbox, and bounded
  long-description detail in `docs/prototypes/jira-mentions/evidence/`. Preserve
  both existing 02 prototypes.

### T12 Ã¢â‚¬â€ Implement natural inline mentions and reply drafts (completed)

- Dependencies: T3/T7/T8/T11. Covers R19/R20/R22 and composer portions of R23.
- New boundaries: `components/JiraMentions/ReplyComposer.tsx` and a focused pure
  editor token/ADF helper, shared with main validation where appropriate.
- Implement plain text/line breaks plus atomic inline mention tokens at selection;
  @ suggestions use fetched issue users, account-ID dedupe and author-first empty
  query. Keyboard arrows/Enter/Escape and pointer selection retain the cursor.
  Preserve IDs and text ordering through edits, deletion, draft save/restore and
  plain-text paste. No pasted HTML, hidden recipient or name-to-ID guess.
  Distinguish duplicate names with available role/source context; omit unavailable
  name-only recipients rather than selecting an arbitrary ID.
- Keep drafts only in the runtime store, keyed by site/account/issue. Explicit
  Post reply sends validated ADF and selected source context; empty/mention-only
  drafts without nonblank reply text cannot post. Retain text on rejected/unknown
  delivery; show uncertainty and allow recheck before another explicit send. Clear
  a successful draft only if it is still the submitted draft, not a newer edit.
- Verification: S41Ã¢â‚¬â€œS46 with text-before/mention/text-after, multiple mentions,
  mid-string insertion, multiline/paste, selection replacement, token backspace,
  duplicate names, raw typed @name, no-mention reply, navigation restoration,
  context switch, send failure/double-click and edit-during-send. Use real-store
  component checks plus an Electron cursor/selection round-trip and exact ADF POST
  captured by the synthetic server, without live Jira writes.
- Completion evidence: editor serialization and integration assertions; no draft
  text in SQLite/layout/localStorage/trace; successful reply follows T3, not UI guess.

### T13 Ã¢â‚¬â€ Verify the integrated feature and document ownership (completed)

- Dependencies: T1Ã¢â‚¬â€œT12. Covers every R/S via the coverage matrix, not a substitute
  for each task's isolated checks.
- Existing files: `e2e/startup.spec.ts`, `playwright.config.ts`, `package.json`,
  `docs/jira-sidebar-status.md`, `docs/multi-window-and-layout.md`, `docs/testing.md`,
  `AGENTS.md`. New test boundary: `e2e/jira-mentions.spec.ts` with an inline loopback
  synthetic Jira HTTP fixture; new Electron SQLite harness
  in `scripts/electron-database-smoke.ts` and its Node launcher. These artifacts
  were added and exercised during this execution.
- Use the existing isolated E2E user-data/home mechanism. Generate fake encrypted
  credentials inside the launched Electron process; never read the developer's
  Jira settings or ignored real-data snapshot. The loopback server supplies paging,
  edits, access failures and successful/unknown synthetic reply responses.
- Run `npm run typecheck`, targeted main/renderer tests for touched boundaries,
  Electron SQLite migration/reopen harness, `npm run build`, then the new inbox
  E2E and existing affected startup/sidebar/transfer/terminal/overlay checks.
  Include reload across durable state, snooze wake-up offline, failed scan retry,
  fresh/v1/newer DB startup, two windows sharing one refresh/count/send lock,
  preexisting terminal output/scrollback after inbox switches, and final shutdown
  restoration of the mixed order. Broad test runs resolve integration risks;
  do not add repeated optional sweeps after sufficient evidence.
- Update the existing Jira subsystem doc to cover the inbox and narrow the old
  no-polling/no-writes wording specifically to status badges. Add concise matching
  guardrails/doc index text for main-owned inbox writes, shared DB scoped recovery
  and navigation; preserve status-only constraints. Document migration mechanism
  in the cohesive Jira/session doc rather than prose in AGENTS. No release,
  publish, version bump, real Jira write or archive is part of this task.
- Completion evidence: task-level R/S/decision/non-goal PASS/FAIL/UNVERIFIED matrix,
  exact commands/results and honest runtime limitations. The independent
  `verify-spec` gate was completed on 2026-10-17; its matrix and final limits are
  recorded below.

## Cross-Cutting Constraints

- All new module names above are planned additions; existing paths/symbols were
  inspected. Verify line locations against the worktree before execution.
- Main owns credentials/network/database/scheduling; renderer owns presentation
  and memory-only drafts. IPC DTOs never carry the token to inbox consumers.
- The user authorized the reply feature, not arbitrary live test posts. Deterministic
  test POSTs go only to the isolated loopback fixture. Live write smoke needs a
  designated disposable issue and explicit authorization.
- No project allowlist, user-configured JQL, automatic resolution by status, top
  tab strip, terminal-as-inbox, iframe, global directory, labels or rich-text scope.
- No terminal env/PATH/PTY flow-control/session hook changes. Preserve lazy project
  hydration, mounted terminals, focus atomicity, multi-window transfer generations,
  overlay singleton ownership, settings token restrictions and allowlisted links.
- Added preference defaults are reversible implementation defaults: mentions off,
  polling off, interval 15; initial eligibility is the user-approved seven days.
- Stable context identity survives token rotation/rule change; invalidate identity
  verification on credential changes, reverify those changed credentials before
  displaying/sending. Unchanged bound credentials restore cached data offline
  while catch-up verification runs. Same verified site/account may reuse its
  cache/actions; another account never can.
- Local actions cannot be undone by network publication. Clearing fetched cache
  retains first-load anchor, actions and unresolved-send metadata; removing
  credentials deletes the associated Jira context. No second SQLite file.

## Risks, Migration, and Rollback

- Broad discovery can exceed thousands of changed issues. Select small fields,
  reuse complete inline comments, fetch incomplete histories with bounded workers,
  and expose partial progress/failure without a false success checkpoint. The live
  probe is not a performance SLA or a complete-recall result.
- Jira search/indexing and multi-page reads are not atomic. Overlap, direct known
  issue checks, before/after markers and daily full rechecks mitigate known gaps.
  New edit eligibility deliberately tolerates a small false-positive ambiguity;
  do not build an audit-history subsystem to eliminate it.
- Threaded/new ADF forms or JSM audiences may be unsupported. Preserve safe text,
  classify structured visible mentions where possible, and use Open in Jira for
  replies whose audience cannot be preserved. Do not broaden permissions.
- SQL work is additive and transactional. Preserve version-0/1 session migrations,
  session rows/FTS/cwd overrides, settings and layouts. A failed/newer schema is
  not corruption and must not be renamed/deleted/downgraded automatically.
- Turning the feature off is the operational rollback: cancel work and hide its
  destination while retaining cache/actions. Do not implement a downgrade that
  drops Jira tables; old binaries cannot be retroactively given new-schema guards.
- Database corruption can affect all tables in the shared file. Preserve original
  bytes and report recovery status; broad salvage/automatic destructive recreation
  is outside scope. Keep this change limited to safe startup and scoped operations.
- Real write permissions/recipient notification behavior and restricted audiences
  are not proven by read-only probes. Record missing live verification honestly;
  deterministic API/UI tests are required regardless of live access.

## Execution Handoff

- [x] Approved plan followed in dependency order; implementation and docs are in
  the shared worktree, with earlier user changes preserved.
- [x] Shared-database migration smoke covers fresh, legacy/v1, rollback, unsupported
  newer schema, scoped session rebuild and Jira repository publication/action clear.
- [x] The synthetic Jira loopback E2E verifies discovery, inline account-ID insertion,
  exact ordered ADF reply, confirmed count update and saved feature navigation.
- [x] Full unit, typecheck, build and isolated Electron E2E checks pass; details and
  acceptance limits are recorded below.
- [x] Independent `verify-spec` review completed; required evidence repairs and
  the final verification matrix are recorded below.
- [x] No live Jira comment was posted; restricted-audience live behavior remains
  unverified. This spec and plan were archived after verification; no release,
  publish or version bump was performed.

## Prior Pre-execution Plan Review (2026-10-16)

Verdict: **APPROVED** Ã¢â‚¬â€ independent blind review and bounded correction review,
2026-10-16. No blocking findings remain.

Completed one coverage pass over R1Ã¢â‚¬â€œR26, S01Ã¢â‚¬â€œS47, the cache/model contract,
non-goals, resolved decisions and cited dependencies, then one targeted
falsification pass. The task matrix covers the contract. The initial pass raised
B1 below; the bounded correction review confirmed its resolution without a
behavioral-spec change.

**Resolved B1 Ã¢â‚¬â€ Offline cached startup and identity isolation.** The initial
plan gated cached display on startup `/myself` without a durable credential
binding, leaving S31/S33/S40 incompatible offline. Discovery step 1 and the new
Durable identity binding section now specify private settings-owned verified
context metadata keyed to the current encrypted credential record, immediate
cached/stale restoration for unchanged bound credentials, and hidden prior data
for changed/unbound credentials. Atomic invalidation, compare-current-key save,
generation checks, database-before-binding ordering and recoverable binding-save
failure cover stale responses and interruption without a cross-file transaction.
T2/T5/T8 explicitly require offline restart/snooze, credential change/removal,
dangling-context, failed-save and delayed-identity checks. No required correction
remains.

Repository checks performed: inspected `SessionIndex` creation/migration and
whole-file fallback, `handlers.ts` database/Jira construction, `layoutStore`
save/shutdown merge, `App.tsx` restore/save/hotkeys, panes-store activation and
hydration, `PaneGrid`, `TabSections` reorder/transfer boundaries, Jira settings/
client/IPC/trace code, and existing settings/session/panes test seams, Vitest
projects and isolated E2E launch setup. The proposed shared migration owner,
scoped rebuild, generation protection, mounted-terminal navigation and explicit
reply paths have concrete current integration points and planned isolated checks.
Coverage of non-goals and decisions is preserved; no external-side-effect choice
was added by this review.

Correction evidence: re-read current S31Ã¢â‚¬â€œS33/S39Ã¢â‚¬â€œS40, the revised discovery,
binding, T2/T5/T8 and cross-cutting sections; checked them against the current
`JiraSettingsStore` encrypted-record/save lifecycle and `writeJsonAtomic` helper.
The proposed binding is a new implementation obligation with a real main-owned
storage seam; it is not claimed to exist today. The bounded falsification pass
considered unchanged offline startup, changed credentials on the same site,
stale `/myself`, missing context, save failure and interruption between stores.

This paragraph records the independent pre-execution plan review. Its stated
limitations apply to that review only; implementation and verification evidence
are recorded below. Live writes and restricted-audience behavior remain
UNVERIFIED.

## Plan Review (2026-10-17)

Verdict: **APPROVED**. This is an independent review of the current plan against
the ready spec, performed after the earlier pre-execution review and plan
revision. The earlier review remains above as history; this verdict is based on
fresh source and test inspection.

### Coverage

| Contract area | Review result |
|---|---|
| Requirements R1-R26 | Every requirement maps to concrete tasks and a proof path. Identity, all-project candidate scope, structured matching, ordering, UI, refresh/error states, bounded discovery, privacy, stale-response handling, shared SQLite ownership/migrations, polling, local actions, reply behavior, context detail, and recomputation are covered across T1-T12. |
| Scenarios S01-S47 | Every scenario maps to task-level verification, with concrete test seams named in the tasks. S46's unsupported-audience fallback is specified and tested synthetically; real restricted-audience behavior remains explicitly UNVERIFIED. |
| Non-goals | The listed exclusions map to the T3/T4/T7/T11/T12 constraints and the cross-cutting boundaries; no implementation task adds issue-label display, broad Jira writes, directory search, an embedded Jira view, or an offline send queue. |
| Resolved decisions | The seven-day initial boundary and edit eligibility, account-ID candidate JQL, strict same-issue reply chronology, snooze instants, explicit inline-recipient replies, shared database and scoped recovery, sidebar navigation, and accepted JQL index limit all have matching architecture and task coverage. |
| Dependencies | The existing settings/client, shared database/session rebuild, validated external-link path, workspace/sidebar ownership, and multi-window behavior have identified source seams and verification paths. The pending-spec inventory contains no additional prerequisite. |
| Risks and verification | Search scale/index limits, non-atomic pagination, partial publication, ambiguous old edits, restricted audiences, shared-database recovery, rollback, and live-write limits are stated with corresponding mitigations or explicit verification limits. |

### Repository and falsification checks

Inspected the current `ApplicationDatabase` migration owner and `SessionIndex`
integration; the Jira client/service/repository and settings identity binding;
the shared ADF classifier; the sidebar/workspace destination and layout-save
paths; and the corresponding client, service, repository smoke, component, and
Electron E2E test seams. The proposed boundaries are real and the sequencing
keeps database ownership before repository work, service behavior before IPC/UI
integration, and workspace navigation separate from project pane ownership.

The discovery design matches current code: `comment ~ "<accountId>"` is paired
with the issue-update bound, search pages are followed to completion, known
tracked issue IDs are checked directly, and complete comment histories are read
without a 1,000-comment download cap. Atlassian's [JQL fields documentation](https://support.atlassian.com/jira-software-cloud/docs/jql-fields/)
confirms that the comment index searches only the most recent 1,000 comments on
larger issues, supporting the plan's explicit recall limitation. The current
[issue comments API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
documents the Add comments permission and the request's visibility field; the
plan safely preserves supported group/role restrictions and disables posting
for unknown/service-desk audiences.

The transactional repository publication, generation checks, identity-bound
offline restoration, unsupported-audience fallback, and feature navigation all
have concrete source and test seams. The review found no missing requirement,
scenario, consequential decision, dependency, or blocking verification path.

The targeted falsification pass checked the cases most likely to invalidate
the design: a tracked issue omitted from JQL is fetched by ID; incomplete or
unstable comment pages cannot publish deletions; old credential/identity
responses cannot bind or publish after settings change; unknown and service-desk
audiences cannot reach the comment POST; and scoped session rebuild preserves
Jira tables. The current implementation and named tests provide seams for each
case.

### Findings and limits

- **Blocking findings:** none. No required corrections remain.
- **Non-blocking plan-as-built follow-up:** The earlier draft named a planned
  `src/main/jira/mentionRules.ts` boundary and omitted the schema-v3
  `initial_scan_started` column from the illustrative DDL. This plan-as-built
  pass corrected both: the classifier path now matches the shared implementation,
  and the DDL includes the migration field.
- **Reviewer limits:** source and test files were inspected, but tests were not run and no Jira tenant was called. Actual comment POST behavior and restricted-audience round-tripping remain UNVERIFIED, as required by the authorization boundary in the spec. Plan approval is only a readiness gate; `verify-spec` must resolve the remaining behavioral evidence before archive.

## Implementation Summary

Implemented the shared `session-index.db` owner and schema version 3, the Jira
mentions repository/client/service, shared structured-mention classifier,
persisted initial-scan anchors, account-bound cached projections, refresh and
reply IPC, settings, workspace destinations, counted sidebar entry, commands
and the inbox/detail/reply UI. Status badge calls remain read-only; comment creation
uses one explicit main-owned Post reply path. Added synthetic main/component/store
tests, an Electron SQLite smoke harness and an isolated loopback Jira E2E. Reply
visibility carries Jira's stable group identifier through storage and POST;
unexpected response visibility remains an uncertain delivery.

The detail, safe ADF renderer and reply composer remain in
`src/renderer/src/components/JiraMentions/index.tsx` instead of the plan's proposed
three component files. They share selected-issue, cursor, suggestion and draft
state; keeping the controlled editor lifecycle together avoided introducing a
second state boundary. This is a file-boundary adjustment only; behavior/scope is
unchanged. The nested-pane E2E keeps its original `>100` frame assertion but now
waits up to 15 seconds for Windows PTY output to reach it rather than sampling at
a fixed 250 ms.

## Implementation Verification Evidence (prior run)

Checks run during verification on 2026-10-16 and 2026-10-17:

- `npm run typecheck` Ã¢â‚¬â€ PASS.
- `npm test` PASS, 94 test files / 1,027 tests, including the final refresh-error
  privacy and Jira draft-navigation tests.
- `npm run test:db` Ã¢â‚¬â€ PASS, Electron SQLite migration/repository smoke; all 11 Jira
  tables, foreign-key integrity, legacy/v1 migration, migration rollback, newer-schema
  byte preservation, session rebuild isolation, stable history boundary across
  cache clear/reopen, malformed-cache rejection, old edited mention eligibility
  across reopen, and uncertain reply recovery after reopen.
- `npm run build` Ã¢â‚¬â€ PASS as part of the full `npm run test:e2e` run.
- `npm run test:e2e` Ã¢â‚¬â€ PASS, all 42 Electron tests. The loopback Jira flow covers
  explicit/uncertain replies, access-revocation purge and re-fetch, old-refresh
  protection, offline restart, exact external URL opening, token absence from the
  database/WAL, detached-window refresh/count and reply, and sidebar reorder after
  restart. Startup migration/recovery, populated project-pane continuity, and
  detached ownership tests also passed.
- `npx vitest run src/main/jira/JiraMentionsService.test.ts src/shared/jiraMentions.test.ts`
  Ã¢â‚¬â€ PASS, including snooze expiry publication without a Jira request, malformed-cache
  projection degradation, refresh error privacy, and active-group ordering.
- `npx vitest run src/renderer/src/components/JiraMentions/index.test.tsx` PASS, 31 tests, including inline account-ID draft restoration after navigation and per-comment draft isolation.
- `npx vitest run src/main/jira/JiraMentionsClient.test.ts` Ã¢â‚¬â€ PASS, 11 tests,
  including a structured mention missed by text search in a complete 1,001-comment
  history.
- `npx playwright test e2e/jira-mentions.spec.ts --reporter=list` Ã¢â‚¬â€ PASS, 1 loopback
  Electron scenario with the same account, cache, permission, token, and detached
  behavior listed above.
- `git diff --check` Ã¢â‚¬â€ PASS; Git may report LF/CRLF normalization warnings.
- Source inspection found no Jira request/response logging or diagnostic export path;
  IPC tracing omits credential saves and reply payloads, and a service test confirms
  sensitive refresh-error text is neither logged nor returned in the projection.

The loopback tests use isolated temporary Electron profiles and a synthetic Jira
server; they do not contact a live Jira service or use a real user token. Development-time live diagnostics were read-only; their environment-specific details and results have been omitted from this public plan.

### Requirement evidence matrix

`PASS` means the stated contract is covered by deterministic behavioral evidence.
`UNVERIFIED` means some implementation/test evidence exists but at least one
specified branch or runtime condition remains for `verify-spec`; no check below is
claimed from a source read alone.

| Requirement | Status | Evidence and limit |
|---|---|---|
| R1 | PASS | Client tests send the configured Jira URL and Basic-auth credentials to the read-only `/myself` endpoint; the service and loopback E2E derive the tracked account from that response. No user-specific account ID or project key is hard-coded. Account-switch restart behavior is tracked separately under R11/S33. |
| R2 | PASS | `JiraMentionsClient.test.ts` asserts the account-ID JQL has no project/status/assignee clause and follows `nextPageToken` across results from OPS and FIN; the service uses this query for discovery. The accepted latest-1,000-comment index boundary remains explicit; this verification pass made no live Jira request. |
| R3 | PASS | Shared ADF traversal tests distinguish account-ID mention nodes from plain text; loopback E2E inserts a structured user ID. |
| R4 | PASS | Classifier and SQLite smoke cover same-issue chronological resolution, distinct authors, cross-issue isolation, retained answers after source edits, resolver edit/delete reopening, alternate qualifying replies, and dismissal retention. |
| R5 | PASS | Projection/UI tests cover ordering, context and selection; the loopback Electron E2E clicks the issue key in both the inbox and detail header and asserts each exact validated issue URL. |
| R6 | PASS | Component tests assert the supplied notifications icon in both launcher and sidebar; synthetic E2E verifies the counted launcher, Jira sidebar destination, and switching between Jira and a project. |
| R7 | PASS | Jira E2E drags the feature to the list end and between two project folders, then asserts the exact mixed order after restart. |
| R8 | PASS | Component tests exercise loading, empty, invalid configuration, authentication, permission, rate-limit, network, and partial states while confirming the cached item remains visible. |
| R9 | PASS | Current repository tests cover the seven-day anchor, aging, cache-clear/reopen persistence, old-edit eligibility, complete issue/comment pagination, and account-ID JQL. `JiraMentionsClient.test.ts` reads all 1,001 comments of a returned candidate; no app-imposed download cap or live-recall claim is used. |
| R10 | PASS | Main owns Jira requests and the explicit reply path; trace tests omit credential/reply payloads, E2E excludes token/comment text from layout and token bytes from SQLite/WAL, and refresh errors are neither logged nor returned verbatim. No Jira diagnostic export path exists. |
| R11 | PASS | Service tests reject a delayed old-identity response after credential replacement; E2E proves an older consistent scan cannot overwrite a confirmed reply or advance its checkpoint. |
| R12 | PASS | Staged cache publication/checkpoint are transactional; DB smoke verifies prior-snapshot preservation on partial failure, and E2E verifies the actual API token is absent from SQLite and its WAL. |
| R13 | PASS | Startup E2E upgrades a populated supported schema and verifies Jira settings, session summaries and project layout; SQLite smoke covers legacy Jira cache migration. |
| R14 | PASS | Startup E2E verifies unsupported/failed schemas remain byte-preserved, the recovery banner appears, and a new shell PTY still starts. |
| R15 | PASS | Electron DB smoke checks session summaries, FTS, cwd overrides, and Jira rows across rebuild/cache clear; credential removal also deletes the prior context. |
| R16 | PASS | Service tests cover startup, open-if-stale, coalescing, polling, disable cancellation and Retry-After; the two-window E2E proves refresh joining and shared count updates. |
| R17 | PASS | SQLite smoke persists independent dismiss/snooze actions through reopen and cache clear; renderer filters and restore controls plus credential-removal cleanup are covered. |
| R18 | PASS | Unit/UI tests cover local display, DST and retaining the same absolute wake instant after a timezone change; SQLite reopen and service-timer tests cover offline expiry and publication without Jira. |
| R19 | PASS | Client gathers ticket user sources; component/E2E tests cover candidate insertion, ordered ADF, same-name users, and account-ID preservation. The component test navigates away from an inline account-ID mention, restores it, and verifies the posted identity. |
| R20 | PASS | Service requires explicit nonblank submissions and validates recipients; E2E rejects duplicate in-flight sends; component tests prove drafts remain separate across comment navigation, survive view unmount/rejection, and clear on identity change. |
| R21 | PASS | E2E verifies confirmed and uncertain outcomes, retained draft without automatic retry, and protection from an older refresh. |
| R22 | PASS | Component tests keep drafts and show actionable permission feedback; the client maps POST 403 to `permission`, treats missing standard Jira visibility as unrestricted, reads JSM public/internal audience, and preserves supported group/role restrictions. JSM replies are re-read to verify the created audience before success. Service tests block unsupported or changed audiences; loopback Electron E2E posts a comment with omitted platform visibility. Atlassian's REST contract documents comment visibility and Add comments permission. No live Jira write was made. |
| R23 | PASS | Component tests cover the compact shared toolbar, All including active/answered/snoozed/dismissed/unverified results, reply composer placement, action placement, concise copy, and search/reply focus treatment with the theme caret; settings tests cover interval validation. |
| R24 | PASS | Component/Electron checks verify the flat uncarded description including unwrapped ADF panels, content-based `auto` height capped at 35% of the detail viewport or 360px, left/center/right resize, fixed width, internal scrolling, manual resizing beyond the automatic cap, and collapse/reopen persistence. The description now uses the prototype's plain disclosure heading instead of a separate button. |
| R25 | PASS | Component tests render prototype-colored status/type/priority properties, safe attachment actions, and all fetched surrounding comments in chronological order at natural height without nested scroll containers; Electron E2E verifies the issue/attachment external URLs use main-owned validation. Absent optional values are omitted and hostile ADF links cannot bypass the allowlist. |
| R26 | PASS | SQLite smoke covers resolver/source edits and deletes, alternate evidence, dismissal retention and rule-version recheck; loopback E2E revokes issue access, verifies cached content is purged, restores access, and confirms a complete rescan restores the requests. |
| R27 | PASS | Renderer and Electron tests verify the reply composer appears after attachments and before the full comment history, which uses natural height and the detail pane's normal scrolling; a component test verifies selecting another mention returns the pane to the top. |

### Acceptance evidence matrix

| Scenario | Status | Evidence and limit |
|---|---|---|
| S01 | PASS | Component tests render prototype-colored ticket properties, a flat description with unwrapped ADF panels, safe attachment actions, and all surrounding comments; Electron E2E verifies the exact main-owned issue and attachment URLs. |
| S02 | PASS | Component/Electron checks cover content-sized description height within 35% of the detail viewport or 360px; Electron E2E confirms the description scrolls internally while the reply composer remains in view. Component tests drag the full edge at left, center, and right, check fixed width/internal scrolling/grip, and verify manual resize removes the automatic cap before collapse/reopen. |
| S03 | PASS | Component/Electron tests verify the composer follows attachments and precedes comment history, Snooze/Dismiss sit in the author/time header, list controls share one row, All includes every cached result state, and the enabled reply placeholder contains no persistent mention instruction. |
| S04 | PASS | Helper/UI tests cover all quick choices, local wake-time display, spring DST, and retaining the same submitted instant after a timezone change; SQLite smoke verifies persisted actions. |
| S05 | PASS | Service tests cover startup/manual/open triggers, coalescing, polling, disable cancellation and Retry-After; E2E verifies two windows join one refresh and receive the same count. |
| S06 | PASS | IPC trace tests redact credentials/reply payloads; service tests suppress sensitive error text; E2E checks layout and SQLite/WAL for token/comment sentinels. No Jira diagnostic export path is present. |
| S07 | PASS | Loopback E2E verifies access-loss purge and restored-access refresh; SQLite smoke injects invalid cached JSON and verifies safe rejection; service startup degrades an unreadable projection to a recoverable error, and startup E2E keeps terminals usable on database failure. |
| S08 | PASS | `JiraMentionsService.test.ts` returns no JQL candidates and verifies a known tracked issue is fetched directly by ID; `JiraMentionsClient.test.ts` paginates and validates a 1,001-comment candidate history. No all-recently-updated fallback exists in the current discovery path; an untracked issue omitted by the accepted account-ID index may remain undiscovered. |
| S09 | PASS | SQLite and classifier tests cover the persisted seven-day anchor, tracked items aging past the boundary, and old-edit eligibility. The synthetic multi-project account-ID search and complete-pagination tests exercise candidate discovery without claiming exhaustive live recall beyond Jira's accepted index boundary. |
| S10 | PASS | Electron SQLite smoke observes an old comment before its structured mention edit, then closes/reopens the database and verifies the unanswered eligibility remains. Answered-source edit retention is also covered. |
| S11 | PASS | Offline Electron restart restores cached detail, comments, reply evidence, mention suggestions and the separate snoozed request; DB smoke independently verifies snooze persistence/expiry. |
| S12 | PASS | Electron SQLite smoke refreshes an edited incoming source while preserving its qualifying reply and `answered` state. |
| S13 | PASS | Electron SQLite smoke preserves resolution through a failed partial run, switches to a second qualifying reply when the first is removed, and reopens only after the remaining resolver is edited/deleted. |
| S14 | PASS | Client tests reject a changed issue marker across comment pages; service retries an unstable issue once and does not commit incomplete snapshots. |
| S15 | PASS | Component test verifies dismiss regrouping; shared ordering tests remove snoozed, dismissed and answered items before calculating group order and ignore unrelated `issue.updatedAt` changes. |
| S16 | PASS | Jira client reads /myself; classifier, serializer, and synthetic E2E use authenticated account IDs rather than display names. |
| S17 | PASS | Synthetic Electron E2E selects an incoming mention and asserts the selected issue heading, comment context, and reply editor. |
| S18 | PASS | Shared classifier test confirms ordinary display-name text does not qualify as a structured mention. |
| S19 | PASS | Shared classifier test confirms a later incoming mention remains unanswered after an earlier request is resolved. |
| S20 | PASS | Shared classifier test confirms Alice stays unanswered after a later self comment that does not mention Alice. |
| S21 | PASS | Classifier and SQLite smoke verify author-specific multi-comment resolution, Bob remains open after Alice's reply, and a reply on another issue does not resolve Alice's request. |
| S22 | PASS | Synthetic search returns issues from OPS and FIN; client tests confirm the account-ID JQL has no folder/status/assignee/project restriction and `searchAll` follows every page. Jira permissions scope results to the authenticated account; this pass made no live query and retains the accepted 1,000-comment indexing boundary under R2/R9. |
| S23 | PASS | Client pagination test fetches 101 comments across pages and rejects inconsistent or non-advancing pages. |
| S24 | PASS | `JiraMentionsService` test runs a completed empty `searchAll` result through commit and asserts a ready zero-item projection; the renderer test shows the empty message and last-checked time for that projection. `JiraMentionsClient` tests search pagination separately. |
| S25 | PASS | UI tests cover actionable auth, permission, rate-limit, network, validation, and partial feedback. |
| S26 | PASS | Delayed identity response and older-refresh-after-reply E2E cover stale-response isolation. |
| S27 | PASS | Electron E2E clicks the inbox and detail-header issue keys and asserts each exact validated `/browse/APP-1` URL passed to `shell.openExternal`. |
| S28 | PASS | Component tests assert `notifications.png` in the launcher and sidebar; Jira E2E starts with exactly three unanswered comments, opens the counted launcher into the sidebar feature, and switches to the Alpha project folder and back. |
| S29 | PASS | Jira E2E switches to the Alpha project and back while its populated terminal remains mounted and visible. |
| S30 | PASS | Jira E2E drags the feature to the list end and then between Alpha and Beta, verifies `sidebarOrder`, restarts offline, and asserts the exact order remains. |
| S31 | PASS | Jira E2E restarts with Jira GETs returning 503, verifies the cached count/last-success/checkpoint, opens cached detail, expands cached reply evidence, and restores mention suggestions. |
| S32 | PASS | Jira E2E holds an older run through a confirmed reply, proves it leaves the successful checkpoint unchanged, then verifies startup retry under offline failure retains that checkpoint and cached rows. |
| S33 | PASS | E2E changes the authenticated account and verifies old results stay hidden through restart; settings tests invalidate the verified binding on site change or credential removal. |
| S34 | PASS | Startup E2E upgrades a populated database and verifies saved Jira settings, session rows and project layout; migration smoke verifies the schema transition. |
| S35 | PASS | Startup E2E upgrades a supported older schema containing Jira rows and verifies cached issue/sync values and foreign keys. |
| S36 | PASS | Startup E2E keeps the workspace/terminal running and preserves the original file for unsupported and failed schemas; SQLite smoke verifies rollback/byte preservation. |
| S37 | PASS | Electron SQLite smoke asserts session summaries, FTS results, and cwd overrides remain after Jira cache clear, and Jira data remains after session rebuild. |
| S38 | PASS | Timer validation/scheduling tests pass; Jira E2E verifies the hidden/shared main-owned service updates the launcher count in both primary and detached windows. |
| S39 | PASS | DB smoke verifies dismissed/snoozed state survives refresh, restart, and cache clear while a separate new comment appears. |
| S40 | PASS | DB smoke verifies offline expiry after reopen; the service timer publishes the active count at expiry without a Jira request, and restore clears the disposition. |
| S41 | PASS | Loopback Electron E2E uses Alice and Bob with the same display name, selects Alice's candidate, verifies the posted account ID, and confirms Bob remains in the active count after success. |
| S42 | PASS | Component tests insert at a middle cursor with a suffix, remove the mention token entirely, and submit text-only content; E2E verifies ordered structured ADF. |
| S43 | PASS | Client gathers available ticket user sources; component/E2E cover keyboard/pointer selection, duplicate display names, and restoring an inline account-ID mention after navigating to another request before posting. |
| S44 | PASS | Jira E2E proves one POST during a delayed duplicate attempt, preserves the draft after a lost response, makes no automatic retry, and rechecks before a second send. Component tests retain rejected drafts. |
| S45 | PASS | Jira E2E holds a consistent older scan across a confirmed reply and verifies it cannot resurrect resolved work or change the successful checkpoint. |
| S46 | PASS | Component tests disable the composer and offer the main-owned Jira link for unsupported audiences; the service test changes the source audience during its pre-send refresh and proves neither a reply attempt nor a POST occurs. Loopback Electron E2E verifies a supported restricted group reply retains its stable ID. Jira REST docs confirm the GET and POST visibility shape. |
| S47 | PASS | Electron SQLite smoke includes a first-seen old edited mention, local dismissal, qualifying reply, and reopening after that reply is removed while dismissal remains effective. |
| S48 | PASS | Component/Electron tests verify the reply composer follows attachments, precedes comment history, and keeps fetched comment content at natural height without nested scrollbars or resize handles; a component test verifies scroll reset on selection. |
| S49 | PASS | Client/service fixtures treat an omitted platform visibility field as unrestricted, and the Electron Jira E2E posts a reply to that standard Jira comment. |
| S50 | PASS | Client fixtures read public/internal audience from the Service Desk request-comment API; an internal reply with a group restriction serializes the matching public flag/property and verifies the created audience before returning success. Live tenant behavior remains unverified. |
| S51 | PASS | Component/Electron tests verify earlier and later groups are visible by default, remain in newest-first order around the selected comment, and use the detail pane's normal scrolling. |
| S52 | PASS | Renderer regression test checks that search and reply fields have no browser-default focus outline and use the accent caret. Their inline styles match the app's existing Session Browser and Command Palette text-entry treatment. |

### Non-goal evidence matrix

| Non-goal | Status | Evidence |
|---|---|---|
| Do not display Jira issue labels | PASS | `JiraMentions/index.tsx` renders selected fields and attachments only; no label rendering. |
| No comment edits/deletes, transitions, or writes except explicit replies | PASS | `JiraMentionsClient.ts` has read paths plus comment creation; `JiraMentionsService.postReply` is the explicit write path. |
| No embedded Jira, rich-text editor, uploads, general user search, or offline send queue | PASS | Inbox uses a textarea and ticket users; no embedded Jira, upload, or queued-send path. |
| No name-like text as mention evidence | PASS | `jiraMentions.test.ts` proves ordinary text does not create a structured mention. |
| No general issue search or notification center | PASS | Inbox search filters the already fetched mention projection. |
| No assignment/status-only inference | PASS | Classifier decisions use structured mention IDs and chronological comment authors. |
| No dependence on ticket-named project folders | PASS | `JiraMentionsClient.searchAll` is independent of renderer project folders; synthetic E2E uses Jira discovery. |

### Consequential resolved-decision matrix

| Decision | Status | Evidence and limit |
|---|---|---|
| A first-discovered old edited mention may be included and locally dismissed | PASS | `verifyAmbiguousOldEditedMention` covers eligibility, reply resolution/removal, and dismissal retention. |
| Removing a qualifying reply/mention reopens the request unless another reply remains | PASS | DB smoke switches resolution to a second qualifying reply, then reopens only after remaining evidence is edited/deleted. |
| A newly added old-comment mention can qualify; editing an answered source does not reopen it | PASS | `jiraMentions.test.ts` covers later-edit eligibility and edited answered sources. |
| Persist a seven-day boundary, include all accessible projects, and do not expire tracked work | PASS | SQLite smoke checks the anchor across clear/reopen and keeps tracked items after eight days; the authenticated account-wide JQL has no project restriction and consumes all pages, subject to the explicitly accepted JQL index boundary. |
| Quick snoozes are 2 hours, 1 day, and next Monday 9 AM saved as an instant | PASS | Helper/UI tests verify calculation, DST, local display and stable instant across zone change; SQLite/service tests verify persistence and offline expiry publication. |
| New incoming comments remain separate; removed reply evidence triggers recomputation | PASS | DB smoke keeps a new incoming author separate and tests edit/delete recomputation when one or both resolvers remain. |
| Keep the UI concise and put the three list controls together | PASS | Component tests cover the connected card, header action placement, shared toolbar, concise enabled composer placeholder, and removal of the obvious-action prompt from the unselected detail pane. |
| Identify the tracked user from the authenticated Jira account | PASS | `/myself` client test and account-ID classifier tests. |
| Use structured mentions and chronological same-issue reply evidence | PASS | `jiraMentions.test.ts` covers structured IDs and chronological resolution. |
| Provide user-positioned inline mentions from ticket users and one explicit reply path | PASS | Client gathers ticket user candidates; component/E2E cover insertion, ordered ADF, duplicate names, restoring a selected account-ID mention after navigation, and explicit/uncertain send outcomes. |
| Include all accessible projects and resolve only earlier same-issue requests by author ID | PASS | Account-wide JQL/search pagination, the bounded live candidate query, and classifier/SQLite tests cover project scope and author-specific chronological resolution within the accepted JQL index boundary. |
| Refresh at startup/open-if-stale/on demand with optional 5Ã¢â‚¬â€œ240 minute polling | PASS | Service tests cover startup, stale-open, manual, timer, disable and retry timing; E2E verifies cross-window refresh coalescing and shared count. |
| Keep snooze/dismiss per-comment and locally restorable | PASS | DB smoke verifies independent dismiss/snooze state across refresh, cache clear and reopen, including a new separate comment. |
| Store Jira cache in the existing SQLite DB and keep credentials encrypted in settings | PASS | `test:db` migration smoke and `JiraSettingsStore.test.ts`. |
| Scope session rebuild/cache clear and preserve the shared DB on migration failure | PASS | Electron DB smoke verifies scoped rebuild/clear and newer-schema preservation. |
| Use a counted shared-sidebar feature destination without top tabs | PASS | E2E covers count, feature/project switching, populated-pane continuity, cross-window refresh/reply, reorder and restart persistence. |
| Keep incomplete checks visibly partial, including for exceptional large comment histories | PASS | Client discovers/classifies a structured mention across a full 1,001-comment history; incomplete snapshots remain partial and do not advance coverage. |

### Dependency evidence matrix

| Dependency | Status | Evidence and limit |
|---|---|---|
| Existing Jira settings, encrypted token record, and status client | PASS | Settings/client tests exercise the existing main-owned boundary; offline identity binding remains in R1. |
| Shared `session-index.db` and session rebuild | PASS | `npm run test:db` covers schema upgrades, failure preservation, and session rebuild isolation. |
| Workspace/sidebar and mounted project panes | PASS | Jira E2E keeps a populated Alpha terminal mounted across Jira navigation and tests detached project ownership in the full suite. |
| Main-owned allowlisted Jira links | PASS | E2E asserts the exact validated issue URL passed to the intercepted `shell.openExternal`. |
| Multi-window shared refresh/count/reply behavior | PASS | Jira E2E proves two-window refresh joining, shared launcher counts and a confirmed reply submitted from the detached window. |
| Jira Cloud authenticated search and comment pagination | PASS | Request-level client tests verify `/myself` authentication, the account-ID search body/token pagination, and complete comment-page reads including a 1,001-comment history. This verification pass did not access tenant credentials or make live Jira requests; the accepted JQL index boundary is recorded under R2/R9. |
| Jira Cloud Add comments permission and restricted-audience behavior | PASS | Atlassian's [Issue comments REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/) documents the Add comments permission, restricted-comment response `visibility` (including group identifier/type/value), and add-comment request visibility. Client/service tests exercise those shapes and permission failures; loopback Electron E2E verifies a restricted group reply end to end. This is contract and local-fixture evidence; no live Jira write was made. |
| Other pending specs | PASS | The plan identifies existing source seams; no pending spec is a prerequisite. |

### Independent verification repairs and remaining status

Independent verification found no implementation failures. A fresh review flagged missing behavioral evidence for restoring inline account-ID mentions and isolating drafts across request navigation; component tests now cover both.
Earlier verification found that the persisted `rule_version` was not consulted during refresh. The service forces a full scan of known mention issues when the cached version is stale, sends the current version with that run, and advances the context version only with a complete transactional publication. A partial run retains the old version. The service and SQLite tests verify this behavior.

Follow-up coverage closes local gaps for persisted old-edit eligibility, snooze
expiry across reopen and service wake-up, inaccessible-issue purge/recovery,
cache-projection errors, token absence from SQLite/WAL, detached-window replies, and draft restoration/isolation across navigation.

An earlier blind `verify-spec` pass confirmed the plan's completed task set and
approved review. At that time it recorded R1, R3-R8, R10-R21, and R23-R26 as
`PASS`; R2, R9, and R22 as `UNVERIFIED`; S01-S08, S10-S21, S23-S45, and S47 as
`PASS`; and S09, S22, and S46 as `UNVERIFIED`. It corrected S46 from `PASS`
because the full scenario requires live restricted-audience behavior beyond the
tested fallback. That reviewer ran
`npm test` (94 files / 1,027 tests), `npm run typecheck`, `npm run build`,
`npm run test:db`, and `npm run test:e2e` (42/42 Electron tests); all passed.

Before the account-ID JQL repair, the refresh query searched every issue updated
since the run's lower bound, then classified structured mentions in comment
histories. Incremental runs use the last successful start minus a
10-minute overlap; daily and explicit full runs use the fixed `historyFrom`
anchor (seven days before the initial scan), so their candidate date range grows
as the tracking context ages. This matches the recorded full-reconciliation
design but is a likely source of increasing work. The supplied Python CLI is
useful for JQL experiments but is not a completeness oracle as written:
`search_issues` requests one 50-result page and drops pagination metadata, while
`get_comments` requests at most 50 comments without paging.

Verification also removed one redundant API request per issue where Jira search
already returned a complete inline comment snapshot and its `updated` marker;
truncated/unknown inline snapshots still use comment pagination and a final
marker check. Issue-detail requests no longer include a second unused `comment`
field. `JiraMentionsClient.test.ts` covers request omission for complete inline
snapshots and retention of the marker check for paginated histories. The focused
client suite (11 tests), full suite (94 files / 1,027 tests), typecheck, SQLite
smoke, and Electron E2E (42/42) all pass after this repair.

Development-time live Jira diagnostics are omitted from this public plan because
their site/account context, response counts, timings, and attachment details are
environment-specific. They exercised authentication, bounded account-ID
candidate discovery, structured comment verification, and in-memory attachment
handling. These observations support only limited behavior and candidate
precision for the tested sample; they do not prove exhaustive recall, since
Jira's comment-text index can omit candidates. Deterministic automated tests and
the requirements remain the durable verification evidence. No Jira writes were
made during the diagnostics.

The accepted JQL index boundary is explicit in the spec and reflected in R2/R9,
S08/S09/S22; verification does not claim recall for an untracked issue omitted
by Jira's comment index. S08 now matches the implemented bounded contract:
account-ID JQL discovers new issues, while known issues are rechecked by ID and
no all-updated-issue scan is allowed. The R22/S46 `UNVERIFIED` status in this
prior snapshot is superseded by the current verification evidence at the end
of this plan.

## Previous Verification Evidence (before this independent pass)

Current verification on 2026-10-17:

- `npm run typecheck` Ã¢â‚¬â€ PASS.
- `npm run build` Ã¢â‚¬â€ PASS.
- `npm run test` Ã¢â‚¬â€ PASS, 95 files / 1,035 tests after the final UI repair.
- `npm run test:db` Ã¢â‚¬â€ PASS, Electron SQLite migration/repository smoke.
- `npm run test:e2e` Ã¢â‚¬â€ PASS, 42/42 Electron tests before the description-bound
  repair; after that repair, `npx playwright test e2e/jira-mentions.spec.ts
  --reporter=list` passed 1/1 with a deliberately overlong description.
- `npx vitest run src/renderer/src/components/JiraMentions/index.test.tsx` Ã¢â‚¬â€
  PASS, 34 tests after the detail-viewport bound repair.
- `git diff --check` Ã¢â‚¬â€ PASS (only Git line-ending normalization notices).
- `npx vitest run src/main/jira/JiraMentionsService.test.ts` Ã¢â‚¬â€ PASS, 15 tests;
  the new S08 case verifies that an issue absent from JQL is rechecked only by
  its known issue ID and flows through snapshot staging/commit.
- Presentation follow-up aligned the issue detail with
  `docs/prototypes/jira-mentions/02-real-ticket-context.html`: the description
  keeps its flat ruled surface and uses a plain disclosure heading, while
  status/type/priority display their prototype-colored values without redundant
  labels. `npm run typecheck`, `npm run build`, the 34-test component suite, and
  `npx playwright test e2e/jira-mentions.spec.ts` (1/1) pass after this update.
- Focused source scan for `TODO`, `debugger`, and `console.log` in the Jira
  implementation, renderer, and Jira E2E Ã¢â‚¬â€ no matches.
- Independent blind review: R2/R9/S09/S22 pass under the spec's explicit
  1,000-comment JQL-index exception; R24/S02 initially failed and were repaired
  to cap at 30% of the actual detail viewport or 260px. The reviewer found an
  S08 conflict between omitted untracked issues and the no-all-issues guardrail.
  The brainstorm follow-up resolved it using the user's explicit constraint:
  only account-ID JQL discovers new issues; known tracked issues are rechecked
  directly, and no all-updated scan is allowed. The revised candidate/tracked
  behavior is covered by the service/client tests. R22/S46 remain live-behavior `UNVERIFIED` because no Jira write was performed; deterministic tests do not establish live POST or restricted-visibility behavior.
- Follow-up research against Atlassian's API documentation found the REST
  comment-list operations are scoped to a known issue ID/key, while the
  structured mention is an ADF body node. Atlassian does document a
  `avi:jira:mentioned:comment` event, but only for installed Forge apps; this
  desktop credential-based feature explicitly keeps server-side apps/webhooks
  out of scope. No documented account-authenticated REST endpoint was found
  that streams all comment mentions independently of JQL. See the [comment
  REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/),
  [ADF mention node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mention/),
  and [Forge comment events](https://developer.atlassian.com/platform/forge/events-reference/jira/).
  This research supports the revised bounded discovery contract: account-ID
  JQL is the new-issue candidate set; the feature rechecks known tracked issues
  by ID and does not fall back to the all-updated query. An untracked issue
  omitted by JQL remains outside recall guarantees.
- Development-time live diagnostic response counts and timings are omitted from
  this public plan because they are environment-specific. The bounded sample
  supported candidate precision but did not establish exhaustive recall.
  Verification claims here rely on the implementation and automated tests;
  they do not claim a complete live Jira inventory.
- **Matrix at that prior pass:** R2/R9, S09/S22, R24/S02, and revised S08 were
  `PASS`; R22/S46 and the restricted-audience dependency were `UNVERIFIED`.
  The current status and evidence are recorded below.

## Verification Evidence

Independent verification on 2026-10-17 used the current spec, this plan, and
current repository code/tests. It did not read credentials or contact a Jira
tenant. It checked Atlassian's documented comment visibility contract against
the current request/client/service implementation and local fixture behavior.

Follow-up on 2026-10-18 increased the description's automatic limit from
25%/220px to 35%/360px, then removed the upper bound for manual description
resizing and added a separate unbounded resize handle for the selected mention.
`npm run typecheck`, `npm run build`, the focused Jira renderer suite, and the
Jira Electron E2E passed after these changes. The Electron test verifies the
initial description cap and reply visibility, manual description expansion
beyond that cap, and independent selected-mention resizing with unchanged
width.

- **Requirements:** R1-R27 `PASS`. The request/client/service tests cover
  authenticated `/myself`, account-ID bounded JQL, pagination, known-ID
  rechecks, structured ADF classification, explicit replies, and restricted
  audience handling. R22 is proven by the 403 feedback tests, role/group
  visibility serialization, pre-send audience recheck, returned-audience
  confirmation, and loopback group-restricted reply.
- **Scenarios:** S01-S48 `PASS`. S01-S47 passed in the 2026-10-17 full unit
  and Electron runs (42/42). The follow-up reran S02 and new S48 in the
  focused renderer suite (36/36) and Jira Electron E2E (1/1). S08 proves direct
  re-fetch of a known issue absent from JQL and validation of all 1,001
  comments on a returned candidate. S46 proves unsupported audiences fall
  back to Jira without posting and supported group visibility survives the
  complete local fixture flow.
- **Prototype presentation:** `JiraMentions/index.test.tsx` verifies the
  compact search/filter/refresh row, prototype-colored status/type/priority,
  plain assignee, a flat description with unwrapped ADF panels, a content-sized
  35%/360px automatic cap with unbounded manual resize, and full-height
  chronological comment history. The reply composer follows attachments and
  precedes that history. The Electron Jira E2E checks the description cap,
  keeps the composer in view, verifies all comment groups render without nested
  scrollbars, checks aligned ADF table columns and safe link rendering, and
  confirms main-validated issue/attachment URLs.
  Captured synthetic Electron views are the [populated inbox](../../docs/prototypes/jira-mentions/evidence/jira-mentions-populated.png), [permission-error/empty inbox](../../docs/prototypes/jira-mentions/evidence/jira-mentions-access-error.png), and [long-description detail](../../docs/prototypes/jira-mentions/evidence/jira-mentions-long-description.png).
- **Non-goals:** all seven non-goal rows `PASS` under the current code and the
  full unit/E2E suites: no issue-label UI, no Jira writes outside the explicit
  reply, no embedded Jira/general directory/offline queue, no name-only
  mentions, no general issue search, no status/assignee inference, and no
  project-folder dependency.
- **Resolved decisions:** all 17 decision rows `PASS` under the current
  focused tests, database smoke, and local Jira E2E; this includes the bounded
  account-ID discovery contract, author-specific resolution, seven-day
  boundary, quick snooze instants, concise controls, and shared-sidebar
  destination behavior.
- **Dependencies:** local request contracts for existing settings, shared
  SQLite, workspace navigation, allowlisted Jira links, multi-window behavior,
  Jira search/comment pagination, and Add comments/restricted-audience behavior
  `PASS` in the listed tests plus Atlassian's [Issue comments REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/).
  No live tenant write was made; other pending specs are not prerequisites.
- `npm run typecheck` Ã¢â‚¬â€ `PASS`.
- `npm run build` Ã¢â‚¬â€ `PASS`.
- Prior full suite on 2026-10-17: `npm run test` Ã¢â‚¬â€ `PASS`, 95 files and 1,040
  tests; `npm run test:db` Ã¢â‚¬â€ `PASS`, Electron SQLite migration smoke; and
  `npm run test:e2e` Ã¢â‚¬â€ `PASS`, 42/42 Electron tests in 3.0 minutes. Jira uses
  a loopback fixture server that verifies restricted-group ID preservation.
- `npx playwright test e2e/jira-mentions.spec.ts --reporter=list` Ã¢â‚¬â€ `PASS`, 1/1.
  The Electron test drags the description edge up and down, verifies automatic
  sizing stays capped while manual resize exceeds the cap without changing
  width, resizes the selected mention independently of the reply editor, and
  uses Enter to collapse and reopen the description. It also generated the
  three synthetic screenshots above.
- Focused `npx vitest run src/renderer/src/components/JiraMentions/index.test.tsx`
  Ã¢â‚¬â€ `PASS`, 36 tests, including flat Jira ADF panel rendering, prototype color
  treatments, automatic description sizing, unbounded description resizing,
  and independent selected-mention resizing.
- `git diff --check` Ã¢â‚¬â€ `PASS` after the 2026-10-18 follow-up. Focused scan for
  `TODO`, `FIXME`, `debugger`, and `console.log` in Jira implementation, Jira
  renderer, and Jira E2E Ã¢â‚¬â€ no hits.
- Verification repairs: preserve Jira's group visibility identifier through
  cache and reply POST, treat a mismatched response audience as uncertain, and
  add pre-send unsupported-audience, permission-error, and loopback coverage.
  The independent audit re-read the R1-R26, S01-S47, non-goal, decision, and
  dependency matrices; all implementation rows passed. The 2026-10-18
  follow-up separately verified R24, R27, S02, and S48 with focused renderer
  and Electron pointer-resize checks. It confirmed the three screenshots and
  the actual Electron pointer/keyboard checks required by T11.
  No Jira credentials or tenant were accessed. The loopback tests and Jira API
  contract verify the app's restricted-audience handling; production tenant
  round-tripping remains unverified because no live write was authorized.

Additional user-requested follow-up on 2026-10-18 completed the reply-audience
behavior and aligned the Jira text-field focus styles with the rest of the app.
R22 and S49-S50 cover unrestricted comments
with an omitted Jira `visibility` field and Service Desk public/internal
audience preservation, including post-create verification and supported
group/role restrictions. R23 and S52 cover the non-orange focus treatment and theme accent
caret on search and reply. Focused Vitest passed (70 tests across 3 files),
typecheck passed, and `npx playwright test e2e/jira-mentions.spec.ts
--reporter=list` passed (1/1), including actual Electron drag checks for both
description edges. No Jira tenant was contacted; Service Desk write behavior is
verified with local API fixtures only.

A temporary read-only attachment-preview diagnostic exercised content-type
handling, range reads, byte limits, and in-memory image decoding. Its
environment-specific site, issue, and attachment details, response metrics,
and image data are omitted from this public plan. The focused automated tests,
typecheck, and build verified the implementation; the temporary live probe was
removed. No credentials or live attachment data were stored in the repository.

Final user-requested comment-layout follow-up on 2026-10-18 supersedes the
earlier selected/comment resize behavior: the reply composer now follows
Attachments and precedes the complete comment history. All fetched comments
are visible in newest-first order at natural height, with the detail pane's
normal scroll handling long histories and no nested comment scrollbars or
resize handles. Selecting another mention returns the pane to its top so the
reply composer starts in view. Updated R25/R27 and S01/S03/S48/S51. Renderer tests passed
(41/41), typecheck and build passed, and `npm run test:e2e --
e2e/jira-mentions.spec.ts` passed (1/1), including checks that the composer
stays in view after a long description and the full comment history has no
internal scrolling.
