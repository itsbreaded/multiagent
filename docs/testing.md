# Testing (mechanism)

The why/how behind the Vitest harness and the regression guards. This expands the
`AGENTS.md` **Test execution safety** guardrail; the one-line rule lives there.

The app has a Vitest 4 test harness (added in spec 030). Tests are the regression net for the
invariants documented in `AGENTS.md` — a future change that reintroduces a PATH rewrite, drops
a guard, or breaks the startup-resume flow should fail a test before it ships.

## Commands

```bash
npm test            # vitest run (both projects, no coverage)
npm run test:watch  # vitest watch
npm run test:coverage  # vitest run --coverage (text + html + lcov under coverage/)
npm run test:e2e    # build + Playwright Electron smoke tests (isolated temp profile)
npm run test:db     # shared-database migration/reopen checks under the Electron ABI
npm run typecheck   # tsc -b --noEmit — also type-checks test files
```

## postinstall / native rebuild

`postinstall` runs `node_modules/electron/install.js` (downloads the Electron binary —
Electron 42+ no longer does this during `npm install`), then the `electron-rebuild` CLI from
`@electron/rebuild` to rebuild `better-sqlite3` for the Electron ABI. `node-pty` ships Windows
Electron-compatible prebuilds in this tree; if those are unavailable, a source rebuild requires
Visual Studio Build Tools. Do not add `--ignore-scripts`.

`test:db` bundles the shared database owner and runs migration/rebuild fixtures under the
installed Electron executable. `better-sqlite3` is rebuilt for Electron's ABI, so running those
fixtures under the system Node binary can fail with a module-version mismatch.

## Project layout

`vitest.config.ts` defines two Vitest **projects** (the v4 replacement for the deprecated
`workspace` API): `renderer` (happy-dom, React Testing Library) and `main` (node env). A
single `npm test` runs both and emits aggregated coverage. Co-locate unit tests beside source
(`foo.ts` → `foo.test.ts`); shared helpers live under `tests/`. Renderer tests are in
`tsconfig.web.json`'s include; main/shared tests in `tsconfig.node.json`'s. Vitest uses esbuild
and does **not** type-check — `npm run typecheck` covers that, so keep it green.

**Projects do not inherit root plugins/resolve by default** — the renderer project
re-declares `@vitejs/plugin-react` and the `@renderer`/`@shared` aliases inside itself. Do not
rely on `extends` for this; TSX transform and alias resolution will silently break.

## The PATH-rewrite guard (spec 012/013)

`src/main/pty/buildEnv.ts` is extracted pure so it can be tested; `buildEnv.test.ts` asserts
`env.PATH === process.env.PATH` (the strong, non-vacuous equality form — a "does not contain
npm/nodejs" check passes trivially when those dirs aren't on PATH) and that the inherited
Claude renderer flags are scrubbed. These are the single highest-value regression guards in
the repo. If you touch `buildEnv`, keep them passing. (Root cause + mechanism in
`docs/pty-and-terminals.md`.)

## Extractions that exist purely to be testable

`src/shared/paneTree.ts` (binary-tree ops, moved out of `panes.ts`) and
`src/shared/cwdRepair.ts` (cwd-repair path mapping, moved out of `panes.ts`) are
behavior-preserving extractions; their tests characterize the layout-tree invariants and the
segment-boundary path rewrite. Prefer extracting pure logic into a sibling/`shared` module
over `vi.mock` hacks for modules that import Electron/native deps at load time.

## Don't mock the Zustand store

Render components against the real store. State reset between tests is handled by the
auto-reset mock at repo-root `__mocks__/zustand.ts`, activated by `vi.mock('zustand')` in
`tests/setup.renderer.ts` (Vitest does not auto-apply node-module `__mocks__` like Jest — the
explicit `vi.mock` call is mandatory). That mock does automatic *state reset* only; it does
not stub store *behavior*.

## Determinism

Tests touching recency, time-grace windows, uuids, or file mtimes must control those inputs
(`vi.setSystemTime`, pinned timestamps via `fs.utimesSync`, structural assertions that ignore
ids). `process.platform` is machine-dependent — pin it in tests that branch on `win32` and
cover both branches; CI runs the 3-OS matrix (`windows-latest`, `macos-latest`,
`ubuntu-latest`).

## Boy-scout rule

Any file a PR touches should gain or extend a test, and new features ship with tests. This is
the durable mechanism that grows coverage without a dedicated sprint — do not chase a
percentage. The global threshold remains 0 for legacy integration-only surfaces; raise the
nonzero scoped ratchets in `vitest.config.ts` as their measured baselines improve.

## Electron E2E

### Desktop and network safety

Every test command must be safe to run while the developer uses the same computer. Run tests only
through the guarded npm entry points (`test`, `test:watch`, `test:coverage`, `test:e2e`, and
`test:db`); calling Vitest, Playwright, Electron, or a test helper directly bypasses preflight and
is unsupported. Every npm test entry point runs `scripts/check-test-desktop-safety.mjs` first. The
preflight scans source tests, shared test setup
and helpers, E2E fixtures, and the Electron database smoke test. It rejects direct browser-native
dialog calls, native dialog/menu activation, direct OS-facing opens, the native select popup
shortcut, non-loopback E2E fetch/navigation targets, and any test-created `BrowserWindow` without
explicit hidden/offscreen options. Each E2E suite that launches Electron must retain the isolated
user-data profile, multi-instance setting, and runtime desktop-isolation assertions.
Tests must stay in the background: they must not display or focus app or browser windows, invoke
browser-native JavaScript dialogs (`window.alert`,
`window.confirm`, or `window.prompt`), open native folder dialogs or menus, launch external
applications, or contact non-loopback hosts. Use synthetic data and loopback fixtures for network
behavior. URL strings used as data in parser and formatting tests are inert; tests must not load
them in a browser or pass them to an OS open API. Hidden windows alone are not a cross-platform
guarantee that JavaScript dialogs stay hidden, so tests must not call those APIs or activate a
native select popup.

The compiled app loads `src/main/e2eIsolation.ts` before creating any windows when
`MULTIAGENT_E2E_USER_DATA_DIR` is set. Main, detached, and app-browser renderer windows use
Electron offscreen rendering and cannot show, focus, restore, or move to the top. That mode also
records external-open attempts without passing them to the OS, disables native folder dialogs and
Jira Mentions' native text menu, and blocks non-loopback requests from Electron sessions and
main-process `fetch`. Main-process session clients and browser fixtures can still use `localhost`,
`127.0.0.0/8`, and `::1`. Each existing Electron E2E suite checks that its windows are offscreen,
invisible, and unfocused through teardown with `e2e/helpers/assertDesktopIsolation.ts`.
Browser MCP clicks in this mode use DOM activation after the normal actionability probe, because
offscreen test windows cannot receive focus. Keep production browser clicks on Electron's mouse
input path; tests must not reveal a window to exercise it.

`test:db` runs its Electron-ABI migration fixture without creating a `BrowserWindow` and launches
Electron with `windowsHide: true`. The wrapped-link E2E verifies routing with the reserved
`external.test` hostname and confirms the attempted external open is recorded without launching a
browser or contacting that host.

E2E teardown must cancel its force-kill timer as soon as Electron exits. If forced termination is
needed, check that the launched process is still alive and invoke `taskkill` with `windowsHide` and
without a shell; a stale delayed `taskkill` can surface a command window or target a reused PID.
Test-created Electron windows must also use `show: false` and `webPreferences.offscreen: true`.
Renderer evidence should use the CDP capture in `e2e/helpers/screenshotUi.ts`, which captures
hidden windows without making them visible.

Any new Electron `webRequest.onBeforeRequest` listener must apply `shouldBlockE2EUrl` from
`src/main/e2eIsolation.ts`; Electron uses a single active listener per session event, so a later
observer can otherwise replace the E2E network guard. Route every OS-facing open through
`src/main/external.ts`, and guard any new dialog, native menu, or window API that can interrupt the
desktop. Tests should assert recorded intent or pure menu templates instead of activating native
UI or touching the user's clipboard.

`e2e/startup.spec.ts` launches the compiled app with a temporary user-data/home profile. It
covers cold layout restore, the real SQLite FTS index, shell `pty:ready` plus direct seq=0
output, sidebar tab reorder and drag-out, primary/detached and detached/detached
`tab:absorb` transfers, destination-ack rollback/no-duplicate behavior, terminal output after
ownership changes, detached-window cleanup, pane drag/drop isolation, and Claude deferred
spawning through an isolated fake agent command. The drag helpers dispatch the same typed
sidebar MIME payloads as the renderer and leave the existing pane MIME path separate. E2E-launched
primary, detached, and browser windows stay hidden and unfocused while Playwright controls their
renderers; `backgroundThrottling: false` keeps covered or hidden renderers painting for assertions.

`e2e/jira-mentions.spec.ts` starts an isolated loopback Jira REST fixture and launches the
compiled app with temporary user-data/home paths. It configures synthetic credentials through
the Jira Settings form, verifies discovery of an ADF mention, selects a requester with keyboard
navigation, and captures exactly one structured reply POST. It does not contact a live Jira site.
The Jira E2E specs pass an ephemeral per-run key for an AES-GCM test adapter so token save/reload
coverage does not depend on an interactive OS keychain. Main enables it only for an unpackaged
app whose active data path matches the isolated E2E profile; all other launches use Electron
`safeStorage`.

## Coverage ratchets

The global floor stays 0 while legacy Electron surfaces require integration tests; nonzero
scoped thresholds protect renderer utilities, shared helpers, and the extracted pure
main-process modules. Raise those floors when their measured baseline improves.
