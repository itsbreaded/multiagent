# 023 — Dependency Version Upgrades (Node, Electron, build toolchain)

## Problem

Several core dependencies have drifted behind their latest releases, including the runtime
foundation (Electron) and the build toolchain (Vite, electron-vite, TypeScript). As this app is
now being shared with alpha testers, we want to be on current, supported versions to get security
fixes, Chromium/V8 improvements, and to avoid compounding upgrade debt. Some of these are simple
minor/patch bumps; others are **major** version jumps that touch the build pipeline and the native
module ABI, so they need deliberate sequencing and verification — not a blind `npm update`.

This spec is a planned upgrade pass, not a same-day task. Treat the major bumps as independently
landable steps so a tester-facing regression can be bisected to a single upgrade.

> **This spec is provisional until Phase 0 is complete.** The version table and breaking-change
> notes below are a point-in-time `npm outdated` snapshot plus model-training-data assumptions —
> both go stale and neither is authoritative. Latest versions, breaking changes, migration steps,
> Electron's bundled Chromium/Node/V8, and native-module prebuild availability **must be confirmed
> by live web search / official release notes** during Phase 0, not taken from this document or
> from model knowledge. Phase 0 ends by **rewriting this spec** into a verified, "real" upgrade
> plan. Do not begin Phases 1–5 against the numbers as currently written.

## Current state (PROVISIONAL — captured 2026-06-21 via `npm outdated`; re-verify in Phase 0)

| Package | Current | Latest | Jump | Notes |
|---|---|---|---|---|
| `electron` | 39.8.10 | 42.4.1 | **major ×3** | Bumps bundled Chromium + Node + V8; changes native ABI. Highest-risk item. |
| `vite` | 6.4.3 | 8.0.16 | **major ×2** | Build/dev server core. Config + plugin compatibility risk. |
| `electron-vite` | 3.1.0 | 5.0.0 | **major ×2** | Wraps Vite; must be compatible with the chosen Vite major. |
| `@vitejs/plugin-react` | 4.7.0 | 6.0.2 | **major ×2** | Must match Vite major. |
| `typescript` | 5.9.3 | 6.0.3 | **major** | TS 6 may surface new type errors; run `typecheck` after. |
| `@types/node` | 22.19.20 | 26.0.0 | **major ×4** | Should track the Node version Electron bundles, not the newest. |
| `@electron-toolkit/tsconfig` | 1.0.1 | 2.0.0 | **major** | tsconfig base; review emitted diffs. |
| `electron-builder` | 26.15.2 | 26.15.3 | patch | Safe. |
| `better-sqlite3` | 12.10.0 | 12.11.1 | minor | Native module — rebuild + verify after bump. |
| `@tailwindcss/vite` | 4.3.0 | 4.3.1 | patch | Safe. |
| `tailwindcss` | 4.3.0 | 4.3.1 | patch | Safe. |
| `node-pty` | 1.1.0 | 1.1.0 | — | Already current. Native module — re-verify after any Electron bump. |

Runtime Node (system, for building/rebuilding native modules): currently pinned to **24.11.1**
via `.nvmrc` and `engines` in `package.json`.

## Intended behavior

- Dependencies on current, mutually-compatible versions.
- Native modules (`node-pty`, `better-sqlite3`) rebuilt against the new Electron ABI and verified
  working (terminal I/O, session index/search).
- `.nvmrc` and `package.json` `engines` updated if the upgrade changes the recommended/bundled
  Node baseline, and the README prereqs kept in sync.
- `npm run typecheck`, `npm run build`, `npm run dev`, and `npm run dist` all pass.
- No regressions in the workflows most sensitive to the runtime: PTY output (no-scroll drop —
  specs 012/013), terminal rendering (WebGL/DOM backend selection — spec 019), agent launch/resume,
  session indexing/search, and the embedded browser MCP panel.

## Implementation phases

Phase 0 is investigation and must complete first. Land each subsequent phase as its own commit so
regressions bisect cleanly.

0. **Audit & research (mandatory, no code changes).** Establish the *real* upgrade landscape from
   authoritative live sources, because training data and the stale snapshot above cannot be trusted
   for versions or breaking changes.
   - Re-run `npm outdated` and `npm ls` to capture the true current tree, including transitive
     native-dependency versions.
   - For each package being bumped, web-search the **official release notes / migration guide** for
     every major crossed (e.g. Vite 7 *and* 8 notes when going 6→8) and record concrete breaking
     changes that touch this repo.
   - Confirm Electron's target version and the exact **Chromium / Node / V8 / module ABI** it
     bundles, from Electron's release docs — this drives `@types/node` major and the native rebuild.
   - Confirm `node-pty` and `better-sqlite3` ship **prebuilt binaries for the target Electron ABI**
     (or that source rebuild works on the toolchain testers have); note minimum toolchain.
   - Confirm electron-vite ↔ Vite ↔ `@vitejs/plugin-react` mutually-compatible major combination.
   - Produce a **revised version table** (verified target per package, or an explicit hold reason)
     and **rewrite this spec** (table, risks, phases) to match reality before any code change.
   - Output of this phase is the verified spec itself; treat the sections below as a draft to
     correct, not a contract to execute as-is.

1. **Safe minor/patch sweep.** Bump `electron-builder`, `tailwindcss`, `@tailwindcss/vite`,
   `better-sqlite3`. Rebuild native modules (`postinstall`/electron-rebuild), then `typecheck` +
   `dev` smoke test (open a shell pane, an agent pane, run a search).

2. **TypeScript 6 + type packages.** Bump `typescript` and `@electron-toolkit/tsconfig`. Hold
   `@types/node` to the major matching whatever Node version Electron bundles (decided in phase 4),
   not the newest. Fix any new `typecheck` errors. This is type-only — no runtime risk.

3. **Vite toolchain major (Vite + electron-vite + plugin-react together).** These three must move
   as a set to compatible majors. Verify `electron-vite.config.ts` still loads, HMR works in
   `dev`, and `build`/`dist` produce a working bundle. Check the shell-integration `.ps1` and MCP
   templates are still emitted/copied beside `out/main/index.js` (see CLAUDE.md packaging notes).

4. **Electron major (39 → 42).** Highest risk; do last and alone.
   - Read Electron 40/41/42 breaking-change notes; record the bundled Chromium/Node/V8 versions.
   - Rebuild `node-pty` and `better-sqlite3` against the new ABI (do **not** add `--ignore-scripts`).
   - Re-verify the PTY isolation path end-to-end: `ptyWorker` spawn under `ELECTRON_RUN_AS_NODE=1`,
     ConPTY traits in `pty:ready`, `windowsPty` + DA1 application timing, OSC 633 CWD parsing.
   - Re-verify terminal rendering backend selection and the WebGL-demotion latch (spec 019).
   - Update `.nvmrc` / `engines` / README if the recommended Node baseline shifts; align
     `@types/node` major to the bundled Node.

5. **Docs + housekeeping.** Update README prereqs and CLAUDE.md if any startup/build behavior or
   constraint changed. Run a final full `typecheck` + `build` + `dist`.

## Risks

- **Native module ABI (highest).** An Electron major changes the ABI; `node-pty`/`better-sqlite3`
  must be rebuilt or the app crashes on load. The PTY child-process isolation (Bun-binary Claude
  crash avoidance) must still hold — this is the project's most load-bearing native behavior.
- **No-flow-control PTY relay regression.** A Chromium/Electron bump could shift output timing.
  Specifically re-test short no-scroll output (`git pull` → `Already up to date.`) which previously
  exposed a timing race (spec 012/013). Do **not** "fix" any flicker by reintroducing flow control,
  ack/seq/pause, or a PATH rewrite — see CLAUDE.md root-cause notes.
- **Vite/electron-vite config breakage.** Major bumps can rename config options or change plugin
  APIs; the `.ps1`/MCP-template emit step is custom and easy to break silently.
- **TS 6 stricter checks** surfacing latent type errors across the renderer/main boundary in
  `src/shared/types.ts`.
- **WebGL backend** behavior changes with a new Chromium — re-validate `auto`/`on`/`off` and the
  software-renderer detection that prevents the CPU-spike trap (spec 019).
- **electron-builder packaging** (Developer Mode symlink path, `asarUnpack`, `build.files`) must
  still produce a runnable `dist\win-unpacked\`.

## Verification steps

For each phase, and a full pass at the end:

1. `npm install` completes and rebuilds native modules without error.
2. `npm run typecheck` — clean.
3. `npm run build` — clean.
4. `npm run dev` smoke test:
   - Open a shell pane; run `git pull` / short commands and confirm no dropped no-scroll output.
   - Open a Claude agent pane and a Codex agent pane; confirm launch, then close/reopen (resume).
   - Run a Summary and a Deep session search.
   - Toggle the browser panel and drive one MCP tool (e.g. `browser_navigate`).
   - Resize panes and split/swap to exercise the layout tree and renderer resize path.
5. `npm run dist` produces `dist\win-unpacked\`; launch the packaged build and repeat the smoke
   test (confirms `.ps1` + MCP templates are present in `resources/app.asar`).

## Handoff contract

**Non-negotiables**

- Phase 0 first: verify all versions and breaking changes against live official sources (not
  training data or this draft) and rewrite this spec before touching any dependency.
- One commit per phase; never bundle the Electron major with other majors.
- Never add `--ignore-scripts`; the native rebuild is required.
- Do not reintroduce any PATH rewrite for terminal panes, nor PTY flow control / ack / seq / pause /
  the removed `shellWorker` path, as a fix for any timing/flicker regression.
- Do not mutate user/project agent config files; MCP injection stays process-scoped.
- Keep `.nvmrc`, `engines`, README prereqs, and `@types/node` major mutually consistent with the
  Node version Electron actually bundles after the upgrade.

**Definition of done**

- Phase 0 completed and this spec rewritten into a verified, source-backed upgrade plan (the
  provisional banner removed) before execution.
- All packages at the agreed target versions (or an explicitly recorded reason to hold one back).
- `typecheck`, `build`, `dev`, and `dist` all pass.
- Packaged build launches and passes the full smoke test, including the no-scroll output and
  agent launch/resume checks.
- Any startup/build/constraint changes folded into CLAUDE.md; README prereqs current.
