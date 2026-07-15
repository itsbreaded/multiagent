# Packaging & Release (mechanism)

The why/how behind `npm run dist`, native module rebuilds, per-OS artifacts, auto-update, and
the release publish flow. The one-line guardrails live in `CLAUDE.md`.

---

## Commands

```bash
npm run dist       # build + package to dist\ (host OS; requires Windows Developer Mode on win)
npm run dist:dir   # build + dir output only (host OS)
npm run dist:nsis  # Windows NSIS explicitly
npm run dist:mac   # macOS explicitly
npm run dist:linux # Linux explicitly
npm run release    # electron-builder --publish always for host OS (CI uses this per-OS)
```

`npm run dist` runs `electron-vite build && electron-builder` with **no `--<os>` flag**, so it
builds for the **host OS**. `npmRebuild: false` is kept because postinstall already handles the
`better-sqlite3` (and node-pty on mac/linux) rebuild for the host ABI.

## Native modules are not cross-compiled

Each CI runner installs + rebuilds natively (postinstall `electron-rebuild` from
`@electron/rebuild`). `postinstall` first runs `node_modules/electron/install.js` (downloads
the Electron binary — Electron 42+ no longer does this during `npm install`), then
`electron-rebuild` to rebuild `better-sqlite3` for the Electron ABI. `node-pty` ships Windows
Electron-compatible prebuilds in this tree; if those are unavailable, a source rebuild requires
Visual Studio Build Tools. Do not add `--ignore-scripts`.

Do not try to build mac/linux artifacts from Windows. `node-pty` ships Windows Electron
prebuilds; on mac/linux it rebuilds from source (needs Xcode CLT / build-essential +
`libudev-dev`).

## Per-OS output

- **Windows**: `dist\MultiAgent Setup X.Y.Z.exe` (NSIS installer, primary artifact) and
  `dist\win-unpacked\` (portable, kept for dev inspection). The NSIS installer does a per-user
  install to `%LOCALAPPDATA%\Programs\MultiAgent` — no admin rights needed.
- **macOS**: `dist/MultiAgent-X.Y.Z-arm64.dmg` + `.zip`. **v1 ships unsigned** (developer
  audience): Gatekeeper blocks a double-click install, so developers run
  `xattr -cr /Applications/MultiAgent.app` (or right-click → Open) after dragging from the dmg.
  Notarization + signing are deferred until an Apple Developer ID exists; the flip-on is one
  config change — set `hardenedRuntime: true` + `"notarize": { "teamId": ... }` in the `mac`
  block and provide `CSC_LINK`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` as
  build env (never committed). `build/entitlements.mac.plist` (committed) is already
  referenced and is applied only once signing is on (allow-jit + disable-library-validation
  for the native modules). **macOS auto-update caveat:** unsigned updates will not pass
  Gatekeeper either until notarization is enabled — a v1 limitation, not a bug.
- **Linux**: `dist/MultiAgent-X.Y.Z.AppImage` + `.deb` (unsigned for v1).

## Icons

`build/icon.icns` (mac) is **generated from `build/icon.png`** by `npm run build:icon`
(`scripts/build-icon.mjs`, `sips`+`iconutil`, macOS-only; no-ops elsewhere) — the CI mac runner
runs it before `--mac`. electron-builder auto-detects `build/icon.icns` and falls back to the
default Electron icon if absent, so `mac.icon` is intentionally not hard-set (a missing .icns
must not fail a local build). `build/icon.png` (Linux) and `build/favicon.ico` (Windows) are
committed.

## asar / packaged assets

`asarUnpack` is set for `**/*.node`, `**/node-pty/**`, and `**/better-sqlite3/**` so native
modules are accessible outside the asar archive. MCP templates under
`src/main/mcp/templates/**/*` are included in packaged builds via `package.json` `build.files`.
If templates move or new runtime templates are added, update the packaging list and verify
they are present in `resources/app.asar`.

## Auto-Update (GitHub Releases)

The app uses `electron-updater` to check `github.com/itsbreaded/multiagent` releases. Updates
are downloaded silently and shown as a slim banner below the titlebar.

**No token required.** The repo is public, so release metadata and assets are readable over
plain HTTPS with no auth — `autoUpdater.setFeedURL` and `publishedInstallerExists`
(`src/main/updateArtifact.ts`) do not send credentials. The updater is always enabled
(`updater:is-enabled` always resolves `true`); there is no `GH_UPDATE_TOKEN` build-time flag
anymore. Do not reintroduce a token requirement or `private: true` on the feed/publish config
unless the repo goes private again.

**Update flow in the running app**: updater checks on startup (10s delay) and hourly.
`updater:status` IPC events drive the `UpdateBanner` component in the renderer. The banner is
suppressed in dev mode and in detached windows.

### Publishing a release (requires `gh auth login`)

1. Bump `version` in `package.json` (the release skill uses
   `npm version patch --no-git-tag-version` so `package-lock.json` stays in sync).
2. Run `publish.bat` — it delegates to `scripts/publish.mjs`, which creates + pushes the
   `v<version>` tag (no local build). The tag push triggers `.github/workflows/release.yml`,
   a 3-OS matrix (win/mac/linux) that builds + publishes each platform's artifacts to the same
   GitHub release in parallel using the auto `GITHUB_TOKEN`.

`npm run release` (`electron-builder --publish always`) is what CI runs per OS. The GitHub
release and `latest.yml`/`*-mac.yml`/`*-linux.yml` metadata are created automatically. Do not
hardcode any tokens in source files.

### patch-package

`patch-package` applies `patches/app-builder-lib+26.15.3.patch` after install. It fixes an
upstream publisher-cache race that otherwise lets concurrent NSIS artifact callbacks create
duplicate GitHub releases. Remove the patch only after upgrading to an `app-builder-lib`
version that caches in-flight publisher creation.