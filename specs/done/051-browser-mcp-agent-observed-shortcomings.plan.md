# Plan: 051 Browser MCP Agent-Observed Shortcomings

- [completed] Correct the `browser_evaluate` contract and add executable coverage for expressions and function forms. Requirements: 1. Files: `BrowserViewManager.ts`, `BrowserMcpServer.ts`, browser manager tests, Electron runtime test.
- [completed] Verify native JavaScript-dialog behavior and keep unsupported control out of the tool surface. Requirements: 2. Files: `BrowserViewManager.ts`, `BrowserMcpServer.ts`, `McpManager.ts`, browser manager tests, Electron runtime test. Electron 42 returned from real prompt/confirm calls while the renderer stayed responsive and emitted no debugger message; `browser_handle_dialog`, dialog gating, and its status entry were removed rather than exposed as a nonfunctional capability. The live `/mcp` `tools/list` result equals renderer `mcp:get-status` tool reporting, including `browser_reload`.
- [completed] Add a deterministic no-navigation asynchronous fixture and trace-backed click-then-text outcome without changing action settling. Requirements: 3. Files: `e2e/fixtures/browser-async-toggle.html`, `e2e/browserMcp.spec.ts`, `BrowserViewManager.ts`. Ten live MCP repetitions of navigate, click, and separate `wait_for_text` passed; test-only poll samples record each text, timestamp, and result, so no speculative network-settle delay was added.
- [completed] Run the full mechanical self-check and leave the spec at review only when all requirements are complete. Requirements: Definition of Done. Files: spec status and this plan. `npm run typecheck`, `npm test` (61 files, 674 tests), `npm run build`, focused Electron MCP e2e (3 tests), and `git diff --check` passed. `npm run lint` is not available in this repository.

## Verification Evidence

- PASS: evaluator contract, status parity, dialog exclusion, and asynchronous click/text scenarios are covered by the focused Electron MCP runtime suite.
- PASS: `npm run typecheck`, `npm test` (61 files, 674 tests), and `npx playwright test e2e/browserMcp.spec.ts` (3 tests) passed after final documentation repair.
- PASS: native JavaScript-dialog control remains deliberately unsupported in Electron 42; no false MCP capability is advertised.
