import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { tmpdir } from 'os'

// PtyManager spawns a worker via child_process.spawn in its constructor. Mock
// the module so we get a fake worker we can drive events on. The mock must be
// in module scope (vi.mock is hoisted) and the factory must construct a fresh
// worker each time spawn() is called.
const lastWorker = vi.hoisted((): { current: FakeWorker | null } => ({ current: null }))

class FakeWorker extends EventEmitter {
  connected = true
  exitCode: number | null = null
  signalCode: number | null = null
  stderr = new EventEmitter()
  send = vi.fn()
  kill = vi.fn()
  pid = 12345
}

vi.mock('child_process', () => ({
  spawn: () => {
    const worker = new FakeWorker()
    lastWorker.current = worker
    return worker
  },
}))

// Imported AFTER vi.mock so the constructor uses the mocked spawn.
import { PtyManager } from './PtyManager'

const REAL_CWD = tmpdir()

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Flush setImmediate-based registration + an optional real-time wait. */
async function flush(ms = 0): Promise<void> {
  await flushImmediate()
  if (ms > 0) await new Promise((r) => setTimeout(r, ms))
  await flushImmediate()
}

describe('PtyManager — worker crash fanout (spec 034)', () => {
  let manager: PtyManager
  let worker: FakeWorker

  beforeEach(() => {
    manager = new PtyManager()
    worker = lastWorker.current!
    expect(worker).toBeDefined()
  })

  afterEach(() => {
    lastWorker.current = null
  })

  it('emits exit for every spawned id when the worker crashes', async () => {
    const id1 = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    const id2 = manager.createDeferred(REAL_CWD, ['powershell.exe'])

    // Drive setImmediate-based cwd check + _spawn so both ids land in spawnedIds.
    await flushImmediate()

    const exits: Array<[string, number]> = []
    manager.on('exit', (id, code) => exits.push([id, code]))

    worker.connected = false
    worker.exitCode = 42
    worker.emit('exit', 42)

    expect(exits).toEqual([[id1, 42], [id2, 42]])
    // Subsequent writes/resizes are silently dropped (no throws, no new send).
    worker.send.mockClear()
    expect(() => manager.write(id1, 'x')).not.toThrow()
    expect(worker.send).not.toHaveBeenCalled()
  })

  it('emits error for pending deferred spawns and clears their fallback timer', async () => {
    // deferSpawn=true: stays in pendingSpawns until first resize or timeout.
    const id = manager.createDeferred(
      REAL_CWD,
      ['claude.exe'],
      undefined,
      { cols: 80, rows: 24 },
      false,
      true,
    )

    // Run the setImmediate that registers the deferred fallback timer.
    await flushImmediate()
    // The pending entry is now waiting for the first resize or the
    // DEFERRED_SPAWN_TIMEOUT_MS (500ms) fallback.

    const errors: Array<[string, string]> = []
    manager.on('error', (eid, err: Error) => errors.push([eid, err.message]))

    worker.connected = false
    worker.exitCode = 7
    worker.emit('exit', 7)

    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe(id)
    expect(errors[0][1]).toContain('7')

    // Wait past the DEFERRED_SPAWN_TIMEOUT_MS fallback. The cleared timer must
    // not fire any spawn or duplicate event.
    const moreErrors: Array<[string, string]> = []
    manager.on('error', (eid, err: Error) => moreErrors.push([eid, err.message]))
    await flush(700)
    expect(worker.send).not.toHaveBeenCalled()
    expect(moreErrors).toHaveLength(0)
  })

  it('latches: a second worker exit does not re-emit pane events', async () => {
    const id = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    await flushImmediate()

    const exits: Array<[string, number]> = []
    manager.on('exit', (eid, code) => exits.push([eid, code]))

    worker.exitCode = 1
    worker.emit('exit', 1)
    worker.emit('exit', 2)

    expect(exits).toEqual([[id, 1]])
  })

  it('fans out a spawn error even when no worker exit follows', async () => {
    const id = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    await flushImmediate()
    const exits: Array<[string, number]> = []
    manager.on('exit', (eid, code) => exits.push([eid, code]))
    worker.emit('error', new Error('spawn ENOENT'))
    expect(exits).toEqual([[id, 1]])
  })

  it('fans out only once when worker error is followed by exit', async () => {
    const id = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    await flushImmediate()
    const exits: Array<[string, number]> = []
    manager.on('exit', (eid, code) => exits.push([eid, code]))
    worker.emit('error', new Error('spawn ENOENT'))
    worker.emit('exit', 1)
    expect(exits).toEqual([[id, 1]])
  })

  it('destroy() suppresses crash fanout on subsequent worker exit', async () => {
    manager.createDeferred(REAL_CWD, ['powershell.exe'])
    await flushImmediate()

    const exits: Array<[string, number]> = []
    manager.on('exit', (id, code) => exits.push([id, code]))

    // Start destroy; the destroyPromise awaits the worker exit.
    const destroyP = manager.destroy()
    worker.exitCode = 0
    worker.emit('exit', 0)
    await destroyP

    expect(exits).toHaveLength(0)
  })

  it('post-crash createDeferred emits error on the next tick and leaves no silent entry', async () => {
    worker.exitCode = 1
    worker.emit('exit', 1)

    const errors: Array<[string, string]> = []
    manager.on('error', (id, err: Error) => errors.push([id, err.message]))

    const newId = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    // The error is emitted via setImmediate.
    await flushImmediate()

    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe(newId)
    expect(errors[0][1]).toContain('not running')
    // No spawn was sent to the dead worker.
    expect(worker.send).not.toHaveBeenCalled()
  })

  it('per-pty exit message (normal worker message) still emits a single exit and cleans that id only', async () => {
    const id1 = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    const id2 = manager.createDeferred(REAL_CWD, ['powershell.exe'])
    await flushImmediate()

    const exits: Array<[string, number]> = []
    manager.on('exit', (id, code) => exits.push([id, code]))

    // Worker reports a normal per-PTY exit for id1.
    worker.emit('message', { type: 'exit', id: id1, exitCode: 0 })

    expect(exits).toEqual([[id1, 0]])
    // id2 is unaffected and still tracked.
    manager.write(id2, 'x')
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'write', id: id2 }))
  })
})
