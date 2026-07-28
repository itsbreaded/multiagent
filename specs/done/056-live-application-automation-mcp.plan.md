# Implementation Plan: Live Application Automation MCP

## Tasks

1. **completed** — Requirements 1–3, 11–14: persisted opt-in settings, status UI, local-only endpoint, and process-scoped injection. Verified by settings and injection unit coverage.
2. **completed** — Requirements 4–8: host self-control, explicit endpoint attachment, target/window isolation, queue ordering, launch-time port contract, and target failure behavior. Verified through MCP server and Electron runtime coverage.
3. **completed** — Requirements 9–10 and 15: semantic window enumeration, inspection, interaction, waiting, screenshot, and diagnostics across main/detached windows. Verified in Electron Playwright.
4. **completed** — Requirements 3–5 and 11–14: packaged-compatible endpoint lifecycle, external local clients, browser-MCP separation, disable/new-session behavior, and settings disclosure. Verified by build, unit, and E2E gates.
5. **completed** — Requirement 9 renderer diagnostics: assert console output and successful/failed network records via `multiagent-ui` in Electron Playwright.

## Implementation Summary

Implemented a separate opt-in `multiagent-ui` MCP service with a persisted Settings toggle and the temporary `MULTIAGENT_UI_AUTOMATION_PORT` opt-in contract. It supports self-control, explicit local target attachment, target/window-scoped interaction, observability, and process-scoped Claude, Codex, and OpenCode injection.

Resumption repairs use the native input/textarea setter plus input/change events for React-controlled fields; return a valid result for `undefined` evaluation; reconcile the listener after settings changes; inject the current UI endpoint rather than stale module state; and serialize requests by target/window key. The E2E test now asserts console output and both 204 and failed network metadata via the UI endpoint.

Checks passed: `npm run typecheck`; `npm run build`; `npm run test` (66 files, 712 tests); focused UI-MCP Electron test; and `npm run test:e2e` (20 tests). Real drag targets and terminal-specific keyboard effects remain application-content-dependent runtime behavior for independent verification.

## Verification Evidence

Independent blind pass on 2026-07-27. No implementation repairs were needed.

### Requirements

| Item | Verdict | Evidence |
| --- | --- | --- |
| R1 separate server | PASS | `AppUiMcpServer` advertises `name: 'multiagent-ui'`; browser server remains separately injected as `multiagent-browser`. |
| R2 opt-in/persistence/launch override | PASS | `McpManager` defaults `builtinUiAutomationEnabled` to false, reads/writes `mcp-settings.json`, and treats only `MULTIAGENT_UI_AUTOMATION_PORT` as temporary opt-in. |
| R3 dev and packaged | PASS | Main-process server is bundled by successful production build; `electron-vite build` and Electron E2E exercise the compiled app without a debug-only condition. |
| R4 scoped new-session injection/self target | PASS | `McpInjector` writes process-local temporary Claude config and in-memory Codex/OpenCode launch settings; `SessionSpawner` injects `multiagent-ui` only when its current URL is present. `ui_windows` defaults to host `self`; E2E calls host tools without discovery. |
| R5 external local client | PASS | HTTP Streamable MCP listener accepts local POST clients; E2E calls it directly through `fetch` at port 48127. |
| R6 requested-port contract | PASS | `reconcileUiAutomation` validates 1..65535, binds precisely the requested value, preserves no fallback on error, and reports `uiAutomation.error`; README documents the same. |
| R7 explicit attachment/stable target | PASS | `ui_attach_target` validates loopback `/mcp` endpoint and returns UUID `target-<uuid>` retained in the server target map; E2E attaches the second instance at 48128 and enumerates it. |
| R8 target/window isolation and ordering | PASS | Every non-self window operation requires `window_id`, remote calls require a retained `target_id`, and queues use `${targetId}:${windowId}`; failed proxy calls name only that target and do not clear other targets. |
| R9 broad primitives | PASS | Tool list and handlers cover windows/content, click/type/scroll/keyboard/drag/wait/screenshot/evaluate/console/network. E2E exercises all interaction and diagnostics paths. |
| R10 main and detached windows | PASS | `BrowserWindow.getAllWindows()` returns owned windows with id/title/url/visible/focused metadata, and operations resolve by `BrowserWindow.fromId`; this naturally includes detached BrowserWindows. |
| R11 browser preservation/distinction | PASS | Existing browser tool list/server remains intact and `multiagent-browser` is a distinct server/tool namespace; E2E browser-runtime tests plus `ui_*` test pass. |
| R12 settings status | PASS | `McpStatus.uiAutomation` exposes enabled/running/port/tools/error through IPC; MCP Settings renders enabled/disabled, running/error, endpoint, and availability to new sessions/local clients. |
| R13 local-only | PASS | Server binds `127.0.0.1`; attachment regex accepts only `http://127.0.0.1:<port>/mcp`; README states no remote exposure. |
| R14 broad-control disclosure | PASS | Settings copy and README explicitly warn that enablement grants a local agent broad visible-UI control including click/type. |
| R15 semantic resilience | PASS | Interactions use selectors and stable BrowserWindow ids rather than feature-specific tools or ordering; E2E uses semantic selectors. |

### Acceptance scenarios

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| Fresh install disabled/no injection | PASS | Default setting false; `currentUiMcpUrl()` returns null and status UI renders Disabled. |
| Toggle persists across relaunch | PASS | `saveSettings` serializes the setting and `loadSettings` restores only explicit true. |
| Enabled new supported session injection | PASS | Claude config, Codex CLI overrides, and OpenCode inline config each add `multiagent-ui` only with current URL. |
| App session controls host by default | PASS | `target_id` defaults to `self`; E2E uses host `ui_windows`, content, and interaction calls without target discovery. |
| Independently launched local client controls installed app | PASS | E2E direct HTTP client controls the launched Electron host at loopback port 48127. |
| Known second dev endpoint controls second instance | PASS | E2E launches a second Electron instance at 48128, attaches its explicit endpoint, and enumerates it. |
| Requested valid port temporary opt-in | PASS | E2E starts with saved default disabled and `MULTIAGENT_UI_AUTOMATION_PORT=48127`, observes running port 48127; code does not mutate persisted setting for env opt-in. |
| Invalid/occupied requested port errors without fallback | PASS | Validation/bind failure leaves `_uiPort` null, preserves the requested-port error in status, and never calls `listen(0)` when env is supplied. |
| Host and attached target remain scoped | PASS | Target-keyed queue/proxy paths and E2E explicit remote target enumeration. |
| Same-window arrival order/other target usable | PASS | Per-target/window promise queue serializes same key only; distinct keys have independent chains. |
| Unreachable target isolated | PASS | Proxy turns fetch failure into `Target <id> is unavailable` without deleting/altering other target entries. |
| Window list scoped to selected target | PASS | Host uses local `ui.windows`; remote list is proxied solely to retained endpoint. |
| Primary/detached identifiable | PASS | Window list includes id, title, URL, visibility, and focus; no ordering contract is used. |
| Settings show endpoint/new-session/local-client availability | PASS | `McpSection` renders `http://127.0.0.1:<port>/mcp · available to new sessions and local clients`. |
| UI interactions apply to selected window | PASS | E2E confirms click, type/value, scroll, keyboard, drag, and wait against enumerated host window. |
| Console/network diagnostics | PASS | E2E asserts console error plus 204 and failed fetch metadata through `ui_console`/`ui_network`. |
| Packaged installation capability | PASS | Production `electron-vite build` succeeds and contains main/preload/renderer output including the server; no development-mode guard exists. |
| Disable affects only future sessions | PASS | `updateInjector()` refreshes launch-time injection after reconciliation; existing child process configuration is not mutated. |
| Both built-ins distinguishable | PASS | Separate `multiagent-browser` and `multiagent-ui` server names/tool namespaces are independently injected. |
| Remote device cannot connect | PASS | `http.listen(port, '127.0.0.1')` binds loopback only. |

### Non-goals, decisions, and dependencies

| Item | Verdict | Evidence |
| --- | --- | --- |
| No feature-specific API / browser replacement / remote exposure | PASS | Only broad `ui_*` primitives added; browser namespace retained; loopback bind and endpoint validation enforce local access. |
| No global/project agent config mutation | PASS | Claude config is a PID-named temp file passed at launch; Codex CLI and OpenCode environment are process-scoped. |
| No destructive-workflow safety guarantee / no indicator-pause / no auth design | PASS | No dedicated destructive-flow handling, persistent indicator/pause, auth, capability exchange, or discovery service was added. |
| Resolved self-control, explicit endpoint, temporary port, target scope | PASS | Confirmed by R4, R6-R8 implementation and Electron runtime test. |
| Existing MCP/agent-launch dependencies | PASS | `@modelcontextprotocol/sdk` Streamable HTTP transport, Electron BrowserWindow/webRequest APIs, existing injection/session-spawner model compile and run in full checks. |

### Commands and review checks

- PASS — `npm run typecheck` (0 errors).
- PASS — `npm run build` (all main, preload, renderer bundles built).
- PASS — `npm run test` (66 files, 712 tests).
- PASS — `npm run test:e2e` (20 Playwright Electron tests, including `controls the host application and an explicitly attached local instance through multiagent-ui`).
- PASS — `git diff --check` (no whitespace errors); searched changed source/E2E for debug code, commented-out dead code, and misleading TODO/FIXME markers. The intentional test diagnostics and existing browser startup log are not debug residue.
- Runtime limit: packaged installer launch was not separately exercised; successful production bundle plus absence of debug-only branching is the available packaged-installation evidence.
