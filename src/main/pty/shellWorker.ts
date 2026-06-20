import * as pty from 'node-pty'
import { existsSync } from 'fs'
import { homedir, release } from 'os'
import { basename } from 'path'
import { defaultShell } from './shell'
import { shellIntegrationCommand } from './terminalEnvironment'

type WorkerMessage =
  | { type: 'spawn'; id: string; cwd: string; cols: number; rows: number; env: Record<string, string> }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'ready'; id: string; pid: number | null; cwd: string; windowsPty?: { backend: 'conpty'; buildNumber: number } }
  | { type: 'exit'; id: string; exitCode: number | null; signal?: number }
  | { type: 'error'; id: string; message: string }

const instances = new Map<string, pty.IPty>()
const pendingInput = new Map<string, string[]>()
const pendingResize = new Map<string, { cols: number; rows: number }>()

function send(message: ParentMessage): void {
  process.send?.(message)
}

process.on('message', (message: WorkerMessage) => {
  switch (message.type) {
    case 'spawn':
      spawnShell(message)
      break
    case 'write': {
      const instance = instances.get(message.id)
      if (instance) {
        instance.write(message.data)
      } else {
        const queue = pendingInput.get(message.id) ?? []
        queue.push(message.data)
        pendingInput.set(message.id, queue)
      }
      break
    }
    case 'resize': {
      const instance = instances.get(message.id)
      if (instance) {
        try { instance.resize(message.cols, message.rows) } catch { /* ignore */ }
      } else {
        pendingResize.set(message.id, { cols: message.cols, rows: message.rows })
      }
      break
    }
    case 'kill': {
      pendingInput.delete(message.id)
      pendingResize.delete(message.id)
      const instance = instances.get(message.id)
      if (instance) {
        instances.delete(message.id)
        instance.kill()
      }
      break
    }
  }
})

function spawnShell(message: Extract<WorkerMessage, { type: 'spawn' }>): void {
  const safeCwd = existsSync(message.cwd) ? message.cwd : homedir()
  const shell = process.platform === 'win32' ? 'powershell.exe' : defaultShell()
  const args = process.platform === 'win32' ? shellIntegrationCommand() : []
  const buildNumber = windowsBuildNumber()

  try {
    const instance = pty.spawn(shell, args, {
      name: process.platform === 'win32' ? basename(shell) : 'xterm-256color',
      cwd: safeCwd,
      cols: message.cols,
      rows: message.rows,
      env: message.env,
      ...(process.platform === 'win32' ? {
        useConpty: buildNumber >= 18309,
        conptyInheritCursor: false,
      } : {}),
    })

    instances.set(message.id, instance)
    instance.onData((data) => send({ type: 'data', id: message.id, data }))
    instance.onExit(({ exitCode, signal }) => {
      instances.delete(message.id)
      pendingInput.delete(message.id)
      pendingResize.delete(message.id)
      send({ type: 'exit', id: message.id, exitCode, signal })
    })

    const resize = pendingResize.get(message.id)
    if (resize) {
      pendingResize.delete(message.id)
      try { instance.resize(resize.cols, resize.rows) } catch { /* ignore */ }
    }
    const input = pendingInput.get(message.id)
    if (input) {
      pendingInput.delete(message.id)
      for (const data of input) instance.write(data)
    }

    send({
      type: 'ready',
      id: message.id,
      pid: instance.pid > 0 ? instance.pid : null,
      cwd: safeCwd,
      windowsPty: process.platform === 'win32'
        ? { backend: 'conpty', buildNumber }
        : undefined,
    })
  } catch (error) {
    send({ type: 'error', id: message.id, message: String(error) })
  }
}

function windowsBuildNumber(): number {
  const build = Number.parseInt(release().split('.')[2] ?? '0', 10)
  return Number.isFinite(build) ? build : 0
}

