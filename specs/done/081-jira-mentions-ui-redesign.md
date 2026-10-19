# Spec: Jira Mentions UI Redesign

Status: done
Created: 2026-10-18
Completed: 2026-10-18

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

The selected Ticket details rail mockup defines the production visual design
for the inbox, ticket header, details rail, reading sections, reply area, and
comment rows. Jira Mentions should follow its spacing, dividers, selected-row
highlighting, and visual emphasis as closely as the app theme allows. Its sample
data and simplified behaviors are not production requirements; explicit
behavioral differences below take precedence.

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
- Production visual baseline: [Ticket details rail, mockup #4](../../docs/prototypes/jira-mentions/design-exploration/04-context-rail.html),
  with intent described in the [gallery index](../../docs/prototypes/jira-mentions/design-exploration/index.html).
  Its accompanying stylesheet and script define the intended visual treatment
  and hierarchy. The requirements below specify product data and explicit
  behavior differences.
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
   area MUST remain visually identifiable. Description, ticket-detail,
   comment, and reply text MUST use a reading size approximately one point
   larger than the prior presentation. This increase MUST stay within those
   regions and MUST NOT change inbox/global application text or attachment
   tile metadata. Remove redundant surrounding padding and framing while
   retaining concise labels.

3. **Available ticket properties.** The rail MUST show populated status,
   issue type, priority, assignee, reporter, parent key, due date, and updated
   time from existing ticket context. Status MUST retain Jira status-category
   colors; issue type MUST use a distinct neutral badge and priority the
   existing gold treatment. People and dates MUST have readable labels and
   values. Created time, when available, MUST appear as a labeled Created
   property in the rail alongside Updated, replacing its current placement
   after the comment history. Missing optional values MUST be omitted,
   without empty property rows, invented
   names, dates, or default statuses. Color MUST accompany readable values,
   not replace them. When existing Jira data includes populated user-valued
   custom fields whose display names are Dev Tester or Main Dev
   (case-insensitive), those people MUST also appear under matching labels in
   the rail. Use the existing field catalog and issue detail response; do not
   add a Jira request or display unrelated custom fields. If multiple custom
   field IDs share either matching name, omit that property rather than
   combining ambiguous values. The mockup's illustrative content does not
   authorize fetching additional fields or making unrelated custom fields
   visible. Treat field names as presentation labels only; do not persist
   catalog names or change existing user-source markers.

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
   identify that it replies to the selected mention; the selected issue MUST
   remain identifiable through its ticket header without repeating its key in
   the reply panel. Post reply and any submission feedback MUST stay with the
   editor. The default editor footer MUST NOT show redundant explanatory copy.
   Neither the composer nor its text-entry area may impose a fixed height or
   maximum content height that forces a separate vertical scrollbar; long
   drafts MUST expand the page and remain accessible through normal detail-page
   scrolling.

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
   time, and existing applicable local actions beside its header. Snooze and
   Dismiss MUST use distinct, readable semantic colors (amber for Snooze and
   the app's danger color for Dismiss) that remain visually separate from the
   selected mention's green highlight. Snooze MUST open a compact duration form
   anchored to its action, with a numeric amount, minutes/hours/days unit, and
   submit action; its increment/decrement controls MUST follow the dark form
   theme. It MUST NOT show a large expanded time display at the end of
   the selected comment. Clicking outside the form or pressing Escape MUST
   close it. Equal-time ordering MUST be deterministic
   without inventing later creation times;
   editing an old comment MUST NOT move it ahead of genuinely newer comments.

8. **Comment reading space.** The newer and earlier context areas MUST each
   be independently vertically resizable when present. The selected mention
   body MUST remain at natural content height and MUST NOT have a resize handle
   or area-local scrollbar. Resizing a context area MUST NOT resize the other,
   alter timeline order, change the column width, or hide actions. All content
   MUST remain reachable when a context area is shortened. Initially, comments
   MUST flow at natural content height and the page MUST provide the normal
   history scrolling; internal scrolling is permitted only within a context
   area the user has explicitly shortened. No fixed-height wrapper may contain
   the reply editor. Returning to the top on a different mention selection MUST
   be preserved.

9. **Attachment presentation.** Attachments MUST start collapsed for each
   newly selected mention. Expansion MUST reveal a single horizontal row of Jira
   Cloud-style tiles with an image thumbnail where supported, filename, and
   size/date where available. Overflowing tiles MUST remain accessible
   through horizontal scrolling at both desktop and narrow widths; tiles MUST
   NOT wrap into additional rows. This takes precedence over the mockup's
   wrapping desktop attachment layout. Non-image attachments may retain their
   existing validated open/download links with a file representation instead
   of a thumbnail.
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
    a compact row. The count beside Needs your reply MUST remain the global
    active unanswered-comment count for the tracked site/account, excluding
    dismissed and unexpired snoozed comments. Search and filter changes MUST
    NOT replace it with the number of visible results. Existing group counts
    remain scoped to the displayed group; any separate result count, if shown,
    MUST be labeled as shown results and reflect the current search/filter.
    No additional result counter is required. Preserve existing filter
    membership and ordering: active issue groups are newest first by their
    newest active incoming comment,
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

16. **Visual fidelity to mockup #4.** The mockup MUST be treated as the new
    design baseline, not a loose source of inspiration. At desktop widths, the
    inbox MUST retain the mockup's compact sidebar proportions, compact header
    and controls, selected mention's green-tinted row with a left accent, and
    subtle issue-group dividers. The ticket header MUST span the primary and
    rail columns and end with a thin divider. The details rail MUST have a
    visible vertical divider, a small `TICKET DETAILS` kicker, compact stacked
    label/value pairs, and the mockup's restrained status/type/priority badge
    treatments. The description and attachment sections MUST use concise
    headings/actions and subtle bottom dividers without card framing. The reply
    section MUST be a distinct, softly tinted panel with a restrained green
    border, a reply icon and heading that identifies the reply target, an inset
    bordered text field, and a footer that places Post reply at the lower right without a repeated
    ticket key at the upper right or a default helper description at the lower
    left. Submission feedback MUST still appear in the footer when available. The
    comment area MUST read as one light timeline with compact author/time rows,
    avatar initials where a name is available, thin separators, and the selected
    mention visibly called out with a green accent, a Mention tag, and adjacent
    actions. Use app theme tokens for all colors, focus, and text treatment; do
    not copy prototype hex values or gallery chrome. At narrow widths, preserve
    these visual relationships as the mockup stacks the inbox and details rail.
    Explicit behavior and content differences in this spec (including the
    one-row attachment scroller, creation-time ordering, live state/actions,
    Created property, and unbounded reply growth) MUST remain in effect.

## Non-Goals

- Change discovery JQL, identity/account lookup, eligibility or answered-state
  rules, Jira API permissions, add Jira requests or expand the existing fetched
  issue field set, refresh/polling, persistence, database schema, or attachment
  caching semantics.
- Build a generic Jira clone, add issue transitions/assignment/editing,
  unrelated Jira controls, request other ticket fields or render unrelated
  custom fields, add user-directory search or uploads, a rich-text toolbar,
  persistent drafts, or automatic sends/retries.
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
  The selected comment is identified within that timeline. When created time
  is available, it appears once as Created in the rail beside the other ticket
  properties, with no duplicate Created footer after the timeline.
- **S02 Optional content (R3, R5, R9).** **Given** a ticket without priority,
  assignee, reporter, parent, due date, created time, Dev Tester, Main Dev,
  description, or attachments,
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
  tiles form one horizontal row with available filename/size/date metadata and
  supported thumbnails, requesting previews lazily. **Given** more tiles than
  fit at either desktop or narrow widths, **When** expanded, **Then** they
  remain in one row with horizontal scrolling and do not wrap. No Show previews
  or cache-clearing button appears. Non-image actions retain validated opening.
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
  mention, and both context areas, **When** the user resizes the description
  and each context area independently, **Then** only the chosen resizable area
  changes height and all content remains reachable without changing column
  width, timeline order, or reply target. The selected mention body remains at
  natural height without a resize handle or local scrollbar. Initially all
  comments have natural height; shortening a context area may introduce its
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
- **S16 Count meanings (R13).** **Given** active unanswered comments across
  several issues, **When** a search matches only some or none, or the user
  selects Answered, Snoozed, Dismissed, or All, **Then** the Needs your reply
  count stays equal to the global active count, while displayed group counts
  reflect their visible comments. A separate shown-results count, if present,
  follows the search/filter and is labeled distinctly. **When** a local action
  or confirmed reply changes active work, **Then** the global count follows
  the existing active-count rules independently of the selected view.
- **S17 Named custom people fields (R3).** **Given** existing issue detail
  includes one populated user-valued custom field named Dev Tester and one
  named Main Dev, plus another unrelated user-valued custom field, **When** the
  issue is selected, **Then** only populated Dev Tester and Main Dev values
  appear as labeled people properties in the rail. Field names match without
  case sensitivity, empty values are omitted, and no additional Jira request is
  made. A matching field name with multiple field IDs is omitted as ambiguous.
  Field names remain transient presentation labels; cached user data and
  existing user-source markers are unchanged.
- **S18 Visual match to mockup #4 (R16).** **Given** the synthetic populated
  fixture at the same desktop width as a mockup #4 reference capture, **When**
  the production Jira Mentions view is compared section by section, **Then** it
  matches the mockup's compact inbox proportions and selected-row treatment,
  header divider, rail divider/kicker/stacked property rhythm, flat description
  and attachment sections with bottom dividers, framed green reply panel and
  inset text field, and compact separated comment rows with a highlighted
  selected Mention and adjacent actions. Colors come from the app theme. At
  narrow width the inbox and rail retain the same emphasis when stacked.
  Explicit spec differences remain intact, including the horizontal
  attachment row, Created property, newer/selected/earlier chronology, actual
  Jira state/actions, and page-growing reply editor. Any other visual departure
  from the mockup requires a documented spec decision before acceptance.
- **S19 Snooze duration form (R7).** **Given** an unanswered selected mention,
  **When** Snooze is activated, **Then** a compact duration form appears beside
  the Snooze action with a numeric amount, minutes/hours/days unit, and submit
  button, with the number stepper styled for the dark theme and without an
  expanded time display at the end of the comment. Clicking outside or pressing
  Escape closes the form; submitting applies the computed duration to the
  selected mention through the existing snooze action.
- **S20 Compact reply panel (R5, R16).** **Given** a selected issue and
  mention, **When** the reply editor renders without a prior submission,
  **Then** its heading identifies the selected mention and its footer shows
  Post reply without a duplicated issue key or static helper description.
  After submission, any delivery result or error feedback remains with the
  editor.
- **S21 Scoped reading typography (R2, R14, R16).** **Given** a populated issue
  at desktop or narrow width, **When** Description, ticket details, comments,
  and reply composition render, **Then** their reading text is approximately
  one point larger than the prior presentation and wraps without horizontal
  overflow. Inbox/global UI and attachment tile metadata retain their existing
  sizes.

## Open Questions

None outstanding. The supplied direction and existing feature settle the
product choices needed for this draft; detailed sizing and layout mechanics
belong in the separately authored implementation plan.

## Resolved Decisions

- Mockup #4 is the production visual baseline for layout, spacing, dividers,
  inbox selection emphasis, reply framing, and comment treatment. Its sample
  values, preview-only controls, and simplified behaviors do not override the
  explicit production behavior below.
- Attachment tiles remain one horizontally scrolling row at all widths,
  preserving the agreed row layout and avoiding expansion that pushes the
  reply farther down. This intentionally supersedes the mockup's desktop wrap.
- Needs your reply retains the existing global active count. The mockup's
  filtered/searched header count is illustrative and must not change that
  meaning; a shown-results count, if present, is separate and clearly labeled.
- Created joins Updated and the other populated ticket properties in the rail,
  so ticket dates are available together rather than below a long timeline.
  This relocates an existing value and does not request a new field.
- This spec supersedes `jira-unanswered-mentions` presentation language
  requiring one connected comment/composer card (R19), and the prohibition on
  context-group resize handles/internal scrolling (R25/R27, S48). The composer
  stays before the timeline; Newer and Earlier context areas gain independent
  optional resizing under R8, while the selected Mention body remains at
  natural height without a resize handle. Natural initial comment height and
  normal page scrolling remain.
- Preserve the existing description automatic-height bound rather than
  copying the mockup's unrestricted initial description. Remove the existing
  reply height cap so long drafts remain part of normal page scrolling.
- Ticket properties use only populated existing context. The rail relocates
  the existing status/type/priority/people/date/parent information and surfaces
  the already-fetched Dev Tester/Main Dev custom people fields; it does not
  expand the fetched field set or make unrelated custom fields visible. Their
  catalog names are transient presentation labels; cached Jira user data and
  its existing source markers remain unchanged.
- Match mockup #4's compact inbox, selected-row highlight, header/rail dividers,
  restrained detail labels, bordered reply panel, and lightweight timeline
  rows. The app theme replaces prototype colors, and explicit requirements
  override prototype behaviors and content.
- Newest-first timeline order is distinct from existing filter-specific
  inbox grouping/order. The redesign preserves those inbox rules.
- Snooze and Dismiss need separate semantic treatments so the selected
  mention's green tint does not make the actions look like the same state:
  Snooze uses amber and Dismiss uses the theme danger color.

## Out-of-Scope Notes

Broader Jira functionality and additional visual variants require separate
product work. Prototype local fixtures are unnecessary; use synthetic
populated, sparse, and long-content cases to compare the production page with
mockup #4 without copying prototype sample values.

## Handoff Contract

- Deliver only this draft at this stage. A separate agent owns the adjacent
  implementation plan and its independent review; implementation requires the
  repository's normal readiness and plan-approval gates.
- The non-negotiables are faithful visual treatment from mockup #4 (including
  inbox selection emphasis, dividers, reply framing, and comment-row styling),
  the selected hierarchy, available-data-only rail,
  composer placement and page scrolling, independent reading-area resizing,
  chronological selected mention, and preservation of the existing functional
  and privacy boundaries. Show Dev Tester/Main Dev only when their existing
  user-valued custom fields are unambiguous and populated. Do not persist field
  catalog names or alter existing cached user-source markers. Leave the
  original functional spec intact.
- Definition of done for the eventual redesign: every requirement and scenario
  has concrete passing evidence, a same-viewport, section-by-section visual
  comparison against mockup #4 records only the explicit differences in this
  spec, and populated/sparse/long-content and existing state cases have been
  visually assessed in the app theme,
  and preserved reply, link, inbox, and attachment behaviors have been verified.
  Record evidence in the adjacent plan during implementation/verification;
  this draft asserts no runtime verification or implementation completion.
