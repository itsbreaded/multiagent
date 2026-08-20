import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

function serverFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
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

function attachProxyProtocol(proxy: FakeProcess, state: FakeProtocolState): void {
  let input = Buffer.alloc(0)
  let handshaken = false
  proxy.stdin.on('data', (chunk: Buffer) => {
    input = Buffer.concat([input, chunk])
    if (!handshaken) {
      const end = input.indexOf(Buffer.from('\r\n\r\n'))
      if (end < 0) return
      proxy.stdout.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
      handshaken = true
      input = input.subarray(end + 4)
    }
    while (handshaken && input.length >= 2) {
      const second = input[1]
      let offset = 2
      let length = second & 0x7f
      if (length === 126) {
        if (input.length < 4) return
        length = input.readUInt16BE(2)
        offset = 4
      }
      if ((second & 0x80) === 0 || input.length < offset + 4 + length) return
      const mask = input.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.from(input.subarray(offset, offset + length))
      input = input.subarray(offset + length)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      const request = JSON.parse(payload.toString('utf8')) as { id?: number; method?: string; params?: Record<string, unknown> }
      state.requests?.push({ method: request.method, params: request.params })
      if (request.id === undefined) continue
      const respond = (value: unknown): void => {
        const frame = serverFrame(value)
        if (state.responseDelay > 0) setTimeout(() => proxy.stdout.write(frame), state.responseDelay)
        else proxy.stdout.write(frame)
      }
      let result: unknown = {}
      if (request.method === 'thread/backgroundTerminals/list') {
        if (state.failBackground) {
          respond({ jsonrpc: '2.0', id: request.id, error: { message: 'unsupported' } })
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
    let sidecar: FakeProcess | undefined
    let proxy: FakeProcess | undefined
    let socketPath: string | undefined
    const manager = new CodexAppServerManager({
      tmpDir: directory,
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          sidecar = new FakeProcess()
          writeFileSync(args[2].slice('unix://'.length), '')
          return asChildProcess(sidecar)
        }
        proxy = new FakeProcess()
        attachProxyProtocol(proxy, state)
        return asChildProcess(proxy)
      },
    })

    try {
      const prepared = await manager.prepare('pty-1', directory, {})
      expect(prepared?.socketPath).toBeTruthy()
      socketPath = prepared?.socketPath
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', sessionId: 'thread-1' })
      expect((reports.at(-1) as any).evidence).toMatchObject({ completeness: 'complete', activeCount: 0, scheduledCount: 0 })

      proxy!.stdout.write(serverFrame({ method: 'turn/started', params: { turn: { id: 'turn-1', threadId: 'thread-1', status: 'inProgress' } } }))
      expect((reports.at(-1) as any).evidence).toMatchObject({ terminalState: 'busy', activeCount: 1, turnId: 'turn-1' })

      state.background = [{ processId: 'background-1' }]
      state.threads = [
        { id: 'thread-1', status: { type: 'idle' } },
        { id: 'unrelated-1', status: { type: 'active' } },
        { id: 'child-1', parentThreadId: 'thread-1', status: { type: 'active' } },
      ]
      proxy!.stdout.write(serverFrame({ method: 'turn/completed', params: { turn: { id: 'turn-1', threadId: 'thread-1', status: 'interrupted' } } }))
      await waitForReports()
      expect((reports.at(-1) as any).evidence).toMatchObject({ terminalState: 'interrupted', completeness: 'complete', activeCount: 1, scheduledCount: 1, activeIds: ['child-1'] })

      manager.bindSession('pty-1', 'thread-2')
      await waitForReports()
      expect(state.requests).toContainEqual({ method: 'thread/unsubscribe', params: { threadId: 'thread-1' } })
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', sessionId: 'thread-2' })
    } finally {
      await manager.dispose()
      expect(proxy?.kill).toHaveBeenCalled()
      expect(sidecar?.kill).toHaveBeenCalled()
      expect(socketPath ? existsSync(socketPath) : false).toBe(false)
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
      tmpDir: directory,
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          writeFileSync(args[2].slice('unix://'.length), '')
          return asChildProcess(process)
        }
        const process = new FakeProcess()
        attachProxyProtocol(process, state)
        return asChildProcess(process)
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
      tmpDir: directory,
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          writeFileSync(args[2].slice('unix://'.length), '')
          return asChildProcess(process)
        }
        const process = new FakeProcess()
        attachProxyProtocol(process, state)
        return asChildProcess(process)
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

  it('marks a proxy disconnect protective and performs one bounded reconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiagent-codex-reconnect-'))
    const state: FakeProtocolState = {
      background: [], threads: [{ id: 'thread-1', status: { type: 'idle' } }], failBackground: false, responseDelay: 0,
    }
    const proxies: FakeProcess[] = []
    const reports: Array<Record<string, unknown>> = []
    const manager = new CodexAppServerManager({
      tmpDir: directory,
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          writeFileSync(args[2].slice('unix://'.length), '')
          return asChildProcess(process)
        }
        const process = new FakeProcess()
        proxies.push(process)
        attachProxyProtocol(process, state)
        return asChildProcess(process)
      },
    })

    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()
      proxies[0].emit('error', new Error('proxy disconnected'))
      await waitForReports()
      expect(proxies).toHaveLength(2)
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
    let proxy: FakeProcess | undefined
    const manager = new CodexAppServerManager({
      tmpDir: directory,
      onReport: (report) => reports.push(report as unknown as Record<string, unknown>),
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          writeFileSync(args[2].slice('unix://'.length), '')
          return asChildProcess(process)
        }
        proxy = new FakeProcess()
        attachProxyProtocol(proxy, state)
        return asChildProcess(proxy)
      },
    })

    try {
      await manager.prepare('pty-1', directory, {})
      manager.bindSession('pty-1', 'thread-1')
      await waitForReports()

      proxy!.stdout.write(serverFrame({ method: 'turn/started', params: { turn: { id: 'turn-old', threadId: 'thread-1', status: 'inProgress' } } }))
      state.responseDelay = 30
      proxy!.stdout.write(serverFrame({ method: 'turn/started', params: { turn: { id: 'turn-new', threadId: 'thread-1', status: 'inProgress' } } }))
      proxy!.stdout.write(serverFrame({ method: 'turn/started', params: { turn: { id: 'turn-old', threadId: 'thread-1', status: 'inProgress' } } }))
      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', turnId: 'turn-new' })
      proxy!.stdout.write(serverFrame({ method: 'turn/completed', params: { turn: { id: 'turn-old', threadId: 'thread-1', status: 'interrupted' } } }))
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(reports.at(-1)).toMatchObject({ event: 'work_snapshot', turnId: 'turn-new' })
      expect(reports.some((report) => report.event === 'turn_interrupted' && report.turnId === 'turn-old')).toBe(false)

      const reportCount = reports.length
      state.responseDelay = 0
      proxy!.stdout.write(serverFrame({ method: 'turn/completed', params: { status: 'interrupted' } }))
      proxy!.stdout.write(serverFrame({ method: 'thread/status/changed', params: { status: { type: 'idle' } } }))
      await waitForReports()
      expect(reports).toHaveLength(reportCount)

      for (let index = 0; index < 253; index++) {
        proxy!.stdout.write(serverFrame({ method: 'turn/started', params: { turn: { id: `turn-fill-${index}`, threadId: 'thread-1', status: 'inProgress' } } }))
      }
      const cappedTurnId = (reports.at(-1)?.turnId as string | undefined)
      expect(cappedTurnId).toBe('turn-fill-252')
      proxy!.stdout.write(serverFrame({ method: 'turn/started', params: { turn: { id: 'turn-after-cap', threadId: 'thread-1', status: 'inProgress' } } }))
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
    let proxy: FakeProcess | undefined
    const manager = new CodexAppServerManager({
      tmpDir: directory,
      onReport: () => undefined,
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          const process = new FakeProcess()
          writeFileSync(args[2].slice('unix://'.length), '')
          return asChildProcess(process)
        }
        proxy = new FakeProcess()
        attachProxyProtocol(proxy, state)
        return asChildProcess(proxy)
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
      expect(proxy?.kill).toHaveBeenCalled()
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
    let sidecar: FakeProcess | undefined
    let proxy: FakeProcess | undefined
    const manager = new CodexAppServerManager({
      tmpDir: directory,
      onReport: () => undefined,
      spawnProcess: (_command, args) => {
        if (args[0] === 'app-server' && args[1] === '--listen') {
          sidecar = new FakeProcess()
          setTimeout(() => writeFileSync(args[2].slice('unix://'.length), ''), 30)
          return asChildProcess(sidecar)
        }
        proxy = new FakeProcess()
        attachProxyProtocol(proxy, state)
        return asChildProcess(proxy)
      },
    })

    try {
      const preparation = manager.prepare('pty-1', directory, {})
      const shutdown = manager.dispose()
      await expect(preparation).resolves.toMatchObject({ socketPath: expect.any(String) })
      await shutdown
      expect(proxy?.kill).toHaveBeenCalled()
      expect(sidecar?.kill).toHaveBeenCalled()
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
