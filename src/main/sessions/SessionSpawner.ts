import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty/PtyManager'
import type { AgentKind } from '../../shared/types'
import { CodexSessionScanner, codexSessionsDir } from './CodexSessionScanner'
import { currentClaudeMcpConfigPath, currentCodexMcpUrl, currentMcpSettings } from '../mcp/McpInjector'
import { defaultShell } from '../pty/shell'

const SESSION_DETECTION_GRACE_MS = 5_000
const SESSION_DETECTION_TIMEOUT_MS = 60_000
const CLAUDE_DETECTION_BATCH_MS = 400

interface PendingDetection {
  ptyId: string
  mainWindow: BrowserWindow
  cwd: string
  normalizedCwd: string
  startedAt: number
  agentKind: AgentKind
  cleanup: () => void
}

interface ClaudeFileCandidate {
  filePath: string
  sessionId: string
  cwd: string
  normalizedCwd: string
  mtimeMs: number
}

const pendingClaudeDetections: PendingDetection[] = []
const claudeFileCandidates = new Map<string, ClaudeFileCandidate>()
let watcherReady = false
let claudeBatchTimer: ReturnType<typeof setTimeout> | null = null

function ensureSharedWatcher(projectsDir: string): void {
  if (watcherReady) return
  watcherReady = true

  void import('chokidar').then(({ watch }) => {
    const watcher = watch(projectsDir, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })

    watcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return

      void (async () => {
        // Retry once after 500ms if the file isn't fully flushed yet
        let info = await readSessionInfo(filePath)
        if (!info) {
          await new Promise<void>((r) => setTimeout(r, 500))
          info = await readSessionInfo(filePath)
        }
        const stat = await fs.promises.stat(filePath).catch(() => null)
        if (!info || !stat) return

        claudeFileCandidates.set(filePath, {
          filePath,
          sessionId: info.sessionId,
          cwd: info.cwd,
          normalizedCwd: normalizePath(info.cwd),
          mtimeMs: stat.mtimeMs,
        })
        scheduleClaudeBatch()
      })()
    })
  })
}

function scheduleClaudeBatch(): void {
  if (claudeBatchTimer) return
  claudeBatchTimer = setTimeout(processClaudeBatch, CLAUDE_DETECTION_BATCH_MS)
}

function processClaudeBatch(): void {
  claudeBatchTimer = null
  if (pendingClaudeDetections.length === 0 || claudeFileCandidates.size === 0) return

  const matches: Array<{ pending: PendingDetection; candidate: ClaudeFileCandidate; score: number }> = []
  for (const candidate of claudeFileCandidates.values()) {
    const candidateMatches = pendingClaudeDetections
      .map((pending) => {
        const score = scoreClaudeCandidate(pending, candidate)
        return score === null ? null : { pending, candidate, score }
      })
      .filter((match): match is { pending: PendingDetection; candidate: ClaudeFileCandidate; score: number } => match !== null)
      .sort((a, b) => b.score - a.score)

    if (candidateMatches.length !== 1) continue
    matches.push(candidateMatches[0])
  }

  const pendingCounts = new Map<PendingDetection, number>()
  for (const match of matches) {
    pendingCounts.set(match.pending, (pendingCounts.get(match.pending) ?? 0) + 1)
  }

  for (const match of matches) {
    if ((pendingCounts.get(match.pending) ?? 0) !== 1) continue
    const stillPending = pendingClaudeDetections.includes(match.pending)
    const stillCandidate = claudeFileCandidates.get(match.candidate.filePath) === match.candidate
    if (!stillPending || !stillCandidate) continue

    match.pending.cleanup()
    claudeFileCandidates.delete(match.candidate.filePath)
    if (!match.pending.mainWindow.isDestroyed()) {
      match.pending.mainWindow.webContents.send('session:detected', match.pending.ptyId, 'claude', match.candidate.sessionId)
    }
  }
}

function scoreClaudeCandidate(pending: PendingDetection, candidate: ClaudeFileCandidate): number | null {
  if (candidate.normalizedCwd !== pending.normalizedCwd) return null
  if (candidate.mtimeMs < pending.startedAt - SESSION_DETECTION_GRACE_MS) return null

  const timeDelta = Math.abs(candidate.mtimeMs - pending.startedAt)
  return 10_000 - Math.min(timeDelta, 10_000)
}

export class SessionSpawner {
  constructor(private ptyManager: PtyManager, private mainWindow: BrowserWindow) {}

  async spawnNew(agentKind: AgentKind, cwd: string, senderWin?: BrowserWindow): Promise<{ ptyId: string; sessionId: string | null; detectionStartedAt: number }> {
    const targetWin = senderWin ?? this.mainWindow
    const startedAt = Date.now()
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(newSessionCommand(agentKind)),
      agentEnv(agentKind)
    )
    this._watchForNewSession(agentKind, ptyId, cwd, startedAt, targetWin)
    return { ptyId, sessionId: null, detectionStartedAt: startedAt }
  }

  async spawnResume(agentKind: AgentKind, sessionId: string, cwd: string, senderWin?: BrowserWindow): Promise<{ ptyId: string }> {
    const targetWin = senderWin ?? this.mainWindow
    const startedAt = Date.now()
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(resumeSessionCommand(agentKind, sessionId, cwd)),
      agentEnv(agentKind)
    )
    if (agentKind === 'codex') {
      this._watchForNewCodexSession(ptyId, cwd, startedAt, targetWin, 'resume', sessionId)
    }
    return { ptyId }
  }

  private _watchForNewSession(agentKind: AgentKind, ptyId: string, cwd: string, startedAt: number, targetWin: BrowserWindow): void {
    if (agentKind === 'codex') {
      this._watchForNewCodexSession(ptyId, cwd, startedAt, targetWin, 'new')
      return
    }

    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    fs.mkdirSync(projectsDir, { recursive: true })

    ensureSharedWatcher(projectsDir)

    let cancelled = false

    const cleanup = () => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timeout)
      this.ptyManager.off('exit', onExit)
      const idx = pendingClaudeDetections.indexOf(pending)
      if (idx >= 0) pendingClaudeDetections.splice(idx, 1)
    }

    // Cancel if the PTY exits before detection completes
    const onExit = (exitId: string) => {
      if (exitId !== ptyId) return
      cleanup()
    }
    this.ptyManager.on('exit', onExit)

    const timeout = setTimeout(() => {
      cleanup()
      if (!targetWin.isDestroyed()) {
        targetWin.webContents.send('session:detection-failed', ptyId, agentKind, 'timeout', 'new')
      }
    }, SESSION_DETECTION_TIMEOUT_MS)

    const pending: PendingDetection = {
      ptyId,
      mainWindow: targetWin,
      cwd,
      normalizedCwd: normalizePath(cwd),
      startedAt,
      agentKind,
      cleanup,
    }
    pendingClaudeDetections.push(pending)
  }

  private _watchForNewCodexSession(ptyId: string, cwd: string, startedAt: number, targetWin: BrowserWindow, mode: 'new' | 'resume', resumedSessionId?: string): void {
    const sessionsDir = codexSessionsDir()
    fs.mkdirSync(sessionsDir, { recursive: true })

    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      if (cancelled) return
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
      clearTimeout(timeout)
      this.ptyManager.off('exit', onExit)
    }

    const onExit = (exitId: string) => {
      if (exitId !== ptyId) return
      cleanup()
    }
    this.ptyManager.on('exit', onExit)

    const scanner = new CodexSessionScanner()
    pollTimer = setInterval(() => {
      void (async () => {
        if (cancelled) return
        const sessions = await scanner.scanAll()
        const normalizedCwd = normalizePath(cwd)
        const match = sessions
          .filter((session) =>
            normalizePath(session.cwd) === normalizedCwd &&
            session.mtimeMs >= startedAt - 5_000 &&
            // In resume mode, only fire for a genuinely different (forked) session ID.
            // Without this, every watcher for panes sharing the same cwd would match the
            // same newest file and overwrite all panes with one session ID.
            (!resumedSessionId || session.sessionId !== resumedSessionId)
          )
          .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
        if (!match) return

        cleanup()
        if (!targetWin.isDestroyed()) {
          targetWin.webContents.send('session:detected', ptyId, 'codex', match.sessionId)
        }
      })().catch(() => {})
    }, 1_000)

    const timeout = setTimeout(() => {
      cleanup()
      if (!targetWin.isDestroyed()) {
        targetWin.webContents.send('session:detection-failed', ptyId, 'codex', 'timeout', mode)
      }
    }, SESSION_DETECTION_TIMEOUT_MS)
  }

}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_\-.:\\/]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function agentLaunchCommand(command: string): string[] {
  if (process.platform === 'win32') {
    return ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
  }
  return [defaultShell(), '-lc', command]
}

function agentEnv(agentKind: AgentKind): Record<string, string> | undefined {
  if (agentKind !== 'claude') return undefined
  return {
    CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL: '1',
    CLAUDE_CODE_NO_FLICKER: '1',
  }
}

function newSessionCommand(agentKind: AgentKind): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs()}`
  return `codex${codexCliArgs()}`
}

function resumeSessionCommand(agentKind: AgentKind, sessionId: string, cwd: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs()} --resume ${shellArg(sessionId)}`
  return `codex resume${codexCliArgs()} -C ${shellArg(cwd)} ${shellArg(sessionId)}`
}

function claudeCliArgs(): string {
  const mcpConfigPath = currentClaudeMcpConfigPath()
  return mcpConfigPath ? ` --mcp-config ${shellArg(mcpConfigPath)}` : ''
}

function codexCliArgs(): string {
  const args = [
    '--no-alt-screen',
    '-c',
    psSingleQuoted('tui.animations=false'),
    '-c',
    psSingleQuoted('tui.terminal_title=[]'),
  ]

  const settings = currentMcpSettings()
  const mcpUrl = currentCodexMcpUrl()

  // Built-in browser server
  if (mcpUrl && (!settings || settings.builtinBrowserEnabled !== false)) {
    args.push(
      '-c',
      psSingleQuoted(`mcp_servers.multiagent-browser.url=${tomlLit(mcpUrl)}`),
      '-c',
      psSingleQuoted('mcp_servers.multiagent-browser.enabled=true')
    )
  }

  // Custom servers
  if (settings) {
    for (const server of settings.customServers) {
      if (!server.enabled || !server.name.trim()) continue
      const key = server.name.trim()
      if (server.type === 'stdio') {
        if (server.command) {
          args.push('-c', psSingleQuoted(`mcp_servers.${key}.command=${tomlLit(server.command)}`))
          if (server.args?.length) {
            // Skip any arg containing a single quote — TOML literal strings can't represent them.
            // Codex won't receive those args, but Claude handles them correctly via the JSON config file.
            const safeArgs = server.args.filter(a => !a.includes("'"))
            if (safeArgs.length) {
              args.push('-c', psSingleQuoted(`mcp_servers.${key}.args=${tomlLitArray(safeArgs)}`))
            }
          }
          if (server.env && Object.keys(server.env).length) {
            for (const [k, v] of Object.entries(server.env)) {
              if (!v.includes("'")) {
                args.push('-c', psSingleQuoted(`mcp_servers.${key}.env.${k}=${tomlLit(v)}`))
              }
            }
          }
          args.push('-c', psSingleQuoted(`mcp_servers.${key}.enabled=true`))
        }
      } else {
        if (server.url) {
          args.push(
            '-c', psSingleQuoted(`mcp_servers.${key}.url=${tomlLit(server.url)}`),
            '-c', psSingleQuoted(`mcp_servers.${key}.enabled=true`)
          )
        }
      }
    }
  }

  return ` ${args.join(' ')}`
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Build a TOML literal string (single-quoted) for use inside psSingleQuoted().
// psSingleQuoted doubles the single quotes so PowerShell passes them verbatim,
// and TOML's literal-string syntax accepts them without any double-quote dependency.
// This avoids the Windows/PowerShell 5.1 behaviour where double quotes passed to
// native executables can be stripped, breaking TOML array parsing.
function tomlLit(value: string): string {
  return `'${value}'`
}

function tomlLitArray(items: string[]): string {
  return `[${items.map(tomlLit).join(', ')}]`
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// sessionId and cwd may appear on different lines - accumulate from first 10 lines
async function readSessionInfo(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  return new Promise((resolve) => {
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      let sessionId = ''
      let cwd = ''
      let lineCount = 0

      rl.on('line', (line) => {
        if (sessionId && cwd) return
        lineCount++
        if (lineCount > 10) {
          rl.close()
          stream.destroy()
          return
        }
        try {
          const record = JSON.parse(line) as { sessionId?: string; cwd?: string }
          if (!sessionId && record.sessionId) sessionId = record.sessionId
          if (!cwd && record.cwd) cwd = record.cwd
          if (sessionId && cwd) {
            rl.close()
            stream.destroy()
          }
        } catch { /* skip malformed lines */ }
      })

      rl.on('close', () => resolve(sessionId && cwd ? { sessionId, cwd } : null))
      rl.on('error', () => resolve(null))
      stream.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

