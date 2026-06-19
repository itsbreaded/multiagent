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
const PROBE_READY_TIMEOUT_MS = 30_000
const PROBE_PARSE_TIMEOUT_MS = 10_000
// Wide probe dimensions: sized so /status boxes never truncate the UUID.
const PROBE_COLS = 240
const PROBE_ROWS = 24
// Codex idle detection: inject /status after this many ms with no PTY output.
const CODEX_IDLE_MS = 800
// Codex: delay between typing "/status" and sending Enter, so the command registers (and its
// autocomplete settles) before the \r — otherwise the \r is consumed as a composer newline.
const CODEX_SUBMIT_DELAY_MS = 250
// How long after readiness to inject /status for Claude.
const CLAUDE_INJECT_DELAY_MS = 200

// Signals that the CLI is ready to accept commands.
// Use prompt characters only — banner text appears too early in startup,
// before the input loop is ready to process slash commands.
const CLAUDE_READY_RE = /❯/
const CODEX_READY_RE = /›/

// Temporary probe diagnostics. Enable with PROBE_DEBUG=1 in the env that launches the app.
// Remove once probe detection is verified working in the real app.
const PROBE_DEBUG = !!process.env.PROBE_DEBUG
function probeDbg(...args: unknown[]): void {
  if (PROBE_DEBUG) console.log('[probe]', ...args)
}

// Read the rendered screen text from a headless xterm terminal, joining soft-wrapped rows
// so a UUID that spans the box border │ is still matched by SESSION_ID_RE.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readScreen(term: any): string {
  const buf = term.buffer?.active
  if (!buf) return ''
  // getLine() takes an ABSOLUTE buffer index, not a viewport-relative one. TUIs emit
  // newlines on startup that push the banner/prompt into scrollback, so the visible
  // viewport begins at buf.baseY. Reading from 0 would return blank scrollback lines and
  // miss the prompt/UUID entirely. Offset every read by baseY to read the visible screen.
  const base = buf.baseY ?? 0
  const lines: string[] = []
  let current = ''
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(base + y)
    if (!line) continue
    current += line.translateToString(true) // trimRight=true
    if (!line.isWrapped) {
      lines.push(current)
      current = ''
    }
  }
  if (current) lines.push(current)
  return lines.join('\n')
}

// Read the ENTIRE headless buffer (scrollback + viewport), joining soft-wrapped rows. Used for
// UUID capture: Codex's /status dialog scrolls up out of the viewport as the TUI pads with
// trailing newlines, so the Session line (and its UUID) may be in scrollback by the time we
// read. The UUID appears only once in the /status output, so scanning the whole buffer is safe
// and catches it regardless of scroll position. (Readiness detection still uses the viewport-only
// readScreen, since the prompt must be currently visible.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFullBuffer(term: any): string {
  const buf = term.buffer?.active
  if (!buf) return ''
  const lines: string[] = []
  let current = ''
  const total = buf.length
  for (let y = 0; y < total; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    current += line.translateToString(true)
    if (!line.isWrapped) {
      lines.push(current)
      current = ''
    }
  }
  if (current) lines.push(current)
  return lines.join('\n')
}

// Match any full UUID in the /status output. We reset the buffer before injection so the
// only UUID present will be the session ID. We do not anchor to "Session ID:" or "Session:"
// because Claude Code renders the dialog using cursor positioning — the UUID bytes may appear
// in the PTY stream before the label — and because Codex's box formatting is also cursor-driven.
const SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
// Fallback for Codex when the terminal is too narrow to show the final UUID segment.
const CODEX_SESSION_PREFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{6,})/i

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

  // Iterate pendings (not candidates) so each pane picks its best match.
  // This mirrors the Codex polling approach and correctly handles the case where
  // an external JSONL is also in the time window: the cwd bonus disambiguates.
  const assignments: Array<{ pending: PendingDetection; candidate: ClaudeFileCandidate; score: number }> = []

  for (const pending of pendingClaudeDetections) {
    const scored: Array<{ pending: PendingDetection; candidate: ClaudeFileCandidate; score: number }> = []
    for (const candidate of claudeFileCandidates.values()) {
      const score = scoreClaudeCandidate(pending, candidate)
      if (score !== null) scored.push({ pending, candidate, score })
    }
    if (scored.length === 0) continue

    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]

    // Reject a tie at the top score — two candidates with equal priority is ambiguous.
    if (scored.length > 1 && scored[1].score === best.score) continue

    assignments.push(best)
  }

  // Ensure no candidate is claimed by more than one pending (e.g. two panes same cwd).
  const candidateCounts = new Map<ClaudeFileCandidate, number>()
  for (const a of assignments) {
    candidateCounts.set(a.candidate, (candidateCounts.get(a.candidate) ?? 0) + 1)
  }

  for (const assignment of assignments) {
    if ((candidateCounts.get(assignment.candidate) ?? 0) !== 1) continue
    const stillPending = pendingClaudeDetections.includes(assignment.pending)
    const stillCandidate = claudeFileCandidates.get(assignment.candidate.filePath) === assignment.candidate
    if (!stillPending || !stillCandidate) continue

    assignment.pending.cleanup()
    claudeFileCandidates.delete(assignment.candidate.filePath)
    if (!assignment.pending.mainWindow.isDestroyed()) {
      assignment.pending.mainWindow.webContents.send('session:detected', assignment.pending.ptyId, 'claude', assignment.candidate.sessionId)
    }
  }
}

function scoreClaudeCandidate(pending: PendingDetection, candidate: ClaudeFileCandidate): number | null {
  // Hard time filter: file must not predate this pane's startup by more than the grace window.
  if (candidate.mtimeMs < pending.startedAt - SESSION_DETECTION_GRACE_MS) return null

  const timeDelta = Math.abs(candidate.mtimeMs - pending.startedAt)
  const timeScore = 10_000 - Math.min(timeDelta, 10_000)
  // cwd match is a strong positive bonus so the pane's own JSONL beats any external one,
  // but a cwd mismatch no longer hard-blocks detection when only one candidate exists.
  const cwdBonus = candidate.normalizedCwd === pending.normalizedCwd ? 20_000 : 0
  return cwdBonus + timeScore
}

export class SessionSpawner {
  constructor(private ptyManager: PtyManager, private mainWindow: BrowserWindow) {}

  async spawnNew(agentKind: AgentKind, cwd: string, senderWin?: BrowserWindow): Promise<{ ptyId: string; sessionId: string | null; detectionStartedAt: number }> {
    const targetWin = senderWin ?? this.mainWindow
    const startedAt = Date.now()
    // createDeferred falls back to homedir() when cwd doesn't exist; match that here
    // so pending.normalizedCwd agrees with what the agent will record in its JSONL.
    const actualCwd = fs.existsSync(cwd) ? cwd : os.homedir()
    const ptyId = this.ptyManager.createDeferred(
      cwd,
      agentLaunchCommand(newSessionCommand(agentKind)),
      agentEnv(agentKind)
    )

    // Filesystem detection runs as fallback; probe cancels it on success.
    const cancelFilesystem = this._watchForNewSession(agentKind, ptyId, actualCwd, startedAt, targetWin)

    this._probeSessionIdViaPty(
      agentKind,
      ptyId,
      (raw) => {
        cancelFilesystem()
        if (raw.length >= 36) {
          // Full UUID captured — emit immediately for both agents
          if (!targetWin.isDestroyed()) {
            targetWin.webContents.send('session:detected', ptyId, agentKind, raw)
          }
        } else {
          // Codex-only: truncated prefix — poll JSONL files until full ID appears
          this._resolveCodexByPrefix(
            raw,
            (fullId) => {
              if (!targetWin.isDestroyed()) {
                targetWin.webContents.send('session:detected', ptyId, 'codex', fullId)
              }
            },
            () => { /* prefix resolution timed out */ }
          )
        }
      },
      () => { /* probe failed or timed out; filesystem fallback continues */ }
    )

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
      // Codex resume can fork to a new rollout ID. Detect that via the filesystem watcher
      // ONLY — never inject /status into a resumed session, because Codex renders /status
      // inline into the live transcript and it pollutes the user's real chat history.
      // If no fork appears, the pane keeps its known session ID and the watcher times out
      // silently (see the 'resume' branch in _watchForNewCodexSession).
      this._watchForNewCodexSession(ptyId, cwd, startedAt, targetWin, 'resume', sessionId)
    }
    return { ptyId }
  }

  private _watchForNewSession(agentKind: AgentKind, ptyId: string, cwd: string, startedAt: number, targetWin: BrowserWindow): () => void {
    if (agentKind === 'codex') {
      return this._watchForNewCodexSession(ptyId, cwd, startedAt, targetWin, 'new')
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
    return cleanup
  }

  private _watchForNewCodexSession(ptyId: string, cwd: string, startedAt: number, targetWin: BrowserWindow, mode: 'new' | 'resume', resumedSessionId?: string): () => void {
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
      // Resume: no fork appeared within the window, so the pane keeps its known session ID.
      // That is the normal successful case — do not surface a detection failure.
      if (mode === 'resume') return
      if (!targetWin.isDestroyed()) {
        targetWin.webContents.send('session:detection-failed', ptyId, 'codex', 'timeout', mode)
      }
    }, SESSION_DETECTION_TIMEOUT_MS)

    return cleanup
  }

  // Primary session detection: inject /status into the running CLI and read the session ID
  // off the rendered screen via a headless xterm terminal. Using the screen model instead of
  // raw byte stream avoids the cursor-addressing interleave that broke UUID detection in both
  // Claude and Codex. The PTY is widened to PROBE_COLS before injection so the /status box
  // never truncates the UUID, then restored to its original size after capture.
  private async _probeSessionIdViaPty(
    agentKind: AgentKind,
    ptyId: string,
    onCaptured: (raw: string) => void,
    onFailed: () => void
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let headless: any
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = await import('@xterm/headless') as any
      // @xterm/headless is a webpacked CJS bundle with no "exports" map, so a dynamic
      // import() exposes the constructor under `.default` (the module.exports object),
      // not on the namespace root. Resolve both shapes.
      const TerminalCtor = m.Terminal ?? m.default?.Terminal ?? m.default
      headless = new TerminalCtor({ cols: PROBE_COLS, rows: PROBE_ROWS, allowProposedApi: true })
      probeDbg('start', agentKind, ptyId, 'headless created; ptyLastSize=', JSON.stringify(this.ptyManager.getPtyLastSize(ptyId)))
    } catch (err) {
      probeDbg('headless construction failed', agentKind, ptyId, err)
      onFailed()
      return
    }

    let headlessDisposed = false
    type ProbeState = 'waiting_ready' | 'injecting' | 'waiting_status' | 'done'
    let state: ProbeState = 'waiting_ready'
    let cancelled = false
    let widened = false
    let savedSize = { cols: 80, rows: PROBE_ROWS }
    let parseTimeoutId: ReturnType<typeof setTimeout> | null = null
    let idleTimerId: ReturnType<typeof setTimeout> | null = null
    let stallDumpId: ReturnType<typeof setTimeout> | null = null

    const readyRe = agentKind === 'claude' ? CLAUDE_READY_RE : CODEX_READY_RE

    const restoreSize = (): void => {
      if (!widened) return
      widened = false
      this.ptyManager.resize(ptyId, savedSize.cols, savedSize.rows)
    }

    const disposeHeadless = (): void => {
      if (headlessDisposed) return
      headlessDisposed = true
      try { headless.dispose() } catch { /* ignore */ }
    }

    // cancelProbeCore: tears down listeners/timers/headless but does NOT restore size.
    // Used in the capture path so the caller can schedule restoreSize after Escape.
    const cancelProbeCore = (): void => {
      if (cancelled) return
      cancelled = true
      this.ptyManager.off('data', onData)
      clearTimeout(readyTimeoutId)
      if (parseTimeoutId !== null) clearTimeout(parseTimeoutId)
      if (idleTimerId !== null) clearTimeout(idleTimerId)
      if (stallDumpId !== null) clearTimeout(stallDumpId)
      disposeHeadless()
    }

    const cancelProbe = (): void => {
      cancelProbeCore()
      restoreSize()
    }

    const injectStatus = (): void => {
      // Only inject once, and only out of the 'injecting' state. Idempotent so no path
      // (idle timer, Claude delay) can fire a second /status — Codex renders /status inline
      // into the live transcript, so a duplicate injection visibly pollutes the session.
      if (cancelled || state !== 'injecting') return
      state = 'waiting_status'
      probeDbg('injecting /status', agentKind, ptyId)
      if (agentKind === 'codex') {
        // Codex opens a slash-command autocomplete as the text is typed. Sending the command
        // and Enter in one chunk lets the \r land before the command registers, so it inserts
        // a newline instead of executing. Type the text first, let the composer settle, then
        // send Enter as a separate key event.
        this.ptyManager.write(ptyId, '/status')
        setTimeout(() => {
          if (!cancelled && state === 'waiting_status') this.ptyManager.write(ptyId, '\r')
        }, CODEX_SUBMIT_DELAY_MS)
      } else {
        this.ptyManager.write(ptyId, '/status\r')
      }
      parseTimeoutId = setTimeout(() => {
        probeDbg('PARSE TIMEOUT — no UUID found after /status', agentKind, ptyId)
        if (PROBE_DEBUG && !headlessDisposed) {
          probeDbg('FULL SCREEN at parse-timeout:\n' + readScreen(headless))
          probeDbg('RAW TAIL (escaped):\n' + JSON.stringify(rawAll.slice(-2500)))
        }
        cancelProbe()
        onFailed()
      }, PROBE_PARSE_TIMEOUT_MS)
      // No retry: the idle gate (Codex) / settle delay (Claude) makes the single injection
      // reliable, and filesystem detection runs in parallel as the fallback. Re-injecting
      // /status would pollute the transcript with a duplicate command.
    }

    const armCodexIdle = (): void => {
      if (idleTimerId !== null) clearTimeout(idleTimerId)
      idleTimerId = setTimeout(() => {
        idleTimerId = null
        injectStatus()
      }, CODEX_IDLE_MS)
    }

    // One-shot diagnostic: if we're still waiting for readiness a few seconds after the
    // first data, dump what the (possibly stalled) pane has emitted — captures the stall
    // signature without waiting for the full 30s ready timeout.
    if (PROBE_DEBUG) {
      stallDumpId = setTimeout(() => {
        stallDumpId = null
        if (cancelled || state !== 'waiting_ready' || headlessDisposed) return
        probeDbg('STALL (still waiting_ready)', agentKind, ptyId, `chunks=${dataChunks}`)
        probeDbg('STALL RAW (escaped):\n' + JSON.stringify(rawAll.slice(-1500)))
      }, 2500)
    }

    const readyTimeoutId = setTimeout(() => {
      probeDbg('READY TIMEOUT — prompt never detected', agentKind, ptyId, `chunks=${dataChunks}`)
      if (PROBE_DEBUG && !headlessDisposed) {
        const buf = headless.buffer?.active
        probeDbg('cursor', `cursorX=${buf?.cursorX} cursorY=${buf?.cursorY} baseY=${buf?.baseY} length=${buf?.length} rows=${headless.rows} cols=${headless.cols}`)
        probeDbg('FULL SCREEN at ready-timeout:\n' + readScreen(headless))
        probeDbg('RAW TAIL (escaped):\n' + JSON.stringify(rawAll.slice(-2500)))
      }
      cancelProbe()
      onFailed()
    }, PROBE_READY_TIMEOUT_MS)

    let dataChunks = 0
    let rawAll = ''
    const onData = (id: string, data: string): void => {
      if (id !== ptyId || cancelled) return
      if (PROBE_DEBUG) rawAll = (rawAll + data).slice(-6000)

      // Codex idle detection: reset the timer on every raw data arrival while settling.
      // This keeps the idle window open as long as the TUI is still painting.
      if (state === 'injecting' && agentKind === 'codex') armCodexIdle()

      if (headlessDisposed) return

      // Mirror the real pane geometry until we widen for /status. Cursor-addressed TUIs
      // (Codex/ratatui) lay out the composer against the real terminal height and pad with
      // trailing newlines; if the headless buffer is a different height, those newlines
      // scroll the composer out of the viewport before we can read it. Keeping the headless
      // size equal to the PTY size makes the rendered screen match what the user sees.
      // The PTY spawns at 80x24 (createDeferred); the renderer fits it shortly after, so
      // getPtyLastSize may be undefined for the first few chunks — fall back to 80x24.
      if (!widened) {
        const sz = this.ptyManager.getPtyLastSize(ptyId) ?? { cols: 80, rows: 24 }
        if (headless.cols !== sz.cols || headless.rows !== sz.rows) {
          try { headless.resize(sz.cols, sz.rows) } catch { /* ignore */ }
        }
      }

      dataChunks++
      headless.write(data, () => {
        if (cancelled || headlessDisposed) return

        // Codex: also reset after write processing so injection waits until the write
        // queue is fully drained (i.e., truly idle, not just between raw chunks).
        if (state === 'injecting' && agentKind === 'codex') {
          armCodexIdle()
          return
        }

        if (state === 'waiting_ready') {
          const screen = readScreen(headless)
          if (!readyRe.test(screen)) return
          probeDbg('READY matched', agentKind, ptyId, `chunks=${dataChunks}`)

          state = 'injecting'
          clearTimeout(readyTimeoutId)
          // Capture real pane size BEFORE widening so we can restore it.
          savedSize = this.ptyManager.getPtyLastSize(ptyId) ?? { cols: 80, rows: PROBE_ROWS }
          widened = true
          this.ptyManager.resize(ptyId, PROBE_COLS, PROBE_ROWS)
          // Snap the headless buffer to the widened PTY size so the /status dialog renders
          // at full width (no UUID truncation) and matches the PTY geometry.
          try { headless.resize(PROBE_COLS, PROBE_ROWS) } catch { /* ignore */ }

          if (agentKind === 'codex') {
            armCodexIdle()
          } else {
            setTimeout(() => injectStatus(), CLAUDE_INJECT_DELAY_MS)
          }
        } else if (state === 'waiting_status') {
          // Scan the whole buffer (incl. scrollback): the /status dialog scrolls out of the
          // viewport as Codex pads with newlines, so the UUID may not be currently visible.
          const screen = readFullBuffer(headless)
          const fullMatch = SESSION_ID_RE.exec(screen)
          const match = fullMatch ?? (agentKind === 'codex' ? CODEX_SESSION_PREFIX_RE.exec(screen) : null)
          if (!match) return

          state = 'done'
          const captured = match[1]
          probeDbg('UUID captured', agentKind, ptyId, captured, fullMatch ? '(full)' : '(prefix)')
          cancelProbeCore() // stop listening; restoreSize deferred below

          if (agentKind === 'claude') {
            // Two Escapes to dismiss the /status dialog; restore size after the second.
            this.ptyManager.write(ptyId, '\x1b')
            setTimeout(() => {
              this.ptyManager.write(ptyId, '\x1b')
              restoreSize()
            }, 350)
          } else {
            restoreSize()
          }
          onCaptured(captured)
        }
      })
    }

    this.ptyManager.on('data', onData)
  }

  // After the Codex /status probe captures a UUID prefix, poll JSONL files until a session
  // whose full ID starts with that prefix appears. The prefix is unique enough in practice
  // (8+ hex chars = billions of possibilities) that collision across a user's sessions is
  // effectively impossible.
  private _resolveCodexByPrefix(
    prefix: string,
    onDetected: (sessionId: string) => void,
    onFailed: () => void
  ): void {
    let cancelled = false
    const scanner = new CodexSessionScanner()

    const cleanup = (): void => {
      if (cancelled) return
      cancelled = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
    }

    const timeout = setTimeout(() => {
      cleanup()
      onFailed()
    }, SESSION_DETECTION_TIMEOUT_MS)

    const pollTimer = setInterval(() => {
      void scanner.scanAll().then((sessions) => {
        if (cancelled) return
        const match = sessions.find((s) => s.sessionId.startsWith(prefix))
        if (!match) return
        cleanup()
        onDetected(match.sessionId)
      }).catch(() => {})
    }, 500)
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
  // --no-alt-screen / animations / title flags reduce cursor redraw flicker in xterm panes.
  // (Removing --no-alt-screen was tried during the spec-008 investigation to make Codex render in
  // a fixed buffer like Claude; it did not fix the concurrent-pane issue, so the flag is kept.)
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

