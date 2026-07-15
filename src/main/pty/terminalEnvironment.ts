import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename } from 'path'

export interface ShellIntegrationCommandDeps {
  /** Materialize the bundled asset to a real file outside app.asar; null on failure. */
  ensureScript: (name: string) => string | null
  /** Resolve the bundled asset path (beside out/main + dev fallbacks); null if none found. */
  bundled: (name: string) => string | null
}

export function shellIntegrationCommand(
  deps: ShellIntegrationCommandDeps = {
    ensureScript: ensureShellIntegrationScript,
    bundled: bundledScriptPath,
  },
): string[] {
  if (process.platform !== 'win32') return []

  // Prefer the materialized <userData> copy: the bundled asset lives inside app.asar when
  // packaged, which PowerShell (a separate process) cannot read — sourcing the asar path
  // fails silently under `catch {}` and CWD tracking (OSC 633) never loads. The <userData>
  // copy is a real file outside the archive, so packaged builds source it correctly. Fall
  // back to the bundled candidates for dev (real files on disk), then the asar path as a
  // last resort. Same pattern the Unix path uses via ensureShellIntegrationScript.
  const scriptPath =
    deps.ensureScript('shellIntegration.ps1') ??
    deps.bundled('shellIntegration.ps1') ??
    join(__dirname, 'shellIntegration.ps1')
  return [
    '-NoLogo',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `try { . "${escapePowerShellDoubleQuoted(scriptPath)}" } catch {}`,
  ]
}

function escapePowerShellDoubleQuoted(value: string): string {
  return value.replace(/`/g, '``').replace(/"/g, '`"')
}

/**
 * Resolve the launch command (and optional env) for an interactive Unix shell with
 * MultiAgent's shell integration wired in. Returns `{ cmd }` with no integration if the
 * integration script cannot be materialized (the shell still launches normally — fail open,
 * never break the shell). See shellIntegration.sh for the emitted sequences.
 *
 * `name`/`argv` detection is by the shell basename: bash uses `--init-file` (which replaces
 * ~/.bashrc; the script re-sources it), zsh uses a generated `ZDOTDIR` (zsh has no --init-file;
 * a small .zshrc there re-sources ~/.zshrc then our script). Other shells (sh/fish/…) get no
 * integration for v1.
 */
export interface UnixShellLaunchDeps {
  ensureScript: (name: string) => string | null
  ensureZdotdir: (shellScriptPath: string) => string | null
}

export function unixShellLaunch(
  shellPath: string,
  deps: UnixShellLaunchDeps = { ensureScript: ensureShellIntegrationScript, ensureZdotdir: ensureZshZdotdir },
): { cmd: string[]; env?: Record<string, string> } {
  const base = basename(shellPath).toLowerCase()
  const script = deps.ensureScript('shellIntegration.sh')
  if (!script) return { cmd: [shellPath] }
  if (base === 'bash') return { cmd: [shellPath, '--init-file', script] }
  if (base === 'zsh') {
    const zdotdir = deps.ensureZdotdir(script)
    return zdotdir ? { cmd: [shellPath], env: { ZDOTDIR: zdotdir } } : { cmd: [shellPath] }
  }
  return { cmd: [shellPath] }
}

// --- script materialization -------------------------------------------------

/** Bundled asset path: beside out/main, then a couple of dev fallbacks. */
function bundledScriptPath(name: string): string | null {
  const candidates = [
    join(__dirname, name),
    join(__dirname, '..', name),
    join(process.cwd(), 'src', 'main', 'pty', name),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* try next */
    }
  }
  return null
}

function userDataDir(): string {
  // Lazy-require so importing this module (e.g. in tests) never pulls Electron at load time.
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('userData')
}

let materialized = new Map<string, string>()

/**
 * Copy the bundled shell-integration asset to a real file at `<userData>/<name>` so a shell
 * (a separate process) can read it — the bundled asset lives inside app.asar, which external
 * shells cannot read. Idempotent: only writes when missing or stale. Mirrors the managed-hook
 * script copy in managedHookController.ts. Returns the real path, or null on failure.
 */
export function ensureShellIntegrationScript(name: string): string | null {
  const cached = materialized.get(name)
  if (cached && existsSync(cached)) return cached
  try {
    const dest = join(userDataDir(), name)
    const src = bundledScriptPath(name)
    if (!src) return null
    const sourceText = readFileSync(src, 'utf8')
    let existing: string | null = null
    try {
      existing = readFileSync(dest, 'utf8')
    } catch {
      /* not present yet */
    }
    if (existing !== sourceText) {
      try {
        mkdirSync(userDataDir(), { recursive: true })
      } catch {
        /* may already exist */
      }
      writeFileSync(dest, sourceText)
    }
    materialized.set(name, dest)
    return dest
  } catch {
    return null
  }
}

/**
 * Materialize a tiny `.zshrc` in `<userData>/shell-integration-zsh/` that sources the user's
 * `~/.zshrc` then MultiAgent's shell-integration script, and return that directory for use as
 * `ZDOTDIR`. zsh sources `.zshrc` from `$ZDOTDIR` (or `$HOME` when unset) for interactive shells.
 */
export function ensureZshZdotdir(shellScriptPath: string): string | null {
  const dirName = 'shell-integration-zsh'
  const cached = materialized.get(dirName)
  if (cached && existsSync(join(cached, '.zshrc'))) return cached
  try {
    const dir = join(userDataDir(), dirName)
    const rc = join(dir, '.zshrc')
    const body =
      '# Auto-generated by MultiAgent. Sources the user rc, then MultiAgent shell integration.\n' +
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null\n' +
      `[ -f "${shellScriptPath}" ] && source "${shellScriptPath}"\n`
    let existing: string | null = null
    try {
      existing = readFileSync(rc, 'utf8')
    } catch {
      /* not present */
    }
    if (existing !== body) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* may exist */
      }
      writeFileSync(rc, body)
    }
    materialized.set(dirName, dir)
    return dir
  } catch {
    return null
  }
}