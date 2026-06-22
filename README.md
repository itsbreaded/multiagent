# MultiAgent

A Windows desktop app (Electron) for running multiple Claude Code and Codex agent sessions
side-by-side in a tiling terminal workspace, with session indexing/search and an embedded
browser the agents can drive.

> **Status: alpha.** Expect rough edges. This is a personal/internal tool being shared with a
> small group of developers for testing.

---

## Prerequisites

This is the part that bites — most "it doesn't work" reports trace back to a missing prereq here.

| Requirement | Why | Notes |
|---|---|---|
| **Windows 10/11** | The app spawns `powershell.exe`, uses ConPTY, and ships a PowerShell shell-integration script. | macOS/Linux are **not** supported. |
| **Node.js 24.x** | Native modules (`node-pty`, `better-sqlite3`) are rebuilt against the Electron ABI on install. A mismatched Node causes cryptic rebuild failures. | See `.nvmrc`. Use `nvm use` if you have nvm-windows. |
| **`claude` CLI** on PATH, **logged in** | The app *launches* the Claude Code CLI for Claude agent panes. | Run `claude` once in a terminal and complete login before starting the app. |
| **`codex` CLI** on PATH, **logged in** | Same, for Codex agent panes. | Run `codex` once and complete login first. |
| **VS Build Tools + Python** *(usually optional)* | Fallback for compiling native modules if prebuilt binaries aren't available for your setup. | Only needed if `npm install` fails on the native rebuild step. |

The agent CLIs are the non-obvious one: the app is just a workspace that *drives* `claude` and
`codex`. If they aren't installed and authenticated, the UI will open fine but agent panes will
fail to start.

---

## Quickstart

```powershell
git clone <repo-url>
cd multiagent
npm install        # postinstall rebuilds native modules — let it finish, don't add --ignore-scripts
npm run dev        # launches the app with Electron + Vite HMR
```

That's it for running it. There are also convenience scripts that pull latest + install + run:

- **`update-and-run.bat`** — `git pull` → `npm install` → `npm run dev`. Day-to-day testing.
- **`update-and-build.bat`** — `git pull` → `npm install` → `npm run dist` (packages to `dist\win-unpacked\`).

---

## Scripts

```powershell
npm run dev        # dev server (Electron + Vite HMR)
npm run build      # compile only, no packaging
npm run typecheck  # TypeScript type-check, no emit
npm run dist       # build + package to dist\win-unpacked\   (see Developer Mode note below)
```

### Packaging (`npm run dist`) — Developer Mode

You only need this if you want to produce a packaged `dist\win-unpacked\` build (or run
`update-and-build.bat`). **Running with `npm run dev` does not need it.**

`electron-builder` creates symbolic links while packaging, and Windows blocks non-elevated symlink
creation unless **Developer Mode** is on:

> **Settings → System → For developers → Developer Mode → On**

Without it, `npm run dist` fails on the symlink step. `npm run dev` is unaffected.

---

## Troubleshooting

- **`npm install` fails rebuilding `better-sqlite3` / `node-pty`** — you're almost certainly on the
  wrong Node version. Check `node -v` against `.nvmrc`. Don't run `npm install --ignore-scripts`;
  the `postinstall` rebuild is required.
- **App opens but agent panes immediately fail** — `claude` and/or `codex` isn't on PATH or isn't
  logged in. Open a regular terminal, run each one, complete auth, then restart the app.
- **`npm run dist` fails on a symlink/EPERM error** — enable Developer Mode (above).

---

## Architecture

See [`CLAUDE.md`](./CLAUDE.md) for the detailed architecture notes (Electron process model, PTY
isolation, pane layout, session indexing, MCP browser panel). It's written for contributors working
in the code.
