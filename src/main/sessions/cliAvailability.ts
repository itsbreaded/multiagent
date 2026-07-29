import * as fs from 'fs'
import type { AgentKind, AgentProviderSettings } from '../../shared/types'

/**
 * Startup CLI availability detection for the three supported coding-agent CLIs
 * (spec 055). Pure (aside from injected async I/O) and side-effect-free so it is
 * unit-testable without Electron.
 *
 * Detection mirrors how {@link SessionSpawner} actually launches each agent: the
 * spawn command is a bare token (`claude`, `codex`, `opencode`) resolved by the
 * shell against the app's PATH. We resolve the same way here by scanning each
 * PATH directory for an executable file, applying PATHEXT on Windows the way
 * `powershell -Command <token>` and `cmd` do. This is the same PATH sessions
 * inherit (the no-PATH-rewrite guardrail keeps `env.PATH === process.env.PATH`),
 * so "detected" here means "a new pane for this kind would actually launch".
 *
 * Uses async fs I/O (never fs.statSync): a PATH can hold dozens of directories,
 * and blocking Node's single main-process event loop for a synchronous scan
 * across all of them (x3 binaries x up to 4 PATHEXT extensions on Windows) would
 * delay every other main-process IPC handler and timer during startup.
 */

/** The bare command token each agent kind launches with (see newSessionCommand). */
const AGENT_BINARIES: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
}

const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode']

export interface DetectEnv {
  /** `process.env.PATH` — the PATH sessions will inherit. */
  path?: string
  /** `process.platform`. */
  platform: NodeJS.Platform
  /** `process.env.PATHEXT` — Windows extension list, e.g. `.COM;.EXE;.BAT;.CMD`. */
  patheext?: string
}

export type ProviderAvailability = Record<AgentKind, boolean>

/** Runtime availability must never rewrite the durable provider preference. */
export function applyAvailabilityToSettings(
  settings: AgentProviderSettings,
  _availability: ProviderAvailability,
): AgentProviderSettings {
  return settings
}

/**
 * spec 055 Req 2/3: force-disable any provider whose CLI was not detected. This is
 * the one-way detection rule — it may turn a provider's saved `Enabled` off, but
 * never on. Returns the same settings object reference when nothing changed (so the
 * caller can skip a persist), otherwise a new object with the undetected kinds
 * disabled. Pure; tested without Electron.
 */
/** A minimal stat result — only the fields `binaryExists` consults. Injectable for tests. */
export interface StatLike {
  isFile(): boolean
  mode: number
}

/**
 * Resolve each agent CLI on the given PATH. Returns a map keyed by agent kind.
 * A kind is "available" when some PATH directory contains an executable file
 * matching the bare command token (with a PATHEXT suffix on Windows). All
 * directories/extensions for all three kinds are probed concurrently.
 *
 * `statFn` defaults to `fs.promises.stat` and is exposed purely for unit testing
 * (NTFS does not track Unix exec bits, so a real-file POSIX test is host-dependent).
 */
export async function detectProviderAvailability(
  env: DetectEnv,
  statFn: (p: string) => Promise<StatLike> = (p) => fs.promises.stat(p) as unknown as Promise<StatLike>,
): Promise<ProviderAvailability> {
  const dirs = (env.path ?? '').split(env.platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = env.platform === 'win32' ? parsePathext(env.patheext) : ['']
  const entries = await Promise.all(
    AGENT_KINDS.map(async (kind) => {
      const found = await binaryExists(dirs, AGENT_BINARIES[kind], exts, env.platform, statFn)
      return [kind, found] as const
    }),
  )
  return Object.fromEntries(entries) as ProviderAvailability
}

function parsePathext(patheext: string | undefined): string[] {
  if (!patheext) return ['.COM', '.EXE', '.BAT', '.CMD']
  return patheext
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : `.${e}`))
}

async function binaryExists(
  dirs: string[],
  bin: string,
  exts: string[],
  platform: NodeJS.Platform,
  statFn: (p: string) => Promise<StatLike>,
): Promise<boolean> {
  const sep = platform === 'win32' ? '\\' : '/'
  const candidates: string[] = []
  for (const dir of dirs) {
    for (const ext of exts) {
      const name = platform === 'win32' ? `${bin}${ext}` : bin
      candidates.push(dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`)
    }
  }
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        // On POSIX, require an executable bit (x bit for owner/group/other). On
        // Windows there is no executable bit; a regular file is enough — the shell
        // resolves it via PATHEXT, and access(X_OK) is unreliable on win32.
        const stat = await statFn(candidate)
        if (!stat.isFile()) return false
        if (platform === 'win32') return true
        return (stat.mode & 0o111) !== 0
      } catch {
        // missing or inaccessible
        return false
      }
    }),
  )
  return results.some(Boolean)
}
