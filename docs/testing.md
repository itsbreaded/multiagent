# Testing (mechanism)

The why/how behind the Vitest harness and the regression guards. The one-line guardrails live
in `CLAUDE.md`.

The app has a Vitest 4 test harness (added in spec 030). Tests are the regression net for the
invariants documented in `CLAUDE.md` — a future change that reintroduces a PATH rewrite, drops
a guard, or breaks the startup-resume flow should fail a test before it ships.

## Commands

```bash
npm test            # vitest run (both projects, no coverage)
npm run test:watch  # vitest watch
npm run test:coverage  # vitest run --coverage (text + html + lcov under coverage/)
npm run test:e2e    # build + Playwright Electron smoke tests (isolated temp profile)
npm run typecheck   # tsc -b --noEmit — also type-checks test files
```

## postinstall / native rebuild

`postinstall` runs `node_modules/electron/install.js` (downloads the Electron binary —
Electron 42+ no longer does this during `npm install`), then the `electron-rebuild` CLI from
`@electron/rebuild` to rebuild `better-sqlite3` for the Electron ABI. `node-pty` ships Windows
Electron-compatible prebuilds in this tree; if those are unavailable, a source rebuild requires
Visual Studio Build Tools. Do not add `--ignore-scripts`.

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

`e2e/startup.spec.ts` launches the compiled app with a temporary user-data/home profile. It
covers cold layout restore, the real SQLite FTS index, shell `pty:ready` plus direct seq=0
output, cross-window `tab:absorb`, and Claude deferred spawning through an isolated fake
agent command.

## Coverage ratchets

The global floor stays 0 while legacy Electron surfaces require integration tests; nonzero
scoped thresholds protect renderer utilities, shared helpers, and the extracted pure
main-process modules. Raise those floors when their measured baseline improves.