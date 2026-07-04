# 039 — Browser MCP Tool Honesty and Argument Validation

Covers backlog items **8** and **45** from `specs/pending/032-code-improvement-backlog.md`. Line numbers below were re-verified against the current source on 2026-07-03.

Files in scope:

- `src/main/browser/BrowserViewManager.ts` (479 lines)
- `src/main/mcp/BrowserMcpServer.ts` (501 lines)

New file to be created: `src/main/mcp/toolArgs.ts` (+ `toolArgs.test.ts`).

## Problem

Two independent honesty defects in the browser MCP stack, both of which cause an MCP agent to receive confident, wrong answers:

1. **Silent no-op success when the browser window is closed (item 8).** `BrowserViewManager` lazily creates its `BrowserWindow` (`_ensureWindow()`, lines 26–46). Only `navigate()` and `setCookies()` call `_ensureWindow()`; every other method reads `this.win?.webContents` and, when the window has never been opened (or was closed by the user — the `'closed'` handler at lines 39–43 nulls `this.win`), quietly returns a fake-success value. The MCP handler then formats that into a success message: `browser_click` with the panel closed returns `"Clicked #foo\nURL: \nTitle: "`, `browser_type` returns `"Typed text"`, `browser_get_elements` returns `[]` (indistinguishable from "selector matched nothing"), `browser_wait_for` burns its full 5s timeout polling `undefined` and then throws a *misleading* "Selector not found" error. Only `screenshot()` (line 136) throws the honest error: `'Browser window not open'`.

2. **Unvalidated tool arguments (item 45).** Every `CallToolRequestSchema` case in `BrowserMcpServer._registerHandlers` (switch at lines 266–394) reads arguments via non-null-asserted casts — `args!.url as string`, `args!.x as number`, a whole-array cast for `browser_set_cookies` (line 382) — despite full JSON schemas being declared in the `ListTools` response. The MCP SDK does **not** validate `arguments` against `inputSchema`; a client that omits `url` or sends `x: "300"` produces `undefined`/string values flowing into `webContents.loadURL(undefined)`, `sendInputEvent({ x: "300" })`, or `.map` on a non-array (`TypeError: args.cookies.map is not a function` — a raw stack-trace-shaped message instead of a usable error). There are ~30 such assertions.

Both defects violate the same contract: a tool result must reflect what actually happened, and a bad call must produce a clear `isError` result, not a fabricated success or an opaque crash message.

## Current Behavior

### BrowserViewManager — complete public-method inventory and no-window behavior

"No window" means `this.win === null` (never opened, or user closed the browser window) or `this.win.isDestroyed()`.

| Method (line) | Current no-window behavior | MCP tool + what the agent sees | Intended |
|---|---|---|---|
| `initialize()` (24) | no-op by design | — | unchanged |
| `show()` (48) | auto-creates window via `_ensureWindow()` | — (app IPC) | unchanged |
| `hide()` (55) | optional-chain no-op | — (app IPC) | unchanged |
| `setUserControlled()` / `setAgentControlled()` / `getState()` (61–73) | state only, no window access | — | unchanged |
| `navigate(url)` (75) | **auto-opens** the window (`_ensureWindow()` + `show()`), then loads | `browser_navigate` — works, this is the entry point | unchanged (this is the documented recovery path) |
| `click(selector)` (84) | returns `{ url: '', title: '' }` (line 86) | `browser_click` → "Clicked …" false success | **throw** |
| `type(selector, text)` (105) | returns `void` (line 107) | `browser_type` → "Typed text" false success | **throw** |
| `screenshot()` (135) | **throws `'Browser window not open'`** (line 136) | `browser_screenshot` → honest `isError` | unchanged — this is the reference contract |
| `evaluate(js)` (141) | optional chain resolves `undefined` (line 142) | `browser_evaluate` → text `"undefined"` | **throw** |
| `getContent(options)` (145) | returns `{ text: '', characters: 0, lines: 0, truncated: false }` (lines 147–149) | `browser_get_content` → empty page, looks real | **throw** |
| `scroll(x, y)` (171) | optional-chain no-op (line 172) | `browser_scroll` → "Scrolled" false success | **throw** |
| `waitFor(selector, timeoutMs)` (175) | polls `undefined` for the full timeout, then throws `Selector not found within …` (line 184) | `browser_wait_for` → 5s wasted + wrong diagnosis | **throw up-front** |
| `getCurrentUrl()` (187) | returns `''` (line 188) | `browser_get_url` → empty string, ambiguous | **throw** (see note below) |
| `goBack()` (191) | `wc?.canGoBack()` is `undefined` → throws `'No previous page in history'` (line 193) | `browser_go_back` → errors, but with the wrong reason | **throw window-not-open first** |
| `goForward()` (199) | same pattern → `'No next page in history'` (line 201) | `browser_go_forward` → wrong reason | **throw window-not-open first** |
| `hover(selector)` (233) | returns `void` (line 235) | `browser_hover` → "Hovered …" false success | **throw** |
| `hoverAt(x, y)` (259) | returns `void` (line 261) | `browser_hover_at` → "Hovered at …" false success | **throw** |
| `clickAt(x, y)` (276) | returns `{ url: '', title: '' }` (line 278) | `browser_click_at` → "Clicked at …" false success | **throw** |
| `clickText(text, exact)` (294) | returns `{ url: '', title: '' }` (line 296) | `browser_click_text` → false success | **throw** |
| `getElements(selector)` (357) | returns `[]` (line 359) | `browser_get_elements` → looks like "no matches" | **throw** |
| `getLinks(textFilter)` (383) | returns `[]` (line 385) | `browser_get_links` → looks like "no links on page" | **throw** |
| `waitForText(text, timeoutMs)` (409) | polls `undefined` for the full timeout, then throws `Text not found within …` (line 418) | `browser_wait_for_text` → 5s wasted + wrong diagnosis | **throw up-front** |
| `keyboard(key, modifiers)` (421) | returns `void` (line 423) | `browser_keyboard` → "Sent key" false success | **throw** |
| `waitForLoad(timeoutMs)` (430) | `if (!wc \|\| !wc.isLoading()) return` (line 432) | `browser_wait_for_load` → "Page finished loading" false success | **throw when no window** (keep the immediate return when a window exists but is not loading) |
| `selectOption(selector, value)` (443) | optional-chain no-op (line 444) | `browser_select` → "Selected …" false success | **throw** |
| `setCookies(cookies)` (455) | **auto-creates** the window via `_ensureWindow()` (line 458) — note this also *shows* it, since `BrowserWindow` defaults to `show: true` | `browser_set_cookies` — works, pops the window open | unchanged behavior; document the auto-open side effect (see Risks) |
| `destroy()` (464) | optional-chain no-op | — (app shutdown) | unchanged |
| private `_waitForNavigation` (207) / `_waitForNavigationIfStarted` (222) | graceful fallbacks when `wc` is gone | internal | unchanged — they guard against the window closing *mid-operation*, which stays a graceful path |

`getCurrentUrl()` note: it is a query, but `''` is a lie ("the current URL is empty"), and after this spec the only way to reach an open window is `browser_navigate`, after which a URL always exists. Throwing is the consistent contract. It has no callers outside `BrowserMcpServer` (verified by grep: only `src/main/mcp/tools/getUrl.ts`, `goBack.ts`, `goForward.ts` — all dead code, see Out of Scope).

### BrowserMcpServer — per-tool argument inventory (switch, lines 266–394)

| Tool (case line) | Required args | Optional args | Current casts |
|---|---|---|---|
| `browser_navigate` (270) | `url: string` | — | `args!.url as string` |
| `browser_click` (275) | `selector: string` | — | `args!.selector as string` |
| `browser_type` (280) | `selector: string`, `text: string` | — | 2 casts |
| `browser_screenshot` (284) | — | — | none |
| `browser_evaluate` (292) | `js: string` | — | `args!.js as string` |
| `browser_get_content` (297) | — | `selector: string`, `max_chars: number` | 2 optional casts (`args?.`) |
| `browser_scroll` (305) | — | `x: number` (default 0), `y: number` (default 0) | `(args!.x ?? 0) as number` ×2 |
| `browser_wait_for` (312) | `selector: string` | `timeout_ms: number` (default 5000) | 2 casts |
| `browser_go_back` (321) / `browser_go_forward` (326) | — | — | none |
| `browser_hover` (331) | `selector: string` | — | 1 cast |
| `browser_keyboard` (335) | `key: string` | `modifiers: string[]` | `args!.key as string`, `(args!.modifiers ?? []) as string[]` |
| `browser_wait_for_load` (342) | — | `timeout_ms: number` (default 10000) | 1 cast |
| `browser_select` (346) | `selector: string`, `value: string` | — | 2 casts |
| `browser_get_url` (350) | — | — | none |
| `browser_click_text` (353) | `text: string` | `exact: boolean` (default false) | 2 casts |
| `browser_click_at` (358) | `x: number`, `y: number` | — | 2 casts |
| `browser_hover_at` (363) | `x: number`, `y: number` | — | 2 casts |
| `browser_get_elements` (367) | `selector: string` | — | 1 cast |
| `browser_get_links` (372) | — | `text_filter: string` | 1 optional cast |
| `browser_wait_for_text` (377) | `text: string` | `timeout_ms: number` (default 5000) | 2 casts |
| `browser_set_cookies` (381) | `cookies: array` of `{ url, name, value: string; domain?, path?: string; secure?, http_only?: boolean; expiration_date?: number }` | — | whole-array cast (line 382) |

## Intended Behavior

### 1. Closed-window error contract

Every interaction/query method in the table above marked **throw** must throw the same error when there is no live window, via one shared private guard:

```ts
private _requireWebContents(): Electron.WebContents {
  if (!this.win || this.win.isDestroyed()) {
    throw new Error('Browser window not open — call browser_navigate to open it')
  }
  return this.win.webContents
}
```

- The message is a single constant used everywhere, **including `screenshot()`** (which switches from its own inline check to the shared guard, so its message gains the `— call browser_navigate to open it` hint). The load-bearing prefix `Browser window not open` is preserved; the suffix tells the agent the recovery action.
- The MCP `CallToolRequestSchema` handler already wraps the whole switch in `try/catch` and converts any throw into `{ isError: true, content: [{ text: 'Error: …' }] }` (lines 395–400). No handler change is needed for this contract to reach the agent.
- The guard also covers the `isDestroyed()` window that `click()`'s current `this.win?.webContents` check misses.
- `navigate()` and `setCookies()` keep their `_ensureWindow()` auto-open behavior — `browser_navigate` remains the documented way to (re)open the browser. `show/hide/setUserControlled/setAgentControlled/getState/initialize/destroy` are window/state management and are unchanged.
- `goBack()`/`goForward()` call `_requireWebContents()` *before* the `canGoBack()`/`canGoForward()` checks so "window not open" is not misreported as "no history".
- `waitFor()`/`waitForText()` call the guard once at entry (fail fast instead of polling a dead window). If the window closes *mid-poll*, the existing behavior (timeout error) is acceptable; do not add per-iteration guards unless trivial.
- `waitForLoad()` throws when there is no window; the `!wc.isLoading()` early return for a live window stays.
- The private `_waitForNavigation` / `_waitForNavigationIfStarted` fallbacks stay graceful: they run *after* an action already happened on a live window, and a window closing mid-navigation should not turn a completed click into an error.

### 2. Argument validation contract

A new dependency-free helper module validates arguments at the top of each tool case and throws `Error`s with actionable messages; the existing catch converts them to `isError` results. Example messages:

- `Invalid arguments: "url" is required and must be a string (got undefined)`
- `Invalid arguments: "x" must be a finite number (got string)`
- `Invalid arguments: "cookies" must be an array (got object)`
- `Invalid arguments: "cookies[0].name" is required and must be a string (got undefined)`

**Recommendation: hand-rolled helpers, not zod.** Rationale: the 22 schemas are flat (one nested object array), the SDK already ships the JSON schemas for documentation, the helpers are ~50 lines with zero runtime dependency added to the Electron main bundle, and repo convention (CLAUDE.md testing section) favors small extracted pure modules. zod would buy schema/validator unification only if the ListTools schemas were also generated from it — a larger refactor explicitly out of scope here.

## Implementation Plan

All work is in `src/main` (main-process Vitest project, node env). No IPC channels, tool names, or tool schemas change.

**Step 1 — Create `src/main/mcp/toolArgs.ts`** (pure module, no Electron/SDK imports, so it is unit-testable per the repo's extraction convention). Exported API:

```ts
export type ToolArgs = Record<string, unknown> | undefined

export function requireString(args: ToolArgs, key: string): string
export function requireNumber(args: ToolArgs, key: string): number      // Number.isFinite check
export function requireArray(args: ToolArgs, key: string): unknown[]
export function optionalString(args: ToolArgs, key: string): string | undefined
export function optionalNumber(args: ToolArgs, key: string, fallback?: number): number | undefined
export function optionalBoolean(args: ToolArgs, key: string, fallback: boolean): boolean
export function optionalStringArray(args: ToolArgs, key: string): string[]  // default []
```

Rules: `undefined`/`null`/missing key on a `require*` throws; wrong type always throws (an *optional* arg that is present but mistyped is an error, not silently ignored); `requireNumber`/`optionalNumber` reject `NaN`/`Infinity`; messages follow the `Invalid arguments: "<key>" …` format above including the received `typeof`. Empty string is a valid string (selectors/text may legitimately be short but a required empty `url`/`selector` may optionally be rejected — implementer's choice; if rejected, only for `require*` and say so in the message).

**Step 2 — Add a cookie-array validator** in the same module:

```ts
export interface CookieInput { url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }
export function requireCookies(args: ToolArgs, key: string): CookieInput[]
```

It validates each element (`url`/`name`/`value` required strings; optional fields type-checked) and performs the `http_only → httpOnly`, `expiration_date → expirationDate` snake-to-camel mapping currently inlined at `BrowserMcpServer.ts:382–387`, indexing errors as `cookies[i].field`.

**Step 3 — Rewrite each `case` in `BrowserMcpServer._registerHandlers`** to validate first, then call. Example shape:

```ts
case 'browser_click_at': {
  const x = requireNumber(args, 'x')
  const y = requireNumber(args, 'y')
  const nav = await this.browser.clickAt(x, y)
  return { content: [{ type: 'text' as const, text: `Clicked at (${x}, ${y})\nURL: ${nav.url}\nTitle: ${nav.title}` }] }
}
```

Apply per the per-tool table above; defaults move into the helpers (`optionalNumber(args, 'timeout_ms', 5000)`, `optionalBoolean(args, 'exact', false)`). After this step there must be **zero** `args!` non-null assertions and zero `as <type>` argument casts in the CallTool handler (`browser_get_content`'s `args?.selector` casts included). Success-message texts are unchanged except that they now interpolate validated values.

**Step 4 — Add `_requireWebContents()` to `BrowserViewManager`** and convert the methods per the Current Behavior table: replace each `const wc = this.win?.webContents; if (!wc) return <fake>` preamble with `const wc = this._requireWebContents()`. Convert `screenshot()`, `evaluate()`, `getContent()`, `scroll()`, `getCurrentUrl()`, `selectOption()`, `waitFor()`, `waitForText()`, `waitForLoad()`, `goBack()`, `goForward()`, `keyboard()`, `hover()`, `hoverAt()`, `click()`, `clickAt()`, `clickText()`, `type()`, `getElements()`, `getLinks()`. Do **not** touch `navigate()`, `setCookies()`, `show()`, `hide()`, `initialize()`, `destroy()`, the state setters, or the two private `_waitForNavigation*` helpers.

**Step 5 —** `npm run typecheck`, `npm test`. Optionally remove the dead `src/main/mcp/tools/*.ts` wrappers (see Out of Scope) in a separate commit if the implementer confirms with the user.

## Tests

Per the boy-scout rule both touched files need coverage; the pure-extraction convention makes most of it unit-testable.

**Unit — `src/main/mcp/toolArgs.test.ts`** (main project, node env; fully testable, no mocks):
- `requireString`: passes through a valid string; throws on missing key, `undefined` args object, `null`, number, with the exact message format (assert the `Invalid arguments: "url"` prefix and the got-type suffix).
- `requireNumber`: accepts `0` and negatives; rejects `NaN`, `Infinity`, numeric strings.
- `optionalNumber`/`optionalBoolean`: returns fallback when absent; throws when present-but-mistyped (the "present but wrong type is an error" rule).
- `optionalStringArray`: `[]` default; rejects arrays containing non-strings.
- `requireCookies`: happy path including snake→camel mapping of `http_only`/`expiration_date`; indexed error message for a bad element (`cookies[1].value`); rejects non-array.

**Unit — MCP handler `isError` path (recommended).** `BrowserMcpServer.ts` imports `BrowserViewManager` **type-only** (line 11), so the server is instantiable in a node test with a plain stub object cast to `BrowserViewManager` — no Electron loads. Use the SDK's `InMemoryTransport.createLinkedPair()` with an MCP `Client` to call tools end-to-end and assert:
- `browser_click_at` with `x: "300"` returns `isError: true` with the `Invalid arguments: "x"` message.
- A stub whose `click` throws `new Error('Browser window not open — call browser_navigate to open it')` yields that message with `isError: true` (proving the catch→isError conversion carries the new contract).
- A stub happy path (e.g. `browser_get_url`) still returns a non-error result.
If wiring the in-memory client proves disproportionate, the first two assertions may instead be covered by manual verification — but state that in the PR; the `toolArgs` unit tests are non-negotiable either way.

**Not unit-testable — `BrowserViewManager` itself.** It imports `electron` at module load (real `BrowserWindow`), and its only pure logic (`normalizeMaxChars`, `countLines`) is not part of this change. Do not add `vi.mock('electron')` scaffolding for a one-line guard (repo convention prefers extraction over Electron mocks, and there is nothing left to extract — the guard is inseparable from `this.win`). The closed-window throw behavior of the manager is covered by the manual Verification Steps below plus the handler-level stub test above.

## Risks

- **Intended contract change: agents that previously "succeeded" now see errors.** Any agent workflow that called `browser_click`/`browser_type`/etc. before `browser_navigate` was already broken (the actions never happened); it will now fail loudly with a recovery hint instead of silently. This is the point of the spec, not a regression.
- **`browser_navigate` auto-open is the recovery path — verified from code.** `navigate()` calls `_ensureWindow()` + `win.show()` (lines 76–79), so the error message's instruction ("call browser_navigate to open it") is accurate. `setCookies()` also auto-creates the window (line 458) and — because `_ensureWindow()` does not pass `show: false` — visibly opens it; that pre-existing side effect is unchanged by this spec but should be kept in mind if an agent's first call is `browser_set_cookies`.
- **`getCurrentUrl()` becomes throwing.** Its only live caller is the `browser_get_url` case; the dead `tools/` wrappers also reference it but are unreachable. No renderer/IPC caller exists (verified by grep across `src/`).
- **Optional-arg strictness.** A client that today sends `timeout_ms: "5000"` (string) silently "worked" (arithmetic coercion); it will now get an `isError`. This is deliberate — document it in the PR description.
- **Message-text sensitivity.** `screenshot()`'s error message gains a suffix. Nothing in the repo matches on the exact string (grep: the only occurrence of `Browser window not open` is `BrowserViewManager.ts:136`), and the prefix is preserved.
- **Mid-operation window close** remains graceful by design (`_waitForNavigationIfStarted` fallback) — do not "fix" that path to throw; it would turn completed clicks into false errors.

## Verification Steps

Manual, in a packaged or `npm run dev` build with a Claude/Codex pane (the MCP server is injected automatically):

1. With the browser window **closed** (fresh app start, never navigated), have the agent call `browser_click` with any selector. Confirm the tool result is `isError` with text `Error: Browser window not open — call browser_navigate to open it`.
2. Repeat for at least one query tool (`browser_get_elements` or `browser_get_url`) and one wait tool (`browser_wait_for` — confirm it fails **immediately**, not after 5s).
3. Call `browser_screenshot` — same error text (contract consistency).
4. Have the agent call `browser_navigate` to `https://example.com` — window opens, success text with URL + title.
5. Re-run `browser_click`/`browser_get_elements` against the live page — normal operation, no behavior change.
6. Close the browser window manually (user X button), call `browser_get_url` — the `'closed'` handler nulled `this.win`, so the same `isError` contract must apply.
7. Validation: call `browser_click_at` with `{ "x": "300", "y": 200 }` (string x) and with `{ "y": 200 }` (missing x) — both return clear `Invalid arguments: "x" …` isError results. Call `browser_set_cookies` with `cookies: {}` — array error message.
8. `npm run typecheck` and `npm test` pass.

## Handoff Contract

### Non-negotiables

1. **Tools stay neutral primitives.** No decision-making, auto-retry, or auto-navigate-on-error is added to any tool. The only "guidance" added is the recovery hint inside the error string.
2. **Tool names, descriptions, and JSON `inputSchema`s in the `ListTools` response are byte-for-byte unchanged.** This spec changes runtime behavior only.
3. **The CLAUDE.md Browser Panel tool table stays accurate** — it lists tools and semantics, none of which change; no CLAUDE.md edit is required unless the implementer also removes the dead `tools/` directory (then update the "MCP server ... can control via tools in `src/main/mcp/tools/`" sentence).
4. One shared error string for the closed-window state, thrown by a single guard; no per-method message drift.
5. `navigate()` and `setCookies()` keep their auto-open behavior; no other method gains it.
6. Zero remaining `args!` assertions or argument `as`-casts in the CallTool handler.
7. `toolArgs.ts` stays free of Electron/SDK imports (must remain unit-testable in the node project).
8. No source changes outside `src/main/browser/BrowserViewManager.ts`, `src/main/mcp/BrowserMcpServer.ts`, the new `src/main/mcp/toolArgs.ts`, and test files (plus the optional dead-code removal if separately approved).

### Definition of Done

- Every method marked **throw** in the Current Behavior table throws the shared error when no window exists; every method marked unchanged is untouched.
- Every tool case validates its arguments through `toolArgs` helpers per the per-tool table; malformed args yield `isError` results with the specified message format.
- `toolArgs.test.ts` covers all helpers including error-message shape and the cookie mapping; handler-level `isError` test present or its absence justified in the PR with manual evidence.
- `npm run typecheck`, `npm test` green; manual Verification Steps 1–7 performed and reported in the PR.

## Out of Scope

- **Removing the dead `src/main/mcp/tools/*.ts` wrappers** (`click.ts`, `navigate.ts`, `getUrl.ts`, etc.). Grep confirms nothing imports them — `BrowserMcpServer` inlines every call — but deletion is a separate cleanup (and requires a matching CLAUDE.md sentence fix). Flag it; do not bundle it silently into this change.
- Generating `ListTools` schemas from zod (schema/validator unification) or adding zod at all.
- Changing `_ensureWindow()` visibility behavior (e.g. `show: false` for `setCookies`) or any window lifecycle semantics.
- Adding new tools, renaming arguments (e.g. `http_only` → `httpOnly` at the wire level), or changing success-message formats.
- Backpressure/flow control, renderer changes, IPC changes.
- Guarding against the window closing mid-poll inside `waitFor`/`waitForText` loops (entry guard only).
