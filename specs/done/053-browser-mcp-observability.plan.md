# 053 Browser MCP Observability — Execution Plan

## Tasks

1. **completed** — R1, R2, R3: add per-active-window bounded console/network capture and cookie query/delete methods in `BrowserViewManager.ts`; verified with focused manager tests for buffer ordering/truncation, cleanup, and cookie identity.
2. **completed** — R4: register console, network, cookie-list, and cookie-delete MCP tools with sensitive-value guidance and validated handlers in `BrowserMcpServer.ts`; verified through the in-memory MCP client tests.
3. **completed** — R4: add the four tools to `McpManager` built-in status reporting; verified with focused manager-status coverage.
4. **completed** — R1–R4: ran typecheck, build, unit tests, and Electron E2E; documented results and runtime limits, then set the spec to review.

## Implementation Summary

- Requirements covered: active-window 200-entry chronological console and network buffers with truncation and close cleanup; selected completed/failed request metadata without bodies; sensitive MCP-only cookie reads and explicit URL/name deletion; all four tools registered in the MCP surface and built-in status list.
- Checks run: `npm run typecheck`; focused Vitest coverage (39 tests); `npm run build`; `npm run test` (62 files, 679 tests); `npm run test:e2e` (18 Electron tests). The first E2E run identified a missing `onBeforeRequest` continuation callback; after correcting it, the targeted test and full E2E suite passed.
- Manual/runtime limit: the new tool results are covered through mocked manager/MCP unit tests and existing Electron browser navigation E2E. No live remote website was used; Electron owns the actual console, request, and cookie APIs at runtime.

## Verification Evidence

- **PASS — bounded active-window buffers:** `BrowserViewManager` keeps separate 200-entry FIFO console/network buffers, tracks truncation, and clears both on browser close/destroy. `BrowserViewManager — observability` verifies ordering, overflow metadata, and cleanup.
- **PASS — network metadata without bodies:** completed/error hooks retain only method, URL, resource type, status/failure, timestamp, and duration. The Electron E2E test `returns console and completed/failed network metadata through MCP` exercised a successful request and a failed request and asserted the exact response keys (no body fields).
- **PASS — console fields and chronology:** the browser `console-message` hook records level, message, source URL, line, and timestamp. The same Electron E2E test emits `console.error`, reads it through MCP, and checks source context plus chronological timestamps.
- **PASS — sensitive cookies and explicit deletion:** `browser_get_cookies` serializes values only as its MCP result, while its tool description warns that values are sensitive; no renderer/status path consumes them. Stateful manager and in-memory MCP tests verify value listing, explicit URL/name removal, and the subsequent empty listing. The delete handler rejects a missing identity field.
- **PASS — MCP/status wiring:** in-memory handler coverage exercises all four tools, `McpManager built-in browser status` checks their status exposure, and Electron E2E checks that the MCP tools list equals the status list.
- **PASS — non-goals and resolved decision:** static audit found passive `webRequest` observation only (no interception/body access), no Playwright dependency added to implementation, and no retry, multi-tab, storage, snapshot, tracing, video, PDF, or UI additions. Cookie values remain deliberately available only through the documented MCP result channel.
- **Dependencies:** Electron 42 provides `console-message`, `webRequest`, and `session.cookies`; MCP in-memory transport and streamable HTTP are exercised by unit/E2E coverage. Electron reports page `fetch()` as `xhr` in the local runtime, which is one of the required captured resource categories.
- **Commands:** `npm run typecheck` PASS; `npm run build` PASS; `npm run test` PASS (62 files, 679 tests); `npm run test:e2e` PASS (19 tests).
- **Verification repair:** added a real Electron MCP regression test for console and successful/failed network events; strengthened stateful manager/MCP cookie tests to prove list → explicit delete → re-list.
- **Runtime limit:** no external website was contacted. Cookie lifecycle uses deterministic session mocks because the shared E2E profile contains pre-existing persisted cookies; the manager uses Electron's direct `session.cookies.get/remove` APIs and the MCP sequence is covered through its in-memory transport.
