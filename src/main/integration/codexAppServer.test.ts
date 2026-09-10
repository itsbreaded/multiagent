import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { CodexAppServerManager } from './codexAppServer'

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn(() => {
    this.exitCode = 0
    this.emit('close', 0, null)
  })
}

function asChildProcess(process: FakeProcess): ChildProcessWithoutNullStreams {
  return process as unknown as ChildProcessWithoutNullStreams
}

type FakeProtocolState = {
  background: Record<string, unknown>[]
  threads: Record<string, unknown>[]
  failBackground: boolean
  responseDelay: number
  requests?: Array<{ method?: string; params?: Record<string, unknown> }>
  pagination?: {
    background: Array<{ data: Record<string, unknown>[]; nextCursor: unknown }>
    threads: Array<{ data: Record<string, unknown>[]; nextCursor: unknown }>
  }
}

function serverMessage(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function attachStdioProtocol(server: FakeProcess, state: FakeProtocolState): void {
  let input = ''
  server.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString()
    let newline = input.indexOf('\n')
    while (newline >= 0) {
      const line = input.slice(0, newline).replace(/\r$/, '')
      input = input.slice(newline + 1)
      if (!line.trim()) {
        newline = input.indexOf('\n')
        continue
      }
      const request = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
      state.requests?.push({ method: request.method, params: request.params })
      if (request.id === undefined) {
        newline = input.indexOf('\n')
        continue
      }
      const respond = (value: unknown): void => {
        const message = `${JSON.stringify(value)}\n`
        if (state.responseDelay > 0) setTimeout(() => server.stdout.write(message), state.responseDelay)
        else server.stdout.write(message)
      }
      let result: unknown = {}
      if (request.method === 'thread/backgroundTerminals/list') {
        if (state.failBackground) {
          respond({ jsonrpc: '2.0', id: request.id, error: { message: 'unsupported' } })
          newline = input.indexOf('\n')
          continue
        }
        const pages = state.pagination?.background
        result = pages
          ? (pages[request.params?.cursor ? 1 : 0] ?? { data: [], nextCursor: null })
          : { data: state.background, nextCursor: null }
      } else if (request.method === 'thread/list') {
        const ancestor = typeof request.params?.ancestorThreadId === 'string' ? request.params.ancestorThreadId : undefined
        const pages = state.pagination?.threads
        result = pages
          ? (pages[request.params?.cursor ? 1 : 0] ?? { data: [], nextCursor: null })
          : { data: ancestor ? state.threads.filter((item) => item.parentThreadId === ancestor) : state.threads, nextCursor: null }
      }
      respond({ jsonrpc: '2.0', id: request.id, result })
      newline = input.indexOf('\n')
    }
  })
}

function waitForReports(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

describe('Codex App Server status observer', () => {
  it('binds the pane session, reconciles nested turn events, and protects background terminals', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-test-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: false, responseDelay: 0, requests: [],
    }
    const reports: Array<Record<string, unknown>> = []
    let server: FakeProcess | undefined
    let serverArgs: string[] | undefined
    const manager = new CodexAppServerManager({
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          serverArgs = args
          server = new FakeProcess()
          attachStdioProtocol(server, state)
          return asChildProcess(server)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })

    try {
      const prepared = await manager.prepare('pty-1', directory, {})
      expect(prepared).toEqual({ observerReady: true })
      expect(serverArgs).toEqual(['app-server', '--listen', 'stdio://'])
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', sessionId: 'thread-1' })
      expect((reports.at(-1) as any).evidence).toMatchObject({ completeness: 'complete', activeCount: 0, scheduledCount: 0 })

      server!.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1', threadId: 'thread-1', status: 'inProgress' } } })}\n`)
      expect((reports.at(-1) as any).evidence).toMatchObject({ terminalState: 'busy', activeCount: 1, turnId: 'turn-1' })

      state.background = [{ processId: 'background-1' }]
      state.threads = [
        { id: 'thread-1', status: { type: 'idle' } },
        { id: 'unrelated-1', status: { type: 'active' } },
        { id: 'child-1', parentThreadId: 'thread-1', status: { type: 'active' } },
      ]
      server!.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1', threadId: 'thread-1', status: 'interrupted' } } })}\n`)
      await waitForReports()
      expect((reports.at(-1) as any).evidence).toMatchObject({ terminalState: 'interrupted', completeness: 'complete', activeCount: 1, scheduledCount: 1, activeIds: ['child-1'] })

      manager.bindSession('pty-1', 'thread-2')
      await waitForReports()
      expect(state.requests).toContainEqual({ method: 'thread/unsubscribe', params: { threadId: 'thread-1' } })
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', sessionId: 'thread-2' })
    } finally {
      await manager.dispose()
      expect(server?.kill).toHaveBeenCalled()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('emits incomplete protective evidence when a provider query is unsupported', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-fallback-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: true, responseDelay: 0,
    }
    const reports: Array<Record<string, unknown>> = []
    const manager = new CodexAppServerManager({
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          attachStdioProtocol(process, state)
          return asChildProcess(process)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })
    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      expect((reports.at(-1) as any).evidence).toMatchObject({ completeness: 'incomplete', activeCount: 1 })
    } finally {
      await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('follows provider cursors and fails closed on malformed pagination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-pagination-'))
    const state: FakeProtocolState = {
      background: [], threads: [], failBackground: false, responseDelay: 0,
      pagination: {
        background: [{ data: [{ processId: 'background-1' }], nextCursor: 'background-page-2' }, { data: [{ processId: 'background-2' }], nextCursor: null }],
        threads: [{ data: [{ id: 'child-1', parentThreadId: 'thread-1', status: { type: 'active' } }], nextCursor: null }],
      },
    }
    const reports: Array<Record<string, unknown>> = []
    const manager = new CodexAppServerManager({
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          attachStdioProtocol(process, state)
          return asChildProcess(process)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })

    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      expect((reports.at(-1) as any).evidence).toMatchObject({ completeness: 'complete', activeCount: 1, scheduledCount: 2 })

      state.pagination!.background[0].nextCursor = 42
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      expect((reports.at(-1) as any).evidence).toMatchObject({ completeness: 'incomplete', activeCount: 1 })
    } finally {
      await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('marks a server disconnect protective and performs one bounded reconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-reconnect-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: false, responseDelay: 0,
    }
    const servers: FakeProcess[] = []
    const reports: Array<Record<string, unknown>> = []
    const manager = new CodexAppServerManager({
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          servers.push(process)
          attachStdioProtocol(process, state)
          return asChildProcess(process)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })

    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      servers[0].emit('error', new Error('server disconnected'))
      await waitForReports()
      expect(servers).toHaveLength(2)
      expect(reports.some((report) => {
        const evidence = report.evidence as Record<string, unknown> | undefined
        return report.event === 'work_snapshot' && evidence?.completeness === 'incomplete' && evidence.activeCount === 1
      })).toBe(true)
    } finally {
      await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('drops a late snapshot from an interrupted turn after a newer turn starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-stale-turn-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: false, responseDelay: 0,
    }
    const reports: Array<Record<string, unknown>> = []
    let server: FakeProcess | undefined
    const manager = new CodexAppServerManager({
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          server = new FakeProcess()
          attachStdioProtocol(server, state)
          return asChildProcess(server)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })

    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()

      server!.stdout.write(serverMessage({ method: 'turn/started', params: { turn: { id: 'turn-old', threadId: 'thread-1', status: 'inProgress' } } }))
      state.responseDelay = 30
      server!.stdout.write(serverMessage({ method: 'turn/started', params: { turn: { id: 'turn-new', threadId: 'thread-1', status: 'inProgress' } } }))
      server!.stdout.write(serverMessage({ method: 'turn/started', params: { turn: { id: 'turn-old', threadId: 'thread-1', status: 'inProgress' } } }))
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', turnId: 'turn-new' })
      server!.stdout.write(serverMessage({ method: 'turn/completed', params: { turn: { id: 'turn-old', threadId: 'thread-1', status: 'interrupted' } } }))
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', turnId: 'turn-new' })
      expect(reports.some((report) => report.event === 'turn_interrupted' && report.turnId === 'turn-old')).toBe(false)

      const reportCount = reports.length
      state.responseDelay = 0
      server!.stdout.write(serverMessage({ method: 'turn/completed', params: { status: 'interrupted' } }))
      server!.stdout.write(serverMessage({ method: 'thread/status/changed', params: { status: { type: 'idle' } } }))
      await waitForReports()
      expect(reports).toHaveLength(reportCount)

      for (let index = 0; index < 253; index++) {
        server!.stdout.write(serverMessage({ method: 'turn/started', params: { turn: { id: `turn-fill-${index}`, threadId: 'thread-1', status: 'inProgress' } } }))
      }
      const cappedTurnId = (reports.at(-1)?.turnId as string | undefined)
      expect(cappedTurnId).toBe('turn-fill-252')
      server!.stdout.write(serverMessage({ method: 'turn/started', params: { turn: { id: 'turn-after-cap', threadId: 'thread-1', status: 'inProgress' } } }))
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', turnId: cappedTurnId })
      expect((reports.at(-1)?.evidence as Record<string, unknown>).completeness).toBe('incomplete')
    } finally {
      state.responseDelay = 0
      await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('makes concurrent pane disposal await the same sidecar teardown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-dispose-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: false, responseDelay: 0,
    }
    let server: FakeProcess | undefined
    const manager = new CodexAppServerManager({
      onReport: () => undefined,
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          server = new FakeProcess()
          attachStdioProtocol(server, state)
          return asChildProcess(server)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })

    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()

      state.responseDelay = 50
      const first = manager.disposePty('pty-1')
      let secondSettled = false
      const second = manager.disposePty('pty-1').finally(() => { secondSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(secondSettled).toBe(false)
      await Promise.all([first, second])
      expect(server?.kill).toHaveBeenCalled()
    } finally {
      state.responseDelay = 0
      await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('waits for an in-flight preparation before shutdown cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-prepare-shutdown-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: false, responseDelay: 0,
    }
    let server: FakeProcess | undefined
    const manager = new CodexAppServerManager({
      onReport: () => undefined,
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          server = new FakeProcess()
          setTimeout(() => attachStdioProtocol(server!, state), 30)
          return asChildProcess(server)
        }
        throw new Error(`Unexpected Codex App Server command: ${args.join(' ')}`)
      },
    })

    try {
      const preparation = manager.prepare('pty-1', directory, {})
      const shutdown = manager.dispose()
      await expect(preparation).resolves.toEqual({ observerReady: true })
      await shutdown
      expect(server?.kill).toHaveBeenCalled()
    } finally {
      await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns null before a PTY exists when sidecar startup fails', async () => {
    const manager = new CodexAppServerManager({
      onReport: () => undefined,
      spawnProcess: () => { throw new Error('codex unavailable') },
    })
    await expect(manager.prepare('pty-1', tmpdir(), {})).resolves.toBeNull()
  })
})
