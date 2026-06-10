/**
 * PTY Worker Process
 *
 * Spawned by PtyManager via child_process.spawn with ELECTRON_RUN_AS_NODE=1
 * so that PTYs are created outside Electron's main process. This keeps
 * Chromium's internal handles out of the ConPTY process tree — without this
 * isolation, claude (a Bun binary) crashes on startup with exit code 1.
 */

import * as pty from 'node-pty'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { defaultShell } from './shell'

type WorkerMessage =
  | { type: 'spawn'; id: string; cwd: string; cmd: string[]; env: Record<string, string>; cols: number; rows: number }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'kill'; id: string }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'ready'; id: string }
  | { type: 'error'; id: string; message: string }

const instances = new Map<string, pty.IPty>()

function send(msg: ParentMessage) {
  process.send!(msg)
}

process.on('message', (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'spawn': {
      const shell = msg.cmd[0] ?? defaultShell()
      const args = msg.cmd.slice(1)
      const safeCwd = existsSync(msg.cwd) ? msg.cwd : homedir()
      const name = process.platform === 'win32' ? basename(shell) : 'xterm-256color'

      try {
        const ptyProcess = pty.spawn(shell, args, {
          name,
          cols: msg.cols,
          rows: msg.rows,
          cwd: safeCwd,
          env: msg.env,
        })

        ptyProcess.onData((data) => send({ type: 'data', id: msg.id, data }))
        ptyProcess.onExit(({ exitCode, signal }) => {
          instances.delete(msg.id)
          send({ type: 'exit', id: msg.id, exitCode, signal })
        })

        instances.set(msg.id, ptyProcess)
        send({ type: 'ready', id: msg.id })
      } catch (err) {
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

    case 'pause': {
      instances.get(msg.id)?.pause()
      break
    }

    case 'resume': {
      instances.get(msg.id)?.resume()
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
  }
})

