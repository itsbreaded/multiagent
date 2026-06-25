# 023 - Dependency Version Upgrades (Node, Electron, build toolchain)

## Status

Phase 0 audit completed on 2026-06-25. Implementation completed on 2026-06-25 with separate commits
for the safe patch sweep, TypeScript toolchain, Vite toolchain, Electron runtime, and docs
housekeeping.

## Problem

Several core dependencies have drifted behind current supported releases, including Electron and the
build toolchain. This app is now shared with alpha testers, so the upgrade needs to reduce security
and platform drift without bundling unrelated major-version risk into one hard-to-bisect change.

The verified compatibility check changed the original plan materially: `vite@8.1.0` and
`@vitejs/plugin-react@6.0.3` are current, but `electron-vite@5.0.0` only declares Vite peer support
through Vite 7. Therefore this pass targets Vite 7, not Vite 8. A Vite 8 upgrade should wait for a
stable electron-vite release with Vite 8 peer support.

## Phase 0 Findings

Commands run locally:

- `npm outdated --long`
- `npm ls electron vite electron-vite @vitejs/plugin-react typescript @types/node @electron-toolkit/tsconfig electron-builder better-sqlite3 @tailwindcss/vite tailwindcss node-pty --depth=0`
- `npm view` for target versions, peer dependencies, engines, and native-module metadata
- `node-abi` lookup through the installed dependency tree for Electron ABI numbers
- Repository search for known migration-sensitive APIs/config keys

Official sources checked:

- Electron releases: https://releases.electronjs.org/
- Electron 40 release notes: https://www.electronjs.org/blog/electron-40-0
- Electron 41 release notes: https://www.electronjs.org/blog/electron-41-0
- Electron 42 release notes: https://www.electronjs.org/blog/electron-42-0
- Electron breaking changes: https://www.electronjs.org/docs/latest/breaking-changes
- Vite 7 announcement/migration links: https://vite.dev/blog/announcing-vite7
- Vite 8 announcement/migration links: https://vite.dev/blog/announcing-vite8 and https://vite.dev/guide/migration
- electron-vite 5 blog/migration guide: https://electron-vite.org/blog/ and https://electron-vite.org/guide/migration
- vite-plugin-react changelog: https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md

Relevant verified findings:

- `electron@42.5.0` is current stable as of 2026-06-25. Electron releases list it with Chromium
  `148.0.7778.271` and Node `24.17.0`; the Electron 42.0.0 blog documents the initial Electron 42
  stack as Chromium `148.0.7778.96`, V8 `14.8`, and Node `24.15.0`.
- Electron ABI changes from `140` for `electron@39.8.10` to `146` for `electron@42.5.0`, so native
  modules must be rebuilt and smoke-tested after the Electron bump.
- Electron 40 bumps Node from 22 to 24. Electron 42 still uses Node 24, so `.nvmrc` and
  `package.json` engines can stay on Node `24.x`; `@types/node` should move to the latest `24.x`,
  not `26.x`.
- Electron 42 changes binary acquisition: the `electron` npm package no longer downloads the binary
  from a `postinstall` script; it downloads on first `electron`/`npx electron` run, with
  `npx install-electron` available for explicit download. This does not permit this repo to use
  `--ignore-scripts`, because native module rebuilds still happen in this repo's own `postinstall`.
- Electron 42 breaking changes to watch: macOS notifications now use `UNNotification`, offscreen
  rendering defaults to `deviceScaleFactor: 1.0`, `Session.clearStorageData(options).quotas` is
  removed, `ELECTRON_SKIP_BINARY_DOWNLOAD` is removed, and `nativeImage.createFromNamedImage()`
  deprecates array-only `hslShift`.
- Repository search found no direct use of `Session.clearStorageData`, Electron `Notification`,
  `nativeImage.createFromNamedImage`, or `ELECTRON_SKIP_BINARY_DOWNLOAD`. Renderer clipboard usage
  is through browser `navigator.clipboard`; Electron `clipboard` usage is already in main IPC.
- Electron 40 deprecates direct Electron `clipboard` access from renderer processes. This repo's
  Electron clipboard calls are in `src/main/ipc/handlers.ts`; renderer code uses browser clipboard
  APIs or IPC, so no Electron API migration is required.
- `electron-vite@5.0.0` deprecates `externalizeDepsPlugin` in favor of `build.externalizeDeps`,
  enabled by default. This repo currently imports and uses `externalizeDepsPlugin` in
  `electron.vite.config.ts`, so the Vite toolchain phase must update config, not just versions.
- `electron-vite@5.0.0` removes function resolution for nested config fields. This repo's
  `main`, `preload`, and `renderer` config objects are static, so no migration is needed there.
- `electron-vite@5.0.0` declares peers `vite: ^5.0.0 || ^6.0.0 || ^7.0.0`; its current stable does
  not support Vite 8.
- `@vitejs/plugin-react@6.0.3` declares peer `vite: ^8.0.0`; it is not compatible with the
  electron-vite 5/Vite 7 target. Use latest compatible plugin-react 5.x instead.
- `@vitejs/plugin-react@5.2.0` declares peer support through Vite 8 and is compatible with Vite 7.
- Vite 7 requires Node `20.19+` or `22.12+` and drops Node 18. This repo's Node 24 baseline satisfies
  it. Vite 7 also changes the default `build.target` to Baseline Widely Available and removes
  deprecated features such as Sass legacy API support and `splitVendorChunkPlugin`; repository
  search did not find those removed APIs.
- Vite 8 moves to Rolldown/Oxc and has a compatibility layer, but official guidance recommends a
  gradual migration through `rolldown-vite` for complex projects. This repo should not attempt that
  until electron-vite stable peer support catches up.
- `better-sqlite3@12.11.1` still uses `prebuild-install` and supports Node `20.x` through `26.x`.
  This repo already forces `electron-rebuild -f -o better-sqlite3` in `postinstall`, so successful
  source rebuild against Electron ABI `146` is the verification gate.
- `node-pty@1.1.0` remains current and has no `binary` metadata in `npm view`; treat it as a source
  rebuild/ABI verification item even though this repo's `postinstall` currently names only
  `better-sqlite3`.
- `@electron/rebuild@4.0.4` requires Node `>=22.12.0`; the Node 24 baseline satisfies it.

## Verified Version Plan

| Package | Current | Target | Decision | Notes |
|---|---:|---:|---|---|
| `electron` | 39.8.10 | 42.5.0 | Upgrade, isolated phase | ABI `140` -> `146`; bundled Node 24, Chromium 148. |
| `vite` | 6.4.3 | 7.3.6 | Upgrade | Latest Vite 7; hold Vite 8 until electron-vite stable supports it. |
| `electron-vite` | 3.1.0 | 5.0.0 | Upgrade with config migration | Peer supports Vite 5/6/7; deprecates `externalizeDepsPlugin`. |
| `@vitejs/plugin-react` | 4.7.0 | 5.2.0 | Upgrade | Latest compatible line for Vite 7/electron-vite 5. Do not use 6.x yet. |
| `typescript` | 5.9.3 | 6.0.3 | Upgrade | Type-only risk; fix stricter errors in its own phase. |
| `@types/node` | 22.19.20 | 24.13.2 | Upgrade to Node 24 types | Tracks Electron's bundled Node major, not latest `26.x`. |
| `@electron-toolkit/tsconfig` | 1.0.1 | 2.0.0 | Upgrade | Review inherited tsconfig diffs/typecheck. |
| `electron-builder` | 26.15.2 | 26.15.3 | Patch | Low risk. |
| `better-sqlite3` | 12.10.0 | 12.11.1 | Minor | Native module; rebuild and verify session index/search. |
| `@tailwindcss/vite` | 4.3.0 | 4.3.1 | Patch | Low risk. |
| `tailwindcss` | 4.3.0 | 4.3.1 | Patch | Low risk. |
| `node-pty` | 1.1.0 | 1.1.0 | Hold/current | Rebuild/verify after Electron ABI change. |
| `vite@8` | n/a | hold | Explicit hold | Blocked by stable `electron-vite@5.0.0` peer range. |
| `@vitejs/plugin-react@6` | n/a | hold | Explicit hold | Requires Vite 8. |
| `@types/node@26` | n/a | hold | Explicit hold | Does not match Electron's Node 24 runtime. |

## Intended Behavior

- Dependencies move to current mutually-compatible versions, with documented holds where latest is
  incompatible.
- Native modules (`node-pty`, `better-sqlite3`) rebuild against Electron ABI `146` and are verified
  through terminal I/O and session index/search.
- `.nvmrc`, `package.json` `engines`, README prereqs, and `@types/node` remain aligned to Node 24.
- `npm run typecheck`, `npm run build`, `npm run dev`, and `npm run dist` pass.
- No regressions in PTY output, terminal rendering, agent launch/resume, session indexing/search,
  or the embedded browser MCP panel.

## Implementation Phases

Land each phase as its own commit so tester-facing regressions bisect cleanly.

1. **Safe minor/patch sweep.** Bump `electron-builder`, `tailwindcss`, `@tailwindcss/vite`, and
   `better-sqlite3`. Run `npm install` and allow postinstall rebuilds. Verify `typecheck`, `build`,
   and a short dev smoke test focused on session index/search for `better-sqlite3`.

2. **TypeScript and Node types.** Bump `typescript` to `6.0.3`, `@electron-toolkit/tsconfig` to
   `2.0.0`, and `@types/node` to latest `24.x` (`24.13.2` at audit time). Do not install
   `@types/node@26`. Fix any new `npm run typecheck` errors.

3. **Compatible Vite toolchain major.** Bump `vite` to `7.3.6`, `electron-vite` to `5.0.0`, and
   `@vitejs/plugin-react` to `5.2.0` together. Update `electron.vite.config.ts` to remove
   `externalizeDepsPlugin` imports/usages and rely on `build.externalizeDeps` defaults or explicit
   `build.externalizeDeps` config. Keep the custom `copy-shell-integration` asset emit and the
   `ptyWorker` entry output unchanged. Verify HMR, `build`, and `dist`, and confirm
   `shellIntegration.ps1` plus MCP templates are still packaged beside the compiled main process.

4. **Electron major, alone.** Bump `electron` to `42.5.0`. Run `npm install` without
   `--ignore-scripts`; if Electron's lazy binary download does not happen during install, run a
   normal Electron command or `npx install-electron` before dev/build verification. Rebuild native
   modules and verify ABI `146`. Re-test the PTY isolation path end-to-end:
   `ptyWorker` spawn under `ELECTRON_RUN_AS_NODE=1`, ConPTY traits in `pty:ready`, `windowsPty` plus
   DA1 application timing, OSC 633 CWD parsing, no-scroll short output (`git pull` ->
   `Already up to date.`), terminal rendering backend selection, and the WebGL-demotion latch.

5. **Docs and housekeeping.** Update README/CLAUDE only if the upgrade changes startup, packaging,
   postinstall, or developer prerequisite behavior. Keep Node 24 in `.nvmrc` and engines unless
   Electron's patch line changes to a different bundled Node major before implementation. Run final
   `typecheck`, `build`, `dev` smoke, and `dist` packaged smoke.

6. **Deferred Vite 8 follow-up.** Open a separate spec/task after stable electron-vite peer support
   includes Vite 8. That task should evaluate `electron-vite` Vite 8 support, `@vitejs/plugin-react`
   6.x, Rolldown/Oxc behavior, and any `rollupOptions` compatibility issues in this repo.

## Risks

- **Native module ABI.** Electron 42 changes this repo from Electron ABI `140` to `146`. A stale
  `node-pty` or `better-sqlite3` binary can crash at load time.
- **Electron lazy binary download.** Electron 42 no longer downloads its binary in Electron's own
  `postinstall`. CI/offline setup may need an explicit `npx install-electron`, while this repo must
  still allow its native rebuild `postinstall` to run.
- **PTY no-scroll regression.** Chromium/Electron timing changes could expose short-output races.
  Do not reintroduce PATH rewriting, PTY flow control, ack/seq/pause, or a deleted shell-worker path.
- **electron-vite config migration.** `externalizeDepsPlugin` is deprecated and currently used in
  `electron.vite.config.ts`. Removing it must not break custom asset emission or multi-entry output.
- **Vite 7 defaults.** Browser build target defaults changed to Baseline Widely Available. Verify
  renderer output and xterm behavior rather than assuming no effect.
- **TypeScript 6 strictness.** New type errors may appear around shared renderer/main contracts.
- **WebGL backend.** A Chromium bump can change GPU/software renderer behavior; re-validate
  `auto`/`on`/`off` and the software-renderer demotion latch from spec 019.
- **Packaging.** `electron-builder` plus `asarUnpack` must still produce a runnable
  `dist\win-unpacked\` with native modules, `.ps1`, and MCP templates present.

## Verification Steps

For each phase, and a full pass at the end:

1. `npm install` completes and rebuilds native modules without error.
2. `npm run typecheck` is clean.
3. `npm run build` is clean.
4. `npm run dev` smoke test:
   - Open a shell pane; run `git pull` and short commands and confirm no dropped no-scroll output.
   - Open a Claude agent pane and a Codex agent pane; confirm launch, close/reopen, and resume.
   - Run a Summary and a Deep session search.
   - Toggle the browser panel and drive one MCP tool, such as `browser_navigate`.
   - Resize panes and split/swap to exercise layout and renderer resize paths.
5. `npm run dist` produces `dist\win-unpacked\`; launch the packaged build and repeat the smoke
   test, confirming `.ps1` and MCP templates are included.

## Handoff Contract

Non-negotiables:

- One commit per phase; never bundle the Electron major with other majors.
- Do not install Vite 8 or plugin-react 6 in this pass unless electron-vite stable peer support has
  changed and this spec is re-audited.
- Never add `--ignore-scripts`; native rebuilds are required.
- Do not reintroduce PATH rewrites for terminal panes, PTY flow control, ack/seq/pause, or the
  removed shell-worker path.
- Do not mutate user/project agent config files; MCP injection stays process-scoped.
- Keep `.nvmrc`, `engines`, README prereqs, and `@types/node` major mutually consistent with the
  Node version Electron actually bundles.

Definition of done:

- All packages are at the agreed target versions, or a hold reason is recorded above.
- `typecheck`, `build`, `dev`, and `dist` pass.
- Packaged build launches and passes the full smoke test, including no-scroll PTY output and agent
  launch/resume checks.
- Any startup/build/constraint changes are folded into CLAUDE.md and README.
