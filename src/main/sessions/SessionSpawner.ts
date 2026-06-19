import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty/PtyManager'
import type { AgentKind } from '../../shared/types'
import { codexSessionsDir, listCodexSessionFilePaths, readCodexSessionMeta } from './CodexSessionScanner'
import { currentClaudeMcpConfigPath, currentCodexMcpUrl, currentMcpSettings } from '../mcp/McpInjector'
import { defaultShell } from '../pty/shell'

const SESSION_DETECTION_TIMEOUT_MS = 30 * 60_000
const SESSION_DETECTION_GRACE_MS = 5_000
const CODEX_SESSION_POLL_MS = 1_000

interface PendingCodexDetection {
  ptyId: string
  cwd: string
  normalizedCwd: string
  startedAt: number
  targetWin: BrowserWindow
  mode: 'new' | 'resume'
  resumedSessionId?: string
  baselinePaths: Set<string>
  inputBuffer: string
  firstMessageAt: number | null
  timeout: ReturnType<typeof setTimeout>
  onExit: (exitId: string) => void
}

interface CodexRolloutCandidate {
  filePath: string
  sessionId: string
  cwd: string
  normalizedCwd: string
  timestampMs: number
}

export class SessionSpawner {
  private pendingCodexDetections = new Map<string, PendingCodexDetection>()
  private claimedCodexFiles = new Set<string>()
  private codexPollTimer: ReturnType<typeof setInterval> | null = null
  private codexPollInFlight = false

  constructor(private ptyManager: PtyManager, private mainWindow: BrowserWindow) {}

  dispose(): void {
    if (this.codexPollTimer) {
      clearInterval(this.codexPollTimer)
      this.codexPollTimer = null
    }
    for (const pending of this.pendingCodexDetections.values()) {
      clearTimeout(pending.timeout)
      this.ptyManager.off('exit', pending.onExit)
    }
    this.pendingCodexDetections.clear()
  }

  async spawnNew(agentKind: AgentKind, cwd: string, senderWin?: BrowserWindow): Promise<{ ptyId: string; sessionId: string | null; detectionStartedAt: number }> {
    const targetWin = senderWin ?? this.mainWindow
    const startedAt = Date.now()
    // createDeferred falls back to homedir() when cwd doesn't exist; match that here
    // so Codex detection agrees with what the agent will record in its JSONL.
    const actualCwd = fs.existsSync(cwd) ? cwd : os.homedir()
    const sessionId = agentKind === 'claude' ? randomUUID() : null
    const codexBaseline = agentKind === 'codex' ? await snapshotCodexSessionPaths() : undefined
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(newSessionCommand(agentKind, sessionId ?? undefined)),
      agentEnv(agentKind)
    )
    if (agentKind === 'codex') {
      this._registerCodexDetection(ptyId, actualCwd, startedAt, targetWin, 'new', codexBaseline)
    }
    return { ptyId, sessionId, detectionStartedAt: startedAt }
  }

  async spawnResume(agentKind: AgentKind, sessionId: string, cwd: string, senderWin?: BrowserWindow): Promise<{ ptyId: string }> {
    const targetWin = senderWin ?? this.mainWindow
    const startedAt = Date.now()
    const codexBaseline = agentKind === 'codex' ? await snapshotCodexSessionPaths() : undefined
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(resumeSessionCommand(agentKind, sessionId, cwd)),
      agentEnv(agentKind)
    )
    if (agentKind === 'codex') {
      this._registerCodexDetection(ptyId, cwd, startedAt, targetWin, 'resume', codexBaseline, sessionId)
    }
    return { ptyId }
  }

  notePtyWrite(ptyId: string, data: string): void {
    const pending = this.pendingCodexDetections.get(ptyId)
    if (!pending || pending.firstMessageAt !== null) return
    if (codexWriteContainsFirstMessageSubmit(pending, data)) {
      pending.firstMessageAt = Date.now()
      this._ensureCodexPoll()
    }
  }

  private _registerCodexDetection(
    ptyId: string,
    cwd: string,
    startedAt: number,
    targetWin: BrowserWindow,
    mode: 'new' | 'resume',
    baselinePaths = new Set<string>(),
    resumedSessionId?: string
  ): void {
    const sessionsDir = codexSessionsDir()
    fs.mkdirSync(sessionsDir, { recursive: true })

    const cleanup = () => {
      const pending = this.pendingCodexDetections.get(ptyId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pendingCodexDetections.delete(ptyId)
      this.ptyManager.off('exit', pending.onExit)
      this._stopCodexPollIfIdle()
    }

    const onExit = (exitId: string) => {
      if (exitId !== ptyId) return
      cleanup()
    }
    this.ptyManager.on('exit', onExit)

    const timeout = setTimeout(() => {
      cleanup()
      if (!targetWin.isDestroyed()) {
        targetWin.webContents.send('session:detection-failed', ptyId, 'codex', 'timeout', mode)
      }
    }, SESSION_DETECTION_TIMEOUT_MS)

    this.pendingCodexDetections.set(ptyId, {
      ptyId,
      cwd,
      normalizedCwd: normalizePath(cwd),
      startedAt,
      targetWin,
      mode,
      resumedSessionId,
      baselinePaths,
      inputBuffer: '',
      firstMessageAt: null,
      timeout,
      onExit,
    })
  }

  private _ensureCodexPoll(): void {
    if (!this._hasMessagedCodexPending()) return
    if (this.codexPollTimer) return
    this.codexPollTimer = setInterval(() => {
      void this._pollCodexDetections()
    }, CODEX_SESSION_POLL_MS)
    void this._pollCodexDetections()
  }

  private _stopCodexPollIfIdle(): void {
    if (this._hasMessagedCodexPending() || !this.codexPollTimer) return
    clearInterval(this.codexPollTimer)
    this.codexPollTimer = null
  }

  private _hasMessagedCodexPending(): boolean {
    return Array.from(this.pendingCodexDetections.values()).some((pending) => pending.firstMessageAt !== null)
  }

  private async _pollCodexDetections(): Promise<void> {
    if (this.codexPollInFlight || this.pendingCodexDetections.size === 0 || !this._hasMessagedCodexPending()) return
    this.codexPollInFlight = true
    try {
      const pending = Array.from(this.pendingCodexDetections.values())
      const candidates = await this._readNewCodexCandidates(pending)
      if (candidates.length === 0) return
      this._assignCodexCandidates(pending, candidates)
    } catch (err) {
      console.warn('[MultiAgent] Codex session detection poll failed:', err)
    } finally {
      this.codexPollInFlight = false
    }
  }

  private async _readNewCodexCandidates(pending: PendingCodexDetection[]): Promise<CodexRolloutCandidate[]> {
    const paths = await listCodexSessionFilePaths()
    const newPaths = paths.filter((filePath) =>
      !this.claimedCodexFiles.has(filePath) &&
      pending.some((p) => !p.baselinePaths.has(filePath))
    )
    const candidates: CodexRolloutCandidate[] = []
    for (const filePath of newPaths) {
      let meta = await readCodexSessionMeta(filePath)
      if (!meta) {
        await delay(250)
        meta = await readCodexSessionMeta(filePath)
      }
      if (!meta) continue
      if (meta.originator && meta.originator !== 'codex-tui') continue
      if (meta.source && meta.source !== 'cli') continue
      const timestampMs = meta.timestamp ? Date.parse(meta.timestamp) : NaN
      candidates.push({
        filePath,
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        normalizedCwd: normalizePath(meta.cwd),
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
      })
    }
    return candidates.sort((a, b) => a.timestampMs - b.timestampMs)
  }

  private _assignCodexCandidates(pending: PendingCodexDetection[], candidates: CodexRolloutCandidate[]): void {
    const cwdKeys = new Set<string>([
      ...pending.map((p) => p.normalizedCwd),
      ...candidates.map((c) => c.normalizedCwd),
    ])

    for (const cwdKey of cwdKeys) {
      const cwdPending = pending.filter((p) => this.pendingCodexDetections.has(p.ptyId) && p.normalizedCwd === cwdKey)
      if (cwdPending.length === 0) continue
      const cwdCandidates = candidates.filter((c) =>
        !this.claimedCodexFiles.has(c.filePath) &&
        c.normalizedCwd === cwdKey &&
        cwdPending.some((p) => codexCandidateMatchesPending(c, p))
      )
      if (cwdCandidates.length === 0) continue

      if (cwdPending.length === 1) {
        if (cwdPending[0].firstMessageAt === null) continue
        if (cwdCandidates.length === 1 && codexCandidateMatchesPending(cwdCandidates[0], cwdPending[0])) {
          this._claimCodexCandidate(cwdPending[0], cwdCandidates[0])
        } else {
          this._logCodexAmbiguity(cwdKey, cwdPending, cwdCandidates)
        }
        continue
      }

      const messagedPending = cwdPending.filter((p) => p.firstMessageAt !== null)
      if (messagedPending.length !== 1 || cwdCandidates.length !== 1) {
        this._logCodexAmbiguity(cwdKey, messagedPending, cwdCandidates)
        continue
      }

      const target = messagedPending[0]
      const candidate = cwdCandidates[0]
      if (codexCandidateMatchesPending(candidate, target)) {
        this._claimCodexCandidate(target, candidate)
      } else {
        this._logCodexAmbiguity(cwdKey, messagedPending, cwdCandidates)
      }
    }
  }

  private _claimCodexCandidate(pending: PendingCodexDetection, candidate: CodexRolloutCandidate): void {
    if (!this.pendingCodexDetections.has(pending.ptyId) || this.claimedCodexFiles.has(candidate.filePath)) return
    clearTimeout(pending.timeout)
    this.pendingCodexDetections.delete(pending.ptyId)
    this.claimedCodexFiles.add(candidate.filePath)
    this.ptyManager.off('exit', pending.onExit)
    this._stopCodexPollIfIdle()
    if (!pending.targetWin.isDestroyed()) {
      pending.targetWin.webContents.send('session:detected', pending.ptyId, 'codex', candidate.sessionId)
    }
  }

  private _logCodexAmbiguity(cwdKey: string, pending: PendingCodexDetection[], candidates: CodexRolloutCandidate[]): void {
    console.warn('[MultiAgent] Ambiguous Codex session detection; leaving pane(s) pending', {
      cwd: cwdKey,
      ptyIds: pending.map((p) => p.ptyId),
      candidateSessionIds: candidates.map((c) => c.sessionId),
    })
  }
}

async function snapshotCodexSessionPaths(): Promise<Set<string>> {
  const sessionsDir = codexSessionsDir()
  fs.mkdirSync(sessionsDir, { recursive: true })
  return new Set(await listCodexSessionFilePaths())
}

function codexCandidateMatchesPending(candidate: CodexRolloutCandidate, pending: PendingCodexDetection): boolean {
  if (pending.baselinePaths.has(candidate.filePath)) return false
  if (candidate.normalizedCwd !== pending.normalizedCwd) return false
  if (pending.resumedSessionId && candidate.sessionId === pending.resumedSessionId) return false
  if (candidate.timestampMs > 0 && candidate.timestampMs < pending.startedAt - SESSION_DETECTION_GRACE_MS) return false
  return true
}

function codexWriteContainsFirstMessageSubmit(pending: PendingCodexDetection, data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]
    if (ch === '\x1b') {
      // Alt+Enter is used for multiline input and should not count as a submit.
      if (data[i + 1] === '\r') {
        i++
        continue
      }
      i = skipEscapeSequence(data, i)
      continue
    }
    if (ch === '\r' || ch === '\n') {
      const hasMessage = pending.inputBuffer.trim().length > 0
      pending.inputBuffer = ''
      if (hasMessage) return true
      continue
    }
    if (ch === '\x7f' || ch === '\b') {
      pending.inputBuffer = pending.inputBuffer.slice(0, -1)
      continue
    }
    if (ch >= ' ') pending.inputBuffer += ch
  }
  return false
}

function skipEscapeSequence(data: string, start: number): number {
  const next = data[start + 1]
  if (next === '[') {
    let i = start + 2
    while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++
    return i
  }
  return start
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function newSessionCommand(agentKind: AgentKind, sessionId?: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs(sessionId)}`
  return `codex${codexCliArgs()}`
}

function resumeSessionCommand(agentKind: AgentKind, sessionId: string, cwd: string): string {
  if (agentKind === 'claude') return `claude${claudeCliArgs()} --resume ${shellArg(sessionId)}`
  return `codex resume${codexCliArgs()} -C ${shellArg(cwd)} ${shellArg(sessionId)}`
}

function claudeCliArgs(sessionId?: string): string {
  const mcpConfigPath = currentClaudeMcpConfigPath()
  const args: string[] = []
  if (mcpConfigPath) args.push('--mcp-config', shellArg(mcpConfigPath))
  if (sessionId) args.push('--session-id', shellArg(sessionId))
  return args.length ? ` ${args.join(' ')}` : ''
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

