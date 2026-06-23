# 027 — Auto-Update via GitHub Releases

## Problem

The app is currently distributed as a manually-copied folder (`dist\win-unpacked\`). There is no mechanism for the running app to detect or install a newer version. Users on other machines must manually pull, rebuild, or receive a new folder copy.

## Intended Behavior

- On startup (after a short delay), the app silently checks GitHub for a newer release.
- If one is found, a non-intrusive UI element appears (e.g. a banner or badge in the sidebar/titlebar) saying "Update available — downloading…".
- The update downloads in the background. When complete, the UI changes to "Ready to install — restart now?"
- Clicking the restart button applies the update and relaunches.
- If the check or download fails, it is silently ignored (no error dialogs).
- Update checks also run once per hour while the app is open.

## Current Behavior

No update mechanism exists. Build target is `dir` (portable folder). No `electron-updater` dependency.

## Architecture Decisions

### Build target: NSIS (per-user, one-click)

`electron-updater` on Windows requires an installer target. Switch from `"target": "dir"` to `"target": "nsis"` with per-user (no admin) settings. This installs to `%LOCALAPPDATA%\Programs\MultiAgent`. No UAC prompt, no admin rights. Single `.exe` artifact instead of a folder.

### GitHub provider

`electron-updater` has a built-in GitHub provider. It calls the GitHub releases API to find the latest release, compares versions (semver), and downloads the installer asset if newer.

### Token handling

The repo is private. GitHub releases API requires authentication. A fine-grained PAT with `contents: read` on `itsbreaded/multiagent` is sufficient for the running app to check for and download updates.

The token is embedded in the main process bundle at build time via an env variable (`GH_UPDATE_TOKEN`) using electron-vite's `define` feature. It is **not** stored in source control. Because the token is fine-grained and read-only on a single repo, extracting it from the asar gives an attacker nothing beyond the ability to download app releases — which they already have.

Publishing releases to GitHub requires a separate write-capable token (`GH_TOKEN`) that is never embedded in the app. The publishing workflow is a separate `npm run publish` script.

### Version source of truth

`package.json` `version` field drives everything. electron-builder stamps it into the built installer and the `latest.yml` metadata file that `electron-updater` reads. Bump version before each publish.

## Implementation Phases

### Phase 1 — Package & build config

- Add `electron-updater` to `dependencies`.
- Add `electron-builder` `publish` block to `package.json`:
  ```json
  "publish": {
    "provider": "github",
    "owner": "itsbreaded",
    "repo": "multiagent",
    "private": true
  }
  ```
- Change `win.target` from `"dir"` to `["nsis", "dir"]` initially (keep `dir` so dev builds still work without signing; remove it once happy with NSIS).
- Add `nsis` block:
  ```json
  "nsis": {
    "oneClick": true,
    "perMachine": false,
    "allowToChangeInstallationDirectory": false
  }
  ```
- Add `publish` script to `package.json` scripts:
  ```
  "publish": "electron-vite build && electron-builder --publish always"
  ```
- Add `GH_UPDATE_TOKEN` to electron-vite main process `define` so it is baked into `out/main/index.js` at build time.

### Phase 2 — Main process updater

New file: `src/main/updater.ts`

- Configure `autoUpdater` with the GitHub feed URL and the baked-in read-only PAT.
- Disable auto-download (so we can show progress in the UI).
- On `update-available`: send IPC `updater:status` with `{ state: 'available', version }` to renderer.
- Start download manually; on `download-progress`: send `updater:status` with `{ state: 'downloading', percent }`.
- On `update-downloaded`: send `updater:status` with `{ state: 'ready' }`.
- On `error`: log silently, send `updater:status` with `{ state: 'error' }`.
- Export `initUpdater()` called from `src/main/index.ts` after window ready, with a 10-second startup delay.
- Export `quitAndInstall()` called via IPC `updater:install` from renderer.
- Schedule hourly re-check via `setInterval`.
- In dev mode (`!app.isPackaged`), skip the check entirely.

New IPC channels to add to `src/shared/types.ts`:
- `updater:status` — SendChannel, payload `UpdaterStatus` (union type of all states)
- `updater:install` — EventChannel (renderer → main, triggers `quitAndInstall`)

### Phase 3 — Renderer UI

New component: `src/renderer/src/components/UpdateBanner.tsx`

Displayed in the main window only (not detached windows). Position: a slim bar at the very top of the app, above the tab bar, collapsing to zero height when no update is pending.

States:
- Hidden: no update or `app.isPackaged` is false.
- `available` / `downloading`: show "Downloading update vX.Y.Z… (N%)" with an indeterminate or percent progress indicator.
- `ready`: show "Update ready — Restart to install" with a "Restart" button that sends `updater:install`.
- `error`: show nothing (silent failure).

Wire `updater:status` listener in the component (or a small Zustand slice if preferred).

Use the existing app visual language: same background as the titlebar area, green `#4ade80` accent, no jarring colors.

### Phase 4 — Publishing workflow

Update `update-and-build.bat` to note the new NSIS output path.

Document in `CLAUDE.md` (Packaging Notes section):
- How to bump version and publish a release.
- The two env vars required (`GH_UPDATE_TOKEN` for building, `GH_TOKEN` for publishing).
- Where the NSIS installer lands (`dist\MultiAgent Setup X.Y.Z.exe`).

## User Setup Required (non-code)

Before the first build after this spec is implemented, the user must:

1. **Create a fine-grained PAT for in-app update checking** (read-only, embedded in the app):
   - GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token
   - Resource owner: `itsbreaded`
   - Repository access: Only `itsbreaded/multiagent`
   - Permissions → Repository permissions → Contents: **Read-only**
   - Name it something like `multiagent-updater-read`
   - Set `GH_UPDATE_TOKEN=<this token>` in your shell environment before running `npm run build` or `npm run dist`.

2. **Create a fine-grained PAT for publishing releases** (write, not embedded in the app):
   - Same steps, but Contents: **Read and write**
   - Name it `multiagent-publish`
   - Set `GH_TOKEN=<this token>` in your shell environment before running `npm run publish`.
   - This token never goes in the app; keep it in your shell profile or a local `.env` file that is gitignored.

3. **For the very first release**, run `npm run publish` (with both tokens set). This will build the app, create a GitHub release tagged with the current `package.json` version, and upload the NSIS installer + `latest.yml` metadata. Subsequent releases follow the same flow after a version bump.

4. **Distribute via the NSIS installer** (`dist\MultiAgent Setup X.Y.Z.exe`) instead of the folder copy. Recipients double-click it; no admin rights needed.

## Verification Steps

- [ ] `npm run build` succeeds with `GH_UPDATE_TOKEN` set — verify the token is baked into `out/main/index.js` (grep for a fragment of it).
- [ ] `npm run dist` produces both a `dist\MultiAgent Setup X.Y.Z.exe` (NSIS) and `dist\win-unpacked\` (dir).
- [ ] `npm run publish` creates a GitHub release on `itsbreaded/multiagent` with the installer and `latest.yml` attached.
- [ ] Install the app via the NSIS installer. Confirm it lands in `%LOCALAPPDATA%\Programs\MultiAgent`.
- [ ] Bump version to a higher number, publish again. The older installed app detects the update within 10 seconds of launch, shows the banner, downloads, and "Restart to install" appears.
- [ ] Clicking "Restart to install" quits and relaunches into the newer version.
- [ ] App runs fine in dev mode (`npm run dev`) with no update-check errors.

## Risks

- **NSIS target requires `electron-builder` to download the NSIS bundler** on first `npm run dist` — this is automatic but takes a minute.
- **No code signing**: Windows SmartScreen will show an "Unknown publisher" warning on first install on each machine. Users click "More info → Run anyway". Acceptable for personal distribution. If this becomes annoying, a self-signed cert can suppress it for machines where it's trusted.
- **`GH_UPDATE_TOKEN` in the asar**: mitigated by fine-grained read-only scope on one repo. Do not reuse this token for anything else.
- **Version must be bumped before each publish** — publishing the same version twice will not trigger an update in the running app (same semver = no update).

## Definition of Done

- App installed via NSIS silently checks GitHub on launch, downloads updates in the background, and presents a one-click restart prompt.
- Publishing a new version requires only: bump `package.json` version, run `npm run publish` (with `GH_TOKEN` set).
- No user-visible errors when the app is offline or GitHub is unreachable.
- Dev mode (`npm run dev`) is unaffected.
