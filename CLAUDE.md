# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Treat this as a living document. When features change, startup behavior changes, agent launch behavior changes, or you discover constraints that matter for future coding sessions, update this file with the durable lesson. Keep it concise and operational: document what future agents need to know to avoid repeating investigation or breaking user workflows.

## Planning Specs

Use `specs/pending/` for planned work that needs design before implementation. Name spec files with a three-digit global sequence and kebab-case title, e.g. `001-lazy-tab-hydration.md`. Before creating a new spec, check both `specs/pending/` and `specs/done/` and use the next unused number across both folders, preserving the number when moving the file to `specs/done/`. A pending spec should describe the problem, current behavior, intended behavior, implementation phases, risks, and verification steps. If the spec is intended as a handoff to another developer or agent, include a clear handoff contract with non-negotiables and a definition of done. Keep specs practical and delete or move them when they stop being useful; do not keep stale todos or historical investigation logs around.

Move completed specs to `specs/done/` only when they still provide durable context worth preserving. If the useful lesson is short, fold it into `CLAUDE.md` instead and delete the spec.

## Commands

```bash
npm run dev        # start dev server (Electron + Vite HMR)
npm run build      # compile only (no packaging)
npm run typecheck  # TypeScript type-check without emitting
npm run dist       # build + package to dist\win-unpacked\ (requires Windows Developer Mode)
```

`postinstall` runs `node_modules/electron/install.js` (downloads the Electron binary — Electron 42+ no longer does this during `npm install`), then the `electron-rebuild` CLI from `@electron/rebuild` to rebuild `better-sqlite3` for the Electron ABI. `node-pty` ships Windows Electron-compatible prebuilds in this tree; if those are unavailable, a source rebuild requires Visual Studio Build Tools. Do not add `--ignore-scripts`.

### Packaging Notes

- `npm run dist` runs `electron-vite build && electron-builder` with **no `--<os>` flag**, so it builds for the **host OS** (Windows → NSIS + dir, macOS → dmg + zip, Linux → AppImage + deb). `dist:dir`/`dist:nsis`/`dist:mac`/`dist:linux` build a specific OS explicitly; `release` is `electron-builder --publish always` for the host OS (used by CI). `npmRebuild: false` is kept because postinstall already handles the `better-sqlite3` (and node-pty on mac/linux) rebuild for the host ABI.
- **Native modules are not cross-compiled.** Each CI runner installs + rebuilds natively (postinstall `electron-rebuild`). Do not try to build mac/linux artifacts from Windows. `node-pty` ships Windows Electron prebuilds; on mac/linux it rebuilds from source (needs Xcode CLT / build-essential + `libudev-dev`).
- Windows output: `dist\MultiAgent Setup X.Y.Z.exe` (NSIS installer, primary Windows artifact) and `dist\win-unpacked\` (portable, kept for dev inspection). The NSIS installer does a per-user install to `%LOCALAPPDATA%\Programs\MultiAgent` — no admin rights needed.
- macOS output: `dist/MultiAgent-X.Y.Z-arm64.dmg` + `.zip`. **v1 ships unsigned** (developer audience): Gatekeeper blocks a double-click install, so developers run `xattr -cr /Applications/MultiAgent.app` (or right-click → Open) after dragging from the dmg. Notarization + signing are deferred until an Apple Developer ID exists; the flip-on is one config change — set `hardenedRuntime: true` + `"notarize": { "teamId": ... }` in the `mac` block and provide `CSC_LINK`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` as build env (never committed). `build/entitlements.mac.plist` (committed) is already referenced and is applied only once signing is on (allow-jit + disable-library-validation for the native modules).
- Linux output: `dist/MultiAgent-X.Y.Z.AppImage` + `.deb` (unsigned for v1).
- `build/icon.icns` (mac) is **generated from `build/icon.png`** by `npm run build:icon` (`scripts/build-icon.mjs`, `sips`+`iconutil`, macOS-only; no-ops elsewhere) — the CI mac runner runs it before `--mac`. electron-builder auto-detects `build/icon.icns` and falls back to the default Electron icon if absent, so `mac.icon` is intentionally not hard-set (a missing .icns must not fail a local build). `build/icon.png` (Linux) and `build/favicon.ico` (Windows) are committed.
- `asarUnpack` is set for `**/*.node`, `**/node-pty/**`, and `**/better-sqlite3/**` so native modules are accessible outside the asar archive.
- MCP templates under `src/main/mcp/templates/**/*` are included in packaged builds via `package.json` `build.files`. If templates move or new runtime templates are added, update the packaging list and verify they are present in `resources/app.asar`.

### Auto-Update (GitHub Releases)

The app uses `electron-updater` to check `github.com/itsbreaded/multiagent` releases. Updates are downloaded silently and shown as a slim banner below the titlebar.

**No token required.** The repo is public, so release metadata and assets are readable over plain HTTPS with no auth — `autoUpdater.setFeedURL` and `publishedInstallerExists` (`src/main/updateArtifact.ts`) do not send credentials. The updater is always enabled (`updater:is-enabled` always resolves `true`); there is no `GH_UPDATE_TOKEN` build-time flag anymore. Do not reintroduce a token requirement or `private: true` on the feed/publish config unless the repo goes private again.

**Publishing a release** (requires `gh auth login`):
1. Bump `version` in `package.json` (the release skill uses `npm version patch --no-git-tag-version` so `package-lock.json` stays in sync)
2. Run `publish.bat` — it delegates to `scripts/publish.mjs`, which creates + pushes the `v<version>` tag (no local build). The tag push triggers `.github/workflows/release.yml`, a 3-OS matrix (win/mac/linux) that builds + publishes each platform's artifacts to the same GitHub release in parallel using the auto `GITHUB_TOKEN`.

`npm run release` (`electron-builder --publish always`) is what CI runs per OS. The GitHub release and `latest.yml`/`*-mac.yml`/`*-linux.yml` metadata are created automatically. Do not hardcode any tokens in source files.

`patch-package` applies `patches/app-builder-lib+26.15.3.patch` after install. It fixes an upstream publisher-cache race that otherwise lets concurrent NSIS artifact callbacks create duplicate GitHub releases. Remove the patch only after upgrading to an `app-builder-lib` version that caches in-flight publisher creation.

**Update flow in the running app**: updater checks on startup (10s delay) and hourly. `updater:status` IPC events drive the `UpdateBanner` component in the renderer. The banner is suppressed in dev mode and in detached windows. **macOS auto-update caveat:** unsigned updates will not pass Gatekeeper either until notarization is enabled — a v1 limitation, not a bug.

## Testing

The app has a Vitest 4 test harness (added in spec 030). Tests are the regression net for the invariants documented in this file — a future change that reintroduces a PATH rewrite, drops a guard, or breaks the startup-resume flow should fail a test before it ships.

**Commands:**

```bash
npm test            # vitest run (both projects, no coverage)
npm run test:watch  # vitest watch
npm run test:coverage  # vitest run --coverage (text + html + lcov under coverage/)
npm run test:e2e    # build + Playwright Electron smoke tests (isolated temp profile)
npm run typecheck   # tsc -b --noEmit — also type-checks test files
```

**Layout.** `vitest.config.ts` defines two Vitest **projects** (the v4 replacement for the deprecated `workspace` API): `renderer` (happy-dom, React Testing Library) and `main` (node env). A single `npm test` runs both and emits aggregated coverage. Co-locate unit tests beside source (`foo.ts` → `foo.test.ts`); shared helpers live under `tests/`. Renderer tests are in `tsconfig.web.json`'s include; main/shared tests in `tsconfig.node.json`'s. Vitest uses esbuild and does **not** type-check — `npm run typecheck` covers that, so keep it green.

**Projects do not inherit root plugins/resolve by default** — the renderer project re-declares `@vitejs/plugin-react` and the `@renderer`/`@shared` aliases inside itself. Do not rely on `extends` for this; TSX transform and alias resolution will silently break.

**The PATH-rewrite guard (spec 012/013).** `src/main/pty/buildEnv.ts` is extracted pure so it can be tested; `buildEnv.test.ts` asserts `env.PATH === process.env.PATH` (the strong, non-vacuous equality form — a "does not contain npm/nodejs" check passes trivially when those dirs aren't on PATH) and that the inherited Claude renderer flags are scrubbed. These are the single highest-value regression guards in the repo. If you touch `buildEnv`, keep them passing.

**Extractions that exist purely to be testable.** `src/shared/paneTree.ts` (binary-tree ops, moved out of `panes.ts`) and `src/shared/cwdRepair.ts` (cwd-repair path mapping, moved out of `panes.ts`) are behavior-preserving extractions; their tests characterize the layout-tree invariants and the segment-boundary path rewrite. Prefer extracting pure logic into a sibling/`shared` module over `vi.mock` hacks for modules that import Electron/native deps at load time.

**Don't mock the Zustand store.** Render components against the real store. State reset between tests is handled by the auto-reset mock at repo-root `__mocks__/zustand.ts`, activated by `vi.mock('zustand')` in `tests/setup.renderer.ts` (Vitest does not auto-apply node-module `__mocks__` like Jest — the explicit `vi.mock` call is mandatory). That mock does automatic *state reset* only; it does not stub store *behavior*.

**Determinism.** Tests touching recency, time-grace windows, uuids, or file mtimes must control those inputs (`vi.setSystemTime`, pinned timestamps via `fs.utimesSync`, structural assertions that ignore ids). `process.platform` is machine-dependent — pin it in tests that branch on `win32` and cover both branches; CI runs the 3-OS matrix (`windows-latest`, `macos-latest`, `ubuntu-latest`).

**Boy-scout rule.** Any file a PR touches should gain or extend a test, and new features ship with tests. This is the durable mechanism that grows coverage without a dedicated sprint — do not chase a percentage. The global threshold remains 0 for legacy integration-only surfaces; raise the nonzero scoped ratchets in `vitest.config.ts` as their measured baselines improve.

**Electron E2E.** `e2e/startup.spec.ts` launches the compiled app with a temporary user-data/home profile. It covers cold layout restore, the real SQLite FTS index, shell `pty:ready` plus direct seq=0 output, cross-window `tab:absorb`, and Claude deferred spawning through an isolated fake agent command.

**Coverage ratchets.** The global floor stays 0 while legacy Electron surfaces require integration tests; nonzero scoped thresholds protect renderer utilities, shared helpers, and the extracted pure main-process modules. Raise those floors when their measured baseline improves.

## Architecture

Three Electron processes:

1. **Main process** (`src/main/`) - IPC, PTY management, session indexing, browser panel
2. **Preload** (`src/preload/index.ts`) - typed `window.ipc` bridge (`invoke`/`on`/`send`)
3. **Renderer** (`src/renderer/`) - React + Zustand, xterm.js terminals, all UI

All IPC channel names and their signatures are the single source of truth in `src/shared/types.ts`.

### PTY Isolation

`node-pty` runs in a child process (`src/main/pty/ptyWorker.ts`) spawned with `ELECTRON_RUN_AS_NODE=1`. This prevents Chromium's IPC handles from being inherited into ConPTY, which would crash Claude (a Bun binary). `PtyManager` communicates with the worker over Node IPC (`process.send`/`process.on('message')`).

The terminal stack follows VS Code's integrated-terminal shape, and **shell and agent panes share one pty host and one worker** (`PtyManager` + `ptyWorker.ts`). `PtyManager` is the single pty-host contract for create/input/resize/kill/data/exit/ready/error. The worker's ready event carries pid, initial cwd, and Windows ConPTY traits. The renderer must apply xterm `windowsPty` and the DA1 `\x1b[?61;4c` response only after `pty:ready`, not at xterm construction time. Shell vs agent differ by launch command, cwd fallback policy, and agent-specific env supplied by `SessionSpawner`, not by a generic Claude-tuned PTY environment.

**Both shell and agent panes relay PTY output directly** (`sendDirectPtyOutput`, `seq=0`, synchronous `terminal.write` in the renderer). There is no coalesce/ack/pause flow control (see the no-flow-control note below). The only buffering left is `pendingDirectOutput` in `handlers.ts`, used solely to hold output while a pty briefly has no routable window (e.g. mid cross-window move); it flushes via `flushDirectOutput` on (re)route.

**No PATH rewrite for terminal panes (specs 012/013).** `buildEnv` used to prepend `%APPDATA%\npm`, `%ProgramFiles%\nodejs`, and `~/.local/bin` to PATH — dirs already on the inherited PATH, so the prepend only *reordered* it, shifting `git`'s startup timing into ConPTY's no-scroll flush race and dropping short output like `git pull -> Already up to date.`. The dropped-output root cause was this PATH rewrite, not the pty worker or output volume. Shells and agents share one worker fine once the rewrite is gone (the deleted `ShellPtyHost`/`shellWorker` were unnecessary). **Do not reintroduce any PATH rewrite for terminal panes.**

On Windows, shell panes spawn `powershell.exe` with `src/main/pty/shellIntegration.ps1` (via `terminalEnvironment.ts`/`_shellCmd`), emitted beside `out/main/index.js` by `electron.vite.config.ts`. The script uses VS Code-style OSC 633 (`OSC 633;P;Cwd=...`) for CWD reporting; main parses it in `handlers.ts` and sends `pty:cwd`. OSC 7 parsing remains only as compatibility fallback. Do not reintroduce ad hoc prompt wrapping or the removed `shellterm:*`/Bare Term scaffolding as a production terminal path. **asar caveat:** the `.ps1` lives inside `app.asar` when packaged and PowerShell (a separate process) cannot read it, so `shellIntegrationCommand` sources a copy materialized to `<userData>` by `ensureShellIntegrationScript('shellIntegration.ps1')` (idempotent on content), falling back to the bundled candidates in dev. Do not revert to sourcing the raw asar path — packaged Windows CWD tracking silently breaks.

On Unix, shell panes launch via `unixShellLaunch` (`terminalEnvironment.ts`): bash with `--init-file`, zsh with a generated `ZDOTDIR` (zsh has no `--init-file`; a tiny `.zshrc` there re-sources `~/.zshrc` then our script). `src/main/pty/shellIntegration.sh` (bash + zsh in one file) installs a `PROMPT_COMMAND`/`precmd` hook that emits `OSC 633;D` + `OSC 633;P;Cwd=<byte-escaped>` + `OSC 7;file://<path>` before each prompt. The same **asar caveat** applies: `ensureShellIntegrationScript('shellIntegration.sh')` copies the bundled script to a real file under `<userData>` and the shell sources that (the same pattern the managed-hook scripts use). macOS' default shell is zsh, so bash-only is not enough. `_shellCmd()` returns `{ cmd, env? }` (the ZDOTDIR rides as `createDeferred`'s `extraEnv`).

**Cross-platform process snapshot (CLI-agent promotion/demotion).** `snapshotProcesses()` (`src/main/pty/processSnapshot.ts`) is the single platform seam feeding the pure `selectForegroundAgent` selector. Windows shells out to `Get-CimInstance Win32_Process`; macOS shells out to `ps -Ax -o pid=,ppid=,comm=,command=`; Linux reads `/proc/<pid>/{stat,cmdline}` directly (null-delimited argv). All three export pure parsers (`toEntries`/`parsePsDarwin`/`parseProcStat`/`parseProcCmdline`) for platform-pinned unit tests. Every platform fails closed (any error → `[]` → no pane transition). Do not add a per-platform scanner "fallback" for the missing platform — keep one mechanism per platform behind the seam.

Renderer resize uses the VS Code principle: immediate resize for first/small-buffer changes, vertical updates immediately once established, and horizontal reflow debounced with a deterministic flush. Avoid raw `ResizeObserver -> pty.resize` loops.

Agent PTYs must spawn at the fitted pane size, not at 80x24 followed by a corrective resize. Claude's classic renderer leaks a redraw into scrollback on every resize, so an avoidable startup resize causes duplicated banners/logos. `SessionSpawner.spawnNew` and `spawnResume` pass `deferSpawn: true`; `PtyManager.createDeferred` then waits for the renderer's first `pty:resize` (with a short timeout fallback) before sending the worker `spawn` message. Keep this non-interactive one-shot size handshake for agent launches.

`createShell` uses `_shellCmd()` for the interactive prompt/CWD wrapper. Agent panes must not start an interactive shell and then wait for a prompt before typing `codex`/`claude`; `SessionSpawner` launches the agent command immediately through a non-profile shell command. Keep this direct launch path so restored Codex panes do not pay the old 10s prompt-detection fallback.

Claude panes should launch like a normal terminal command. Do not set `CLAUDECODE`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_DISABLE_MOUSE`, `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL`, or `CLAUDE_CODE_NO_FLICKER` in the generic PTY env or default Claude launch env; `buildEnv()` also scrubs inherited copies of those flags from the app process environment. Those nonstandard flags caused app-created Claude sessions to lose input after `/tui fullscreen`, while launching Claude manually from a shell pane worked. The only default Claude-specific terminal env is `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`; provider/model/auth overrides belong in `SessionSpawner.agentEnv('claude')`. Let the user's Claude `tui` setting and `/tui` command control classic vs fullscreen rendering unless a future setting deliberately maps to process-scoped env.

Agent panes must not fall back to `os.homedir()` when their saved cwd is missing. `SessionSpawner` validates agent cwd before launch and `PtyManager.createDeferred` only allows cwd fallback for shell panes. Missing-cwd agent resumes should reject and leave a visible `resumeError`/recovery placeholder so the directory can be repaired rather than silently spawning in the wrong project.

Codex panes pass `--no-alt-screen`, `-c tui.animations=false`, and `-c tui.terminal_title=[]` to reduce cursor redraw/flicker in xterm panes. `tui.terminal_title=[]` suppresses OSC title sequences that serve no purpose in an embedded pane. Keep these flags unless verified against current Codex behavior.

PTY output has **no flow control**. Main relays each `node-pty` data chunk straight to the renderer as a `pty:data` payload with `seq=0`; the renderer writes it to xterm synchronously (`terminal.write(data)`). There is no coalescing, no `pty:data-ack`, no `pause`/`resume`, and no byte watermarks — those were removed because they were unnecessary (node-pty + xterm absorb the volume; heavy interactive PowerShell sessions run fine without them). The `pty:data` channel still carries `seq`/`byteLength` args for shape compatibility, but the renderer ignores them. Terminal resize is one-way `window.ipc.send('pty:resize', ...)`, not `invoke`. If you ever need backpressure for a pathological flood, add it as opt-in for agents only (the no-scroll drop was caused by the PATH rewrite, not by output volume — see the root-cause note above and spec 013).

### Pane Layout Model

The layout is a binary tree of `PaneNode = PaneLeaf | PaneSplit` (same model as tmux). Each `Tab` has a `rootNode` and a `focusedPaneId`. `PaneLeaf` holds `paneType` (`'shell'|'agent'`), optional `agentKind` (`'claude'|'codex'`), `cwd`, optional `ptyId`, optional `sessionId`, and optional `customName` (user-set label prefix).

Display labels: `src/renderer/src/utils/tabLabels.ts` is the single source for label computation. `paneLabelText(pane, sessions)` returns `"customName - directory"` or just the directory. `computeLabels(tabs, sessions)` returns a `Map<tabId, string>` for the tab bar.

Layouts are auto-restored on startup without prompting. `App.tsx` guards restore with a ref so React StrictMode cannot start duplicate restores, and layout saving is disabled until `layoutReady` to avoid overwriting a saved layout with an empty initial state. Saved layout includes `activeTabId`, `sidebarSectionOpen`, and `sidebarPanelSizes`; `layout:save` and `applyLayout` normalize every saved tab to `detached: false` because detached BrowserWindows are not recreated on cold start. `applyLayout` validates focused pane IDs, restores tab/pane metadata and sidebar section expansion state, clears stale detached-window ownership maps, and hydrates only the restored active tab. Inactive restored tabs stay visible in the tab bar/sidebar from metadata but their pane trees, shell PTYs, xterms, and agent resumes are deferred until first focus. Once a tab has hydrated, keep it mounted while inactive so scrollback and live PTY/session state survive tab switches. Startup resume should feel exactly like "where we left off"; do not collapse, expand, or focus UI sections implicitly unless that state was not present in an older saved layout. Any new resizable/collapsible sidebar panel must use a stable panel id and persist its size through `sidebarPanelSizes`.

Terminal scrollback defaults to `250_000` lines because panes host long-running Codex/Claude chats and users need access to full visible history. Users can adjust this in Settings → Terminal; the value is persisted in `useSettingsStore.terminalScrollbackLines` and applied to both new and existing xterm instances through `xtermRegistry.setScrollbackLines()`. Lowering the value can trim existing scrollback, so do not silently lower the default as a performance fix.

**Terminal renderer selection** lives in `src/renderer/src/terminal/rendering/`. The `resolveBackend(pref, caps)` function is the single decision point: `auto` picks WebGL only when `caps.webgl && !caps.softwareRendering`, `off` is always DOM, `on` is WebGL when available. Software-rendered WebGL (SwiftShader / WARP / llvmpipe) was the documented CPU-spike trap (50–60% on a keypress) and is now auto-detected by probing `UNMASKED_RENDERER_WEBGL` on a throwaway canvas — the `auto` setting avoids it. The master `optimizedTerminalRenderer` flag reverts to the legacy unconditional-WebGL try/catch path when false. Do not add flow control or ack/seq/pause to the renderer pipeline (see no-flow-control note). The per-renderer-process `webglDemoted` latch in `backends.ts` prevents context-loss/reattach thrash: once a WebGL context is lost in a renderer process, all subsequent panes in that process use DOM.

### Renderer State

Two Zustand stores:

- `usePanesStore` (`src/renderer/src/store/panes.ts`) - pane tree, tab list, focus, zoom, CWD updates via `setPaneCwd`
- `useSessionsStore` (`src/renderer/src/store/sessions.ts`) - session list synced from main via `sessions:updated`

IPC listeners are wired at module level after store creation (not inside components) to avoid multiple registrations.

### Multi-Window State Invariants

The primary window owns the sidebar and shows local plus detached tabs. Detached windows have content and a tab bar, but no sidebar. Multi-window tab and pane movement should preserve a single coherent ownership model across main, source renderer, target renderer, and PTY routing.

User-level focus transitions must be atomic. Do not compose primitive actions such as `setActiveTab()` followed by `focusPane()` when the UI expects one focus change; use tab-aware transition actions such as `focusPaneInTab(tabId, paneId)`. Primitive setters should stay side-effect-light, and named transition actions should own any paired state update plus IPC broadcast.

PTY routing must not move ahead of renderer ownership. For cross-window pane or tab movement, the destination should commit and ack before main reroutes PTYs, and the source should not delete its last good copy until the transfer is committed or rollback is possible. This is especially important for `tab:absorb`: a release timeout after the source has already removed the tab can lose the tab from all windows and orphan its PTYs.

A cross-window transfer ack must reflect that the destination *actually applied* the change, not merely that it received the message. Destination store actions used by transfers (`addPaneToTab`, `insertPaneAtSplit`, `replacePaneById`) return a success boolean, and their renderer listeners send the `*-applied` ack only when that boolean is true. A no-op apply (self-drop, or a target tab/pane that vanished mid-drag) must stay silent so main times out and discards/rolls back instead of removing the source pane — otherwise the source is deleted after a no-op insert and the pane is lost (spec 024). Guard self-drops (`sourcePaneId === targetPaneId`) at the drop site, at the IPC handler, and in the store action; the local-only path's `movePaneToSplit` guard does not cover the cross-window IPC path.

Detached sync and focus messages should be versioned or generation-checked. Stale `tab:state-sync` or focus acks must not reclaim moved tabs or focus a window that no longer owns the tab.

### UI Consistency

Keep overlay surfaces visually aligned. Settings, Session Browser, and Command Palette should share the same application modal language: centered dark overlay, `#1a1b1e` panel, `#2a2b2e` borders, 10px radius, `0 24px 64px rgba(0,0,0,0.6)` shadow, muted section labels, and green `#4ade80` active accents. Do not introduce VS Code-specific colors or layout treatments in one overlay unless the rest of the app is intentionally updated to match.

Buttons should use image icons from `src/renderer/src/assets/` instead of visible text characters or emojis. If a needed button icon is missing, ask the user to provide a new `.png` asset before implementing the button.

Renderer styling should start from `src/renderer/src/styles/theme.ts` for palette, borders, shadows, z-indexes, and reusable sidebar/menu/control style fragments. Add new shared tokens there when a value is meant to become a convention; avoid copying raw hex values or ad hoc menu/sidebar styles into new components.

When one UI has multiple presentation modes, keep the shared pieces structurally shared. For example, tab overflow modes may change only the container behavior (scroll vs wrap); tab cards, add-tab controls, row metrics, padding, and interaction semantics should come from the same constants/components. Before fixing a mode-specific visual or hit-test bug, compare both render paths and remove duplicated branches that let sizing, placement, or behavior drift. In Electron chrome, default top chrome regions to draggable and explicitly exempt real controls; avoid native `no-drag` rectangles on horizontally scrolled children because Chromium/Electron hit regions can leak when scrolled.

All non-terminal scrollable renderer surfaces should use the shared `dark-scrollbar` class from `src/renderer/src/assets/main.css`. Terminal scrollbars are styled separately through `.xterm .xterm-viewport`. When adding a reusable component that owns an internal scroll container, expose a className hook instead of forcing callers to accept an unstyled native scrollbar.

### Command Registry

The command palette reads from a declarative registry at `src/renderer/src/commands/registry.ts`. Commands are **not** auto-discovered — every palette-reachable action must be explicitly added there. Key rules:

- **New settings sections**: adding a section to `SettingsPanel` requires a corresponding `settings.open.<section>` entry in the registry.
- **New store actions**: any new pane/tab/view/window action that should be keyboard-reachable needs a new `Command` entry.
- **New context data**: if a command needs a store getter or action not yet in `CommandContext`, extend that interface and wire it in `CommandPalette/index.tsx`.
- `shortcut` functions call `buildHotkeys(hotkeyOverrides)` at render time so shortcut chips always reflect the user's current bindings.
- `enabled` functions are evaluated on every render so context-sensitive hiding (no focused pane, single tab, detached window, VS Code not installed, etc.) is live.
- Sessions do not appear in the command palette; session discovery goes through the Session Browser (`Ctrl+Shift+O`) and the sidebar Recent section.
- The palette uses `window.prompt()` for inline rename inputs (Rename Pane). This is an Electron native dialog — acceptable for v1, replace with a custom overlay if it becomes a UX pain point.

### Session Indexing

`SessionIndex` wraps better-sqlite3 with FTS5 for full-text search over session transcripts. `TranscriptScanner` reads `~/.claude/projects/**/*.jsonl` and `CodexSessionScanner` reads `~/.codex/sessions/**/*.jsonl`; both extract metadata into the same index. Sessions are polled every 5 seconds and pushed to the renderer on change. Closing an agent pane with a known `sessionId` also triggers an immediate `sessions:refresh` scan so the session can move from the live pane list to Recent without waiting for the next poll.

`SessionIndex.search(query)` is summary-only FTS5 over `projectName`, `displayName`, `firstMessage`, and `lastMessage`. It is **not** a full transcript search.

`DeepSearcher` (`src/main/sessions/DeepSearcher.ts`) implements full transcript search via a pure Node.js streamer (no PATH-provided `rg`). It walks both Claude and Codex JSONL roots, reads each file line-by-line, matches each line against the query, parses matching lines to extract human-readable text (not raw JSON), groups results by `agentKind:sessionId`, hydrates from `SessionIndex` (scans and upserts unindexed files on demand), ranks by role quality + recency + match count, and caps at 50 sessions / 5 matches per session. The IPC channel is `sessions:search-deep` (invoke, receives a `SessionSearchRequest`, returns `SessionSearchResult[]`). Default mode is literal (not regex); `caseSensitive` and `regex` flags are opt-in per request.

Session Browser UI has two modes: **Summary** (instant in-memory filter over loaded metadata) and **Deep** (300ms debounced call to `sessions:search-deep`). Deep mode shows match snippets inline under each session row with role badges (user/assistant/tool) and timestamps. Stale results are discarded via a generation counter — a new query increments the counter and any response from an older generation is dropped.

Session cwd corrections are app-owned metadata first. `SessionIndex` keeps per-session cwd overrides in SQLite and applies them during scanner upserts so a repaired directory is not undone by the 5s transcript rescan. Session rows include `cwdExists`; UI should mark missing directories as severed/recoverable. Missing cwd repair is project-level: all sessions from the old cwd move together. Claude Code is directory-scoped, so repairing a Claude cwd copy/merges the old `~/.claude/projects/<encoded-old-cwd>/` transcript directory into the new encoded cwd directory and updates indexed file paths. Do not rewrite whole transcript JSONL files for normal repair; Codex does not need transcript copying for cwd changes.

Directory repair also rewrites app-owned layout state. `sessions:repair-cwd` applies a prefix-aware, segment-boundary mapping to `layout.json` (`PaneLeaf.cwd`, `PaneLeaf.sessionDetectionCwd`, and `Tab.defaultCwd`), writes a timestamped `layout.json.bak.*`, atomically replaces the layout file, and broadcasts `layout:cwd-repaired` so live primary/detached renderer stores apply the same mapping before the next layout save.

### Session Detection

`SessionSpawner` assigns a session id at launch for Claude only: new Claude panes generate a UUID and launch `claude --session-id <uuid>`, so the renderer receives the session id immediately. App-launched Codex is linked by the managed `SessionStart` hook (spec 047 phase 4; see "Agent MCP Injection" and "CLI-launched agent detection" below) — the user accepts the managed hook once via `codex /hooks` and the persisted trust covers every future launch; there is **no** launch-time codex id and **no** cwd/time file-poll scanner (deleted in phase 4). `codex resume` forks are handled because each `SessionStart` re-reports via the hook.

Key constraints:

- Do not reintroduce Claude filesystem matching for new panes; preserve the launch-time `--session-id` path unless Claude removes that flag. (Filesystem matching for CLI-launched agents was also removed in phase 4 — hooks cover it.)
- Do not reintroduce the Codex cwd/baseline/time file-poll scanner (`codexDetection.ts`) or the `SessionSpawner` Codex pending-detection machinery. The managed hook is the sole session-id source for Codex; do not add a scanner "fallback" — that re-introduces the ambiguity/first-message-gate problems hooks remove. One mechanism.
- App-launched Codex does **not** bypass hook trust — it relies on the same one-time `codex /hooks` trust as CLI-launched Codex (the persisted `[hooks.state]` trust covers both). Do not add `--dangerously-bypass-hook-trust` to the launch command; do not try to bypass trust programmatically (herdr doesn't either).
- Startup should default to resume. Do not reintroduce a restore prompt unless explicitly requested.
- New agent panes persist `sessionDetectionState`, `sessionDetectionStartedAt`, and `sessionDetectionCwd` while detection is pending. On startup, panes with a pending marker and no `sessionId` may recover only from an exact single cwd/time transcript match; otherwise they remain visible as agent recovery placeholders. Legacy agent panes with no `sessionId` and no pending marker are still converted back to shell panes.
- `hydrateTabRuntime` calls `sessions:validate(agentKind, sessionId, cwd)` before `session:resume`. If the transcript is missing, the pane gets `resumeError` and no CLI process is spawned. This prevents repeated doomed-spawn loops on startup when a session was deleted or moved.
- On primary window close, main intercepts the `close` event once (via `isShutdownSaveComplete` flag), sends `layout:request-state` to the primary renderer and `layout:collect-detached-state` to each detached window (up to 1000ms timeout each), merges the fresh detached snapshots into the primary's tab list, and writes a final `layout.json`. This ensures detached-window changes made immediately before shutdown are preserved despite the 300ms sync debounce. New IPC channels: `layout:request-state`, `layout:collect-detached-state` (EventChannels); `layout:state-response`, `layout:detached-state-response` (SendChannels).

### CLI-launched agent detection (spec 047)

When a user types `claude` or `codex` inside a **shell** pane (instead of spawning an agent pane through the UI), the running CLI is detected and the shell pane is **promoted** to an agent pane so it behaves like one for session linkage and resume. When the agent exits, the pane **demotes** back to a shell (scrollback and the still-running shell prompt intact).

- `AgentProcessSweeper` (`src/main/pty/agentProcessSweeper.ts`) is one app-global poller constructed in `registerIpcHandlers`. It tracks **only shell panes** — `trackShell` is called from the `pty:create` handler; `SessionSpawner` agent panes are never tracked. It subscribes to `PtyManager`'s `ready` (records the shell pid) and `exit` (untracks).
- Each tick (only while ≥1 shell pane is tracked) snapshots the process table once via `snapshotProcesses()` (`src/main/pty/processSnapshot.ts`, a `Get-CimInstance Win32_Process` shell-out — Windows-only, fails closed to an empty snapshot on any error; the pure `selectForegroundAgent` selector in `src/main/pty/agentProcessDetect.ts` is platform-agnostic and is the seam a future Linux/macOS `/proc` or `ps` implementation slots in behind). It identifies a foreground `claude`/`codex` (direct name, `node`/`cmd`/`powershell` wrapper + npm package paths, ignoring `-e`/`-c` eval payloads) with herdr-style disambiguation (zero / multiple distinct agents / sibling chains → stay shell).
- Two consecutive identical observations are required before emitting `pane:agent-detected(ptyId, AgentKind | null)` (worst-case ≤ ~6 s), so a transient `claude --version` does not flap the pane kind. Delivery is cross-window via `windowManager.sendToWindowForPty`.
- The renderer's `pane:agent-detected` listener (`panesIpc.ts`) calls `promoteShellPaneToAgent` / `demoteAgentPaneToShell` — **pure metadata, atomic and tab-scoped** (no `ptyId` change, no pty kill, no xterm clear). Only panes carrying the in-memory `promotedFromShell` flag demote; native (app-spawned) agent panes never demote. `promotedFromShell` is **never serialized** — `normalizeTabsForLayout` (`src/main/ipc/layoutStore.ts`) strips it and reverts a phase-1-only promotion (agent, no `sessionId`) to `shell`, so a promotion with no linked session does not survive restart. A promotion with a linked `sessionId` persists as an agent pane and resumes on restart (intended behavior change: a shell pane that hosted a CLI agent resumes as that agent after restart).
- Session-id **linking is hook-based (spec 047 phase 4)**. ALL session-id capture flows through the managed `SessionStart` hooks (see "Agent MCP Injection" below), with one exception: **app-launched Claude keeps `--session-id <GUID>`** (the id is known at spawn). The hook fires at session start and POSTs `{ ptyId, agentKind, sessionId, transcriptPath }` to the localhost `AgentSessionReportServer`; main emits the existing `session:detected(ptyId, agentKind, sessionId)`, whose listener promotes a still-shell pane if the report raced ahead of the sweeper, then attaches the `sessionId`. There is **no file-poll fallback** — `PromotedSessionLinker`, `codexDetection.ts`, `claudeCliLink.ts`, and the `SessionSpawner` Codex pending-detection machinery (`notePtyWrite`, `registerPromotedCodex`, the 1 s poll) were deleted. The hook is the sole source of the session id.
- **App-launched Codex** links via the hook, same as CLI-launched: the user accepts the managed hook once via `codex /hooks`, and the persisted trust (`[hooks.state]` in `~/.codex/config.toml`) covers every future app/CLI Codex launch. We deliberately do **not** pass `--dangerously-bypass-hook-trust` — uniform trust UX, no scary flag. **App-launched Claude** additionally sets `MULTIAGENT_SESSION_ID=<guid>` via `agentEnv` so the global Claude hook bails early instead of re-reporting the same id (`buildEnv` scrubs it).
- **CLI-launched Codex** promotes (phase 1 sweeper) but links only after the user trusts the hook once via `codex /hooks` (we cannot add the flag to a user-typed command; herdr accepts this one-time trust too). Until then it stays unlinked — fail closed. **CLI-launched Claude** promotes and links at start (Claude has no trust gate).
- **Codex links on its first user message, not at cold launch.** The Codex interactive TUI defers `SessionStart` (`source: "startup"`) until the first message creates the rollout — that is the earliest moment a `session_id` exists, so "right away" is impossible for Codex by any mechanism. The hook fires then and links (verified: `POST ok` + `session:detected`). Claude links at launch. Do not treat first-message Codex linking as a regression; it matches the old scanner's first-message gate and Codex's own rollout lifecycle.
- **Codex hook matcher must be OMITTED, not `""`.** `injectManagedHook(cfg, cmd, null)` for Codex omits the `matcher` key (mirrors herdr's `install_codex`); Claude uses `''` (empty matcher = match-all, verified firing). An empty-string matcher matches **nothing** in Codex — the hook shows as Trusted in `codex /hooks` but never fires. This is the single load-bearing difference between the two agents' hook installs.
- The Claude filesystem matching that earlier phases did is **gone**; the non-negotiable "preserve the launch-time `--session-id` path" still holds for panes **we spawn** (`SessionSpawner.spawnNew` still passes `--session-id`, untouched).
- A linked pane that the user resumes *inside* the pane (`claude --resume <other>`, `codex resume`) re-reports via each `SessionStart`, so the id follows the fork correctly (this is why hooks replaced the one-shot file match).

### Agent MCP Injection

The app must not mutate user or project agent config files. Do not write to `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`, or similar files as part of startup. MCP injection is process-scoped only.

**Scoped exception (spec 047 phase 3 / phase 4):** the **"Session linking (managed hooks)"** toggle in Settings → Terminal (default-ON under phase 4 — app-launched Codex can only link via the managed hook) installs **managed, idempotent, versioned `SessionStart` hooks into BOTH `~/.claude/settings.json` (Claude — the user-scope file Claude reads hooks from, NOT `~/.claude.json`) and `~/.codex/hooks.json` (Codex)**, plus the `[features] hooks = true` flag in `~/.codex/config.toml` (`src/main/integration/codexConfigFeatures.ts`, pure line-based TOML surgery — Codex runs no hook until that flag is on). The toggle is an opt-OUT: turning it off removes both hooks (the `[features]` flag is intentionally left, matching herdr; harmless once the hook entry is gone). Both installs are marked-block (sentinel `multiagent-agent-state` — the script basename **without** extension, so it matches both the Windows `.ps1` and the Unix `.sh` command strings; unambiguous because the two live in separate files), preserve all unrelated settings keys/hooks, write a timestamped `.bak` on every change, atomically replace, and are cleanly uninstallable from the same toggle; on install/uninstall it also removes any stray managed hook a prior version left in `~/.claude.json`. The hook script is **platform-split**: `src/main/integration/assets/multiagent-agent-state.ps1` (Windows, run via `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`) and `…/multiagent-agent-state.sh` (Linux/macOS, run via `bash`, single-quoted path; pure-`sed` JSON parse + `curl`, no `jq`/python/node prerequisite). Both are emitted beside `out/main/index.js` via `electron.vite.config.ts` and take the agent kind as the first arg. The selected one is copied to a **fixed user path** `<userData>/multiagent-agent-state.<ps1|sh>` at install time (refreshed only when the bundled content changes) so the command string is byte-identical across dev/packaged/versions and Codex's persisted `/hooks` trust is not invalidated. It reads the agent `SessionStart` stdin payload and POSTs `{ptyId, agentKind, sessionId, transcriptPath}` to a localhost-only `AgentSessionReportServer` (`src/main/integration/agentSessionReportServer.ts`); main emits `session:detected` from the report. The pure JSON surgery (`managedHooks.ts`, with `generateHookCommand(path, kind, platform)` — win32 → powershell + `.ps1`, else → bash + `.sh`) and the IO wrapper/orchestrator (`managedHookController.ts`) are shared by both agents. Pane identity is carried by `MULTIAGENT_PTY_ID` / `MULTIAGENT_ENV` / `MULTIAGENT_HOOK_PORT` env vars set per-pane via `PtyManager`'s `getPaneEnv` option; `buildEnv` scrubs inherited copies (including `MULTIAGENT_SESSION_ID`) so a nested MultiAgent never reuses them. The report server's port is `await`ed before `session:new`/`session:resume` return so an app-Codex pane spawned at startup always has `MULTIAGENT_HOOK_PORT`. This is a deliberate exception — do not treat it as license to mutate agent config elsewhere; the marked-block + `.bak` pattern exists precisely to keep it reversible.

`BrowserMcpServer.startHttp()` exposes the browser MCP server. Both Claude and Codex should use the streamable HTTP endpoint at `http://127.0.0.1:{port}/mcp` via templates in `src/main/mcp/templates/`:

- `claude-mcp.json` - JSON config for Claude Code, with `{port}` replaced at runtime.
- `codex-mcp.toml` - TOML snippet for Codex CLI config overrides, with `{port}` replaced at runtime.

`McpInjector` resolves these templates on startup. Claude Code on Windows requires a real file path for `--mcp-config`; inline JSON is unreliable and has been observed to be treated as a mangled file path. Therefore Claude uses a PID-scoped temp file under `%TEMP%`, passed as `--mcp-config <path>` (no `--strict-mcp-config`), and cleaned up by `McpInjector`. Omitting `--strict-mcp-config` is intentional — it allows Claude to still load user-level and project-level MCP servers from its normal config locations alongside the injected browser server.

Codex does not need a temp file. It receives the MCP server process-scoped through CLI `-c` overrides generated from the template, along with the TUI flags noted above.

### Browser Panel (MCP)

`BrowserViewManager` embeds a `BrowserView` that an MCP server (`BrowserMcpServer`, server name `multiagent-browser`) controls via neutral primitive tools in `src/main/mcp/tools/` (navigate, click, click_text, click_at, type, hover, hover_at, keyboard, select, scroll, screenshot, get_content/url/elements/links, evaluate, wait_for/wait_for_text/wait_for_load, set_cookies). The renderer shows/hides it via `browser:toggle`. The tool surface and recommended selection order are documented with the MCP server itself — keep that list in sync with `src/main/mcp/tools/`, not here. To override JS dialogs (`alert`/`confirm`/`prompt`), use `browser_evaluate` to patch `window.confirm = () => true` etc. after navigation.
