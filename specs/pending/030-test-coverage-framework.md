# 030 — Test Coverage Framework

## Progress (as of 2026-06-29)

**Done:**
- Phase 0 — Vitest 4 harness (`vitest.config.ts`, two projects), `tests/setup.renderer.ts`, repo-root `__mocks__/zustand.ts`, `test`/`test:watch`/`test:coverage` scripts, tsconfigs include test files, `.github/workflows/ci.yml` (Windows runner), `.gitignore` covers `coverage/`. 247 tests pass; `npm run typecheck` clean; `npm run build` clean.
- Phase 1 Wave 1A — tests for `tabLabels`, `hotkeys`, `terminalKeyBindings`, `paneDrag`, `agents`, `git`, `time`, `resolveBackend`.
- Phase 1 Wave 1B (partial) — behavior-preserving extractions: `src/shared/paneTree.ts` (tree ops out of `panes.ts`) + characterization tests; `src/shared/cwdRepair.ts` (renderer cwd-repair out of `panes.ts`) + separator-coverage tests.
- Phase 1 Wave 1C — `buildEnv` extracted to `src/main/pty/buildEnv.ts` + PATH/Claude-flag guard test. Ratchet verified: reintroducing the PATH prepend turns the guard red.
- Phase 1 Wave 1B (remaining pure extractions — done):
  - OSC 633/7 shell-integration parser → `src/main/pty/shellIntegration.ts` (`parseOsc7`, `parseShellIntegrationCwd`, `unescapeShellIntegrationValue`) extracted out of `handlers.ts`; test covers OSC 633 `Cwd=` + `\xNN` unescape, OSC 7 `file://` win32/posix branches, BEL/ST terminators. `process.platform` is pinned for the win32 OSC-7 branch.
  - Claude transcript parse helpers → `src/main/sessions/transcriptParse.ts` (`extractText`, `isRealUserMessage`, `truncate`, `parseRecord`, `deriveProjectName`) extracted out of `TranscriptScanner.ts`; test covers real-user-message classification (meta/`<command>` exclusion), string vs array content, truncation, project-name derivation.
  - Codex session-detection matching → `src/main/sessions/codexDetection.ts` (`normalizePath`, `codexCandidateMatchesPending`, `selectCodexAssignments`) extracted out of `SessionSpawner.ts`; `_assignCodexCandidates` now delegates to the pure selector. Test covers cwd/time-grace/baseline/resume exclusion and the **ambiguity-is-ignored** invariant (spec 003/008).
  - Deep-search helpers → `src/main/sessions/deepSearch.ts` (`buildMatcher`, `snippetAround`, `truncate`, `extractClaudeText`/`extractCodexText`, `scoreResult`, caps + session-id regex) extracted out of `DeepSearcher.ts`; test covers matcher modes, snippet window, role/recency ranking (`vi.setSystemTime`), caps.
  - Claude transcript path encoding → `src/main/sessions/claudePaths.ts` (`encodeClaudeProjectDir`, `claudeProjectDirForCwd`, `claudeTranscriptPathForCwd`) extracted out of `SessionIndex.ts`; test covers the separators+colons→dashes encoding used during cwd repair.
- Phase 2 — real-store transition suites cover `usePanesStore` focus atomicity, cwd/zoom/tree edits, cross-window ack booleans, and cwd repair; `useSessionsStore` loading, exact-project selection, IPC/local search, composite-identity deletion, and cwd-repair reconciliation. React Testing Library covers `UpdateBanner`, `CommandPalette` filtering/enabled gates, `PaneHeader` actions, `TabBar` overflow modes, and `SessionBrowser` summary/deep rendering.
- Phase 4 — nonzero scoped coverage ratchets now protect `src/renderer/src/utils/**`, `src/shared/**`, and the extracted pure main-process modules. `CLAUDE.md` documents the testing workflow, scoped ratchets, and boy-scout rule.
- Wave 1B cwd-repair main-side reconciliation — the former `path.*`/host-bound behavior is captured for Win32 and POSIX hosts in `src/main/ipc/cwdRepairLegacy.test.ts`, including the known cross-platform divergences. `handlers.ts` now delegates layout rewrites to `src/shared/cwdRepair.ts`, so main and renderer use the same separator-agnostic semantics.
- Phase 3 — Playwright launches the compiled Electron app against an isolated temporary profile. Six E2E tests cover duplicate-free cold layout restore, a real Electron-ABI SQLite/FTS5 `MATCH` query, cwd-override persistence across restart/reindex, shell `pty:ready` plus direct `seq=0` output rendered by the real DOM-backed xterm, a real renderer tear-off followed by destination-side `DataTransfer`/`receiveTab`/`tab:absorb` commit-before-release with PTY rerouting, and the Claude deferred-spawn handshake via an isolated fake agent command. The multi-window test caught and fixed init-data and renderer-path races in detached-window startup. `createDirectPtyDataHandler` has a renderer test proving `terminal.write` occurs before callback return and that output handling emits no ack/pause/resume IPC.
- Clean-install verification — `npm ci` completed with Electron's `better-sqlite3` rebuild, followed by clean typecheck, 247 Vitest tests, coverage ratchets, production build, and all six Electron E2E tests.

**Remaining before this spec can move to `done`:**
- **Remote CI confirmation:** confirm the updated Windows GitHub Actions workflow, including Electron E2E, is green after these changes are committed and pushed. The equivalent clean-install matrix is green locally.

## Problem

This codebase has **zero automated tests**. There is no test runner installed, no test config, no test scripts in `package.json`, and no test files anywhere in `src/`. Every change today is validated by manual `npm run dev` runs and the user's eyes.

The app is growing (≈45 main-process files, ≈36 renderer files, native modules, multi-window IPC, FTS search, PTY isolation, layout persistence) and the `CLAUDE.md` already encodes a large body of hard-won invariants — the PATH-rewrite root cause (spec 013), the no-flow-control PTY contract, cross-window transfer ack semantics (spec 024), session detection constraints, layout save/restore invariants. None of these are protected by tests. A future change can silently reintroduce a PATH rewrite, drop a guard, or regress the startup-resume flow, and nothing will catch it until a user hits it.

We need a test foundation so that ongoing maintenance and new features are testable and regressions are caught before release — not a one-shot 100% coverage push.

## Current State

- **No test tooling.** No Vitest/Jest/Playwright in `devDependencies`; Vitest is not even a transitive dep. No `*.test.ts(x)` / `*.spec.ts` files. No test scripts.
- **Build stack (modern, test-friendly):** TypeScript 6, Vite 7, electron-vite 5, React 19, Zustand 5, Node ≥24. Two `tsconfig` projects: `tsconfig.node.json` (main/preload/shared, `NodeNext`) and `tsconfig.web.json` (renderer/shared, `bundler` module resolution). `@vitejs/plugin-react` already in use.
- **Three separate execution contexts** that need different test environments:
  - **Renderer** — React + Zustand + xterm; wants jsdom/happy-dom + React Testing Library.
  - **Main process** — Node code: scanners, indexers, parsers, env building, path mapping; wants a Node `node` environment.
  - **Native/Electron boundary** — `better-sqlite3`, `node-pty`, Electron APIs (`BrowserWindow`, `ipcMain`, `app`, `dialog`, `shell`, `clipboard`). These need mocking or real-integration tests; they are *not* unit-test candidates.
- **Lots of pure, high-value, untested logic already exists** (the cheapest, highest-ROI targets — see Phase 2). The layout binary-tree ops, label computation, hotkey matching, pane-drag (de)serialization, terminal-backend resolution, transcript parsing, FTS query building, and cwd-repair path mapping are all essentially pure functions with little or no Electron coupling.

## Intended Behavior

A test pyramid that is cheap to run, runs in CI, and protects the invariants documented in `CLAUDE.md`:

1. **Unit tests** (Vitest) for pure logic in both renderer and main — the bulk of coverage, fast feedback.
2. **Component/integration tests** (Vitest + React Testing Library + happy-dom) for Zustand stores and renderer components, rendering against the *real* store where feasible.
3. **E2E smoke tests** (Playwright Electron, `_electron.launch`) for a small number of critical startup/spawn flows — deferred to a later phase, not blocking.
4. **CI gate** that runs typecheck + tests + coverage on every PR, with a coverage threshold that starts low and is ratcheted upward.

Guiding principles (from 2025–26 best-practice research):
- **Incremental adoption over a big-bang rewrite.** Get the harness running and green in CI at *0%* first, then add tests file-by-file. The "boy-scout rule": every touched file gets its first test; every new feature/bugfix ships with a test.
- **Don't chase coverage percentage.** Build confidence to change. Characterize the risky invariants first.
- **Don't mock the store by default** (official Zustand guidance). Render components against the real store; mock only when the real store is too heavy to set up.
- **Characterization tests before refactors** — capture current behavior of risky modules (layout tree, session detection, cwd repair) as a golden master before touching them.

## Implementation Plan

### Phase 0 — Tooling & harness (no app behavior change)

Add dev dependencies (2026 current lines; verify exact versions at install):

- `vitest@^4` (test runner; native Vite integration — reuses the existing Vite/electron-vite toolchain). Pin **v4** and use the `projects` config directly — `workspace` was renamed to `projects` in the v3→v4 migration and is deprecated.
- `@vitest/coverage-v8` (V8 coverage provider — fastest, recommended)
- `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`
- `happy-dom` (lighter than jsdom; fine for this renderer surface)
- `@playwright/test` (Phase 3 only — can be deferred; do not block Phase 0–2 on it)

**Vitest config.** Use Vitest **projects** (the modern replacement for `workspace`, per the Vitest 3→4 migration) to give the two contexts separate environments and configs while emitting *aggregated* coverage from a single `vitest run`:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/types.ts', 'src/**/*.{test,spec}.{ts,tsx}'],
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 }, // start at 0, ratchet up
    },
    projects: [
      {
        // Renderer: React components + stores + utils — DOM environment.
        // plugins/resolve are re-declared here (see inheritance note below).
        plugins: [react()],
        resolve: {
          alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
        },
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./tests/setup.renderer.ts'],
        },
      },
      {
        // Main process: Node-only logic — node environment, no DOM globals.
        resolve: {
          alias: { '@shared': resolve('src/shared') },
        },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.{test,spec}.{ts,tsx}', 'src/shared/**/*.{test,spec}.{ts,tsx}'],
        },
      },
    ],
  },
})
```

**Projects do not inherit root config by default — be explicit.** In Vitest, an inline project does **not** inherit root-level `plugins` / `resolve.alias` / `test` options unless it sets `extends: true` (tracked in [vitest#7225](https://github.com/vitest-dev/vitest/issues/7225); `extends: true` only *becomes* the default in v4). Relying on inheritance is fragile across v3/v4 and will silently break TSX transform (`@vitejs/plugin-react`) and `@renderer`/`@shared` alias resolution in the renderer project. **The config above re-declares `plugins` and `resolve.alias` inside each project** rather than depending on `extends` — this is the robust choice. If you instead prefer one root declaration, set `extends: true` on every project and verify resolution after install.

Notes:
- `src/shared/types.ts` is the IPC contract source of truth; exclude pure type files from coverage. If pure helper logic is later split out of `types.ts`, add tests for it.
- `setup.renderer.ts` imports `@testing-library/jest-dom/vitest`, calls `vi.mock('zustand')` to activate the root `__mocks__/zustand.ts` auto-reset (see Phase 2), and stubs renderer globals as needed.

**`package.json` scripts:**
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage",
"typecheck": "tsc -b --noEmit"
```

Keep `typecheck` as-is; Vitest uses esbuild and does not type-check tests by default — rely on `tsc` for that. **Add test files (`**/*.test.ts(x)`) to the relevant `tsconfig` `include`** (node project → main/shared tests, web project → renderer tests) so `tsc -b --noEmit` type-checks tests too.

**Decide globals up front (this is what makes test typechecking actually work).** The choice must be settled before writing the first test:
- The config above has **no `globals: true`**, so tests must `import { describe, it, expect, vi } from 'vitest'` explicitly. That's the recommended default — no `types` entry needed for the core API.
- `@testing-library/jest-dom/vitest` augments `expect` with matchers (`toBeInTheDocument`, …). For `tsc` to see them, the tsconfig including renderer tests must resolve the jest-dom types (it registers itself via `reference`/global augmentation on import in the setup file).
- If you *do* opt into `test.globals: true`, add `"types": ["vitest/globals"]` to that tsconfig or `tsc` errors on every bare `describe`/`expect`.
- **Verify `tsc -b` still builds with tests included.** `tsc -b` is composite/build mode; the existing `tsconfig.node.json`/`tsconfig.web.json` may carry `composite`/`rootDir`/emit constraints. Dropping `**/*.test.ts` into their `include` can trip `rootDir` or emit rules — confirm a clean `tsc -b --noEmit` after wiring, don't assume it works. If it conflicts, prefer a separate `tsconfig.test.json` that `extends` the relevant base with `noEmit` and the test include rather than loosening the prod configs.

**CI.** Add `.github/workflows/ci.yml` (Windows `windows-latest` runner, matching the native-module/ConPTY target) running `npm ci && npm run typecheck && npm test`. Use the existing `postinstall` (do not add `--ignore-scripts`). Upload the lcov coverage artifact and/or wire a coverage comment/check. The Windows runner is important: `better-sqlite3`/`node-pty` rebuild and any Phase-3 Electron E2E are Windows-shaped.

**Definition of done for Phase 0:** `npm test` runs, passes with zero tests (or one trivial smoke test), and CI is green. Coverage threshold is 0 — it exists only as the ratchet mechanism.

### Test conventions (established in Phase 0, used throughout)

- **Layout.** `tests/setup.renderer.ts` (jest-dom + `vi.mock('zustand')` activation), `tests/mockIpc.ts` (stubbed `window.ipc` for renderer modules), `tests/fixtures/` (canned JSONL transcripts, layout trees, session metadata), and the Zustand auto-reset mock at **repo-root `__mocks__/zustand.ts`** (not under `tests/` — see Phase 2). Co-locate unit tests beside source (`foo.ts` → `foo.test.ts`) where convenient; cross-cutting helpers live under `tests/`.
- **Temp dirs for integration tests.** SQLite (`SessionIndex`) and `DeepSearcher` fixture trees need real files. Create a unique dir under `os.tmpdir()` per test, wrap creation in `beforeEach`, and guarantee cleanup in `afterEach` (`fs.rm(tmp, { recursive: true, force: true })`). Never write into the repo tree or the user's real `~/.claude`/`~/.codex`.
- **cwd-repair separator coverage.** The repair helpers branch on separator style (`isWindowsPath`, `repairSeparator`, `normalizeRepairPath`, `comparableRepairPath`, `joinRepairPath`). Characterization tests must cover `\`-style, `/`-style, and mixed `[\\/]+` paths explicitly, plus the drive-prefix (`C:`) case — these branches are exactly where a regression hides.
- **ESLint override for test files (not applicable in this spec).** The repository has an ESLint config package dependency but no ESLint configuration, lint script, or lint CI step. Introducing the lint system is outside this test-framework scope. When linting is added, its first change must include test/E2E file configuration; no unexercised override is added here.

### Phase 1 — Invariant tests (highest ROI, pure logic)

Phase 1 runs in **two waves**. Most "pure" targets are currently **module-private and trapped behind top-level Electron/native imports** (e.g. `handlers.ts` imports `electron` at line 1; `PtyManager.ts` pulls in `child_process`), so they cannot be imported in a Node test as-is. Wave 1 proves the toolchain on the genuinely-zero-coupling files. Wave 2 is an explicit, mechanical **extraction pass** — add `export` (or move helpers into a sibling `*.pure.ts`) — before tests can be written. This extraction is expected Phase-1 work, not an edge-case risk; it stays behavior-preserving (pure logic moves, no logic changes).

#### Wave 1A — Zero-coupling files (prove the toolchain, get green fast)

One `*.test.ts` beside each source file. These import cleanly with no Electron/native coupling.

**Renderer pure logic:**
- `src/renderer/src/utils/tabLabels.ts` — `findLeafById`, `firstLeaf`, `collectLeaves`, `paneLabelText` (customName − directory composition), `computeLabels`. **Protects:** label computation contract used by tab bar + sidebar.
- `src/renderer/src/utils/hotkeys.ts` — `codeToDisplayKey`, `hotkeyDisplay`, `matches`, `hotkeyKey`, `eventKey`. **Protects:** spec 028 keybinding customization + command palette shortcut chips reflecting current bindings.
- `src/renderer/src/utils/terminalKeyBindings.ts` — `isValidTrigger`, `findClaimant`, `bindingKey`, `defaultTerminalKeyBindings`. **Protects:** spec 028/029 binding conflict resolution.
- `src/renderer/src/utils/paneDrag.ts` — `encodePaneDragPayload` / `decodePaneDragPayload` round-trip, `paneDragSourceId`. **Protects:** multi-window pane transfer payload integrity (spec 024).
- `src/renderer/src/utils/agents.ts`, `utils/git.ts`, `utils/time.ts` — small, pure, trivial wins to build momentum.
- `src/renderer/src/terminal/rendering/resolveBackend.ts` — `resolveBackend(pref, caps)`: assert `auto` picks WebGL only when `caps.webgl && !caps.softwareRendering`, `off` → DOM, `on` → WebGL when available. **Protects:** the SwiftShader/WARP CPU-spike auto-detection trap (spec 019). Note: test `resolveBackend` directly (pass canned `caps`) — do **not** transitively import `capabilities.ts`'s `getCapabilities()`, which probes a real canvas via `document.createElement('canvas').getContext('webgl2')` and returns `null` (→ `webgl:false`) under happy-dom. If you must touch it, stub it explicitly.

**Wave 1A definition of done:** every file above has a passing test with *no* code extraction required, proving the Vitest/projects/happy-dom/coverage toolchain end-to-end before any refactor.

#### Wave 1B — Extract-and-test (named extraction steps)

These are the highest-value invariant tests. All but one are **behavior-preserving** extractions (add `export`, or move pure helpers to a sibling/`shared` module — no logic change). The **exception is the cwd-repair consolidation**, which is a deliberate *behavioral reconciliation* (the two copies have already diverged — see below); it is called out separately and must not be bundled into the same "no behavior change" milestone as the pure extractions. List each extraction explicitly so it is reviewable and tracked.

- **cwd-repair path mapping (duplicated, ALREADY-DIVERGED logic — behavioral reconciliation, not a pure extraction).** `replaceCwdPrefix` / the prefix-aware segment-boundary `CwdRepairMapping` exists **twice**, independently and module-private: `src/renderer/src/store/panes.ts:162` (helpers `isWindowsPath`/`normalizeRepairPath`/`comparableRepairPath`/`joinRepairPath`/`repairSeparator`, lines 177–215) and `src/main/ipc/handlers.ts:1225` (different helper `comparablePath` + inline `path.resolve`). They have **already diverged structurally** — the renderer copy is string-based and platform-agnostic (handles `[\\/]+` mixing + drive prefixes regardless of host OS); the main copy uses Node `path.*` + `process.platform` and is host-bound. **They produce different output for the same input** (e.g. a `C:\…` path on a non-win32 host, relative inputs where `path.resolve` injects `process.cwd()`, trailing-`..`), so consolidating to either semantics **changes the other call site's behavior**. This is therefore *not* behavior-preserving and must be its own focused PR, sequenced: (1) write golden-master characterization tests against **each** copy as-is, capturing current behavior of both; (2) deliberately choose the winning semantics — almost certainly the string-based renderer version, since it's the only one correct for cross-platform stored paths; (3) consolidate into one shared module under `src/shared/` (e.g. `src/shared/cwdRepair.ts`) exporting `replaceCwdPrefix` + `CwdRepairMapping` + `rewriteNodeCwds`, accepting that the main call site's behavior changes to match, with the characterization tests proving the new shared impl matches the chosen golden master. **Test:** segment-boundary cases (prefix mid-path, trailing separator, `sessionDetectionCwd`, `Tab.defaultCwd`). **Protects:** spec 009/015, and removes a real divergence bug surface. Because it changes behavior, it is the **riskiest** item here — do **not** use it as the toolchain-proving exercise (that's Wave 1A); land it after the harness is green.
- `src/renderer/src/store/panes.ts` tree helpers (`findLeaf`, `replaceNode`, `removeLeaf`, `makeLeaf`, `makeSplit`, `uuid`) — none exported today; the file is the live Zustand store with IPC wiring at module load. **Extraction:** export the tree helpers (or move to `src/shared/paneTree.ts`). **Test:** characterization tests that add/remove/split/merge keep the binary tree well-formed. **Protects:** pane-layout invariants, focused-pane validation.
- `src/main/sessions/TranscriptScanner.ts` — `extractText`, `isRealUserMessage`, `truncate`, `parseRecord`, `deriveProjectName`. **Extraction:** move the pure parse/extract helpers into a sibling `*.pure.ts` (or export them). **Test:** parse/extraction against fixture JSONL lines.
- `src/main/sessions/CodexSessionScanner.ts` — candidate-matching (cwd/time/grace) logic, factored to accept a canned file list without touching disk. **Protects:** spec 003/008 Codex session detection invariants.
- `src/main/sessions/SessionIndex.ts` — FTS query construction and per-session cwd override application. better-sqlite3 is sync and cheap; a real temp-DB integration test is acceptable here, or factor the query-builder out.
- `src/main/sessions/DeepSearcher.ts` — ranking (role quality + recency + match count), caps (50 sessions / 5 matches), regex-vs-literal + case-sensitivity flags. Run against fixture transcript trees on a temp dir. **Protects:** spec 011.
- Shell-integration OSC parsing (OSC 633 `Cwd=` and the OSC 7 fallback) — currently inlined in `handlers.ts`/`terminalEnvironment.ts`. **Extraction:** factor the parser into a pure function. **Test:** parse known escape sequences.

#### Wave 1C — The PATH + Claude-flag guard (single highest-value regression test)

- `buildEnv` lives in **`src/main/pty/PtyManager.ts:303`** (not `terminalEnvironment.ts` — that file only holds `shellIntegrationCommand`), is module-private, and `PtyManager.ts` imports `child_process`/`./shell`. **Extraction:** export `buildEnv` (or move it to a pure `src/main/pty/buildEnv.ts`). **Test:** assert that for terminal panes PATH passes through **unmodified** — `expect(built.PATH).toBe(process.env.PATH)` (the strong, non-vacuous form: a "does not contain npm/nodejs/local-bin" check passes trivially when those dirs aren't on the test runner's PATH; equality actually catches a reintroduced prepend) — covering the spec 012/013 root cause, **and** that it scrubs the inherited `CLAUDECODE`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_DISABLE_MOUSE`, `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL`, and `CLAUDE_CODE_NO_FLICKER` flags (PtyManager.ts:308–314 — the other CLAUDE.md invariant in the same function). Encode both invariants as explicit assertions in one test.

**Definition of done for Phase 1:** Wave 1A tests pass with no extraction; the behavior-preserving Wave 1B extractions are done with no logic change; the cwd-repair reconciliation lands in its own PR (golden-master tests of both copies first, then the consolidated `src/shared/` module — a deliberate, test-backed behavior change, *not* part of the "no behavior change" set); Wave 1C's PATH+Claude-flag guard and the layout-tree characterization tests all pass. Coverage is meaningful on `src/renderer/src/utils`, the extracted tree/cwd-repair modules, and the pure parts of `src/main/sessions`.

#### Determinism (required for three Wave-1B targets)

Several extraction targets use real time or randomness and will produce flaky tests unless controlled. Pin these in fixtures from the start:
- **DeepSearcher ranking** — recency is computed from `Date.now()` against `session.lastActivity` (`DeepSearcher.ts:245`). Use `vi.useFakeTimers()` / `vi.setSystemTime()` and fixtures with pinned `lastActivity` timestamps.
- **panes tree helpers** — `makeLeaf`/`makeSplit` get ids from `crypto.randomUUID()` (`panes.ts:42`). Either stub the id generator (`vi.spyOn(crypto, 'randomUUID')` or an injectable id factory) or assert structurally while ignoring ids.
- **CodexSessionScanner matching** — candidate matching keys off `info.mtimeMs` (`CodexSessionScanner.ts:163`) plus record timestamps. Fixtures need pinned timestamps in the JSONL *and* controlled mtimes via `fs.utimesSync` — never wall-clock.

Generic guidance: any test touching recency, time-grace windows, uuids, or file mtimes must control those inputs. Don't reach for `Date.now()`/randomness in test data.
- **`process.platform` is machine-dependent.** The cwd-repair helpers (`isWindowsPath`/`normalizeRepairPath` in `panes.ts`) and `comparablePath` (`handlers.ts`) branch on `process.platform === 'win32'` / separator style. CI runs `windows-latest` (`'win32'`), but a developer on macOS/Linux running `npm test` locally hits the posix branch — so tests pass in one place and fail in the other. **Pin `process.platform` in these tests** (`Object.defineProperty(process, 'platform', { value: 'win32' })` in `beforeEach`, restored in `afterEach`, or `vi.stubGlobal`) and cover **both** branches explicitly rather than relying on the host OS.

### Phase 2 — Stores & component integration

- **Zustand store tests.** Reset state between tests via the official **auto-reset mock** pattern — a `__mocks__/zustand.ts` at the **repo root** (Vitest discovers a `__mocks__/` for a bare `import 'zustand'` only when it sits adjacent to `node_modules`; under `tests/` it is *not* picked up without extra `deps.moduleDirectories`/`root` config) that wraps `create`/`createStore` and clears all stores in `afterEach` — **not** by adding test-only `reset` actions to production stores (don't litter prod code with test hooks). The mock body follows the [official Zustand testing recipe](https://zustand.docs.pmnd.rs/learn/guides/testing) (an internal store registry cleared in `afterEach`). Use the **Vitest** variant, not the Jest one: the factory must be `async` and pull the real module via `const actual = await vi.importActual('zustand')` (the Jest snippet's synchronous `requireActual` does not work under Vitest's hoisted `vi.mock`). **Activation is explicit:** unlike Jest, Vitest does not auto-apply a node_module `__mocks__` file — `tests/setup.renderer.ts` must call `vi.mock('zustand')` for the reset wrapper to take effect; without it the mock is dead and state leaks between tests (the exact gotcha this prevents). This does *not* contradict the "don't mock the store" principle: that principle is about not stubbing store *behavior* in component tests; this is automatic *state reset*, which the components' real store still drives. Test `usePanesStore` transitions (`focusPaneInTab` atomicity, `setPaneCwd`, zoom) and `useSessionsStore` filtering against the real store. **Protects:** the "focus transitions must be atomic" / "don't compose `setActiveTab` + `focusPane`" invariant.
- **React Testing Library component tests** for leaf components that are pure-presentational or driven by props: `PaneHeader`, `TabBar` overflow modes, `SessionBrowser` Summary vs Deep rendering, `CommandPalette` filtering/enabled-gates. Use `user-event` for interaction. Prefer role/accessible-name queries, avoid testing implementation details.
- Mock `window.ipc` in setup (`vi.stubGlobal('window', ...)` or a `tests/mockIpc.ts`) so renderer modules that call `window.ipc.invoke/on/send` don't blow up; assert the *calls* the component makes rather than real IPC.
- xterm-backed components stay thin in tests — don't drive a real terminal. Extract and test the logic that *feeds* xterm (resize decisions, DA1 response timing) as pure functions where possible; otherwise defer to E2E.

**Definition of done for Phase 2:** store transitions and key presentational components have tests; IPC call assertions are in place.

### Phase 3 — Electron E2E smoke

A small number of Playwright-Electron tests via `_electron.launch({ executablePath, args })` exercising critical startup/spawn flows the unit tests can't reach:
- Cold-start restores saved layout without duplicates (StrictMode guard, `layoutReady`).
- New shell pane spawns and emits `pty:ready`; new Claude pane uses `deferSpawn` size handshake.
- Cross-window `tab:absorb` commit-before-reroute ordering does not orphan the tab.

The harness and all listed flows are implemented in `e2e/startup.spec.ts` and run in CI. Claude uses an E2E-only fake command gated behind the isolated-profile environment, so CI does not depend on a globally installed CLI.

**Invariants with no Phase-1 home.** Two `CLAUDE.md` invariants motivated in the Problem section are *not* unit-testable and land only here in Phase 3 — they are **not** covered by Phase 1's DoD, and a reviewer should not read Phase 1 as protecting them:
- The **no-flow-control PTY contract** (seq=0, synchronous `terminal.write`, no ack/pause) — spans main↔renderer↔xterm at runtime.
- **Cross-window transfer ack semantics** (spec 024 — destination must *actually apply* before acking; self-drop guards; commit-before-reroute for `tab:absorb`) — spans main + two renderer processes + PTY routing.

Both are real-time, multi-process behaviors and are now exercised by the shell direct-output and two-window absorb E2E tests; the synchronous renderer callback is additionally protected by `ptyData.test.ts`.

### Phase 4 — Ratchet & policy

- Set a real starting coverage threshold on the high-value directories only (e.g. `src/renderer/src/utils/**`, `src/main/sessions/**`) — start where current coverage is and forbid regression. Enable `--coverage.thresholds.autoUpdate` cautiously (or set thresholds manually per-PR) so the bar only ever rises.
- Document the **boy-scout rule** in `CLAUDE.md`: any file a PR touches should gain or extend a test; new features ship with tests. This is the durable mechanism that keeps coverage growing without a dedicated sprint.
- Add a short "Testing" section to `CLAUDE.md`: how to run tests, where projects live, the PATH-rewrite guard test, and the "don't mock the store" guidance.

## Risks & Constraints

- **"Pure" targets are mostly module-private behind Electron/native imports.** This is the dominant Phase-1 cost, not an edge case (see Wave 1B). `handlers.ts` imports `electron` at line 1; `PtyManager.ts` imports `child_process`; `panes.ts` is a live Zustand store. Mitigation is the explicit Wave-1B extraction pass — behavior-preserving exports/sibling modules — not `vi.mock` hacks.
- **Duplicated, already-diverged cwd-repair logic.** `replaceCwdPrefix` exists independently in `panes.ts:162` and `handlers.ts:1225` and the two copies already produce different output (string-based/platform-agnostic vs `path.*`/host-bound — see Wave 1B). Consolidation is a Phase-1 deliverable but is a **behavioral reconciliation**, not a pure dedup: characterize both copies first, then unify in its own PR. Don't treat it as risk-free or fold it into a behavior-preserving commit.
- **Native modules in the test process.** Importing `better-sqlite3` or `node-pty` at module top-level pulls native bindings into the Vitest process. Keep those imports behind thin seams and structure projects so pure logic doesn't transitively import `node-pty`. `SessionIndex`/`DeepSearcher` may use real temp-file integration tests rather than mocks (better-sqlite3 is sync and cheap).
- **Module resolution mismatch.** Renderer code uses `bundler` resolution + `@renderer`/`@shared` aliases; the Vitest config must mirror those aliases (handled above). Main-process code is `NodeNext` (ESM/`.js`-suffix imports) — watch for import-suffix friction under Vitest and adjust if a module fails to resolve.
- **Electron API access from main modules.** Files that call `app`, `BrowserWindow`, `ipcMain` at import time can't be imported in a plain Node test. Factor pure logic out of these modules, or `vi.mock('electron', ...)` in tests.
- **Windows-only CI.** ConPTY, `better-sqlite3` ABI, and the PowerShell shell-integration path are Windows-specific. CI must run on `windows-latest`; don't assume macOS/Linux CI will exercise the real terminal stack.
- **Vitest version.** Target **Vitest 4** and the `projects` config; the v3 `workspace` API is deprecated and coverage-v8 remapping changed between v3 and v4, so re-verify threshold numbers after install.
- **Test type-checking is mandatory.** Vitest uses esbuild and does not type-check by default — type errors in tests would never surface. Add test files (`**/*.test.ts(x)`) to the relevant `tsconfig` `include` (node project for main/shared tests, web project for renderer tests) so `tsc -b --noEmit` covers them. This is a definite requirement, not a "consider".
- **CI native-rebuild cost.** A Windows runner rebuilding `better-sqlite3` + `node-pty` on every PR costs minutes. Cache `%LOCALAPPDATA%\electron`, the electron download cache, and `node_modules` (keyed on `package-lock.json`) in the workflow to keep CI time reasonable.
- **Coverage gaming.** Thresholds can incentivize low-value tests. Keep the focus on the `CLAUDE.md` invariants, not on a number. Reviewers should reject tests that exist only to move a percentage.

## Verification Steps

1. `npm test` runs from a clean `npm ci`, passes, and reports per-project results.
2. `npm run test:coverage` emits `coverage/` with text + html + lcov; thresholds configured and enforced (CI fails on regression below threshold for gated dirs).
3. GitHub Actions CI (Windows runner) is green on a trivial PR.
4. Phase 1 invariant tests exist and pass, specifically:
   - the PATH-rewrite guard test (env builder does not prepend npm/nodejs/local-bin to PATH),
   - layout tree characterization tests,
   - `resolveBackend` software-rendering auto-detection,
   - session-detection candidate matching,
   - cwd-repair path mapping.
5. Ratcheting works: deliberately breaking one invariant fails a specific test (manually verify by flipping the PATH prepend back on and confirming the test goes red).
6. `CLAUDE.md` has a Testing section documenting how to run tests and the boy-scout rule.

## Out of Scope

- Aiming for any specific coverage percentage as a goal.
- Rewriting app code beyond the **behavior-preserving extraction** called out in Phase 1 Wave 1B (export private helpers, move pure parsers/matchers into sibling/`shared` modules). These extractions are expected and in-scope; they must not change logic. Any *other* change that alters runtime behavior is out of scope and belongs in its own PR. **One deliberate exception:** the cwd-repair consolidation (Wave 1B) intentionally changes the main-side behavior to match the renderer semantics — it is in scope, but only as its own focused PR gated by golden-master characterization tests of both pre-existing copies, never folded into a "no behavior change" extraction commit.
