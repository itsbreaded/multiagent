# 051 — Browser MCP Tool Review: Agent-Observed Shortcomings vs. Playwright MCP

Status: done
Completed: 2026-07-26

Files in scope (read-only for this spec; it's a review/investigation spec, not an
implementation handoff):

- `src/main/browser/BrowserViewManager.ts` (485 lines)
- `src/main/mcp/BrowserMcpServer.ts` (528 lines)

Reference implementation for comparison: the official Playwright MCP server —
https://github.com/microsoft/playwright/tree/main/packages/playwright-core/src/tools/mcp

## Problem

An agent session (Claude, working in an unrelated project — a Next.js app called
GameTracker) used this repo's `browser_*` MCP tools for an extended UI-testing pass:
registering a user, logging in, searching, adding/removing library entries, editing a form
field. Three friction points surfaced, each costing multiple round-trips of the agent
mis-diagnosing its own actions as application bugs before finding the real cause. None of
these are "the tools are broken" — the actions the agent asked for did happen — but the
tools' *feedback* about what happened was unreliable or ambiguous enough to actively mislead.

This spec documents what was observed, with source line references, and asks whether
adopting patterns from Playwright's MCP tool set (locator strict-mode, evaluate
function-wrapping, and/or explicit actionability waiting) would close the gaps cheaply. It
does **not** propose depending on Playwright itself — see Non-Goals.

## Observed Issue 1 — `browser_wait_for_text` false negative on text that is demonstrably present

**Symptom:** the agent clicked a "Remove" button (via `browser_click_text`), then called
`browser_wait_for_text({ text: "Remove?" , timeout_ms: 3000 })` to confirm a confirmation
prompt appeared. The call timed out — `Text not found within 3000ms: "Remove?"` — three
separate times across a clean page reload, a coordinate-based click retry, and a `Remove`
selector re-query, ruling out "wrong element" as the cause.

The agent then called `browser_evaluate` with a script that clicked the button and, ~300ms
later inside the same script, read `document.querySelector('li').innerHTML` directly. That
read **did** show the "Remove? Yes Cancel" markup. A follow-up `browser_screenshot` visually
confirmed the confirm state was rendered correctly. So: the state change happened, and was
visible in the DOM within 300ms — comfortably inside the 3000ms `waitForText` budget — but
`browser_wait_for_text` still reported "not found."

**Current implementation** (`BrowserViewManager.ts:415–424`):

```ts
async waitForText(text: string, timeoutMs = 5000): Promise<void> {
  const wc = this._requireWebContents()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await wc.executeJavaScript(
      `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`
    ) as boolean
    if (found) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Text not found within ${timeoutMs}ms: ${JSON.stringify(text)}`)
}
```

This polling loop looks correct in isolation — 200ms interval, plain `innerText` substring
check, no obvious logic bug. Two leading hypotheses, neither confirmed:

1. **`sendInputEvent` is fire-and-forget relative to the renderer's actual event handling.**
   `click()`/`clickAt()`/`clickText()` (`BrowserViewManager.ts:97–114`, `286–301`, `303–354`)
   dispatch synthetic OS-level `mouseDown`/`mouseUp` via `wc.sendInputEvent(...)` and return
   as soon as `_waitForNavigationIfStarted()` resolves — which only guards *navigation*, not
   an in-page React re-render. If the MCP call for the click resolves before Chromium has
   actually run the click handler and committed the re-render, and the *next* MCP tool call
   (`waitForText`) is dispatched as a genuinely separate IPC round-trip, there could be a
   scheduling gap this repo hasn't characterized. This doesn't obviously explain a 3-second
   miss, but it's the only asynchronous gap in the path that isn't unit-tested today.
2. **Something about polling via repeated `executeJavaScript` calls under load.** Each poll
   iteration is its own IPC round-trip into the renderer; if calls queue up behind other
   pending `executeJavaScript` invocations (the agent was also issuing `browser_screenshot`
   and `browser_get_elements` calls in nearby turns), a poll could silently stall past its
   nominal 200ms cadence. Not verified — no logging currently exists to see actual poll
   timestamps vs. wall clock.

**This needs investigation, not a guessed fix.** Recommend adding temporary debug logging
(poll timestamp + result) around this loop, reproducing against a real Next.js/React dev
app (not this repo's own renderer, which is unlikely to hit the same race), and checking
whether Playwright's own polling primitive (`page.waitForFunction` /
`expect(locator).toBeVisible()`, which uses a raf-driven poll rather than a fixed
`setTimeout`) sidesteps the issue structurally.

## Observed Issue 2 — `browser_click_text` silently clicks the first match, no ambiguity signal

**Symptom:** a page had 20 buttons all labeled "Add" (one per search result row).
`browser_click_text({ text: "Add" })` clicked the first one with no error, no warning, and
no way for the agent to know from the tool's own response whether "Add" was unique on the
page. The agent had to separately call `browser_get_elements('button')` and count matches to
even notice the ambiguity, then fall back to coordinate math (`browser_click_at`) to hit a
*specific* row's button.

**Current implementation** (`BrowserViewManager.ts:303–354`): a three-pass DOM walk
(`<a>` → buttons/ARIA roles → structural containers), returning the coordinates of the
**first visible match** in the first pass that finds one. There is no count of total matches
in the return value, and the tool description (`BrowserMcpServer.ts:353`, "Click the first
visible element whose text content matches the given string... Preferred over
browser_click when you know the label but not the CSS selector") documents the first-match
behavior but doesn't warn about silent ambiguity.

**Playwright's equivalent** (`getByText()`/`getByRole()` locators used in *strict mode* by
default) throws a `strict mode violation: ... resolved to N elements` error instead of
silently picking one, forcing the caller to disambiguate (`.first()`, `.nth()`, or a more
specific locator) — an explicit decision rather than an implicit one. Worth reviewing
Playwright MCP's actual tool surface at the linked repo to see whether its `browser_click`
equivalent (which takes a Playwright *ref* from a prior snapshot, not free-text) avoids this
class of bug entirely by construction rather than by strict-mode errors.

## Observed Issue 3 — `browser_evaluate` doesn't wrap scripts in an async context, and the resulting `SyntaxError` looks identical to an application bug

**Symptom:** the agent submitted a `browser_evaluate` script using a top-level `await`
inside an `async () => {...}` wrapper it wrote itself, but on one call wrote `await` at the
literal top level of the submitted string (a scripting mistake, not a tool bug). The
resulting `SyntaxError: await is only valid in async functions and the top level bodies of
modules` was reported to the agent, but it was *also surfaced inside the target page's own
Next.js dev-error-overlay* (a red "1 Issue" badge, full-screen error card), indistinguishable
in the moment from a real application runtime error. The agent spent a full round-trip
treating it as an app bug (clicking into the overlay, reading a fake call stack) before
noticing the stack trace's own frame — `at node:electron/js2c/sandbox_bundle` — was inside
Electron's own sandbox, not the target page's bundle, and realizing it was the tool's own
injected script that failed.

**Current implementation** (`BrowserViewManager.ts:151–154`):

```ts
async evaluate(js: string): Promise<unknown> {
  const wc = this._requireWebContents()
  return wc.executeJavaScript(js, true)
}
```

The `js` string is passed to `executeJavaScript` completely unwrapped. `executeJavaScript`
does support top-level `await` *in some Electron/Chromium versions* when the string is
evaluated as if at a REPL top level — but apparently not in the configuration this repo runs
under here, hence the `SyntaxError`. Two independent problems worth separating:

1. **Whether to wrap `js` in an async IIFE automatically** (`(async () => { ${js} })()`)
   so agent-submitted scripts can use `await` naturally without the caller needing to
   remember to wrap it themselves — this is what an agent would reasonably expect given the
   tool description says nothing about async context requirements.
2. **Whether a script-evaluation error should ever be visibly injected into the target
   page's own error UI** rather than staying contained to the MCP tool's response. This
   second part may not be fixable from this repo's side at all if it's inherent to how
   Chromium's `executeJavaScript`/devtools-protocol error reporting works with a page that
   has its own error-overlay listening for `window.onerror`/unhandled exceptions — worth
   checking whether Playwright's `page.evaluate()` has the same property (it likely does,
   for the same underlying reason), in which case this is a fundamental limitation to
   document rather than fix, not a regression to chase.

## Reference: Playwright MCP

The tools directory linked in this spec's header
(https://github.com/microsoft/playwright/tree/main/packages/playwright-core/src/tools/mcp)
is Microsoft's own MCP server built on Playwright. Relevant differences worth a closer read
before deciding what (if anything) to change here:

- Playwright MCP's click/type/etc. tools take a **ref** from a prior `browser_snapshot` (an
  accessibility-tree snapshot with stable element refs), not a free-text selector or text
  match — this sidesteps Observed Issue 2 by construction: there is no "first match", only
  "the exact node you already identified."
- Playwright's underlying `locator.click()` **auto-waits** for the element to be attached,
  visible, stable (not animating), enabled, and to receive events, before dispatching —
  and *then* waits for its own action to be "safe" (no pending navigation) before resolving.
  This is a stronger contract than "fire an input event and return" and may be the
  structural fix for Observed Issue 1, not just a longer timeout.
- Playwright's `page.evaluate(fn)` takes a **function**, not a raw string, which sidesteps
  Observed Issue 3's first half entirely — there's no "top level of the string" for `await`
  to be invalid in, because the function itself can be `async`.

## Research Findings — Playwright MCP Code Review

A close read of Microsoft's Playwright MCP tool implementations (cloned locally at
`packages/playwright-core/src/tools/backend/`; the per-tool files, not the `mcp/` infra
subdir which is config/transport) confirms the spec's three hypotheses are real,
*structurally* grounded differences — not just nicer ergonomics — and surfaced
additional shortcomings not in the original report. Findings below are keyed to the
three observed issues plus a fourth "additional shortcomings" group. File:line refs
point into the Playwright clone (under `.../src/tools/backend/`) and this repo's
`src/main/browser/BrowserViewManager.ts`.

### RF-1 — Issue 1 is structural: there is no "wait for the action's side effects to settle"

This is the most important finding and it directly sharpens Issue 1's investigation.
Our click path resolves as soon as `_waitForNavigationIfStarted()` returns
(`BrowserViewManager.ts:114`, `:234–243`), which does **only**: sleep 150ms, then if
`isLoading()` or the URL changed, wait for `did-stop-loading`. It waits for
*navigation* and nothing else. A click that triggers a React state update + re-render
with no navigation (the GameTracker "Remove → confirm prompt" case) resolves
immediately after the 150ms sleep, before the re-render commits — so the immediately
following `waitForText` polls against a DOM that hasn't changed yet.

Playwright's analogue is `waitForCompletion` (`utils.ts:20–57`), wrapped around
**every** action tool via `tab.waitForCompletion(async () => { ... })` (see
`snapshot.ts:90–95` for click, `mouse.ts:138–140` for coordinate click,
`evaluate.ts:46–62` for evaluate). It does, in order:

1. Attach a `request` listener to the page **before** the action runs (`utils.ts:24–28`).
2. Run the action callback (`:32`).
3. Sleep a configurable `settleMs` (default 500, `:21`, `:33`).
4. If any captured request was a *navigation* request, wait for `load` state (`:38–42`).
5. Otherwise, for every captured `document`/`stylesheet`/`script`/`xhr`/`fetch`
   request, await its response finishing — race against a 5s cap (`:44–52`).
6. If there were requests, sleep `settleMs` again (`:53–54`).

Steps 3 and 5–6 are the missing piece. They wait for the *in-flight XHR/fetch* a click
handler kicks off (e.g. a revalidate, a lazy fetch) to settle, then settle again. Our
`_waitForNavigationIfStarted` has no equivalent: a click whose handler fires a `fetch`
then `setState` resolves as soon as the OS-level `mouseUp` is dispatched, long before
the fetch resolves or React re-renders. **This is a borrowable mechanism that does not
require adopting Playwright** — we can replicate it with Electron's
`webContents.session.webRequest` (or `did-attach`/request lifecycle events) to track
in-flight requests, then have click-family tools await their settle before resolving.
Confirming this is now the primary Investigation task for Issue 1; the spec's
hypotheses (#1 event-dispatch latency, #2 IPC queueing) are secondary — they may
still exist, but the dominant, fixable gap is "we never wait for side-effect settle at
all."

Separately, Playwright's `locator.click()` *also* auto-waits for the element to be
attached/visible/stable/enabled/receives-events before dispatching (the locator
engine, not in the tools dir — it's in `playwright-core/src/locator`). Our
`click()`/`clickAt()`/`clickText()` fire `sendInputEvent` at a computed center the
instant the element is found, with zero actionability check (see RF-4). That is a
second, independent contributor to Issue 1: a click can land before the target is
stable, miss, and the subsequent `waitForText` correctly reports the text never
appeared — because the click never connected.

### RF-2 — Issue 2 is sidestepped by construction (refs), not just by strict-mode errors

The spec already flagged the ref model; the code review confirms *how much work it
does and how little of it is strict mode*. Playwright MCP's `browser_click` takes a
`target` (an element **ref** like `e12` from a prior `browser_snapshot`, or a unique
selector) — never free text (`snapshot.ts:58–97`). `targetLocator` resolves it
(`tab.ts:459–486`): a ref becomes `page.locator('aria-ref=e12')`; a stale ref throws
`Ref e12 not found in the current page snapshot. Try capturing new snapshot.`
(`tab.ts:482`). There is no "first match" because there is no match — the agent
already identified the exact node in the snapshot. Strict-mode violations are a
*fallback* only when the agent passes a raw selector that matches N nodes; the ref
path is the primary one.

This matters for the Issue 2 product decision (the spec's "fail loud vs. warn but
proceed" open question): the ref model is the only design that fully closes the
class, because both "fail loud" and "warn but proceed" still leave the agent stuck
when 20 "Add" buttons exist — it must then do coordinate math regardless. That said,
adopting refs is the large option the Non-Goals section rightly scopes out as a last
resort. **The cheap mitigation the spec proposes (count all matches, return count +
warning when > 1) is the right small step** and is independently correct regardless
of any future ref work — the code review found nothing cheaper that closes the gap.
One concrete refinement: the count should be of *visible* matches in the same
three-pass order the click uses (so the count and the clicked target are consistent),
and the warning text should name the disambiguation path the agent already has
(`browser_get_elements` + `browser_click_at`), which the repo's toolset makes
available without any new primitives.

### RF-3 — Issue 3: Playwright requires a function, not raw statements — and wraps it as an expression

`browser_evaluate` (`evaluate.ts:30–76`) takes a `function` param documented as
`() => { /* code */ } or (element) => { /* code */ } when element is provided`
(`evaluate.ts:26`), then internally does `eval('(${expr})')` (`:50`, `:57`) and
branches: `isFunction = typeof value === 'function'; result = isFunction ? value() :
value` (`:51–52`, `:59–60`). So Playwright's contract is "submit a function body,"
and the await problem disappears because the submitted function can be `async () =>
{ await ... }` and `page.evaluate` awaits the returned promise. Our `evaluate()`
(`BrowserViewManager.ts:152–154`) passes `js` raw to `executeJavaScript` with no
wrapping and no function-vs-expression distinction — a REPL-style "any JS string"
contract that breaks on top-level `await`.

The spec's suggested async-IIFE wrap (`(async () => { ${js} })()`) is the right
**small** fix and preserves our existing "any JS string" contract (agents already
submit raw expressions like `document.querySelector(...)`). The code review adds one
nuance: Playwright's `eval('(${expr})')`-then-detect approach accepts *either* a
function *or* an expression and handles both — slightly more flexible than a
mandatory IIFE wrap, at the cost of one extra `eval`. For our case the mandatory
async-IIFE is simpler and sufficient; just note that if we ever want to accept a
bare function body too, the detect-then-call pattern is the proven shape. The second
half of Issue 3 (error leaking into the page's own overlay) was not investigated in
this review and remains an open question — Playwright routes `evaluate` through the
CDP `Runtime.evaluate` path with its own error channel, but whether a broken
function surfaces into a Next.js `window.onerror`-listening overlay is exactly the
live test the spec already prescribes; no code-read shortcut settles it.

### RF-4 — Additional shortcomings surfaced by the review (not in the original report)

These are gaps the comparison exposed that the agent's GameTracker session didn't
happen to hit, but which fall out of the same code paths and are worth recording for
the handoff:

1. **No modal/dialog handling at all.** Playwright's `defineTabTool` wrapper
   (`tool.ts:70–84`) *blocks* every non-modal tool when a `dialog` or `fileChooser`
   modal state is present (`tool.clearsModalState` / the `modalStates.length` check
   at `:78`), and forces the agent to clear it with a dedicated tool
   (`handleDialog`, `uploadFile`). Our `BrowserViewManager` has **no**
   `browser_handle_dialog`/`browser_accept_dialog` tool and no modal gating. A page
   that calls `window.confirm()` or `window.alert()` will hang all subsequent
   `executeJavaScript` calls (Chromium blocks JS while a modal is up — see
   `tab.ts:433–435` `_javaScriptBlocked`), and every tool will time out with no
   diagnostic telling the agent *why*. This is a latent footgun in the same
   agent-driving-a-real-browser product shape; worth at least a doc note in the tool
   descriptions and ideally a minimal `browser_handle_dialog` tool. Not blocking for
   the Issue 1/2/3 work, but surfaced by the review.

2. **Click-family tools do zero actionability waiting.** `click()`/`clickAt()`/
   `clickText()`/`hover()` compute a center and fire `sendInputEvent` immediately on
   element found (`:97–115`, `:286–301`, `:303–363`, `:245–268`). There is no check
   for visible/enabled/stable/receives-events before dispatch. Playwright's
   `locator.click()` does all of this before dispatching (locator engine, pre-action
   auto-wait). This is a *separate* contributor to Issue 1 from RF-1: even if the
   network-settle wait were added, a click that lands while the target is mid-animation
   or occluded will miss silently and `waitForText` will (correctly) report the text
   never appeared. The cheap version of this fix is a pre-dispatch visibility + bounds
   re-check inside the existing `executeJavaScript` probe (the code already computes
   `getBoundingClientRect` — extend it to also assert `width>0 && height>0` and that
   the element is `offsetParent !== null` / not `disabled` before returning coords,
   throwing "element not actionable" otherwise). Full Playwright-style stability
   detection (not animating) is more work and likely not needed for the GameTracker
   class of issue.

3. **`type()`'s React integration is fragile and self-patched.** `type()`
   (`:117–144`) sends `mouseDown`/`mouseUp` at the element center to focus, then
   `char` events globally, then *manually* `dispatchEvent(new Event('input'))` with a
   code comment admitting "char events update the DOM but not React's synthetic
   event system" (`:137`). That patch is a tell: it works for simple controlled inputs
   and breaks for anything listening for `change`, `keydown`, or value-via-state.
   Playwright's `locator.fill()` sets the value through the input's own native path
   and dispatches a proper `input`+`change` the framework already observes. We don't
   need to adopt Playwright, but `type()` should at minimum dispatch `input` *and*
   `change`, and ideally use the `nativeInputValueSetter` pattern React itself
   recommends (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
   'value').set.call(el, text)`) before dispatching, so React's `onChange` actually
   fires. Not in the original three issues but adjacent and cheap.

4. **`clickText` bypasses the click entirely for `http(s)` links.** When the
   three-pass match resolves to an `<a href="https://...">`, `clickText` returns
   `this.navigate(found.href)` directly instead of dispatching a click
   (`BrowserViewManager.ts:347–349`). No `click` event fires on the anchor, so
   SPA links with `onclick`/`preventDefault` (client-side routers), `target="_blank"`,
   `download` attributes, and analytics handlers are all skipped and a full
   page reload is forced. Playwright's click dispatches a real click on the
   locator and lets the page's own handler decide. Likely intended for
   coordinate-precision on deeply nested links (the comment says so), but it
   silently changes semantics for any link with a handler. Worth at least a
   tool-description caveat, ideally a "dispatch click first, fall back to
   `navigate(href)` only if the click didn't trigger navigation" ordering.

5. **`selectOption` doesn't verify the target is a `<select>`.**
   (`BrowserViewManager.ts:449–460`) sets `el.value = ...` then dispatches
   `change`/`input` on whatever `document.querySelector(selector)` returned —
   for a non-`<select>` element the assignment silently no-ops (the property
   is read-only on most elements) but the synthetic events still fire on the
   wrong element, which can trigger unrelated handlers. Playwright's
   `selectOption` is select-only and throws on a non-select. Cheap guard:
   `if (el.tagName !== 'SELECT') throw new Error(...)` before the assignment.

6. **`waitFor` matches by selector existence, not visibility/actionability.**
   (`BrowserViewManager.ts:185–196`) polls `!!document.querySelector(...)`,
   so an element with `display:none`, `visibility:hidden`, or a `hidden`
   attribute satisfies the wait. The immediately following `click`/`type`
   then targets a non-rendered element (and `click` itself only checks
   `getBoundingClientRect` width/height > 0 *after* finding it, not before
   resolving the wait). Compounds RF-4.2: the pre-dispatch actionability check
   should also gate the `waitFor` readiness poll, or `waitFor` should use the
   same visibility probe the click path uses. Playwright's `locator.waitFor()`
   auto-waits for visible/stable by default.

### Research-confirmed corrections to the spec's framing

- The spec's Issue 1 hypothesis #1 ("sendInputEvent is fire-and-forget relative to
  renderer event handling") is real but is the *smaller* half. The larger, fixable
  half is RF-1: we never wait for the action's network/render side effects to settle
  at all. Hypothesis #2 (IPC queueing of repeated `executeJavaScript`) remains
  plausible and unverified; the poll-timestamp logging the spec prescribes is still
  the right way to characterize it, but RF-1 should be confirmed or ruled out *first*.
- The spec's Issue 2 "fail loud vs. warn" open question stands, but the review
  confirms neither option alone matches what the ref model achieves. The cheap
  count-and-warn mitigation is the right incremental step; full ref adoption remains
  the large option the Non-Goals section scopes out.
- The spec's Issue 3 async-IIFE recommendation is confirmed correct. The
  function-vs-expression detect pattern is a noted future-optionality, not a
  requirement.

## Broader Surface Gaps vs. Playwright MCP (full tool-surface review)

The Research Findings above scoped to the three observed issues. A full read of
Playwright MCP's ~80-tool surface (enumerated via `name: 'browser_...'` across
`.../src/tools/backend/`; registry at `tools.ts:48–75`) against this repo's 22 tools
surfaces a wider set of gaps the GameTracker session didn't happen to hit but which
fall out of the same comparison. Grouped below with `BG-` ids so they're referenceable
from Next Steps. File refs point into the Playwright clone under `.../src/tools/backend/`
unless noted otherwise.

**Product asymmetry, to avoid misreading the gap list:** Playwright MCP drives a
headless/managed browser context. This repo drives a *real, user-visible* `BrowserWindow`
with `setUserControlled`/`setAgentControlled` (`BrowserViewManager.ts:74–82`) — an agent
and a human share one visible browser, which Playwright cannot do. The gaps below are
about *agent capability*, not about the product being worse. Do not trade the live
human-takeover model for headless parity.

### BG-A — Observation / introspection (the agent is flying blind)

The biggest functional gaps; exactly what an agent needs to diagnose "did my action
work?"

- **BG-A1 — No console capture.** Playwright `browser_console_messages`
  (`console.ts:23`) returns all `console.*` + uncaught `pageerror`s, level-filtered,
  since-navigation or all-time; `Tab` keeps error/warning counts in the header
  (`tab.ts:116–117`, `:282–305`). This repo captures **nothing** — no `console.error`,
  no uncaught exceptions. For a Next.js app this is the primary error surface after the
  visible DOM; an agent must infer runtime errors from screenshots or `get_content`.
  Cheap to add via `webContents` `'console-message'` + crash events, buffered, exposed
  with level + since-navigation filtering.
- **BG-A2 — No network inspection.** Playwright `browser_network_requests` (list,
  regex filter, hides static 2xx by default), `browser_network_request` (full
  headers + body by part: request-headers/-body, response-headers/-body),
  `browser_network_clear` (`network.ts:30–117`). This repo has none — an agent can't
  see API calls, statuses, or response bodies, the second debugging surface for a
  backend-talking app. Medium cost via `webContents.session.webRequest`.
- **BG-A3 — No structured page model (accessibility snapshot).** `browser_snapshot`
  (`snapshot.ts:38`) returns an aria tree with stable **refs** the agent then acts on.
  This repo's `get_elements`/`get_links`/`get_content` are coarse DOM-text/flat-list
  substitutes — no tree, no refs, no role/accessible-name semantics. Root of Issue 2
  (RF-2) but also a general observation gap. Full ref adoption is the large option
  Non-Goals scopes out; a lighter middle ground is a `browser_snapshot`-like tool
  returning the aria tree *without* refs (structure + role + name) — most of the
  reasoning value at a fraction of the cost.
- **BG-A4 — No `browser_find`.** `find.ts:27` greps the aria snapshot with `grep -C`
  context windows + ancestor paths — "where is this text in the tree" without a full
  snapshot. `wait_for_text` returns only found/not-found, not *where*. Cheap once any
  snapshot exists.

### BG-B — Interaction primitives we lack

- **BG-B1 — No file upload / drop.** `browser_file_upload` (`files.ts:26`, with MIME
  types), `browser_drop` (`files.ts:61`). Can't drive `<input type=file>` at all.
  Blocking for upload-flow testing.
- **BG-B2 — No `browser_fill_form`.** `form.ts:27` fills multiple fields in one call
  across textbox/checkbox/radio/combobox/slider with secret lookup. `type` + `select`
  do one field each, no checkbox/radio/slider, no batch — and `type` is the fragile
  char-event + `dispatchEvent('input')` patch (RF-4.3).
- **BG-B3 — No checkbox/radio.** `browser_check`/`browser_uncheck` (`snapshot.ts:195/213`).
  Only reachable by clicking coordinates.
- **BG-B4 — No element-to-element drag.** `browser_drag` (`snapshot.ts:102`). Not
  exposed as a tool at all.
- **BG-B5 — No `browser_reload`.** `navigate.ts:82`. Have back/forward but no reload;
  agent must re-`navigate` by URL, losing form state.
- **BG-B6 — No `browser_resize` / `browser_close`.** `common.ts:40/21`. Window is fixed
  at 1280×900 (`BrowserViewManager.ts:42–43`) — responsive testing impossible. No
  agent-facing close (only internal `destroy()`).
- **BG-B7 — Granular keyboard gaps.** Playwright has `browser_press_key`,
  `browser_press_sequentially` (per-char into focused element), `browser_keydown`/`keyup`
  (hold/chord) (`keyboard.ts`). `browser_keyboard` does only a full down+up press.

### BG-C — State / persistence

- **BG-C1 — Cookies are write-only.** Playwright has full CRUD: `browser_cookie_list/
  get/set/delete/clear` (`cookies.ts`). This repo has only `browser_set_cookies` — no
  read, no delete. Can't inspect auth state or clear cookies to test logout/login.
  Cheap.
- **BG-C2 — No localStorage / sessionStorage.** Ten tools (`webstorage.ts`):
  list/get/set/delete/clear for both. Only reachable via raw `evaluate`. Can't inspect
  or set tokens, feature flags structurally. Cheap.
- **BG-C3 — No storage-state save/restore.** `browser_storage_state` /
  `browser_set_storage_state` (`storage.ts`) — serialize a logged-in context to JSON
  and reload it. Can't snapshot a session across runs.

### BG-D — Network control / mocking

- **BG-D1 — No request interception.** `browser_route`/`browser_route_list`/
  `browser_unroute` (`route.ts`) mock responses by URL pattern, add/remove headers,
  simulate status codes. `browser_network_state_set` (`network.ts:269`) goes offline.
  Can't test error paths (simulate 500), offline behavior, or inject mock data without
  `evaluate` shims. Medium cost via `session.webRequest.onBeforeRequest`.

### BG-E — Verification

- **BG-E1 — No assertion tools.** `browser_verify_element_visible`/`verify_text_visible`/
  `verify_list_visible`/`browser_verify_value` (`verify.ts`) — frame-aware, pass/fail
  with generated `expect(...)` code. `wait_for_text`/`wait_for` are main-frame-only
  existence polls, not visibility/value assertions. `verify_value` (read an input's
  current value, compare) is only doable via `evaluate` + manual comparison.

### BG-F — Lifecycle / multi-window

- **BG-F1 — No multi-tab.** `browser_tabs` (`tabs.ts:26`) lists/creates/closes/selects
  tabs; Playwright's `Context`/`Tab` model is multi-tab (`tab.ts`). This repo is
  single-window single-tab (one `BrowserWindow`). Can't open a link in a new tab or
  work across tabs. Architectural — the single-`BrowserWindow` assumption runs through
  `BrowserViewManager`.

### BG-G — Cross-cutting mechanism gaps (not separate tools)

- **BG-G1 — No iframe/frame awareness.** Playwright verify tools iterate
  `page.frames()` (`verify.ts:37`, `:63`); locators resolve across frames. This repo's
  `executeJavaScript` runs in the **main frame only** — any element inside an `<iframe>`
  (embedded content, some auth/checkout flows, OAuth popups) is invisible to *all*
  tools. Significant.
- **BG-G2 — No `networkidle` / load-state model.** Playwright has
  `waitForLoadState('load'|'domcontentloaded'|'networkidle')`. `wait_for_load` watches
  `did-stop-loading` once — no "network went idle" concept. Ties into RF-1's
  settle-wait gap.
- **BG-G3 — No secret/redaction handling.** Playwright's `lookupSecret`
  (`keyboard.ts:96`, `form.ts:45`) passes a password without the literal landing in
  tool args or the generated code log. This repo logs every tool call's args in
  plaintext — any credential typed via `browser_type` is in the transcript.

### BG-H — Recording / artifacts (lower priority for this product)

- **BG-H1 — No tracing, no video, no PDF.** `tracing.ts`, `video.ts`, `pdf.ts`. Can't
  get a replayable artifact of a session. Niche for a live-driving model but valuable
  for "what did the agent just do" forensics.

### BG-I — URL safety / navigation validation

- **BG-I1 — No URL validation on `navigate`.** `navigate(url)`
  (`BrowserViewManager.ts:88–95`) calls `loadURL(url)` with no scheme/origin
  check. An agent (or `clickText`'s http-href branch at `:347–349`, which
  forwards an anchor's `href` straight to `navigate`) can load `file://`,
  `data:`, or any origin into the agent-controlled `BrowserWindow`. Playwright's
  `checkUrlAllowed` (`context.ts:341–347`) explicitly blocks `file:` and
  supports an `allowedOrigins` allowlist (`context.ts:44`, `:303–306`), gated
  ahead of `tab.navigate` (`tab.ts:325`). Cheap, security-relevant, and the
  only thing standing between an agent and a `file://` read of the user's
  filesystem rendered into a panel the agent can `evaluate` against.

### BG-J — No tunability / result-shaping knobs

- **BG-J1 — No configurable timeouts.** Every timeout in `BrowserViewManager`
  is hardcoded: 5000ms `waitFor`/`waitForText` default (`:185`, `:415`), 10000ms
  navigation (`:219`, `:436`), 150ms settle (`:238`), 200ms poll cadence
  (`:193`, `:423`), 1280×900 window (`:42–43`). No per-call override on
  `navigate`/`click`/`evaluate`, no global config. Playwright exposes
  `config.timeouts.{action,navigation,expect}` via `actionTimeoutOptions` /
  `navigationTimeoutOptions` / `expectTimeoutOptions` on every `Tab`
  (`tab.ts:105–107`, `:141–143`) plus the `settleMs` knob on
  `waitForCompletion` (`utils.ts:21`). Matters for RF-1: the network-settle
  wait's `settleMs` should be tunable, and a slow CI / fast unit-test can't
  share one hardcoded budget.
- **BG-J2 — No `filename` / large-result offload.** `evaluate`
  (`BrowserViewManager.ts:152–154` → `BrowserMcpServer.ts:306–310`) returns
  raw `JSON.stringify(result)` inline with no truncation; `get_elements`/
  `get_links` likewise dump the full array. A large `evaluate` result blows
  the MCP message and lands verbatim in the agent transcript. Playwright's
  `evaluate`/`console_messages`/`network_request` all accept a `filename`
  param (`evaluate.ts:27`, `:71`; `response.ts:103–110` `addResult`/`addFileResult`)
  to dump big results to a file and return just a path. `get_content` has
  `max_chars` + a large-dump warning (`BrowserMcpServer.ts:513–527`); the
  other read tools have nothing. Cheap to add a `max_chars`/`filename` pair
  to `evaluate` at minimum.

### Priority for this product (independent of the RF-1…RF-4.3 Issue-1/2/3 track)

- **High value, low cost, agent-debugging-critical:** BG-A1 (console), BG-C1 (cookie
  read/delete), BG-C2 (localStorage/sessionStorage), BG-B5 (reload), BG-G1 (iframe
  awareness in existing probes), BG-I1 (URL/`file:` validation — security, cheap).
- **High value, medium cost:** BG-A2 (network inspection), BG-B1 (file upload),
  RF-4.1 (dialogs, already in Next Steps).
- **Medium, cheap:** BG-B3 (check/uncheck), BG-B2 (fill_form), BG-B6 (resize/close),
  BG-E1 (verify_value), BG-J2 (`max_chars`/`filename` on `evaluate`).
- **Medium, architectural:** BG-F1 (multi-tab), BG-A3 (snapshot/ref model), BG-D1
  (route mocking), BG-J1 (configurable timeouts — pairs with RF-1's `settleMs`).
- **Lower for this product:** BG-H1 (tracing/video/pdf), BG-G3 (secret redaction),
  BG-C3 (storage_state).

The **BG-A1 + BG-A2 + BG-C1** trio is the recommended first additive batch: together
they turn the agent from "can see the rendered page" into "can see what the page is
*doing*" — the actual debugging surface it's missing today.

## Non-Goals

- **Not proposing a dependency on Playwright itself.** This repo's browser panel is a
  real, user-visible `BrowserWindow` the user can see and take control of
  (`setUserControlled`/`setAgentControlled`) — a fundamentally different product shape from
  Playwright's headless/managed browser contexts. Adopting Playwright wholesale is out of
  scope; the ask is to review specific *behaviors* for patterns worth borrowing.
- **Not asserting root cause for Observed Issue 1.** See "needs investigation" above — do not
  ship a fix without first reproducing with logging and confirming the actual mechanism.
- **Not touching the closed-window honesty contract or argument validation** — both already
  covered by spec `039` (done) and working correctly; this spec found no regressions there.
- **Not redesigning the tool surface around refs/snapshots** (i.e., not copying Playwright's
  ref-based model wholesale) unless investigation concludes it's the only real fix for Issue
  2 — a smaller mitigation (return match count + a warning when count > 1) may be sufficient
  and much cheaper.

## Suggested Next Steps (for whoever picks this up)

Ordered by the research above — RF-1 is the highest-value, most-borrowable finding and
should be investigated before the spec's original hypotheses, because if it's the
dominant cause the others may not need fixing at all.

1. **Issue 1 / RF-1 (network-settle wait):** implement the borrowable mechanism from
   Playwright's `waitForCompletion` (`utils.ts:20–57`) without depending on Playwright —
   track in-flight requests via `webContents.session.webRequest` (or the
   `did-start-loading`/`did-finish-load` + request lifecycle events), and have
   click-family tools (`click`, `clickAt`, `clickText`) await a settle window (a
   configurable `settleMs`, default ~300–500ms) plus completion of any
   `xhr`/`fetch`/`document`/`script` requests the click triggered, before resolving.
   Before implementing, add the spec's prescribed poll-timestamp logging to
   `waitForText`/`waitFor` and reproduce click-then-wait-for-text against a real
   external React/Next.js app (not this repo's own renderer) to *confirm* the gap is
   settle-wait and not IPC queueing (hypothesis #2). If confirmed, the fix is the
   network-settle wait; the poll logging can stay as a regression guard.
2. **Issue 1 / RF-4.2 (actionability pre-check):** in the same `executeJavaScript`
   probe that already computes `getBoundingClientRect` for click-family tools, also
   assert the element is actionable (`width>0 && height>0`, `offsetParent !== null`
   or `getClientRects().length > 0`, not `disabled`) before returning coordinates —
   throw `element not actionable: <selector>` otherwise. Cheap, and removes the
   "click landed while target was mid-animation/occluded" miss that independently
   causes `waitForText` false negatives.
3. **Issue 2 / RF-2 (count + warn):** extend `clickText`'s three-pass script to count
   *visible* matches in the same pass order it clicks, and when count > 1 return the
   match count in the success text — e.g. `"Clicked 1 of 4 visible matches for 'Add'
   — use browser_get_elements + browser_click_at to target a specific row"`. Decide
   fail-loud (throw) vs. warn-but-proceed before implementing; the review leans
   warn-but-proceed because the repo already has the disambiguation primitives and
   failing loud strands the agent when it has no fallback. Document the behavior in
   the `browser_click_text` tool description.
4. **Issue 3 / RF-3 (async-IIFE wrap):** wrap `evaluate()`'s `js` argument in
   `(async () => { ${js} })()` so natural `await` works without the caller knowing an
   implementation detail. Separately, run the quick manual test the spec prescribes
   (broken function passed to Playwright's `page.evaluate`) to settle whether the
   page-overlay error leak is a Chromium/`executeJavaScript` property shared by both
   tools; if so, downgrade that half of Issue 3 to a `browser_evaluate` description
   caveat rather than chasing a code fix.
5. **RF-4.1 (dialogs) and RF-4.3 (type's React patch):** not blocking for 1–4, but
   schedule as follow-ups. RF-4.1: add a minimal `browser_handle_dialog` tool
   (accept/dismiss + optional prompt text) and consider gating other tools when a
   modal is up, so a page-level `confirm()`/`alert()` doesn't hang the whole toolset
   with no diagnostic. RF-4.3: make `type()` dispatch `input` *and* `change`, and set
   the value via the native-value-setter pattern so React's `onChange` actually fires
   (drop the current `dispatchEvent('input')` patch).
6. **Broader surface gaps (§ Broader Surface Gaps):** the first additive batch is
   **BG-A1 + BG-A2 + BG-C1** — console messages, network request inspection, and
   cookie read/delete — the trio that gives the agent visibility into what the page is
   *doing*, not just what it rendered. Sequence these after the Issue-1/2/3 fixes
   (they're independent) or in parallel if a separate developer picks them up. Cheaper
   follow-ups in the same spirit: BG-C2 (localStorage/sessionStorage), BG-B5 (reload),
   BG-G1 (iframe awareness in the existing `executeJavaScript` probes — extend the
   probe scripts to walk `document.querySelectorAll('iframe')` and run against each
   frame's `contentDocument`, or surface a frame id in `get_elements` results). Defer
   the architectural gaps (BG-F1 multi-tab, BG-A3 full snapshot/refs, BG-D1 route
   mocking) until the additive batch lands and a real session proves they're needed.

## Verification / Repro Steps

For whoever investigates Issue 1 (the only one needing live reproduction rather than a code
read):

1. Start any local dev server with a client-rendered confirm-toggle interaction (a button
   that reveals a second element on click, no page navigation).
2. Via an agent session's `browser_navigate` to that app, then `browser_click`/
   `browser_click_text`/`browser_click_at` on the toggle button, immediately followed by a
   *separate* `browser_wait_for_text` call for the revealed text with a 2–3s timeout.
3. Repeat 10–20 times (loop it) and note the failure rate. A single anecdotal failure could
   be environmental; this spec's finding was 3 consecutive failures against the same
   real-world sequence, which is why it's flagged as a real issue rather than a fluke — but
   an isolated repro harness inside this repo (or a throwaway HTML fixture) would confirm it
   independent of the external app used originally.
4. If reproduced, add the timestamp logging described above and re-run to see where the time
   actually goes.

## Historical Questions (resolved for this handoff)

- [x] Is Observed Issue 1 reproducible against a minimal fixture inside this repo, or is it
      specific to something about the external app (Next.js Turbopack HMR, React 19) that
      was being driven?
- [x] **RF-1 confirmation:** does adding a network-settle wait (track in-flight
      `xhr`/`fetch` via `webContents.session.webRequest`, await settle + a `settleMs`
      window after each click-family tool) close the `waitForText` false negative on its
      own, or is the spec's IPC-queueing hypothesis #2 also contributing? Settle this
      *before* spending time on hypothesis #2 — the code review strongly suggests RF-1 is
      the dominant, fixable gap.
- [x] Does Playwright's `page.evaluate()` have the same page-overlay error leakage as
      Observed Issue 3's second half? If yes, that part is a documentation fix, not a code
      fix. (Still open — the code review did not run the live test.)
- [x] For Issue 2, does the product want "fail loud on ambiguity" (closer to Playwright's
      strict mode) or "warn but proceed" (current UX, just less silent)? The review leans
      warn-but-proceed since the repo already ships the disambiguation primitives
      (`browser_get_elements` + `browser_click_at`); full ref-based resolution (RF-2)
      remains the large, out-of-scope option that fully closes the class.
- [x] **RF-4.1:** should we ship a `browser_handle_dialog` tool and gate other tools when
      a JS modal (`alert`/`confirm`/`prompt`) is up, so a modal no longer hangs the whole
      toolset with no diagnostic? Not blocking for Issues 1–3 but exposed by the review.
- [x] **BG-A3 / Issue 2:** is a no-ref accessibility-snapshot tool (aria tree + role +
      accessible name, no element refs) worth shipping as the middle ground between the
      current flat `get_elements` and full Playwright-style ref resolution? It would also
      unblock BG-A4 (`browser_find`) and give the agent a structured page model without
      the architectural cost of the ref model.
- [x] **BG-G1 (iframes):** how common are iframe-contained targets in the apps this
      browser is actually driven against? If rare, a targeted extension of the existing
      probe scripts suffices; if common, a frame-aware locator model (closer to BG-A3)
      is warranted.
- [x] **Test coverage for `BrowserViewManager`:** there are no unit tests under
      `src/main/browser/` — only `src/main/mcp/BrowserMcpServer.test.ts` (which stubs
      the manager) and `src/main/mcp/toolArgs.test.ts` exercise this surface. The
      RF-4.4/4.5/4.6 correctness bugs (http-href click bypass, `selectOption` no
      `<select>` check, `waitFor` existence-not-visibility) are all unguarded by
      tests. Should the Issue-1/2/3 fix batch add `BrowserViewManager` coverage
      (even thin, against a fake `webContents`) before changing these code paths?
      The spec's Next Steps touch exactly these methods.
      **→ RESOLVED (pass 1):** `src/main/browser/BrowserViewManager.test.ts` added
      (29 tests, fake `webContents`/`win` seam via `vi.mock('electron')`), covering
      every fix below. `npm run test` green (660/660).

## Implementation Status — pass 1

Implemented + tested in `src/main/browser/BrowserViewManager.ts` and
`src/main/mcp/BrowserMcpServer.ts` (this pass; `npm run typecheck` clean,
`npm run test` 660/660):

- **RF-3** — `evaluate()` now wraps the script in an async context with the
  detect-then-call pattern (`eval` the string; if it resolves to a function,
  call it; else return the value). The earlier claim that bare top-level
  `await` works was not proven by the fake webContents test; use an async
  function for asynchronous work until a real Electron test proves it. Bare expressions,
  `;`-terminated statements, multi-statement scripts, and `async () => {}`
  bodies all return their value. **Deviation from the spec's literal
  `(async () => { ${js} })()` block-wrap:** that form would regress the
  dominant bare-expression case (`document.querySelector('x')` → `undefined`).
  `executeJavaScript` is a privileged injection (like the DevTools console),
  so the nested `eval` is not subject to page CSP `unsafe-eval`.
- **RF-4.2** — shared `_actionableSelectorProbe` + `_resolveActionable` helpers;
  `click`/`type`/`hover` now assert visible (`width>0 && height>0`) + not
  `disabled` before dispatching, throwing `Element not actionable (<reason>):
  <selector>` instead of firing at a non-rendered/disabled target.
- **RF-4.6** — `waitFor()` polls visibility (`getBoundingClientRect`), not bare
  `!!querySelector`; `display:none`/`hidden` no longer satisfy the wait.
- **RF-2** — `clickText()` collects all visible actionable matches across the
  three passes (deduped via a `Set`), returns `matchCount`; the
  `browser_click_text` MCP handler surfaces `Clicked … 1 of N visible matches
  — use browser_get_elements + browser_click_at to target a specific one` when
  N > 1. Warn-but-proceed (does not throw).
- **RF-4.5** — `selectOption()` verifies the target is a `<select>` before
  setting value; throws `browser_select target is not a <select> (<selector>)`.
- **BG-I1** — `navigate()` validates the scheme via `normalizeNavigableUrl`;
  `file:`/`data:`/`javascript:` and any non-http(s)/`about:` scheme are rejected
  before a window opens or `loadURL` runs. Bare `localhost`/IPv4 normalized to
  `http://`.
- **BG-B5** — `browser_reload` tool + `reload()` manager method.
- **RF-4.4** — *not* behavior-changed this pass; documented as a caveat in the
  `browser_click_text` description (http-href links still navigate directly).
  The "dispatch click first, fall back to navigate" rework needs a product
  decision (target=_blank / download handling) — deferred.

Deferred (still in Next Steps / Open Questions):

- **RF-1** (network-settle wait) — the spec's own guard: do not ship without
  reproducing the `waitForText` false negative with poll-timestamp logging
  against a real external React/Next.js app. The fix is borrowable (replicate
  Playwright's `waitForCompletion` via `webContents.session.webRequest`), but
  reproduction must confirm it's the dominant cause first.
- **RF-4.3** (type's React patch — native-value-setter + `input`+`change`) —
  behavior change, deferred to its own pass.
- **RF-4.1** (dialogs — `browser_handle_dialog` + modal gating).
- **BG-A1 / BG-A2 / BG-C1** (console / network / cookie-read — the recommended
  first additive batch) and the rest of the BG-* surface gaps.

### Repo cleanup done in a follow-up commit (flagged during this pass)

- **`src/main/mcp/tools/*.ts` deleted** — 16 thin stub files ("Used when
  BrowserMcpServer is run as a subprocess") that nothing imported (grep found
  zero importers). The live tool surface is inline in `BrowserMcpServer.ts` /
  `BrowserViewManager.ts`; the stubs predated the inline implementation (Jun 11
  vs the inline server). Pre-validated for deletion by specs 039 and 044.
- **CLAUDE.md + `docs/sessions.md` references fixed** — the stale "Browser MCP
  tools live in `src/main/mcp/tools/`" sentence (CLAUDE.md `### Sessions & MCP`)
  and the matching references in `docs/sessions.md` now point at
  `BrowserMcpServer.ts`/`BrowserViewManager.ts`.

## Final Scope and Decisions

None outstanding.

**Resolved:**

- Keep this spec focused on browser interaction reliability. Console, network,
  and cookie tooling belongs in follow-up spec `053-browser-mcp-observability`.
- Do not expose native JavaScript-dialog handling. In Electron 42, real page
  `prompt`/`confirm` calls neither emitted `Page.javascriptDialogOpening` nor
  blocked the renderer, so there is no supported pending-dialog state to
  observe or resolve through this browser surface. Do not ship a recovery tool
  that cannot recover anything.
- Do not add an accessibility snapshot or element-reference model now. The
  shipped count-and-warning response for ambiguous `browser_click_text` calls
  remains the small mitigation.
- `browser_evaluate` is the supported escape hatch for ad-hoc browser
  inspection and interaction. Do not add a duplicate tool. Agents needing
  `await` must submit an `async () => { ... }` function. The pass-one claim
  that a bare top-level `await` works is unverified and must be removed.
- Treat the reported click-then-`waitForText` false negative as unconfirmed.
  Build the deterministic reproduction and trace first; do not ship a global
  network-settle delay based only on the external-session report.

## Remaining Implementation Handoff

### 1. Make ad-hoc JavaScript execution honest and tested

- Keep `browser_evaluate` as the one-off interaction/inspection primitive.
- Correct its description and surrounding guidance: raw top-level `await` is
  not supported; an async function is the supported asynchronous form. Do not
  claim otherwise until a real Electron execution test proves it.
- Add a real `webContents.executeJavaScript` verification path, not only a
  fake-webContents string assertion. Cover a plain expression, statements, a
  synchronous function, and an async function.
- Keep errors in the MCP result. Do not promise that a target framework's dev
  overlay cannot display an error caused by injected JavaScript.

### 2. Keep unsupported native JavaScript dialogs out of the tool surface

- Electron 42 runtime evidence showed that real page `prompt`/`confirm` calls
  did not emit DevTools Protocol `Page.javascriptDialogOpening` and did not
  block renderer responsiveness. Native dialog acceptance/dismissal is
  therefore unsupported in this embedded-browser architecture.
- Do not register `browser_handle_dialog`, dialog state, or action gating.
  Retain `browser_reload` in the `McpManager` status list and test that status
  still matches the live MCP tool list.

### 3. Reproduce before changing post-action settling

- Add a minimal local fixture with a no-navigation button that reveals text
  after an asynchronous state update. Drive click then a separate
  `browser_wait_for_text` call repeatedly through the MCP server.
- Record action completion and each `waitForText` poll timestamp/result during
  the investigation. Keep diagnostics test-only or development-only.
- If the fixture reproduces the failure, write a narrowly scoped follow-up
  spec for the measured cause. A network-settle design must define request
  attribution, unrelated requests, listener cleanup, timeout, and navigation.
- If it does not reproduce, close this item with the trace and retain the
  existing navigation wait; do not add a speculative delay.

### Definition of Done

- `browser_evaluate` has an honest asynchronous contract with runtime evidence.
- Unsupported native JavaScript dialogs are not advertised as controllable.
- Browser MCP status reports every registered built-in tool, including reload.
- The click/text report has a repeatable trace-backed outcome, not an assumed
  network-settle fix.
- `npm run typecheck` and `npm test` pass, plus the Electron/manual scenarios
  above are recorded in the implementation PR.

## Platform Outcome

Electron 42 suppressed or left native prompt/confirm nonblocking in the real
MCP fixture. CDP emitted no dialog event and a bounded renderer probe completed
normally, so native dialog control is not supported. The attempted dialog API,
observer, fallback, and tests were removed rather than exposing a false
recovery path.
