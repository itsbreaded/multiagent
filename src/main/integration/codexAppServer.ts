import { randomBytes, randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { unlinkSync } from 'fs'
import { join } from 'path'
import type { AgentWorkSnapshot } from '../../shared/types'
import { MAX_AGENT_ID_LENGTH, MAX_AGENT_TRACKED_IDENTITIES, MAX_AGENT_WORK_ITEMS } from '../../shared/agentStatusEvidence'
import type { AgentEventReport } from './agentSessionReportServer'

const MAX_PAGES = 16
const MAX_SEEN_TURNS = 256
const SOCKET_WAIT_MS = 4000
const REQUEST_TIMEOUT_MS = 3500

type SpawnFn = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams

interface JsonRpcResult {
  id?: number
  result?: unknown
  error?: unknown
}

interface StdioWebSocketOptions {
  onMessage: (message: unknown) => void
  onClosed: () => void
}

/** Small RFC 6455 client for the documented `codex app-server proxy` stdio bridge. */
class StdioWebSocket {
  private buffer = Buffer.alloc(0)
  private handshakeDone = false
  private closed = false
  private nextRequestId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly handshake: Promise<void>
  private resolveHandshake!: () => void
  private rejectHandshake!: (error: Error) => void
  private fragment: Buffer | null = null

  constructor(private readonly process: ChildProcessWithoutNullStreams, private readonly options: StdioWebSocketOptions) {
    this.handshake = new Promise<void>((resolve, reject) => { this.resolveHandshake = resolve; this.rejectHandshake = reject })
    process.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    process.stdout.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    process.on('error', (error) => this.fail(error))
    process.on('close', () => this.fail(new Error('Codex App Server proxy closed')))
  }

  async connect(): Promise<void> {
    const key = randomBytes(16).toString('base64')
    this.process.stdin.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    await this.handshake
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex App Server proxy is closed'))
    const id = this.nextRequestId++
    const message = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.writeFrame(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) return
    this.writeFrame(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', method, params })))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex App Server proxy disposed'))
    }
    this.pending.clear()
    try { this.process.stdin.end() } catch { /* already closed */ }
    try { if (this.process.exitCode === null) this.process.kill() } catch { /* already closed */ }
  }

  private writeFrame(payload: Uint8Array, opcode = 1): void {
    const length = payload.byteLength
    let header: Buffer
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length])
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    const mask = randomBytes(4)
    const body = Buffer.from(payload)
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
    this.process.stdin.write(Buffer.concat([header, mask, body]))
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.handshakeDone) {
      const end = this.buffer.indexOf(Buffer.from('\r\n\r\n'))
      if (end < 0) return
      const response = this.buffer.subarray(0, end).toString('ascii')
      this.buffer = this.buffer.subarray(end + 4)
      if (!/^HTTP\/1\.1 101\b/m.test(response)) {
        this.fail(new Error('Codex App Server proxy did not accept WebSocket upgrade'))
        return
      }
      this.handshakeDone = true
      this.resolveHandshake()
    }
    while (!this.closed) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      let offset = 2
      let length = second & 0x7f
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const longLength = this.buffer.readBigUInt64BE(2)
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) { this.fail(new Error('Codex App Server frame is too large')); return }
        length = Number(longLength)
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskOffset = masked ? offset : -1
      if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      const frame = this.buffer.subarray(offset, offset + length)
      const data = Buffer.from(frame)
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4)
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
      }
      this.buffer = this.buffer.subarray(offset + length)
      const opcode = first & 0x0f
      if (opcode === 8) { this.fail(new Error('Codex App Server proxy sent close')); return }
      if (opcode === 9) { this.writeFrame(data, 10); continue }
      if (opcode === 0) this.fragment = Buffer.concat([this.fragment ?? Buffer.alloc(0), data])
      else if (opcode === 1 && (first & 0x80) === 0) this.fragment = data
      else if (opcode === 1) this.dispatch(data)
      if (opcode === 0 && (first & 0x80) !== 0) {
        const complete = this.fragment ?? Buffer.alloc(0)
        this.fragment = null
        this.dispatch(complete)
      }
    }
  }

  private dispatch(data: Buffer): void {
    let message: JsonRpcResult & { method?: string; params?: unknown }
    try { message = JSON.parse(data.toString('utf8')) as typeof message } catch { return }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.method) this.options.onMessage(message)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    if (!this.handshakeDone) this.rejectHandshake(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.options.onClosed()
  }
}

export interface CodexAppServerManagerOptions {
  onReport: (report: AgentEventReport) => void
  spawnProcess?: SpawnFn
  command?: string
  tmpDir?: string
}

interface PaneObserver {
  ptyId: string
  cwd: string
  env: Record<string, string>
  socketPath: string
  sidecar: ChildProcessWithoutNullStreams
  proxy: ChildProcessWithoutNullStreams
  ws: StdioWebSocket
  sessionId?: string
  turnId?: string
  turnGeneration: number
  seenTurnIds: Set<string>
  binding: Promise<void>
  reconnects: number
  disposing: boolean
}

export interface CodexPreparedPane {
  socketPath: string
}

export class CodexAppServerManager {
  private readonly panes = new Map<string, PaneObserver>()
  private readonly disposals = new Map<string, Promise<void>>()
  private readonly preparations = new Map<string, Promise<CodexPreparedPane | null>>()
  private readonly spawnProcess: SpawnFn
  private readonly command: string
  private readonly tmpDir: string
  private disposing = false

  constructor(private readonly options: CodexAppServerManagerOptions) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams)
    this.command = options.command ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex')
    this.tmpDir = options.tmpDir ?? tmpdir()
  }

  async prepare(ptyId: string, cwd: string, env: Record<string, string>): Promise<CodexPreparedPane | null> {
    if (this.disposing) return null
    const existing = this.preparations.get(ptyId)
    if (existing) return existing
    const preparation = this.prepareInternal(ptyId, cwd, env)
    this.preparations.set(ptyId, preparation)
    try {
      return await preparation
    } finally {
      if (this.preparations.get(ptyId) === preparation) this.preparations.delete(ptyId)
    }
  }

  private async prepareInternal(ptyId: string, cwd: string, env: Record<string, string>): Promise<CodexPreparedPane | null> {
    if (this.panes.has(ptyId)) return null
    const socketPath = join(this.tmpDir, `multiagent-codex-${process.pid}-${randomUUID()}.sock`)
    let sidecar: ChildProcessWithoutNullStreams | undefined
    let proxy: ChildProcessWithoutNullStreams | undefined
    try {
      const listen = `unix://${socketPath.replace(/\\/g, '/')}`
      const processOptions = {
        cwd, env, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
        windowsHide: true, shell: process.platform === 'win32',
      }
      sidecar = this.spawnProcess(this.command, ['app-server', '--listen', listen], { ...processOptions, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] })
      await this.waitForSocket(sidecar, socketPath)
      proxy = this.spawnProcess(this.command, ['app-server', 'proxy', '--sock', socketPath], processOptions)
      const observer = this.createObserver(ptyId, cwd, env, socketPath, sidecar, proxy)
      await observer.ws.connect()
      await observer.ws.request('initialize', {
        clientInfo: { name: 'multiagent', title: 'MultiAgent', version: '0.3.42' },
        capabilities: { experimentalApi: true },
      })
      observer.ws.notify('initialized', {})
      this.panes.set(ptyId, observer)
      return { socketPath }
    } catch (error) {
      console.warn('[MultiAgent] Codex App Server preparation failed; using direct CLI:', error)
      try { proxy?.kill() } catch { /* already closed */ }
      try { sidecar?.kill() } catch { /* already closed */ }
      try { unlinkSync(socketPath) } catch { /* not created */ }
      return null
    }
  }

  bindSession(ptyId: string, sessionId: string): void {
    const pane = this.panes.get(ptyId)
    if (!pane || !sessionId) return
    if (pane.sessionId !== sessionId) {
      const previousSessionId = pane.sessionId
      pane.sessionId = sessionId
      pane.turnId = `${sessionId}:observer:1`
      pane.turnGeneration++
      pane.seenTurnIds = new Set([pane.turnId])
      pane.binding = pane.binding.then(async () => {
        if (previousSessionId) {
          try { await pane.ws.request('thread/unsubscribe', { threadId: previousSessionId }) } catch { /* connection may already be gone */ }
        }
        if (!pane.disposing && pane.sessionId === sessionId) await this.resumeAndRefresh(pane)
      }).catch(() => undefined)
    } else {
      pane.sessionId = sessionId
      pane.turnId ??= `${sessionId}:observer:1`
      if (pane.turnId) pane.seenTurnIds.add(pane.turnId)
      pane.binding = pane.binding.then(() => {
        if (!pane.disposing && pane.sessionId === sessionId) return this.resumeAndRefresh(pane)
        return undefined
      }).catch(() => undefined)
    }
  }

  async disposePty(ptyId: string): Promise<void> {
    const existing = this.disposals.get(ptyId)
    if (existing) {
      await existing
      return
    }
    const pane = this.panes.get(ptyId)
    if (!pane) {
      const preparation = this.preparations.get(ptyId)
      if (preparation) {
        await preparation
        await this.disposePty(ptyId)
      }
      return
    }
    if (pane.disposing) return
    pane.disposing = true
    const disposal = (async () => {
      await pane.binding
      if (pane.sessionId) {
        try { await pane.ws.request('thread/unsubscribe', { threadId: pane.sessionId }) } catch { /* connection may already be gone */ }
      }
      pane.ws.close()
      try { if (pane.proxy.exitCode === null) pane.proxy.kill() } catch { /* already closed */ }
      try { if (pane.sidecar.exitCode === null) pane.sidecar.kill() } catch { /* already closed */ }
      await waitForExit(pane.proxy, 1000)
      await waitForExit(pane.sidecar, 1000)
      try { unlinkSync(pane.socketPath) } catch { /* already absent */ }
    })().finally(() => {
      if (this.panes.get(ptyId) === pane) this.panes.delete(ptyId)
      this.disposals.delete(ptyId)
    })
    this.disposals.set(ptyId, disposal)
    await disposal
  }

  async dispose(): Promise<void> {
    this.disposing = true
    await Promise.all([...this.preparations.values()])
    const ptyIds = new Set([...this.panes.keys(), ...this.disposals.keys()])
    await Promise.all([...ptyIds].map((ptyId) => this.disposePty(ptyId)))
  }

  private createObserver(ptyId: string, cwd: string, env: Record<string, string>, socketPath: string, sidecar: ChildProcessWithoutNullStreams, proxy: ChildProcessWithoutNullStreams): PaneObserver {
    const pane: PaneObserver = {
      ptyId, cwd, env, socketPath, sidecar, proxy,
      ws: undefined as unknown as StdioWebSocket,
      turnGeneration: 0, seenTurnIds: new Set(), binding: Promise.resolve(), reconnects: 0, disposing: false,
    }
    pane.ws = new StdioWebSocket(proxy, {
      onMessage: (message) => this.onMessage(pane, message),
      onClosed: () => { void this.onObserverClosed(pane) },
    })
    return pane
  }

  private async onObserverClosed(pane: PaneObserver): Promise<void> {
    if (pane.disposing || !this.panes.has(pane.ptyId)) return
    this.emitIncomplete(pane, 'busy')
    if (pane.reconnects >= 1) return
    pane.reconnects++
    try {
      const proxy = this.spawnProcess(this.command, ['app-server', 'proxy', '--sock', pane.socketPath], {
        cwd: pane.cwd, env: pane.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        shell: process.platform === 'win32',
      })
      pane.proxy = proxy
      pane.ws = new StdioWebSocket(proxy, { onMessage: (message) => this.onMessage(pane, message), onClosed: () => { void this.onObserverClosed(pane) } })
      await pane.ws.connect()
      await pane.ws.request('initialize', {
        clientInfo: { name: 'multiagent', title: 'MultiAgent', version: '0.3.42' },
        capabilities: { experimentalApi: true },
      })
      pane.ws.notify('initialized', {})
      if (pane.sessionId) await this.resumeAndRefresh(pane)
    } catch {
      this.emitIncomplete(pane, 'busy')
    }
  }

  private onMessage(pane: PaneObserver, message: unknown): void {
    if (!this.isCurrentPane(pane)) return
    if (!message || typeof message !== 'object') return
    const event = message as { method?: string; params?: Record<string, unknown> }
    if (event.method !== 'turn/started' && event.method !== 'turn/completed' && event.method !== 'thread/status/changed') return
    const params = event.params
    // Codex's turn notifications carry the turn object under `params.turn`, while
    // thread status notifications carry the thread id/status at the top level.
    // Accept only these documented shapes (plus the equivalent snake-case fields
    // observed in older generated bindings); unknown shapes stay protective.
    const turn = isRecord(params?.turn) ? params.turn : undefined
    const sessionId = stringField(params, 'threadId') ?? stringField(params, 'thread_id') ??
      stringField(turn, 'threadId') ?? stringField(turn, 'thread_id') ??
      stringField(params, 'sessionId') ?? stringField(params, 'session_id')
    const eventTurnId = stringField(params, 'turnId') ?? stringField(params, 'turn_id') ?? stringField(turn, 'id')
    if (!pane.sessionId) return
    const rawStatus = stringField(params, 'status') ?? stringField(turn, 'status')
    const status = rawStatus ?? (isRecord(params?.status) ? stringField(params.status, 'type') : undefined) ??
      (isRecord(turn?.status) ? stringField(turn.status, 'type') : undefined)
    if (event.method === 'thread/status/changed') {
      if (!sessionId) return
      if (sessionId && sessionId !== pane.sessionId) {
        // A child notification cannot prove that the root turn ended. An active
        // child is protective; an idle child is deliberately ignored until the
        // root reports its own terminal status.
        if (status === 'active') this.emitIncomplete(pane, 'busy')
        return
      }
      if (status === 'active') {
        this.emitSnapshot(pane, 'busy', { activeCount: 1, scheduledCount: 0 })
        return
      }
      if (status === 'systemError') {
        void this.refresh(pane, 'failed')
        return
      }
    }
    if (sessionId && sessionId !== pane.sessionId) return
    if (event.method === 'turn/completed' && (sessionId !== pane.sessionId || eventTurnId !== pane.turnId)) return
    if (event.method === 'turn/started') {
      const nextTurnId = stringField(params, 'turnId') ?? stringField(params, 'turn_id') ??
        stringField(turn, 'id') ?? pane.turnId ?? `${pane.sessionId}:observer:1`
      if (nextTurnId !== pane.turnId && pane.seenTurnIds.has(nextTurnId)) return
      if (nextTurnId !== pane.turnId && pane.seenTurnIds.size >= MAX_SEEN_TURNS) {
        this.emitIncomplete(pane, 'busy')
        return
      }
      if (nextTurnId !== pane.turnId) pane.turnGeneration++
      pane.turnId = nextTurnId
      pane.seenTurnIds.add(nextTurnId)
      while (pane.seenTurnIds.size > MAX_SEEN_TURNS) pane.seenTurnIds.delete(pane.seenTurnIds.values().next().value as string)
      this.emitSnapshot(pane, 'busy', { activeCount: 1, scheduledCount: 0 })
      return
    }
    const interrupted = status === 'interrupted'
    void this.refresh(
      pane,
      interrupted ? 'interrupted' : status === 'failed' ? 'failed' : status === 'retry' ? 'retry' : 'completed',
      interrupted ? 'turn_interrupted' : 'work_snapshot',
    )
  }

  private async refresh(
    pane: PaneObserver,
    terminalState: AgentWorkSnapshot['terminalState'],
    event: 'work_snapshot' | 'turn_interrupted' = 'work_snapshot',
  ): Promise<void> {
    if (!this.isCurrentPane(pane) || !pane.sessionId) return
    const expectedTurnId = pane.turnId
    const expectedGeneration = pane.turnGeneration
    try {
      const backgrounds = await this.listPages(pane, 'thread/backgroundTerminals/list', { threadId: pane.sessionId })
      if (!this.isCurrentPane(pane) || pane.turnId !== expectedTurnId || pane.turnGeneration !== expectedGeneration) return
      const threads = await this.listPages(pane, 'thread/list', { ancestorThreadId: pane.sessionId })
      if (!this.isCurrentPane(pane) || pane.turnId !== expectedTurnId || pane.turnGeneration !== expectedGeneration) return
      let unresolvedThread = false
      for (const item of threads.items) {
        const id = stringField(item, 'id')
        if (!id) { unresolvedThread = true; continue }
      }
      const allActiveIds: string[] = []
      for (const item of threads.items) {
        const id = stringField(item, 'id')
        if (id && ['busy', 'running', 'active', 'retry'].includes(threadStatus(item))) allActiveIds.push(id)
      }
      const allBackgroundIds: string[] = []
      for (const item of backgrounds.items) {
        const id = stringField(item, 'processId') ?? stringField(item, 'id') ?? stringField(item, 'terminalId')
        if (!id) unresolvedThread = true
        else allBackgroundIds.push(id)
      }
      const activeIds = allActiveIds.slice(0, MAX_AGENT_WORK_ITEMS)
      const backgroundIds = allBackgroundIds.slice(0, MAX_AGENT_WORK_ITEMS)
      const complete = !unresolvedThread && backgrounds.complete && threads.complete && allActiveIds.length <= MAX_AGENT_WORK_ITEMS && allBackgroundIds.length <= MAX_AGENT_WORK_ITEMS
      this.emitSnapshot(pane, terminalState, {
        activeCount: Math.min(MAX_AGENT_WORK_ITEMS, activeIds.length),
        scheduledCount: Math.min(MAX_AGENT_WORK_ITEMS, backgroundIds.length),
        activeIds: activeIds.length <= MAX_AGENT_TRACKED_IDENTITIES ? activeIds : undefined,
        scheduledIds: backgroundIds.length <= MAX_AGENT_TRACKED_IDENTITIES ? backgroundIds : undefined,
        completeness: complete ? 'complete' : 'incomplete',
      }, event, expectedTurnId)
    } catch {
      if (this.isCurrentPane(pane) && pane.turnId === expectedTurnId && pane.turnGeneration === expectedGeneration) {
        this.emitIncomplete(pane, terminalState, event, expectedTurnId)
      }
    }
  }

  private async listPages(pane: PaneObserver, method: string, params: Record<string, unknown>): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
    const items: Record<string, unknown>[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await pane.ws.request(method, cursor ? { ...params, cursor } : params)
      const payload = isRecord(result) ? result : {}
      const pageItems = Array.isArray(result)
        ? result
        : arrayField(payload, 'data') ?? arrayField(payload, 'items') ?? arrayField(payload, 'threads') ?? arrayField(payload, 'terminals')
      if (!pageItems) return { items, complete: false }
      if (pageItems.some((item) => !isRecord(item))) return { items, complete: false }
      for (const item of pageItems) items.push(item as Record<string, unknown>)
      if (items.length > MAX_AGENT_TRACKED_IDENTITIES) return { items: items.slice(0, MAX_AGENT_TRACKED_IDENTITIES), complete: false }
      const hasNextCursorField = Object.prototype.hasOwnProperty.call(payload, 'nextCursor') || Object.prototype.hasOwnProperty.call(payload, 'next_cursor')
      const hasUnknownCursorField = Object.prototype.hasOwnProperty.call(payload, 'cursor')
      const rawNext = Object.prototype.hasOwnProperty.call(payload, 'nextCursor') ? payload.nextCursor : payload.next_cursor
      const next = stringField(payload, 'nextCursor') ?? stringField(payload, 'next_cursor')
      const hasMoreValue = Object.prototype.hasOwnProperty.call(payload, 'hasMore') ? payload.hasMore : payload.has_more
      if (hasMoreValue !== undefined && typeof hasMoreValue !== 'boolean') return { items, complete: false }
      const hasMore = hasMoreValue === true
      if (hasUnknownCursorField && !hasNextCursorField) return { items, complete: false }
      if (hasNextCursorField && rawNext !== null && !next) return { items, complete: false }
      if (!Array.isArray(result) && !hasNextCursorField) return { items, complete: false }
      if (hasMore && !next) return { items, complete: false }
      if (!next) return { items, complete: !hasMore }
      if (seenCursors.has(next)) return { items, complete: false }
      seenCursors.add(next)
      cursor = next
    }
    return { items, complete: false }
  }

  private emitIncomplete(
    pane: PaneObserver,
    terminalState: AgentWorkSnapshot['terminalState'],
    event: 'work_snapshot' | 'turn_interrupted' = 'work_snapshot',
    turnId = pane.turnId,
  ): void {
    this.emitSnapshot(pane, terminalState, { completeness: 'incomplete', activeCount: 1, scheduledCount: 0 }, event, turnId)
  }

  private emitSnapshot(
    pane: PaneObserver,
    terminalState: AgentWorkSnapshot['terminalState'],
    extra: Partial<AgentWorkSnapshot>,
    event: 'work_snapshot' | 'turn_interrupted' = 'work_snapshot',
    turnId = pane.turnId,
  ): void {
    if (!this.isCurrentPane(pane) || !pane.sessionId) return
    const evidence: AgentWorkSnapshot = {
      provider: 'codex', completeness: extra.completeness ?? 'incomplete', terminalState,
      activeCount: extra.activeCount ?? 0, scheduledCount: extra.scheduledCount ?? 0,
      ...(extra.activeIds ? { activeIds: extra.activeIds } : {}),
      ...(extra.scheduledIds ? { scheduledIds: extra.scheduledIds } : {}),
      sessionId: pane.sessionId, ...(turnId ? { turnId } : {}),
    }
    this.options.onReport({ ptyId: pane.ptyId, agentKind: 'codex', event, sessionId: pane.sessionId, turnId, evidence })
  }

  private async waitForSocket(sidecar: ChildProcessWithoutNullStreams, socketPath: string): Promise<void> {
    const deadline = Date.now() + SOCKET_WAIT_MS
    while (Date.now() < deadline) {
      if (existsSync(socketPath)) return
      if (sidecar.exitCode !== null) throw new Error('Codex App Server exited before listening')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for Codex App Server socket')
  }

  private async resumeAndRefresh(pane: PaneObserver): Promise<void> {
    if (!this.isCurrentPane(pane) || !pane.sessionId) return
    try {
      await pane.ws.request('thread/resume', { threadId: pane.sessionId })
      await this.refresh(pane, 'idle')
    } catch {
      this.emitIncomplete(pane, 'busy')
    }
  }

  private isCurrentPane(pane: PaneObserver): boolean {
    return !pane.disposing && this.panes.get(pane.ptyId) === pane
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== 'string') return undefined
  const result = value[key] as string
  return result.length > 0 && result.length <= MAX_AGENT_ID_LENGTH ? result : undefined
}

function arrayField(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value) || !Array.isArray(value[key])) return undefined
  return value[key] as unknown[]
}

function threadStatus(value: Record<string, unknown>): string {
  const status = value.status
  if (typeof status === 'string') return status
  return isRecord(status) && typeof status.type === 'string' ? status.type : ''
}

function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    process.once('close', () => { clearTimeout(timer); resolve() })
  })
}
