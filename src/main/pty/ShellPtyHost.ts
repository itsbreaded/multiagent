import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PtyReadyEvent } from './PtyManager'

type WorkerMessage =
  | { type: 'spawn'; id: string; cwd: string; cols: number; rows: number; env: Record<string, string> }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'ready'; id: string; pid: number | null; cwd: string; windowsPty?: PtyReadyEvent['windowsPty'] }
  | { type: 'exit'; id: string; exitCode: number | null; signal?: number }
  | { type: 'error'; id: string; message: string }

export class ShellPtyHost extends EventEmitter {
  private worker: ChildProcess
  private ids = new Set<string>()
  private readyEvents = new Map<string, PtyReadyEvent>()

  constructor() {
    super()
    this.worker = spawn(process.execPath, [join(__dirname, 'shellWorker.js')], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    })

    this.worker.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text.includes('AttachConsole failed')) return
      console.error('[shellWorker stderr]', text)
    })

    this.worker.on('message', (message: ParentMessage) => {
      switch (message.type) {
        case 'data':
          this.emit('data', message.id, message.data)
          break
        case 'ready': {
          const readyEvent: PtyReadyEvent = {
            id: message.id,
            pid: message.pid,
            cwd: message.cwd,
            windowsPty: message.windowsPty,
          }
          this.readyEvents.set(message.id, readyEvent)
          this.emit('ready', readyEvent)
          break
        }
        case 'exit':
          this.ids.delete(message.id)
          this.readyEvents.delete(message.id)
          this.emit('exit', message.id, message.exitCode ?? 0, message.signal)
          break
        case 'error':
          this.emit('error', message.id, new Error(message.message))
          break
      }
    })
  }

  create(cwd: string, size: { cols: number; rows: number }): string {
    const id = randomUUID()
    this.ids.add(id)
    this.send({
      type: 'spawn',
      id,
      cwd: existsSync(cwd) ? cwd : homedir(),
      cols: size.cols,
      rows: size.rows,
      env: buildShellEnv(),
    })
    return id
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  getReadyEvent(id: string): PtyReadyEvent | undefined {
    return this.readyEvents.get(id)
  }

  write(id: string, data: string): void {
    this.send({ type: 'write', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: 'resize', id, cols, rows })
  }

  kill(id: string): void {
    this.ids.delete(id)
    this.readyEvents.delete(id)
    this.send({ type: 'kill', id })
  }

  destroy(): void {
    this.worker.kill()
  }

  private send(message: WorkerMessage): void {
    this.worker.send(message)
  }
}

function buildShellEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'vscode'
  return env
}

