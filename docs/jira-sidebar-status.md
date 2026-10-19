# Jira sidebar integration

This document expands the `AGENTS.md` **Jira sidebar status badges** guardrails.
It covers status badges and the separate unanswered-mentions inbox.

## Ownership and credentials

The main process owns Jira settings persistence, credential access, network
requests, and refresh scheduling. The token is encrypted through Electron
`safeStorage` in the Jira settings file. The Settings form may hold the decrypted
token only in component memory for its password Show/Hide control. If secure
storage is unavailable or a secure write/decrypt fails, the app fails closed and
never writes plaintext. Tokens, account email, comment bodies, and reply drafts
must stay out of renderer persistence, layout state, logs, errors, diagnostics,
and IPC traces.

Playwright's cross-platform Jira integration tests use a per-run AES-GCM key
through `MULTIAGENT_E2E_JIRA_SECURE_STORAGE_KEY`, because CI runners do not
consistently provide an OS keychain. The main process accepts that adapter only
for an unpackaged app whose `MULTIAGENT_E2E_USER_DATA_DIR` equals the active user
data path. Tests use synthetic credentials in temporary profiles; ordinary and
packaged app launches continue to use Electron `safeStorage`.

Status badges and unanswered mentions share credentials but have different
lifecycles. A badge lookup is read-only and runs only for initial appearance or
an explicit per-folder/bulk refresh. It does not poll or mutate Jira. Mention
discovery and refresh are also read-only; the only new Jira write is a comment
created after an explicit **Post reply** action in the inbox. No status-badge
path may call that write operation.

## Status badge lookup

The renderer derives an issue key only from the leading whitespace-delimited
token of a displayed project-folder label. Matching is a case-insensitive
literal prefix followed by decimal digits. There is no pane lookup,
Recent-session lookup, transcript/path scan, timer, polling, Jira mutation, or
automatic tab closure.

Each row owns its request generation and cached result. A late response is
discarded after a rename, close, configuration change, or newer refresh. A
transient failed refresh retains the last successful status as explicitly
stale; an invalidated base URL or issue key never exposes its old link until
refreshed.

## Unanswered-mentions inbox

The main-owned `JiraMentionsService` verifies the authenticated account through
`/myself`; it uses the returned account ID for structured ADF mention matching.
The renderer receives only sanitized issue/comment projections and invokes
typed operations for refresh, local disposition, detail, and explicit reply.
Every window shares the same main service and published projection, so refreshes
coalesce and counts remain consistent without each window starting its own
network work.

The first successful identity verification anchors an initial seven-day history
boundary to the scan start. Enhanced issue search and comment retrieval follow
all pages and validate issue/comment markers before publication. Discovery JQL
must combine the update lower bound with `comment ~ "<authenticated accountId>"`;
never enumerate all recently updated issues. JQL results are candidates only:
the service verifies structured ADF account IDs before publishing. Jira's
comment-text index may search only the most recent 1,000 comments on a larger
history, so keep that recall boundary visible in verification and never replace
it with an all-issues scan. Incomplete pages leave the previous complete
projection visible and report partial/error state. The committed evidence
includes comment identity, author, timestamps,
structured body, visibility, and the rule result needed to recompute answered
state after edits or deletions. Issue status never answers a mention.

Mention snapshots, local dismissals/snoozes, retry metadata, and reply-attempt
outcomes live in additional tables in the existing `session-index.db`. The
shared `ApplicationDatabase` coordinates schema version 3 with session tables
in one transaction. Jira cache clearing deletes fetched issue/comment evidence
and staged scans while retaining the initial history anchor, local actions, and
unresolved reply-attempt metadata. Removing the Jira credentials removes the
associated identity context. A subsystem rebuild must not replace the shared
database; failed or newer-schema opens preserve the original file and surface a
sanitized recoverable status while the rest of the app remains available. The
Electron-ABI migration and scoped-rebuild harness is `npm run test:db`.

Background mention polling is optional, defaults off, and uses the saved
5–240-minute interval. Startup, explicit refresh, and opening a stale inbox can
also request a read-only scan. A Jira `Retry-After` deadline blocks immediate
retries, including manual refresh. Snoozes store an absolute wake-up timestamp
and can restore the local count without a network call.

Reply drafts exist only in renderer memory and are keyed by issue/comment for
the verified account session. The main process rechecks the source comment and
audience, validates structured recipients against users fetched from that
issue, and records the attempt before sending. Supported group/role visibility
is preserved; a missing Jira platform `visibility` field means the comment is
unrestricted. Service Desk comments get their `public` flag from the request-
comment API; replies carry that same public/internal audience and any group or
role restriction. The created audience is re-read before the reply is confirmed.
If audience metadata is absent or cannot be verified, the inbox keeps the Jira
fallback. A confirmed response is fed through the same comment-classification
rules. A timeout or malformed success response stays unknown and is never
retried automatically. A successful reply does not advance the discovery
checkpoint. See Atlassian's [Issue comments API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
and [Jira Service Management request comments API](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/).

## External links and diagnostics

Badge and inbox issue links send an issue key to main, not a renderer-supplied
URL. Main reloads current settings, builds a validated HTTP(S) issue URL, and
sends it through the external-browser allowlist. Renderer navigation, ADF links,
and auxiliary anchor paths must not bypass that validation. Non-image attachment
clicks send only the issue and attachment IDs; main looks up the cached Jira
content URL, checks it against the current configured Jira site, then uses the
same external-browser allowlist. The app opens Jira's link without downloading
the file, and raw URLs are never IPC arguments or trace values. Jira requests
reject redirects so Authorization cannot follow an untrusted origin.
Reply/comment content and structured drafts are omitted from IPC trace arguments.

Comment ADF media previews and image attachment clicks use the cached
attachment-ID boundary. Main confirms the attachment belongs to the selected
issue, accepts only supported raster image types, and caps the attachment at 8
MiB. It builds Jira's authenticated content endpoint from the configured HTTPS
API base and cached attachment ID, requesting `redirect=false` with a bounded
range sized to the attachment metadata when available, with an 8 MiB cap. It
uses `Accept: */*`; requesting the image's exact MIME can make Jira return 406.
If Jira still returns a redirect, main accepts only a signed HTTPS URL on
`api.media.atlassian.com` and makes that follow-up request without Jira
Authorization; further redirects are disabled. Previewing does not depend on
the cached attachment `contentUrl`, so older snapshots remain usable when they
contain the attachment ID and MIME metadata.
The renderer receives only the validated MIME type and bytes, creates a
temporary Blob URL for the inline image and zoom viewer, and revokes it when the
comment unmounts. Image attachments in the attachment list open the same viewer
inside MultiAgent; other attachment types retain their Jira link. SVG and other
unsupported image formats are not rendered. No attachment is saved to disk.

ADF media IDs can differ from Jira attachment IDs. A comment `media` node
renders inline when its ID directly matches cached attachment metadata, its
unique `alt` filename matches an image attachment, or (when `alt` is absent) a
single image attachment belongs to that comment's author and was added within
five minutes of the comment. Ambiguous or unmatched media shows a fallback
instead of guessing. Images load when they approach the viewport; clicking
opens a full-size viewer, and Escape, the close button, or the backdrop closes
it. Missing, unsupported, oversized, or failed previews show a short fallback
in the comment.

The client tests cover authentication, the byte-range request, MIME validation,
redirects, and the 8 MiB limit. The service test checks cached issue/attachment
lookup without requiring a cached content URL, and the renderer tests cover
inline rendering, attachment-list preview, and zoom behavior.

## Settings behavior

The Jira form follows the rest of the settings panel: edits are drafts while the
panel is open and are persisted when the Jira settings view closes. The footer
action is **Test Jira connection**. It sends the current base URL, email, and
token to a read-only Jira account endpoint without saving the draft. A
successful or failed test is shown inline and never blocks closing or saving the
settings. Mention tracking and its optional polling controls are independent of
the existing status-prefix list and badge lookups.
