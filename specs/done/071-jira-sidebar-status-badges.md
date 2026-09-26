# Spec: Jira Status Badges for Sidebar Project Folders

Status: done
Created: 2026-09-25
Completed: 2026-09-25

## Problem

MultiAgent users can keep many ticket-named project folders open in the sidebar.
The sidebar currently shows the project-folder name and its panes, but not the
current Jira status for that ticket. To determine whether a ticket is complete,
the user has to leave the sidebar workflow and inspect the ticket elsewhere.
This makes it tedious to identify folders that can be closed, especially when a
large number of tickets have accumulated.

## Goal

When a sidebar project-folder name matches a user-configured Jira issue-key
pattern, MultiAgent should show the ticket's current Jira status beside that
folder, and clicking that status should open the matching Jira ticket. The
status should be fetched once when the folder is detected at startup or created,
with explicit per-folder and bulk refresh actions and no background polling.

## Users & Context

Developers who organize project folders around Jira issue keys, such as
`DZ-1234`, use the primary sidebar as their working set and routinely close a
folder after its ticket reaches a completed status. This includes detached
project folders while they remain represented in the primary sidebar. The Jira
base URL is user-configured so the public application does not assume a
particular Jira site.

## Requirements

1. MultiAgent MUST provide Jira integration settings for an editable Jira base
   URL, an Atlassian account email, an API-token credential, and a repeatable
   list of user-configured issue-key matching patterns. The base URL MUST start
   empty and require user configuration.
2. The settings UI MUST allow the user to add, edit, remove, and save multiple
   matching patterns. A v1 pattern MUST be a literal, case-insensitive prefix
   such as `DZ-`; a matching issue key MUST consist of that prefix followed by
   one or more decimal digits, such as `DZ-1234`.
3. Jira credentials MUST be treated as sensitive: the account email and token
   MUST be masked as appropriate during entry, the token MUST be encrypted at
   rest in the app's persisted settings, and neither credential MUST appear in
   user-visible errors, diagnostics, or application logs.
4. A project-folder row in the primary sidebar MUST be eligible for Jira status
   lookup only when the leading token of its current user-visible name matches
   a configured pattern and yields a Jira issue key. Matching MUST be
   case-insensitive and MUST be based on the displayed project-folder name, not
   terminal output or the full filesystem path. A non-matching project-folder
   name MUST NOT show a Jira status badge or trigger a Jira lookup.
5. A successfully retrieved Jira status MUST appear as a compact, readable
   text badge in the matching project-folder header. The badge MUST identify
   the current Jira status by text and MUST NOT rely on color alone.
6. The successful Jira status badge MUST be a link to the matching issue in the
   configured Jira site. Activating the badge MUST open the ticket URL formed
   from the configured base URL and detected issue key in the user's external
   browser, without changing Jira data or the active MultiAgent project folder.
7. On application startup, every matching project-folder row represented in the
   primary sidebar, including detached project folders, MUST receive one initial
   status lookup. A newly created project folder whose name matches a configured
   pattern MUST also receive one initial lookup. The integration MUST NOT poll
   Jira or refresh statuses on a timer.
8. Each matching project-folder context menu MUST provide a user-invoked
   `Refresh Jira status` action. The action MUST request a fresh status for that
   folder and update the badge when the request completes.
9. The sidebar action row MUST provide a user-invoked `Refresh all Jira
   statuses` action adjacent to the existing expand/contract-all action. It MUST
   refresh every project-folder row currently represented in the primary sidebar
   that matches a configured pattern, including detached project folders, and
   MUST be disabled or clearly inert when no detected Jira project folders exist.
10. While a Jira lookup is in progress, the matching badge MUST communicate that
    the status is loading without blocking normal sidebar navigation. Repeated
    manual refreshes MUST NOT allow an older response to overwrite a newer result.
11. Jira responses that indicate an unknown issue, insufficient permission,
    invalid credentials, an invalid base URL, rate limiting, or a network
    failure MUST be represented as unavailable/unknown rather than as a valid
    status. The UI MUST never present an unknown or failed lookup as `Closed`,
    `Done`, or another successful status.
12. If a refresh fails after a successful status was already shown, the UI MUST
    retain the last successful status with a clear stale or refresh-failure
    marker and a discoverable retry path. A failed refresh MUST NOT silently
    present the retained status as current or erase the context needed to retry.
13. When Jira settings or matching patterns change, project-folder eligibility
    MUST be re-evaluated without making an implicit network request. A folder
    that stops matching MUST lose its Jira badge and Jira-specific refresh
    affordances. A folder that starts matching MUST be eligible for an explicit
    refresh-all or per-folder refresh, and existing retained results MUST be
    treated as stale until refreshed with the new configuration.
14. The integration MUST be read-only. It MUST retrieve issue status only and
    MUST NOT modify, transition, close, comment on, or otherwise write to Jira
    issues.
15. Status badges and cached lookup state MUST be scoped to each project-folder
    row rendered in the primary sidebar, whether its tab is local or detached.
    The integration MUST NOT add status polling or implicit ticket-closing
    behavior to panes, Recent sessions, or other surfaces in this iteration.

## Non-Goals

- We will NOT automatically close a project folder when Jira reports a completed
  or closed status.
- We will NOT poll Jira continuously or refresh on every sidebar render.
- We will NOT create, edit, transition, comment on, assign, or otherwise modify
  Jira issues.
- We will NOT add a Jira issue browser, embedded Jira page, or full Jira search
  workflow.
- We will NOT infer ticket keys from arbitrary terminal output or session
  transcripts.
- We will NOT make Jira status a replacement for the existing project-folder
  name, pane status, or agent status indicators.

## Scenarios (Acceptance Criteria)

- **Given** Jira integration is configured with the target base URL, valid
  credentials, and the `DZ-` pattern, **When** a persisted project folder named
  `DZ-1234` is restored at startup and its status lookup succeeds, **Then** the
  folder header shows a text badge containing the Jira status returned for that
  issue.
- **Given** a project folder is named `DZ-1234` and the `DZ-` pattern is
  configured, **When** the user creates that folder, **Then** MultiAgent performs
  one initial Jira status lookup without requiring the user to open the folder.
- **Given** the sidebar contains a project folder whose name does not match any
  configured pattern, **When** the sidebar renders and when bulk refresh is
  invoked, **Then** that folder has no Jira badge and is not included in the Jira
  requests.
- **Given** the configured pattern is `DZ-`, **When** project folders are named
  `DZ-1234`, `dz-1234`, `X-DZ-1234`, and `DZ-ABC`, **Then** only the first two
  folders are treated as matching Jira issue keys.
- **Given** several matching project folders are visible, **When** the user
  chooses `Refresh all Jira statuses`, **Then** each currently detected matching
  folder is refreshed and no unmatched folder is requested.
- **Given** a detached project folder matching `DZ-1234` is represented in the
  primary sidebar, **When** initial lookup or `Refresh all Jira statuses` runs,
  **Then** that detached folder receives the same Jira badge and refresh behavior
  as a local project folder.
- **Given** a matching project folder has a displayed status, **When** the user
  opens its project-folder context menu and chooses `Refresh Jira status`,
  **Then** a fresh request is made for that issue and the badge reflects the
  newest successful response.
- **Given** a matching project folder has a successful Jira status badge, **When**
  the user activates the badge, **Then** the configured Jira site opens the
  matching issue in the external browser and the active MultiAgent project
  folder remains unchanged.
- **Given** a lookup is in progress, **When** the user navigates to another
  project folder or pane, **Then** sidebar navigation remains usable and the
  lookup may finish without requiring the user to revisit the folder.
- **Given** two manual refreshes for the same project folder are issued close
  together and the older response arrives last, **When** both responses are
  processed, **Then** the older response cannot replace the newer lookup result.
- **Given** Jira returns an authentication, permission, not-found, rate-limit,
  or network error, **When** the lookup finishes, **Then** the folder shows an
  unavailable/unknown state or clearly marked stale state and never reports the
  ticket as closed or complete.
- **Given** a folder previously displayed a successful Jira status, **When** a
  user refresh fails, **Then** the previous result is not silently presented as
  current, a stale/failure marker is visible, and the user can retry it.
- **Given** a project-folder name is changed so it no longer matches, **When**
  the rename is committed, **Then** the Jira badge and Jira refresh action are
  removed and no later bulk refresh includes that folder.
- **Given** the user has configured credentials and matching patterns, **When**
  the application is restarted with the same profile, **Then** the base URL,
  patterns, and masked credential setting are available for the next startup
  lookup without displaying the credential value.
- **Given** time passes after an initial lookup without a user refresh, **When**
  the sidebar remains open, **Then** MultiAgent makes no periodic Jira request.
- **Given** a matching folder has a displayed Jira result, **When** the user
  changes the Jira credentials, base URL, or matching patterns, **Then** the
  folder's eligibility is recalculated without an automatic Jira request and any
  retained result is treated as stale until an explicit refresh.
- **Given** the user saves a Jira token, **When** the application persists the
  settings, **Then** the token is not stored as plaintext and is not revealed
  when Settings is reopened.

## Open Questions

None outstanding.

## Resolved Decisions

- Jira lookup is read-only and status-only; it will not become a Jira mutation
  or ticket-closing workflow.
- There is no background polling. The initial lookup occurs at startup or when a
  matching project folder is created, and later refreshes are user initiated.
- The required per-folder refresh affordance is the existing project-folder
  context menu. A small badge-level refresh control is not required for the
  initial draft.
- A successful status badge is also the ticket link. Clicking it opens the
  detected issue in the external browser using the configured Jira base URL;
  this does not activate, close, or otherwise mutate the MultiAgent folder.
- The sidebar's existing expand/contract-all controls will be accompanied by a
  distinct bulk action for refreshing all currently detected Jira statuses.
- No Jira site is preconfigured; the base URL is editable and must be supplied
  by the user before status lookups or links can work.
- Jira Cloud authentication for v1 uses the configured account email plus API
  token and the configured base URL. This matches the supplied credential and
  avoids introducing an OAuth account-connection workflow in this iteration.
- The API token is encrypted at rest while remaining part of the app's ordinary
  persisted Settings experience. The Settings password field is masked by
  default and may reveal the decrypted value only when the user chooses Show;
  persisted plaintext, logging, and diagnostic exposure remain prohibited.
- Every matching project-folder row shown in the primary sidebar is in scope,
  including detached tabs represented there, because the user-visible workflow
  is the sidebar rather than tab ownership.
- v1 matching is deliberately limited to a case-insensitive leading prefix plus
  decimal issue number. This supports the stated `DZ-1234` workflow without
  making arbitrary regular expressions part of the first release.
- Saving Jira settings recalculates eligibility but does not make a network
  request. Explicit refresh remains the user's control over external requests.
- A failed refresh retains the last successful status with an explicit stale or
  failure marker so the user can still identify the ticket while knowing that
  the displayed value is not current.

External validation indicates that Jira Cloud REST API v3's Get issue operation
accepts an issue key and returns issue details, including status, subject to the
user's Browse projects permission. The operation is documented here: [Get issue
(Jira Cloud REST API v3)](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
Using the supplied account email and local `JIRA_ACCESS_TOKEN`, the configured
site returned HTTP 200 for `GLD-1955`; its status was `Main Development` with
status category `In Progress`. This validates the read-only lookup path without
including the credential in the spec.

## Out-of-Scope Notes

- A future iteration could provide user-defined status colors, completion
  categories, or a configurable list of statuses that count as closeable.
- A future iteration could support OAuth account connection and multiple Jira
  sites or credentials.
