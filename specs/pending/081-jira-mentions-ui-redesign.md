# Spec: Jira Mentions UI Redesign

Status: draft
Created: 2026-10-18
Completed:

## Problem

Jira Mentions already provides ticket context and replies under the
`jira-unanswered-mentions` contract. The current page gives substantial width
to the inbox, spreads ticket properties across rows above the description,
and encloses the conversation in a shared card. This framing and spacing
compete with the content needed to understand a request and respond.

The current renderer already has a flat, collapsible description with a
bounded automatic height and unlimited manual expansion, collapsed attachment
tiles, a composer before the timeline, and newest-first context around the
selected mention. These are starting behaviors to preserve. The composer
currently caps its height and scrolls internally for long drafts; selected
and surrounding comments currently have no resize controls.

The selected Ticket details rail mockup gives ticket properties a compact
secondary column and gives the description, attachments, reply, and discussion
a clearer primary reading path. It is a visual direction, not an executable
feature contract or a source of Jira data.

## Goal

Make Jira Mentions a focused workspace for understanding a selected request
and replying, using the selected mockup's hierarchy with less framing and
wasted space. Preserve the existing feature's data, safety, and reply behavior
while improving presentation and control over reading space.

## Users & Context

MultiAgent users reviewing their existing Jira mentions inbox need to read
the ticket description, inspect relevant attachments, understand surrounding
comments, and compose a reply without recreating Jira Cloud inside the app.
The selected incoming comment remains the reply target even when newer
comments appear above it in the timeline.

References:

- Existing functional contract: `jira-unanswered-mentions`.
- Approved visual direction: [Ticket details rail, mockup #4](../../docs/prototypes/jira-mentions/design-exploration/04-context-rail.html),
  with intent described in the [gallery index](../../docs/prototypes/jira-mentions/design-exploration/index.html).
  Its accompanying stylesheet and script describe illustrative presentation
  and interactions; the requirements below govern production behavior.
- Earlier layout and data-shape context: [real-ticket context prototype](../../docs/prototypes/jira-mentions/02-real-ticket-context.html)
  and its accompanying styles/script. Its ignored local data is not a design
  input and must not be inspected or copied for this work.

## Requirements

1. **Workspace hierarchy.** The page MUST retain the grouped mention inbox
   and selected ticket workspace. At widths that accommodate both, the ticket
   MUST have a primary content column and a compact right-hand ticket details
   rail beneath a clear issue header, following mockup #4. Properties MUST no
   longer consume multiple full-width rows above the description. At narrower
   widths, content and controls MUST remain reachable without overlap or
   clipping; the rail may flow into the page as illustrated by the mockup.

2. **Content treatment.** The description MUST read as normal page content
   with a heading and subtle section separation, without an enclosing card.
   Rendered description panels MUST NOT acquire generic card framing.
   Comments MUST read as a continuous timeline with lightweight separation,
   rather than a collection of nested cards. The selected mention and reply
   area MUST remain visually identifiable. Remove redundant surrounding
   padding and framing while retaining readable text and concise labels.

3. **Available ticket properties.** The rail MUST show populated status,
   issue type, priority, assignee, reporter, parent key, due date, and updated
   time from existing ticket context. Status MUST retain Jira status-category
   colors; issue type MUST use a distinct neutral badge and priority the
   existing gold treatment. People and dates MUST have readable labels and
   values. The already displayed created time MUST remain available. Missing
   optional values MUST be omitted, without empty property rows, invented
   names, dates, or default statuses. Color MUST accompany readable values,
   not replace them. No additional fields or requests are required by the
   mockup's illustrative content.

4. **Issue identity and link.** The issue key MUST remain the clickable Jira
   link in both the inbox group and selected ticket header, using the existing
   validated external-open behavior. The summary MUST remain descriptive
   text. Layout changes MUST NOT introduce a separate redundant Open issue
   control or bypass existing link validation.

5. **Reading and reply order.** The primary column MUST present description
   when present, attachments when present, reply editor, then the comment
   timeline. The editor MUST sit immediately below the attachment section,
   including when that section is collapsed; if attachments are absent, it
   follows the description or available header content. The editor MUST
   identify the selected issue and that it replies to the selected mention.
   Post reply and submission feedback MUST stay with the editor. Neither the
   composer nor its text-entry area may impose a fixed height or maximum
   content height that forces a separate vertical scrollbar; long drafts MUST
   expand the page and remain accessible through normal detail-page scrolling.

6. **Description sizing.** Before manual resizing, description height MUST
   follow its content up to the smaller of 35% of the detail viewport height
   or 360 px, with longer content scrolling inside that initial bound. The
   entire bottom edge MUST allow vertical resizing, with a visible grip and
   resize cursor. Manual dragging MUST have no upper size limit and MUST NOT
   change the column width. Collapse/expand MUST work independently of the
   chosen height. This keeps the automatic description from dominating the
   initial reply flow while allowing deliberate expansion.

7. **Timeline chronology and selection.** All fetched context comments MUST
   be visible by default. The timeline MUST sort by comment creation time,
   newest first: newer comments above the selected mention and older comments
   below it, labeled Earlier comments where grouped. Each context group MUST
   also run newest to oldest. The selected comment MUST appear exactly once
   in its chronological position, with a visible Mention indicator, author,
   time, and existing applicable local actions beside its header. Equal-time
   ordering MUST be deterministic without inventing later creation times;
   editing an old comment MUST NOT move it ahead of genuinely newer comments.

8. **Comment reading space.** The selected mention body and the newer and
   earlier context areas MUST each be independently vertically resizable
   when present. Resizing one MUST NOT resize the others, alter their order,
   change the column width, or hide actions. All content MUST remain reachable
   when an area is shortened. Initially, comments MUST flow at natural content
   height and the page MUST provide the normal history scrolling; internal
   scrolling is permitted only within a comment area the user has explicitly
   shortened. No fixed-height wrapper may contain the reply editor. Returning
   to the top on a different mention selection MUST be preserved.

9. **Attachment presentation.** Attachments MUST start collapsed for each
   newly selected mention. Expansion MUST reveal a horizontal row of Jira
   Cloud-style tiles with an image thumbnail where supported, filename, and
   size/date where available. Overflowing tiles MUST remain accessible
   horizontally. Non-image attachments may retain their existing validated
   open/download links with a file representation instead of a thumbnail.
   Missing metadata MUST NOT become invented values. The page MUST NOT have
   a redundant Show previews control or a cache-clearing button.

10. **Attachment lifetime and preview interaction.** Preview loading MUST
    remain lazy and bounded under the existing behavior. Collapsed sections
    MUST NOT fetch their hidden previews. Revealing attachments or comment
    context MUST request only previews needed by the existing lazy visibility
    behavior that are not already loaded or in flight. Within the current
    selected mention, reopening a section or showing the same attachment
    inline and in its tile MUST reuse loaded preview data and share an
    in-flight fetch. Changing to a different mention, including on the same
    issue, MUST release that preview scope; late results MUST NOT populate the
    new selection. Failed previews may be retried under the existing behavior.
    Inline comment images and loaded image tiles MUST remain clickable for
    the existing larger preview/zoom, with its existing close interactions.
    Missing, unsupported, oversized, ambiguous, or failed previews MUST retain
    appropriate fallbacks without blocking other content. Existing byte/type
    limits, attachment validation, and memory-only reuse MUST be preserved.

11. **Reply composition and drafts.** The relocated/restyled editor MUST
    preserve plain text and inline structured @mentions at the cursor,
    keyboard and pointer suggestion selection, multiple/removable mentions,
    fetched identity retention, and text/line-break order. Plain typed names
    MUST NOT become structured recipients implicitly. Candidate scope,
    disambiguation, original-author preference, and existing in-memory draft
    isolation/restoration across inbox navigation MUST remain unchanged.

12. **Posting and audience.** Only explicit Post reply with valid nonblank
    content MUST submit. Existing disabled states, duplicate-send prevention,
    success/error feedback, draft retention on failure, and uncertain-delivery
    recheck behavior MUST remain effective. Only confirmed success may affect
    answered state under the existing matching rule. Missing platform
    visibility MUST retain its unrestricted meaning; supported group/role
    and Service Desk audiences MUST remain preserved and verified. An audience
    that cannot be safely preserved MUST keep the Jira fallback and block
    posting to a broader audience.

13. **Inbox continuity.** Search, All, Active, Snoozed, Dismissed, Answered,
    refresh, counts, selected-row indication, checked time, and history/coverage
    information MUST remain available. Search, filter, and refresh MUST share
    a compact row. Preserve existing filter membership and ordering: active
    issue groups are newest first by their newest active incoming comment,
    with existing chronological ordering within those groups; All retains
    newest-first result ordering before issue grouping. This redesign MUST
    NOT replace these rules with issue-update ordering or the mockup's sample
    array order. Snooze, dismiss, restore, and unsnooze MUST retain their
    existing meanings and count effects.

14. **Theme and interaction consistency.** The page MUST match the app's
    existing colors, typography, text fields, focus treatment, caret, and
    scrollbars. Focusing or typing in search/reply MUST NOT introduce an
    orange outline or orange typing treatment. Controls MUST retain accessible
    names and existing keyboard interactions; the rail and timeline MUST
    remain readable with long values and wrapped content. Do not reproduce
    prototype gallery chrome, static-preview labels, instructional filler,
    or illustrative people as production UI.

15. **Existing feature states and content safety.** Loading, not checked,
    configuration required, authentication/permission failure, rate limiting,
    network failure, partial results, cached/stale results, unavailable detail,
    unavailable comments, and successful empty/filter-empty states MUST remain
    distinguishable wherever the existing feature exposes them. Last complete
    results and their last successful check time MUST remain available when
    permitted; incomplete or failed checks MUST NOT appear as a definitive
    empty inbox. Safe structured description/comment rendering, including
    aligned ADF tables and media fallbacks, MUST be preserved.

## Non-Goals

- Change discovery JQL, identity/account lookup, eligibility or answered-state
  rules, Jira API permissions, requests for ticket fields, refresh/polling,
  persistence, database schema, or attachment caching semantics.
- Build a generic Jira clone, add issue transitions/assignment/editing,
  unrelated Jira controls, new ticket fields, user-directory search, uploads,
  a rich-text toolbar, persistent drafts, or automatic sends/retries.
- Redesign settings, sidebar navigation, status badges, or other feature pages.
  Removing the Mentions page cache button does not remove existing settings
  cache management or change its semantics.
- Rewrite `jira-unanswered-mentions`, create an implementation plan, implement
  code, or create additional mockup variants as part of authoring this spec.
- Inspect ignored prototype local data or copy real ticket content,
  credentials, account IDs, tenant URLs, or mockup sample values into requirements.

## Scenarios (Acceptance Criteria)

- **S01 Populated ticket (R1-R5, R7).** **Given** existing context with a
  description, attachments, surrounding comments, and populated properties,
  **When** a mention is selected, **Then** a clear issue header precedes the
  primary reading column and compact right rail; the description is flat,
  the collapsed attachments precede the editor, and the timeline follows it.
  The selected comment is identified within that timeline.
- **S02 Optional content (R3, R5, R9).** **Given** a ticket without priority,
  assignee, reporter, parent, due date, description, or attachments,
  **When** selected, **Then** absent values and sections do not create empty
  property rows or fake values, remaining properties keep their labels, and
  the reply editor remains before the timeline without a blank attachment area.
- **S03 Long description (R2, R6).** **Given** description content exceeding
  the automatic bound, including structured panels or a table, **When** first
  displayed, **Then** it uses at most the smaller of 35% of the detail viewport
  or 360 px and scrolls internally without added card framing or misaligned
  table columns. **When** dragged from the left, center, or right of its bottom
  edge beyond that bound, **Then** it grows without an upper drag limit;
  collapse/reopen retains its chosen height and does not change its width.
- **S04 Attachment expansion (R9-R10).** **Given** an uncached mention with
  image and non-image attachments, **When** selected with attachments collapsed,
  **Then** hidden tile previews are not fetched. **When** expanded, **Then**
  tiles form a horizontal row with available filename/size/date metadata and
  supported thumbnails, requesting previews lazily. No Show previews or
  cache-clearing button appears. Non-image actions retain validated opening.
- **S05 Preview reuse and release (R10).** **Given** a preview already loaded
  or loading in the current mention, **When** its attachment section is reopened
  or the same image is revealed in comment context, **Then** it reuses that
  data/request. **When** a different mention is selected, even on the same
  issue, **Then** the previous preview scope is released and late responses
  cannot appear in the new selection; loading there follows existing rules.
- **S06 Preview outcomes (R10).** **Given** a loaded inline image, **When**
  clicked, **Then** the larger preview opens and existing close/Escape/backdrop
  interactions work. **Given** unsupported, oversized, unmatched, or failed
  media, **When** displayed, **Then** its fallback leaves text, other
  attachments, and replies usable without changing preview limits.
- **S07 Timeline order (R7).** **Given** several comments created before and
  after the selected mention, **When** displayed, **Then** newer comments run
  newest to oldest above the selected mention and Earlier comments run newest
  to oldest below it. The selected mention appears once. Equal-time comments
  retain deterministic order; a later edit does not reverse creation chronology.
- **S08 Independent resizing (R6, R8).** **Given** the description, selected
  mention, and both context areas, **When** the user resizes each independently,
  **Then** only the chosen reading area changes height and all content remains
  reachable without changing column width, timeline order, or reply target.
  Initially comments have natural height; shortening one may introduce its
  own content scroll, while the reply remains in the page flow.
- **S09 Reply composition (R5, R11, R14).** **Given** a selected mention and
  available ticket users, **When** the user inserts several @mentions by
  keyboard and pointer between existing text, removes one, writes a long
  multiline draft, navigates away, and returns, **Then** text order and remaining
  structured identities are restored under existing draft isolation, without
  automatic recipients. The editor grows with content, uses page scrolling,
  and has the application's normal focus/caret treatment without orange.
- **S10 Submission outcomes (R12).** **Given** a valid draft, **When** Post
  reply is activated, **Then** posting feedback and duplicate-send prevention
  remain effective. Confirmed success updates work only under the existing
  reply rule. Rejection retains the draft and actionable error; uncertain
  delivery retains it and requires reconciliation before another send.
- **S11 Audience restrictions (R12).** **Given** an unrestricted comment
  without platform visibility or a supported restricted/Service Desk comment,
  **When** replying, **Then** existing audience validation and preservation
  apply. **Given** an unverifiable audience, **When** shown, **Then** posting
  remains blocked with the validated Jira fallback available.
- **S12 Inbox controls and links (R4, R13).** **Given** mixed active,
  snoozed, dismissed, answered, and unverified results, **When** searching,
  changing among all existing filters, refreshing, or taking local actions,
  **Then** existing membership, count effects, and ordering remain intact,
  including newest-first active issue groups and All results. Clicking an
  issue key from either surface opens that issue through existing validation.
- **S13 Loading and empty (R15).** **Given** an initial load, a detail load,
  or a completed successful check with no matching results, **When** shown,
  **Then** loading/context-loading, not-checked, and successful empty or
  filter-empty feedback remain distinct and checked time is truthful.
  Unavailable ticket/comment content retains its existing fallback.
- **S14 Failed and partial checks (R15).** **Given** configuration required,
  authentication/permission failure, rate limiting, network failure, or a
  partial check, with and without cached results, **When** displayed,
  **Then** the appropriate existing feedback remains visible, permitted last
  complete results retain their successful-check time and stale/partial
  meaning, and failure is not presented as a complete empty inbox.
- **S15 Constrained workspace (R1, R14).** **Given** long property values,
  long comments, and a workspace too narrow for the full side-by-side layout,
  **When** its width changes, **Then** the rail, reading content, inbox
  controls, and reply actions remain reachable and legible without overlap
  or clipped actions, consistent with the selected mockup's compact intent.

## Open Questions

None outstanding. The supplied direction and existing feature settle the
product choices needed for this draft; detailed sizing and layout mechanics
belong in the separately authored implementation plan.

## Resolved Decisions

- Mockup #4 is the selected direction. Its sample values, preview-only controls,
  and simplified behaviors do not override the existing functional contract.
- This spec supersedes `jira-unanswered-mentions` presentation language
  requiring one connected comment/composer card (R19), and the prohibition on
  comment resize handles/internal scrolling (R25/R27, S48). The composer stays
  before the timeline; comment areas gain independent optional resizing under
  R8. Natural initial comment height and normal page scrolling remain.
- Preserve the existing description automatic-height bound rather than
  copying the mockup's unrestricted initial description. Remove the existing
  reply height cap so long drafts remain part of normal page scrolling.
- Ticket properties use only populated existing context. The rail relocates
  the existing status/type/priority/people/date/parent information; it does
  not expand the fetched field set or make every available data field visible.
- Newest-first timeline order is distinct from existing filter-specific
  inbox grouping/order. The redesign preserves those inbox rules.

## Out-of-Scope Notes

Broader Jira functionality and additional visual variants require separate
product work. Prototype local fixtures are unnecessary for this redesign;
synthetic populated, sparse, and long-content cases can describe its outcomes.

## Handoff Contract

- Deliver only this draft at this stage. A separate agent owns the adjacent
  implementation plan and its independent review; implementation requires the
  repository's normal readiness and plan-approval gates.
- The non-negotiables are the selected hierarchy, available-data-only rail,
  composer placement and page scrolling, independent reading-area resizing,
  chronological selected mention, and preservation of the existing functional
  and privacy boundaries. Leave the original functional spec intact.
- Definition of done for the eventual redesign: every requirement and scenario
  has concrete passing evidence, the populated/sparse/long-content and existing
  state cases have been visually assessed against mockup #4 in the app theme,
  and preserved reply, link, inbox, and attachment behaviors have been verified.
  Record evidence in the adjacent plan during implementation/verification;
  this draft asserts no runtime verification or implementation completion.
