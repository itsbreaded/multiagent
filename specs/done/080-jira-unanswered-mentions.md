# Spec: Jira Unanswered Mentions

Status: done
Created: 2026-10-16
Completed: 2026-10-18

## Problem

Jira comments can mention a user and ask for a response, but the existing Jira
integration shows only issue status for ticket-named project folders. A user
must inspect Jira notifications and comment timelines to find mentions that
still need a reply. Jira issue search returns matching issues, not an ordered
answer about whether the mentioned person commented afterward.

## Goal

Give each user a focused inbox of Jira comments that mention their own
authenticated Atlassian account and have no later comment from that account
mentioning the person who raised the request,
with enough context to reply directly from MultiAgent or open the issue in Jira.

## Users & Context

MultiAgent users who already configure their own Jira Cloud site, account
email, and API token for status badges can use those credentials for this
feature. The feature must identify the signed-in account by its Jira account
ID rather than a hard-coded name or email. Jira Cloud exposes the authenticated
account through `myself`; comments contain author account IDs and structured
Atlassian Document Format mention nodes
([Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/),
[comment API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/),
[mention node](https://developer.atlassian.com/platform/framework/adf-builder/reference/nodes/mention/)).
A read-only live check against locally configured Jira credentials on
2026-10-16 confirmed successful account identity, paginated issue search, and
paginated comment-list responses. It did not establish that a particular JQL
text query reliably finds every structured mention.

A later bounded read-only enhanced-search probe requested all fields for one
recent issue on the configured site and returned 221 fields, including 180
custom fields. Standard results included summary, status, issue type, priority,
project, people, description, dates, parent/subtasks/links, labels/components,
attachments, and a paginated comment container; several values were empty for
that issue. This establishes available response structure, not a requirement
to render every field or a complete inventory for every project. Production
requests should select needed fields rather than fetch all custom fields.
The selected context fields are specified in R25. Search field selection is documented in the
[enhanced search API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/).

## Requirements

1. MultiAgent MUST reuse the user's configured Jira Cloud site and credentials
   and determine the target identity from the authenticated Atlassian account.
   It MUST NOT require a user-specific account ID, display name, or project key
   hard-coded into the application.
2. Tracking MUST include mentions from any person in any project accessible
   to the authenticated Jira account, independently of open project folders,
   issue status, assignee, or existing status-badge prefixes. There MUST NOT
   be a project allowlist or user-supplied JQL filter for this feature. Jira
   settings MUST expose enable/disable and optional background refresh controls.
   Existing status-badge settings and behavior MUST remain usable independently.
3. A qualifying mention MUST be an actual Jira comment mention of the
   authenticated account, identified by account ID in the structured comment
   body. Matching a person's display name as ordinary text MUST NOT by itself
   create an unanswered item.
4. A comment from another person mentioning the authenticated account MUST
   remain unanswered until a later comment by the authenticated account on
   that same issue explicitly mentions the original author by account ID.
   An unrelated later comment, plain-text name, or a mention of someone else
   MUST NOT resolve it. Each incoming comment MUST be evaluated separately.
   One reply mentioning an author resolves all earlier comments from that
   author on that issue; a reply mentioning several authors can resolve their
   earlier comments together. A later incoming mention opens new work again.
   Editing that same incoming comment after a qualifying reply MUST NOT reopen
   it; compare its original creation time with the reply's creation time.
   If a qualifying reply is deleted or edited to remove the original author's
   structured mention, a complete check MUST recompute the request as
   unanswered unless another qualifying reply remains. Local dismissal is
   still available and MUST remain effective across this recomputation.
5. The user MUST be able to see each unanswered item with issue key, issue
   summary, mentioning author, mention time, and enough comment context to
   recognize the request. The inbox MUST group unanswered comments by issue
   while preserving each comment's author, context, and independent state.
   By default, issue groups MUST sort by their newest active unanswered
   comment, newest first; comments within each issue MUST sort oldest first.
   Ordering MUST use comment creation times rather than issue update times.
   Snoozed/dismissed/answered comments MUST NOT determine active group order.
   Selecting an item MUST show its context and reply editor in the inbox.
   Its Jira issue key MUST be clickable from both the inbox group and selected
   issue header, opening the matching issue through the validated main-owned
   external link path. The issue summary remains descriptive text.
6. When unanswered-mention tracking is enabled, the top-left chrome MUST have
   a Jira mentions button with a count of unanswered comments in the tracked
   scope, excluding locally dismissed or currently snoozed comments. A comment
   that mentions the same account more than once MUST count
   once. Activating the button MUST reveal a Jira tab in the same sidebar list
   as project folders, without a separate feature header or section. Selecting
   the Jira tab shows the full Jira mentions view in the workspace,
   while selecting a project folder returns to that project's panes. It MUST
   NOT add a top tab strip or launch a terminal merely to show the inbox. Use
   the supplied notifications bell image for Jira mentions in both the chrome
   launcher and sidebar entry.
7. The sidebar feature navigation MUST allow additional non-terminal feature
   destinations later without changing the meaning of project folders or
   their pane trees. Jira and future feature tabs MUST be reorderable among
   project folders through the same sidebar drag gesture, and their chosen
   positions MUST survive application restart. A newly enabled Jira destination
   MUST appear first until the user reorders it. This iteration adds only the
   Jira destination.
8. The feature MUST expose when its results were last checked and provide a
   user-invoked refresh. It MUST show loading, empty, invalid configuration,
   authentication/permission, rate-limit, and network-failure states without
   presenting incomplete or failed results as a complete empty inbox.
 9. Discovery JQL MUST include a comment-text clause for the authenticated
    account ID and the applicable issue-update lower bound; it MUST NOT
    enumerate every issue updated in that window. Pagination and rechecks MUST
    still cover all accessible projects and disclose any initial history
    boundary. Every JQL candidate MUST be verified against structured ADF
    mention nodes before it can produce an inbox item. Previously tracked
    mention issues MUST be rechecked by their known issue IDs when due, even
    when absent from current JQL results. Jira's comment-text index can omit an
    untracked issue; the feature MUST NOT compensate with an all-recently-
    updated issue scan or claim that a completed JQL search proves exhaustive
    mention recall. Initial load MUST include eligible incoming mentions
    returned by the bounded search that were created in the preceding seven
    days, with the lower boundary anchored to the initial scan start and
    persisted for that site/account. This is an initial backfill boundary, not a rolling
   expiry: tracked unanswered comments MUST NOT disappear when they become
   older than seven days. Older comments may be fetched as context and reply
   evidence without becoming initial inbox requests. After tracking starts,
   an edit that adds a structured mention of the authenticated account to a
   previously unmentioned, unanswered comment MUST make it eligible even if
   its creation predates the initial boundary. This exception MUST NOT reopen
   an already answered comment or treat every edit as a new mention. If an old
   comment is first discovered already containing the mention and its latest
   edit occurred after tracking started, include it without requiring proof
   that the edit introduced the mention; the user can dismiss it. A request
   budget or service limit MUST NOT silently exclude projects; incomplete
   checks MUST be labeled partial rather than claim all mentions were reviewed.
10. All Jira requests MUST remain main-owned. Status lookups, discovery,
   refresh, and background polling MUST remain read-only. The one Jira write
   introduced here is an explicitly user-submitted reply comment from the
   mentions inbox; it MUST NOT broaden the existing status-badge workflow.
   Credentials and
   sensitive comment text MUST NOT appear in logs, diagnostics, IPC traces, or
   persisted layout state. The feature MUST respect Jira's issue and comment
   visibility permissions.
11. A response received after a refresh, settings change, or identity change
   MUST NOT replace results belonging to the newer configuration or request.
12. Jira inbox display data and synchronization metadata MUST persist as
   additional unencrypted tables in the existing main-owned `session-index.db`.
   The application MUST retain that filename and use a single app-owned SQLite
   database for these tables and existing session data. API tokens MUST NOT be
   stored in the database. Cache updates and their successful synchronization point
   MUST become durable together, so an interrupted save cannot mark missing
   results as synchronized.
13. Fresh installs and upgrades from releases without the Jira cache MUST
   initialize it automatically without changing existing settings, session
   indexes, or project layouts. Subsequent schema upgrades MUST preserve
   valid cached content and synchronization state, complete atomically, and
   be safe to rerun after interruption.
14. Shared database schema upgrades MUST coordinate session and Jira tables
   under one version history. A failed upgrade MUST roll back without erasing
   existing tables. An unsupported newer schema MUST be preserved without
   automatic downgrade or recreation; affected database features MUST report
   a recoverable error while the rest of the application can start. A version
   mismatch or migration failure alone MUST NOT be treated as corruption.
15. Session index rebuilds MUST preserve Jira tables and synchronization state;
   clearing the Jira cache MUST preserve session summaries, search indexes,
   and cwd overrides. Recovery MUST distinguish a subsystem rebuild from
   actual database corruption and MUST NOT recreate the whole database merely
   because one subsystem's migration or initialization fails.
16. Tracking MUST refresh at startup, on manual refresh, and when the inbox
   is opened more than five minutes after its last successful check. Settings
   MUST offer optional background polling with a whole-number interval from
   5 through 240 minutes inclusive. Polling MUST default off, run while the
   app is running even when the inbox is not selected, and update the shared
   count. Windows and overlapping refresh triggers MUST share one refresh
   operation rather than create duplicate scans. Invalid intervals MUST show
   validation feedback instead of being saved. Rate limits MUST respect the
   service's retry delay without issuing repeated immediate requests.
17. Users MUST be able to dismiss or snooze an individual incoming comment
   locally, using compact actions in the selected comment's header beside
   its author/time, above the reply editor. Neither action changes Jira or
   marks a comment answered. Hidden
   comments MUST leave the active count immediately. A new comment on the same
   issue MUST remain eligible even if another comment was dismissed/snoozed.
   Snoozed and dismissed comments MUST be accessible through simple inbox
   filters with restore/unsnooze actions. Local actions MUST survive refreshes
   and restarts, remain scoped to Jira site/account/comment, and be preserved
   by clearing the fetched cache. Removing credentials clears this Jira data.
18. Snoozing MUST offer a small fixed menu: 2 hours, 1 day (24 hours), and
   next Monday at 9 AM local time. Persist the calculated wake-up instant so
   restart or a time-zone change does not reschedule an existing snooze. The menu
   MUST show the actual wake-up date/time. Snoozed comments MUST return to
   the active count at expiry without requiring a Jira network request,
   including after app restart, unless already answered or dismissed.
19. The selected incoming comment MUST offer a compact reply editor supporting
   plain text and inline mentions. The comment and its composer MUST form one
   connected card with a shared outer boundary and a subtle divider between
   the original comment and reply area. Comment actions remain in the comment
   header, and Post reply belongs to the reply area. Candidate users MUST be collected from all
   user references available in the fetched ticket and its paginated comments:
   assignee, reporter, creator, user-valued fields, comment authors, and existing
   mentions. Candidates MUST be deduplicated by account ID. Typing `@` at the
   cursor MUST open suggestions filtered as the user types a name; selecting
   a suggestion by keyboard or pointer inserts a mention at that exact position.
   The original comment author SHOULD appear first when the query is empty.
   Users MUST
   be able to put mentions anywhere, use several, remove them, or post text
   without mentions. There MUST be no fixed recipient row or automatically
   prepended/appended mentions. Each selected mention MUST retain its fetched
   Jira account ID through editing and draft restoration; display names and
   unselected typed `@name` text MUST NOT substitute for that identity. Posting
   MUST preserve the order of text, line breaks, and structured mentions.
   Account IDs MUST remain internal to the editor; names and available ticket
   context distinguish suggestions, including different users with the same
   display name. Missing user details MUST NOT cause a name to be matched to
   an arbitrary account. Ticket data is not assumed to include every user in
   the Jira site; the menu covers the users actually available from that ticket.
   A generic Jira directory search, formatting toolbar, and full rich-text
   editor remain outside this iteration.
20. Only activating an explicit `Post reply` action with nonblank reply text
   and valid structured mentions, if present, MUST send a comment to the
   selected issue using the configured credentials. The composer MUST identify the issue and
   inline mentions before submission and prevent duplicate in-flight submissions.
   Draft text MUST survive inbox navigation and failed submissions within
   the running app, isolated by issue and account; no persistent draft or
   offline send queue is required.
21. A confirmed successful Jira response MUST feed the created comment through
   the same author/mention/time matching rule used for fetched comments and
   update the relevant rows and badge. Clicking Send or an HTTP error alone
   MUST NOT mark work answered. A successful POST MUST NOT advance the global
   search checkpoint or let an older refresh resurrect the answered rows.
   If delivery is uncertain after a timeout/disconnection, retain the draft,
   show that uncertainty, and recheck comments before offering another send;
   never automatically retry a potentially delivered comment.
22. Missing Add comments permission, invalid recipients, authentication,
   validation, rate limiting, and network failures MUST leave the reply text
   available with actionable feedback. Posting MUST preserve the source
  comment's audience restrictions. A missing Jira platform `visibility` field
  means the comment is unrestricted. Service Desk public/internal audience and
  any supported group/role restriction MUST be preserved and verified after
  posting. Where an audience cannot be verified or preserved, the composer MUST
  offer opening Jira rather than silently posting to a broader audience.
  External-browser opening remains available for richer replies and unsupported
  cases.
23. The final UI MUST use concise labels and controls without persistent
   instructional paragraphs, explanations of obvious actions, repeated reply
   rules, or implementation commentary. Keep issue/comment context, recipients,
   timestamps, counts, and necessary loading/error/confirmation feedback.
   Settings MUST expose their labels, values, and validation without tutorial
   copy around each control. Search, the all/active/snoozed/dismissed/answered view selector,
   and refresh MUST share a compact row above the comment list instead of
  occupying separate toolbar rows. The prototype MUST reflect this restrained copy.
  Text-entry fields MUST follow the app's existing focus treatment, without a
  browser-default orange outline, and use the theme accent for the caret.
24. When a ticket description is displayed, its content area MUST support
   vertical resizing and internal scrolling so users can expand large
   descriptions without changing the width of the workspace. The entire
   bottom edge MUST be a draggable resize target, with a vertical resize
   cursor and a subtle grip; resizing MUST NOT require grabbing the corner.
   The description MUST remain collapsible independently of its height. Keep
   it as a flat section with subtle top/bottom rules instead of a card, and
   render ADF panel contents without adding generic card framing. Its initial
   height MUST follow its content up to the smaller of 35% of the detail
   viewport or 360 px; longer content scrolls inside that bound.
   Once the user drags the description, manual resizing MUST have no upper
   size cap.
25. The selected issue detail MUST show available status, priority, issue type,
   assignee, reporter, update time, description, attachment metadata, and
  all fetched earlier/later comments around the selected mention. Preview
  supported image attachments with bounded in-memory loading; show non-image
  attachments only with safe Jira content URLs and open them through
  main-process validation. Omit absent optional values instead of inventing them. Render
  fetched ADF tables with shared column sizing and other structured text
  safely. In the newest-first conversation, later comments appear above the
  selected mention and earlier comments below it; each context group sorts
  newest to oldest. All context comments MUST be visible by default at their
  natural height, without nested scrollbars or resize handles. Color the status
  by Jira status category, use a neutral chip for issue type, gold text for
  priority, and a plain person field for assignee, matching the prototype.
26. Persist enough comment/mention evidence to recompute answered state after
   comment edits, deletions, permission changes, or rule-version changes. An
   issue's closed/done status MUST NOT resolve a comment. An incomplete or
   inconsistent page set MUST NOT be used to remove unseen comments or claim
   a complete classification. Previously answered issues remain trackable.
27. The reply composer MUST appear immediately after the attachment section and
   before the comment history. The selected incoming mention and surrounding
   comments MUST flow at their natural content height; the comment history MUST
   not use an internal height cap, scrollbar, or resize handle. The detail pane
   provides the normal page scrolling for long histories and returns to the top
   when a different mention is selected so the composer starts in view.

### Cache storage and sync behavior

- Preserve the last complete inbox snapshot across application restarts,
  together with its Jira site/account identity, search scope, reply rule,
  last attempt time, last successful check time, and completeness state.
  Restored results and the chrome count are explicitly cached until verified.
- Keep cached results separate from project layout and credentials. Cache the
  selected ticket metadata/description, full fetched comment context, derived
  excerpts, mention identities, and resolution evidence needed to restore the
  agreed UI and recompute answers. The user accepts this unencrypted SQLite
  content; credential encryption remains governed by the existing settings.
- Run a catch-up check at startup. Opening the inbox reuses the snapshot and
  checks again if the last successful check is more than five minutes old;
  manual refresh always checks. Optional background polling follows R16.
- After the initial complete search, catch-up checks consider issues changed
  since the start of the last successful check, with a ten-minute overlap,
  and recheck every issue currently holding an unanswered mention. These are
  accepted optimizations, not a guarantee that Jira search is immediately
  consistent. Jira documents that recent updates can be absent from search
  results ([issue search API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)).
- Repeat the complete configured search at the first eligible refresh after
  24 hours, and provide an explicit full recheck. This reconciles changes
  missed by incremental search; overlap alone does not prove completeness.
- Publish a new complete snapshot and advance the catch-up point only after
  all required search and comment pages finish successfully. A failed,
  cancelled, partial, or interrupted check retains the previous complete
  snapshot and successful check time, with an explicit stale/partial marker.
  On restart, retry from that successful point rather than reuse an old page
  continuation token or mark the interrupted attempt complete.
- A different Jira site/account must never display the previous identity's
  inbox. Changed scope or reply rules require a new complete check. Confirmed
  loss of access to an issue removes its cached content; a transient failure
  retains previous results as stale. Clearing credentials clears cached Jira
  content. Settings provide a clear-cache action; malformed
  cache data falls back to a fresh check without preventing app startup.

### Planned database model

All tables below extend the existing `session-index.db`; this is a proposed
schema contract, not a second database or an implementation plan. `C` denotes
`context_id`, `I` a stable Jira issue ID, and `M` a stable Jira comment ID.
Jira identifiers are opaque text, never parsed as numbers. Times used for
comparison are UTC instants; a due date remains a calendar date. JSON columns
hold validated structured values, not arbitrary whole Jira responses.

| Table | Identity | Required contents and purpose |
|---|---|---|
| `jira_cache_contexts` | `context_id`; unique normalized site URL + self account ID | Verified identity, rule/discovery versions, requested history boundary, verified-at time, and committed data generation. Context identity is stable across settings/rule changes so local actions survive. No token/email credential copies. |
| `jira_cached_issues` | `(C, I)` | Current issue key, summary, project ID/key/name, status ID/name/category, issue type, priority, assignee/reporter/creator IDs, Jira created/updated times, due date, resolution, description ADF, and selected parent/subtask/link metadata. Attachment metadata includes ID, name, MIME type, byte size, author/time, and validated content/thumbnail URLs; no downloaded files. Record which optional sections were fetched versus absent, metadata fetch time, completed comment-snapshot time, observed comment count, complete/partial/access state, and committed generation. Labels and unrelated custom-field values are not cached for display. |
| `jira_comments` | `(C, I, M)` | Author account ID and display-name snapshot, original created and latest updated times, full fetched ADF body, derived plain text/excerpt, visibility/internal-audience metadata, canonical body fingerprint, fetch time, last complete snapshot generation, and visible/removed/unavailable state. Holds context comments and the user's replies as well as incoming mentions, so the discussion and resolution evidence survive restart. Partial pages never imply deletion. |
| `jira_comment_mentions` | `(C, I, M, mentioned_account_id)` | One row per distinct structured account mention in a comment. Multiple occurrences of one person share a row; their exact positions remain in the ADF body. Supports both incoming-mention discovery and finding which original authors a reply addresses. |
| `jira_issue_users` | `(C, I, account_id)` | Display name, optional avatar URL and active state when returned, known role/source list, and fetch generation. Includes available user references from ticket fields, comments, and mention nodes. Distinct account IDs never merge because names match; unavailable email is not needed. |
| `jira_mention_state` | `(C, I, incoming_comment_id)` | Derived unanswered/answered/removed/unknown state, original author ID, source created/updated times, observed body fingerprint, eligibility basis (initial/new comment or mention added by a later edit), first observed mention time and qualifying edit time when available, the resolving reply comment ID/time when proven, rule version, computation time, and evidence generation. Retain answered records for tracked issues so edits/deleted replies can be reevaluated; do not store only the current unanswered list. Creation time governs resolution; updated time refreshes content without reopening an answered source comment. |
| `jira_mention_actions` | `(C, I, incoming_comment_id)` | Local disposition (`dismissed` or `snoozed`), absolute snooze-until instant, and last action time. No row means no suppression. These rows are independent of fetched comment rows and survive cache rebuilds, even if the source comment is temporarily absent. They remain scoped to the stable site/account context. |
| `jira_sync_state` | `C` | Authoritative last successful scan start/end, last successful full scan time, incremental checkpoint, requested and completed history coverage, backfill-complete flag, current committed generation, retry-not-before time, and references to last attempted/successful runs. This is sync state, not the last time the app happened to run. |
| `jira_sync_runs` | `run_id`, belonging to `C` | Initial/incremental/full kind, starting data/config/rule generation, search lower/upper bounds, start/end times, running/success/partial/failed/interrupted outcome, discovery-complete flag, required/completed issue counts, and safe error codes. A running run found after restart becomes interrupted and cannot advance coverage. Do not persist opaque Jira continuation tokens for cross-restart reuse. |
| `jira_sync_issue_work` | `(run_id, I)` within `C` | Per-run pending/complete/failed/access-lost result, fetch time, observed issue/comment versions, completeness markers, and a validated staged issue/comment snapshot. Completed pages assemble a complete per-issue result here before publication. Supports bounded-memory fetching and an atomic final publish without holding a database transaction open across HTTP requests. Abandoned stage rows are disposable. |
| `jira_reply_attempts` | `attempt_id`, belonging to `(C, I)` | Explicit send start/end, sending/confirmed/rejected/unknown outcome, canonical outgoing body fingerprint, selected mention IDs, known returned Jira comment ID, safe failure code, and reconciliation time. Metadata supports detecting uncertain delivery after interruption; it is not an offline queue and never causes an automatic send or retry. Draft body text remains in memory. An ambiguous result stays unknown rather than guessing success from a name or similar text. |

**Relationships and integrity**

- Every Jira-owned row belongs to a site/account context. Child references
  include that context, preventing joins or updates across identities.
- Comments belong to cached issues; extracted mentions and derived states
  refer to comments in the same issue/context. A resolving comment must be a
  reply on that same issue, not merely another comment with a matching ID/name.
- User references may retain an account ID without a full user profile; missing
  profile details must not break ingestion. Parent/linked issue metadata does
  not require fully caching the related issue.
- Local actions and send-attempt records do not cascade away when fetched
  issue/comment rows are cleared. Removing credentials/context clears all
  associated Jira data. Cache clearing discards fetched results/staging and
  resets coverage, while retaining local dispositions and any unknown send
  outcome needed to avoid a duplicate post.
- Snooze expiry and restoring a dismissal are local computations. Count only
  `unanswered` rows with no dismissal and no unexpired snooze. Derive group
  ordering from those rows' source creation times. Neither count nor answered
  status is inferred from issue status, an issue update, or a local dismissal.
- Description ADF, complete comment bodies, and ticket-user identity mappings
  support the agreed detail view and inline mentions. Preserve unknown ADF
  nodes safely rather than treating them as HTML. Cache only selected display
  context, not all custom fields or attachment bytes.

**Access paths to support**

- Unique context identity; direct issue/comment lookup by stable IDs.
- Issues by context + Jira update time; comments by context + issue + creation
  time, with deterministic tie ordering that does not invent later timestamps.
- Comment mentions by context + mentioned account ID and comment; the user's
  replies by context + issue + author + creation time.
- Derived incoming states by context + state + issue + creation time, and
  resolution evidence by resolving comment ID for reevaluation after edits.
- Local actions by context + disposition + snooze expiry, without filtering
  away future items before their timers can be scheduled.
- Runs/work by context + outcome/run ID; send attempts by context + issue +
  outcome. Exact SQL indexes and query plans are verified during planning.

**Publication and recovery**

1. Record a refresh attempt and its base generation. Fetch outside the shared
   database transaction and stage only complete per-issue snapshots. Incomplete
   pages remain incomplete and cannot remove previously known comments. If
   versions/counts change during pagination, retry or mark the snapshot partial
   rather than treating the page set as coherent deletion evidence.
2. Publish issue/comment/user updates, extracted mention IDs, derived resolution
   evidence, the committed result generation, and the successful checkpoint in
   one transaction after all required work completes. The successful checkpoint
   advances to the scan's start boundary, with overlap on the next scan, so
   updates occurring during a long scan are revisited.
3. A confirmed posted reply may publish its returned comment and matching
   resolutions immediately without advancing discovery coverage. A refresh
   based on an older generation must reconcile that proof or be discarded;
   it must not resurrect resolved work.
4. On failed/interrupted refresh, leave the last committed snapshot and
   checkpoint intact; discard incomplete staging and retry from the successful
   checkpoint. Explicit access-loss purges can remove forbidden cached content
   without treating that action as a successful full scan.
5. Session rebuilds target session tables; Jira cache clearing targets fetched
   Jira tables. Migration failure is not corruption. Handle actual database
   corruption separately, preserving the original file for recovery rather
   than silently destroying unrelated table data.

**Install and migration contract**

- Use the existing shared SQLite schema version, extending the current
  version-1 database through a transactional additive migration. Determine the
  actual next version during implementation; do not hard-code a competing
  Jira-only `user_version` or run two independent migration owners.
- A fresh installation creates session and Jira tables through the same schema
  history. An older installation adds Jira tables without rewriting session
  rows, cwd overrides, settings, or layouts. Reopening the current version is
  a no-op. Any schema version increment commits with its schema/data changes.
- Verify fresh creation, upgrade from a populated current session database,
  reopening, interrupted/failed migration rollback, unsupported newer versions,
  and scoped session/Jira rebuild behavior using populated fixtures.
- Feature enablement/poll settings and credentials retain their existing app
  settings ownership; sidebar tab placement and active-view restoration belong
  to layout persistence. Neither is duplicated in comment or sync tables.
  In-memory reply drafts and rendered editor selections are not database data.
- Clean up abandoned/completed work snapshots once no active or retained run
  references them. Keep only necessary run metadata rather than accumulating
  a permanent copy of every poll. Confirmed send-attempt metadata can be
  pruned after authoritative reconciliation; unknown delivery must not be
  silently forgotten in a way that permits automatic duplicate posting.

### Discovery and resolution discussion

Read-only account-ID JQL probes returned matching issues, and complete comment
reads confirmed structured mentions in those candidates. This shows a working
candidate path, not complete recall. An explored issue had more than 1,000
comments, where Jira documents a comment-text indexing limit. The API must
still paginate every comment of a returned or already tracked issue; the JQL
index limit is not an artificial comment-download cap.

Discovery uses account-ID comment JQL and its issue-update lower bound across
all accessible projects. JQL results are candidates only; structured mentions
and chronological reply evidence come from complete comment histories. The
feature does not enumerate every recently updated issue as a fallback. Known
tracked issues are rechecked directly by issue ID even when removed from search
results, so edits, deleted replies, and resolution changes remain detectable.
An untracked issue omitted by Jira's comment-text index may remain undiscovered;
the product does not claim exhaustive recall for those omissions. Incremental
checks use the successful scan-start checkpoint and overlap, while daily full
rechecks cover the persisted initial boundary and known tracked issues. Search
remains eventually consistent and is not an instantaneous Jira notification
stream
([enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/),
[search consistency](https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/)).

An edit that adds a structured mention to a previously untracked old comment is
eligible once its issue enters the bounded candidate set. The seven-day initial
boundary cannot be applied as a permanent comment-creation filter. Persist
eligibility evidence for discovered edits so restart and recomputation retain
them.

For an incoming comment by author A on issue I, answered evidence requires a
comment on I authored by the authenticated account, created strictly later,
and containing a structured mention of A. One reverse chronological traversal
can track later replies per mentioned author and classify incoming comments;
there is no need to issue a Jira search per comment. Save the resolving comment
ID as evidence so later edits/deletions can recompute the result. Partial scans,
unknown author IDs, equal creation timestamps, and missing evidence must not
invent an answered state. Edits that change the source comment after a reply
do not reopen it when the qualifying reply still exists. Compare original
creation times for resolution; updated times detect changed content and
refresh the displayed text without turning that edit into a new request.

## Non-Goals

- We will NOT display Jira issue labels in the mentions view.
- We will NOT edit/delete existing comments, transition issues, assign work,
  mark Jira notifications read, or write Jira data except explicitly submitted
  reply comments from this inbox.
- We will NOT embed Jira, build a rich-text editor, upload attachments, add
  general user search, or automatically send queued/offline replies.
- We will NOT use name-like plain text as proof of a Jira mention.
- We will NOT build a general Jira issue search or notification center.
- We will NOT infer unanswered work from assignee, watcher, or issue status
  alone.
- We will NOT make the feature depend on ticket-named project folders.
- We will NOT enumerate all recently updated issues to recover an untracked
  issue omitted by Jira's account-ID comment search.

## Scenarios (Acceptance Criteria)

- **S01** **Given** the detail view, **When** it renders a selected issue, **Then**
  available R25 metadata, description, safe attachment actions, and the full
  surrounding comment history appear without invented missing values. All
  context comments are visible by default. Status/type/priority use their
  prototype color treatment and the
  description, including ADF panel content, remains flat rather than
  card-framed. Attachment clicks open their Jira content URL through main-process
  validation without downloading the file. ADF table headers and body cells
  share aligned columns. Hostile structured text and links cannot execute
  scripts or bypass the external-browser allowlist.
- **S02** **Given** a long description, **When** the user drags the left, center, or
  right portion of its bottom edge, **Then** its height changes while its
  width stays fixed and its content scrolls internally. Before manual resizing,
  its height follows the rendered content up to the smaller of 35% of the
  detail viewport or 360 px; manual dragging can exceed that automatic cap.
  Collapsing and reopening it works independently of the selected height.
- **S03** **Given** a selected incoming comment, **When** its detail is shown,
  **Then** the composer appears immediately after attachments and before the
  full comment history, Snooze and Dismiss sit beside the comment header, and
  the list search/filter/refresh share
  one compact row without persistent instructional copy. The All filter
  includes active, answered, snoozed, dismissed, and unverified results.
- **S04** **Given** a snooze menu, **When** a quick option is selected, **Then** its
  displayed wake-up time matches 2 hours, 24 hours, or the next Monday at
  9 AM local time. A later time-zone change preserves that saved instant.
- **S05** **Given** tracking is enabled, **When** startup or a manual refresh occurs,
  **Then** a shared check starts. Opening the inbox checks only if the last
  successful check is more than five minutes old. Concurrent triggers from
  multiple windows join one operation. Disabling tracking cancels its timers
  and prevents late results from changing the current view.
- **S06** **Given** an API reply or cached comment containing sensitive text,
  **When** diagnostics or E2E IPC tracing runs, **Then** neither body text nor
  credentials are recorded. Renderer state and saved layout contain no token.
- **S07** **Given** confirmed loss of issue access or removed credentials, **When**
  the app processes that change, **Then** the corresponding cached sensitive
  content is removed. A transient failure instead retains the last snapshot
  as stale; malformed Jira cache rows do not prevent terminal startup.
- **S08** **Given** an issue is returned by the account-ID JQL or is already
  tracked, **When** its inline comment container is incomplete, **Then** the
  app fetches and validates the complete comment pages before classifying it.
  A tracked issue is rechecked by its known issue ID even if JQL omits it; an
  untracked issue omitted by JQL does not trigger an all-recently-updated issue
  scan and may remain undiscovered under Jira's accepted comment-index limit.
- **S09** **Given** a first load, **When** the initial account-ID JQL scan starts,
  **Then** qualifying candidates in every accessible project are checked and
  only incoming mentions created in the preceding seven days, subsequent new
  comments, and qualifying mentions added by later edits are eligible inbox
  requests, across all accessible projects.
  Restart preserves that history boundary, and tracked requests remain
  eligible after they become older than seven days.
  Jira issues omitted by its comment-text index do not cause an all-updated-
  issue fallback.
- **S10** **Given** an old, previously unmentioned comment outside the initial window,
  **When** its author edits it after tracking starts to add a structured
  mention of the authenticated account, **Then** discover and evaluate it as
  an eligible request. Persist its eligibility across restart. An already
  answered comment remains answered when its source is edited.
- **S11** **Given** a committed ticket with description, context comments, extracted
  user IDs, a resolving reply, and a snoozed separate request, **When** the app
  restarts or the rule is recomputed, **Then** the detail view and mention
  suggestions restore from cached structured data, the answer retains its
  specific reply evidence, and the snooze remains a separate local decision.
- **S12** **Given** an incoming comment has a qualifying reply, **When** its author
  edits that same incoming comment after the reply, **Then** refresh the
  displayed content while keeping it answered and out of the active count.
- **S13** **Given** a previously qualifying reply is edited to remove the original
  author's mention or is deleted, **When** a complete consistent comment check
  confirms the change, **Then** earlier requests are recomputed and become
  unanswered unless another qualifying reply remains. A failed/partial check
  alone cannot erase the saved resolution evidence.
- **S14** **Given** comments change while multiple pages are fetched, **When** the
  resulting version/count checks disagree, **Then** retry or report partial
  coverage rather than deleting comments missing from that inconsistent set.
- **S15** **Given** several issues with active unanswered comments, **When** the inbox
  is shown, **Then** the group with the newest active mention comes first
  while each group's comments remain chronological. Resolving, snoozing, or
  dismissing that newest comment recalculates its group's position using the
  remaining active comments; unrelated issue edits do not change that order.
- **S16** **Given** valid Jira credentials, **When** tracking runs, **Then** the target
  identity is the account authenticated by those credentials, and the result
  does not depend on the account's mutable display name.
- **S17** **Given** another user mentions the authenticated account in a comment and
  the account has not commented later, **When** the relevant issue is checked,
  **Then** the mention appears with the issue and comment context.
- **S18** **Given** a comment merely contains the person's name in plain text,
  **When** the issue is checked, **Then** it does not appear as a mention.
- **S19** **Given** the account replies with a mention of the original author and is mentioned again
  later, **When** the issue is checked, **Then** the later mention appears and
  the earlier one is resolved by that reply.
- **S20** **Given** Alice mentions the user and the user later comments without
  mentioning Alice, **When** the issue is checked, **Then** Alice's comment
  remains unanswered.
- **S21** **Given** Alice and Bob each mention the user on one issue, **When** the user
  replies mentioning only Alice, **Then** Alice's earlier comments are resolved
  and Bob's remain; a reply mentioning both resolves both authors' earlier
  comments. Mentioning Alice on a different issue does not resolve this one.
- **S22** **Given** a qualifying mention on an accessible project with no open folder
  whose issue is returned by account-ID JQL or is already tracked, **When**
  tracking runs, **Then** it is included regardless of project prefix, issue
  status, or assignee. The feature does not enumerate every updated issue to
  compensate for Jira omitting an untracked issue from comment search.
- **S23** **Given** a matching issue has more comments than one response page,
  **When** it is checked, **Then** comments across required pages are evaluated
  or the item is clearly marked as not fully checked.
- **S24** **Given** the search has no qualifying mentions and completes within its
  configured scope, **When** results load, **Then** the user sees an empty state
  and the time of the check.
- **S25** **Given** Jira denies access, rate limits, or becomes unavailable,
  **When** a check runs, **Then** the user sees an actionable failure or partial
  state, not a definitive zero count.
- **S26** **Given** a newer refresh or changed Jira account, **When** an earlier
  request finishes, **Then** its results do not overwrite the current view.
- **S27** **Given** an unanswered item, **When** the user selects it, **Then** its
  detail and reply card appear inside the inbox. Activating Open in Jira
  through the issue key opens its issue in the external browser and modifies
  no Jira data.
- **S28** **Given** three unanswered comments in the checked scope, **When** the Jira
  feature is enabled, **Then** the top-left button shows `3`; activating it
  reveals the Jira sidebar entry with the supplied notifications bell icon,
  and selecting that entry shows the full inbox in the workspace without
  opening a terminal or a top tab strip. The launcher and sidebar use the same
  icon.
- **S29** **Given** the Jira inbox is visible, **When** the user selects a project
  folder in the sidebar, **Then** that project's existing pane workspace
  returns; selecting Jira mentions again restores the inbox.
- **S30** **Given** Jira mentions and several project folders share the sidebar list,
  **When** Jira is newly enabled and then dragged between two folders or to
  either end of the list, **Then** it starts first, remains reorderable without
  a separate feature section, and the chosen position is preserved after restart.
- **S31** **Given** a saved complete inbox snapshot, **When** the app restarts,
  **Then** the previous count and results appear as cached with their last
  successful check time while the catch-up check runs.
- **S32** **Given** a completed check followed by an interrupted or failed check,
  **When** the app restarts, **Then** it retains the completed snapshot and
  retries without treating the later attempt as successful.
- **S33** **Given** the configured Jira site or authenticated account changes,
  **When** the inbox is opened, **Then** cached content from the previous
  identity is not shown.
- **S34** **Given** a fresh install or an upgrade from a release without Jira caching,
  **When** the feature initializes, **Then** the cache is created automatically
  and existing settings, session data, and layouts remain intact.
- **S35** **Given** an older supported shared database schema with saved mentions and sync
  state, **When** the application upgrades it, **Then** both are preserved;
  interruption leaves a valid old or new schema that can be reopened safely.
- **S36** **Given** a newer unsupported schema or a failed schema upgrade, **When**
  the app starts, **Then** affected database features report a recoverable error
  without deleting the database or blocking other app functionality.
- **S37** **Given** Jira cache data and session data coexist in the database, **When**
  the session index is rebuilt or the Jira cache is cleared, **Then** only the
  intended subsystem's tables change and the other subsystem's data survives.
- **S38** **Given** background polling is enabled at 15 minutes and the inbox is not
  selected, **When** the interval elapses while the app is running, **Then**
  one shared check updates the count; an interval outside 5–240 or a fractional
  value is rejected, and disabled polling schedules no background checks.
- **S39** **Given** a snoozed or dismissed incoming comment, **When** tracking refreshes
  or the app restarts, **Then** its local state survives and it remains excluded
  from the active count. A separate new comment still appears normally.
- **S40** **Given** a snooze expires while offline or during app shutdown, **When** the
  due time arrives in the running app or the app next starts, **Then** the
  still-unanswered comment returns to the active inbox and count without
  waiting for network access. Restoring a dismissed comment works likewise.
- **S41** **Given** Alice's incoming comment and a nonblank draft, **When** the user
  inserts Alice's inline mention and posts the reply, **Then** Jira receives a structured mention
  using Alice's original account ID and the reply text; only confirmed success
  resolves Alice's earlier comments on that issue. Bob's remain unless Bob
  is also mentioned. Identical display names cannot redirect replies.
- **S42** **Given** text before and after the cursor, **When** the user selects Alice
  from the `@` suggestions there, **Then** her mention is inserted between
  that text and remains in that position in the submitted Jira comment.
  Removing it leaves no hidden recipient or automatic mention. Posting text
  without a structured mention does not resolve Alice's outstanding comments.
- **S43** **Given** ticket users from assignee/reporter/custom fields/comments/mentions,
  **When** the user types `@` and part of a name, **Then** available matching
  users appear once per account ID; keyboard and pointer selection both insert
  the chosen identity at the cursor. Posting serializes its ID while retaining
  the visible text order. Two users sharing a display name remain distinct.
- **S44** **Given** a reply is in flight, **When** the user activates Post reply again,
  **Then** no duplicate request is sent. A rejected request preserves the
  draft and unresolved state; uncertain delivery triggers a comment recheck
  before another send is offered.
- **S45** **Given** a successful reply and an older refresh still running, **When**
  that refresh returns old data, **Then** it cannot restore work resolved by
  the confirmed reply or change the global successful-search checkpoint.
- **S46** **Given** a restricted/internal source comment whose audience cannot be
  preserved by the supported reply path, **When** the user views it, **Then**
  the app offers opening Jira and does not post an unrestricted reply.
- **S47** **Given** an old comment first discovered with a current structured
  mention and a last edit after tracking started, **When** historical contents
  are unavailable, **Then** include and classify it without demanding proof
  of when the mention was added. A qualifying reply still makes it answered,
  and dismissal remains available.
- **S48** **Given** a selected incoming mention with attachments and surrounding
  comments, **When** its detail is shown, **Then** the composer follows
  attachments and precedes the comment history, and all comment content flows
  at natural height without nested scrolling or resize handles.
- **S49** **Given** a standard Jira comment with no platform `visibility`
  field, **When** the user opens it in the inbox, **Then** the composer treats
  it as unrestricted and can post a reply.
- **S50** **Given** a Service Desk comment with a public or internal audience
  and an optional supported group/role restriction, **When** a reply is posted,
  **Then** the request carries the same audience and the created comment is
  checked against it before success is confirmed.
- **S51** **Given** both earlier and later comment groups are present, **When**
  the detail renders, **Then** both groups are visible in newest-first order
  around the selected comment and the detail pane uses normal page scrolling.
- **S52** **Given** the user focuses the Jira search or reply field, **When**
  typing, **Then** neither field shows the browser-default orange outline and
  both use the theme accent caret like the app's existing text fields.

## Open Questions

None outstanding.

## Resolved Decisions

- Treat an old comment first discovered with a current mention and a last edit
  after tracking started as eligible, even if historical mention contents are
  unavailable. This minor ambiguity does not justify an audit-history system;
  the user can dismiss an irrelevant request.
- Removing a qualifying reply or its mention reopens the request unless
  another qualifying reply remains; the user can dismiss it locally.
- A mention newly added by an edit after tracking starts is eligible even on
  a comment older than the initial seven-day window. This does not override
  the rule that edits to an already answered source comment do not reopen it.
- Initial load covers incoming mentions from the past seven days across all
  accessible projects. Persist the initial boundary; this does not expire
  tracked unanswered requests after a week or reset coverage on restart.
- Discovery uses account-ID comment JQL across all accessible projects and
  directly rechecks known tracked issues. An untracked issue omitted by Jira's
  comment-text index may remain undiscovered; never scan all recently updated
  issues as a fallback. This accepts Jira's documented 1,000-comment JQL index
  limit and avoids the measured all-updated query volume. Resolved by the
  auto-orchestrator's blind decision pass in accordance with the user's
  explicit no-all-issues constraint.
- Quick snoozes are 2 hours, 1 day (24 hours), and next Monday at 9 AM local
  time, saved as an absolute wake-up instant.
- Editing an incoming comment after it has been answered does not reopen it.
  A new incoming comment is separate work; removal of the qualifying reply
  evidence still triggers the existing resolution recomputation rule.
- Keep the UI concise: no persistent how-to commentary or repeated workflow
  explanations; use labels, visible state, and contextual feedback.
- The tracked person is the authenticated Jira account, determined per user
  from the configured credentials. This avoids manual identity matching and
  reuses the existing secure credential setup.
- Detection requires a structured comment mention and a chronological comment
  check. Discovery uses `comment ~ "<authenticated accountId>"` with the issue
  update lower bound to avoid enumerating all recently updated issues. JQL text
  matches are candidates only; structured ADF identity and chronological reply
  rules remain authoritative.
- Provide a small API-backed reply composer using the configured credentials,
  with inline account-ID mentions from users available in the fetched ticket
  and its comments. Users control
  each mention's position through `@` suggestions in the editor; fixed
  recipient chips and automatic mention prefixes/suffixes are rejected.
  This is the one scoped write path; the existing Jira status-badge workflow
  and all refresh/polling remain read-only. Jira Cloud supports adding comments
  through its [comment API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
  and structured [mention nodes](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mention/).
  No live comment was posted during discovery; actual write permissions and
  restricted-audience handling still require verification during implementation.
- Include every accessible Jira project without project/JQL filtering or
  dependence on open folders. A reply resolves only earlier incoming comments
  whose original author is explicitly mentioned in the user's later comment
  on the same issue. Group by issue, with the active badge counting comments.
- Refresh on startup, on opening an inbox older than five minutes, and on
  demand. Optional polling accepts 5–240 whole minutes and defaults off.
  Incremental catch-up, rechecking outstanding issues, and a complete search
  at the first refresh after 24 hours are accepted.
- Provide local per-comment snooze and dismiss actions with restoration.
  Exclude suppressed comments from the active count while preserving their
  state across refresh and restart, using the confirmed quick snooze times.
- Cache the selected ticket context, fetched comment bodies, derived mention
  states, and short excerpts in SQLite without encryption, as accepted by the user. Add tables to the existing
  `session-index.db` and accept its historical filename. Session and Jira data
  share one database and coordinated schema migrations, with subsystem-scoped
  cache clearing and rebuilding. Credential storage continues to use the
  existing encrypted settings mechanism.
- Update the existing whole-database replacement fallback as part of sharing
  the database: session initialization or migration failure must not discard
  Jira tables. This is a targeted compatibility change; a broader database
  recovery redesign is outside this feature's scope.
- Navigation uses a counted top-left Jira button, a Jira tab in the shared
  sidebar list, and a full workspace view. Feature tabs have no separate
  header or section and can be dragged among project folders. The current
  app has no top tab navigation; the
  [updated feature-view prototype](../../docs/prototypes/jira-mentions/02-sidebar-feature.html)
  illustrates the chosen direction. Later non-terminal features can use the
  same sidebar pattern.
- The user expects issues with more than 1,000 comments to be exceptional and
  accepts Jira's comment-text search limit for this feature. The UI still must
  identify a known incomplete check rather than report a definitive empty
  result ([JQL fields](https://support.atlassian.com/jira-software-cloud/docs/jql-fields/)).

## Out-of-Scope Notes

- Jira description mentions, plain-text `@name` references, assignment-based
  requests, and Jira notifications could support later workflows. This draft
  targets comment mentions because their author and mention identity can be
  checked against ordered comments.
- Jira webhooks or an installed server-side app could reduce future discovery
  traffic but are not required for this desktop credential-based integration.

## Handoff Contract

- Implement the agreed sidebar navigation and connected comment/reply design,
  using the separate real-ticket-context prototype for the additional detail
  layout. Preserve the baseline prototype and keep real local data ignored.
- Preserve authenticated account-ID identity, seven-day initial coverage,
  later edit eligibility, explicit recipient matching, and independent local
  snooze/dismiss state. No project filtering or resolution based on status.
- Preserve session data during additive shared-database upgrades and every
  scoped cache clear; never treat migration failure as database corruption.
- Implementation was invoked against this ready spec and the independently
  approved adjacent plan. The implementation and its execution evidence are
  recorded in [`080-jira-unanswered-mentions.plan.md`](080-jira-unanswered-mentions.plan.md).
- The independent `verify-spec` gate completed on 2026-10-17. Its row-by-row
  evidence and T11 screenshots are recorded in the adjacent plan. Local tests
  verify the app's restricted-audience handling; no Jira tenant or live write
  was used, so production tenant round-tripping remains UNVERIFIED.
- This spec and its adjacent plan were archived to `specs/done/` after the
  requirements, scenarios, plan evidence, and required screenshots passed.
