/**
 * PTY Worker Process
 *
 * Spawned by PtyManager via child_process.spawn with ELECTRON_RUN_AS_NODE=1
 * so that PTYs are created outside Electron's main process. This keeps
 * Chromium's internal handles out of the ConPTY process tree — without this
 * isolation, claude (a Bun binary) crashes on startup with exit code 1.
 */

import * as pty from 'node-pty'
import { appendFileSync, existsSync } from 'fs'
import { homedir, release } from 'os'
import { basename, join } from 'path'
import { defaultShell } from './shell'

// Temporary first-time-macOS diagnostics. Gated to E2E runs only (the env var is set
// exclusively by startup.spec.ts) so production is unaffected. Electron main-process stderr
// is captured by Playwright and never reaches the CI step log, so also append each line to
// <userDataDir>/ptydbg.log, which the test's afterEach reads and console.logs (test-side
// console DOES appear in Playwright output). Remove once macOS PTY is green.
const e2eUserDataDir = process.env.MULTIAGENT_E2E_USER_DATA_DIR
const E2E_DEBUG = !!e2eUserDataDir
const dbgLogPath = e2eUserDataDir ? join(e2eUserDataDir, 'ptydbg.log') : null
function dbg(label: string, extra?: unknown): void {
  if (!E2E_DEBUG) return
  const detail = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
  const line = `[ptydbg] ${label}${detail}`
  console.error(line)
  try { appendFileSync(dbgLogPath!, line + '\n') } catch { /* ignore */ }
}
dbg('worker started', { platform: process.platform, shell: defaultShell(), nodePty: !!pty })

type WorkerMessage =
  | { type: 'spawn'; id: string; cwd: string; cmd: string[]; env: Record<string, string>; cols: number; rows: number; allowCwdFallback?: boolean }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }
  | { type: 'shutdown' }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'ready'; id: string; pid: number | null; cwd: string; windowsPty?: WindowsPtyTraits }
  | { type: 'error'; id: string; message: string }
  | { type: 'shutdown-complete' }

const instances = new Map<string, pty.IPty>()
let shuttingDown = false
let shutdownTimer: NodeJS.Timeout | null = null

interface WindowsPtyTraits {
  backend: 'conpty'
  buildNumber: number
}

function send(msg: ParentMessage) {
  process.send!(msg)
}

process.on('message', (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'spawn': {
      const shell = msg.cmd[0] ?? defaultShell()
      const args = msg.cmd.slice(1)
      const cwdExists = existsSync(msg.cwd)
      dbg('spawn', { id: msg.id, shell, args, cwd: msg.cwd, cwdExists, cols: msg.cols, rows: msg.rows })
      if (!cwdExists && !msg.allowCwdFallback) {
        dbg('spawn rejected (cwd missing)', { id: msg.id })
        send({ type: 'error', id: msg.id, message: `Working directory does not exist: ${msg.cwd}` })
        break
      }
      const safeCwd = cwdExists ? msg.cwd : homedir()
      const name = process.platform === 'win32' ? basename(shell) : 'xterm-256color'

      try {
        const ptyProcess = pty.spawn(shell, args, {
          name,
          cols: msg.cols,
          rows: msg.rows,
          cwd: safeCwd,
          env: msg.env,
          ...(process.platform === 'win32' ? {
            useConpty: windowsBuildNumber() >= 18309,
            conptyInheritCursor: false,
          } : {}),
        })
        dbg('spawned', { id: msg.id, pid: ptyProcess.pid })

        let dataSeen = false
        ptyProcess.onData((data) => {
          if (!dataSeen) { dataSeen = true; dbg('first data', { id: msg.id, bytes: data.length }) }
          send({ type: 'data', id: msg.id, data })
        })
        ptyProcess.onExit(({ exitCode, signal }) => {
          dbg('exit', { id: msg.id, exitCode, signal })
          instances.delete(msg.id)
          send({ type: 'exit', id: msg.id, exitCode, signal })
          finishShutdownIfReady()
        })

        instances.set(msg.id, ptyProcess)
        sendReadyWhenPidIsAvailable(msg.id, ptyProcess, safeCwd)
      } catch (err) {
        dbg('spawn threw', { id: msg.id, error: String(err) })
        send({ type: 'error', id: msg.id, message: String(err) })
      }
      break
    }

    case 'write': {
      instances.get(msg.id)?.write(msg.data)
      break
    }

    case 'resize': {
      try {
        instances.get(msg.id)?.resize(msg.cols, msg.rows)
      } catch { /* ignore */ }
      break
    }

    case 'kill': {
      const inst = instances.get(msg.id)
      if (inst) {
        inst.kill()
        instances.delete(msg.id)
      }
      break
    }

    case 'shutdown': {
      if (shuttingDown) break
      shuttingDown = true
      for (const inst of instances.values()) {
        try { inst.kill() } catch { /* process may already be exiting */ }
      }
      shutdownTimer = setTimeout(finishShutdown, 1500)
      finishShutdownIfReady()
      break
    }
  }
})

function finishShutdownIfReady(): void {
  if (shuttingDown && instances.size === 0) finishShutdown()
}

function finishShutdown(): void {
  if (!shuttingDown) return
  shuttingDown = false
  if (shutdownTimer) clearTimeout(shutdownTimer)
  shutdownTimer = null
  try { send({ type: 'shutdown-complete' }) } catch { /* parent may have exited */ }
  setImmediate(() => process.exit(0))
}

function sendReadyWhenPidIsAvailable(id: string, ptyProcess: pty.IPty, cwd: string): void {
  const sendReady = () => {
    dbg('sending ready', { id, pid: ptyProcess.pid })
    send({
      type: 'ready',
      id,
      pid: ptyProcess.pid > 0 ? ptyProcess.pid : null,
      cwd,
      windowsPty: process.platform === 'win32'
        ? { backend: 'conpty', buildNumber: windowsBuildNumber() }
        : undefined,
    })
  }

  if (ptyProcess.pid > 0 || process.platform !== 'win32') {
    sendReady()
    return
  }

  const disposable = ptyProcess.onData(() => {
    disposable.dispose()
    sendReady()
  })
}

function windowsBuildNumber(): number {
  const build = Number.parseInt(release().split('.')[2] ?? '0', 10)
  return Number.isFinite(build) ? build : 0
}

