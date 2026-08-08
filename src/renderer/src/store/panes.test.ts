import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { usePanesStore } from './panes'
import {
  makeLeaf,
  makeSplit,
  collectLeafIds,
  collectLeaves,
  findLeaf,
} from '../../../shared/paneTree'
import type { PaneNode, Tab } from '../../../shared/types'
import { installMockIpc } from '../../../../tests/mockIpc'


// Transition tests against the REAL usePanesStore. The auto-reset mock
// (activated in tests/setup.renderer.ts) restores initial state in afterEach, so
// each test starts clean. window.ipc is intentionally absent here: the store's
// inbound listeners wire only when window.ipc exists, and every action's IPC
// branch is guarded — so transitions run pure. This is exactly the seam that
// lets us test "focus transitions must be atomic" (spec: never compose
// setActiveTab + focusPane) and the cross-window ack booleans (spec 024) without
// a live IPC layer.

function plantTab(tree: PaneNode, focusedPaneId?: string): string {
  const id = crypto.randomUUID()
  const tab = {
    id,
    rootNode: tree,
    focusedPaneId: focusedPaneId ?? (tree.type === 'leaf' ? tree.id : collectLeafIds(tree)[0] ?? ''),
  }
  usePanesStore.setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
  return id
}

function tabRoot(tabId: string): PaneNode | undefined {
  return usePanesStore.getState().tabs.find((t) => t.id === tabId)?.rootNode
}

// Captured at module load: the pane:agent-event handler registered by wirePanesIpc
// against the setup mock's window.ipc.on, before any test nulls window.ipc. The handler
// closes over the live store, so it stays valid across the per-test state reset.
const paneAgentEventHandler = (() => {
  const on = (window as unknown as { ipc?: { on: { mock: { calls: Array<[string, (...a: unknown[]) => void]> } } } }).ipc?.on
  return on?.mock.calls.find((c) => c[0] === 'pane:agent-event')?.[1]
})()

describe('usePanesStore — stale resume failures', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'ipc', { configurable: true, value: undefined })
  })

  function pendingResume(): { promise: Promise<never>; reject: (error: Error) => void } {
    let reject!: (error: Error) => void
    const promise = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise })
    return { promise, reject }
  }

  it('does not stamp resumeError after the pane gains a ptyId', async () => {
    const pane = makeLeaf('C:\\repo', 'agent', 'claude')
    pane.sessionId = 'session-1'
    plantTab(pane)
    const deferred = pendingResume()
    Object.defineProperty(window, 'ipc', { configurable: true, value: { invoke: vi.fn(() => deferred.promise) } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const resume = usePanesStore.getState().resumeAgentPane(pane.id)
    usePanesStore.getState().updatePane(pane.id, { ptyId: 'pty-new' })
    deferred.reject(new Error('late failure'))
    await resume

    const current = usePanesStore.getState().findPaneInAnyTab(pane.id)
    expect(current?.ptyId).toBe('pty-new')
    expect(current?.resumeError).toBeUndefined()
  })

  it('does not stamp resumeError after the pane changes session', async () => {
    const pane = makeLeaf('C:\\repo', 'agent', 'claude')
    pane.sessionId = 'session-1'
    plantTab(pane)
    const deferred = pendingResume()
    Object.defineProperty(window, 'ipc', { configurable: true, value: { invoke: vi.fn(() => deferred.promise) } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const resume = usePanesStore.getState().resumeAgentPane(pane.id)
    usePanesStore.getState().updatePane(pane.id, { sessionId: 'session-2' })
    deferred.reject(new Error('late failure'))
    await resume

    const current = usePanesStore.getState().findPaneInAnyTab(pane.id)
    expect(current?.sessionId).toBe('session-2')
    expect(current?.resumeError).toBeUndefined()
  })
})

describe('usePanesStore — idle defaults for agent session entry paths', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'ipc', { configurable: true, value: undefined })
  })

  function layoutFor(tab: Tab) {
    return {
      tabs: [tab],
      sidebarWidth: 220,
      sidebarOpen: true,
    }
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
  }

  it('seeds a newly created agent session idle', async () => {
    const tabId = usePanesStore.getState().addTab('C:\\work')
    await usePanesStore.getState().newSession('C:\\work', 'vertical', 'claude')
    const tab = usePanesStore.getState().tabs.find((candidate) => candidate.id === tabId)
    const pane = tab?.rootNode && findLeaf(tab.rootNode, tab.focusedPaneId)
    expect(pane?.agentStatus?.status).toBe('idle')
  })

  it('seeds every retained agent layout outcome idle, including pending recovery placeholders', async () => {
    const restored = makeLeaf('C:\\restored', 'agent', 'claude')
    restored.sessionId = 'session-restored'
    const pending = makeLeaf('C:\\pending', 'agent', 'codex')
    pending.sessionDetectionState = 'pending'
    pending.sessionDetectionStartedAt = 1
    pending.sessionDetectionCwd = pending.cwd
    await usePanesStore.getState().applyLayout(layoutFor({
      id: 'tab-layout',
      rootNode: makeSplit('vertical', restored, pending),
      focusedPaneId: restored.id,
    }))

    const root = usePanesStore.getState().tabs[0].rootNode!
    const leaves = collectLeaves(root)
    expect(leaves.map((leaf) => leaf.agentStatus?.status)).toEqual(['idle', 'idle'])
  })

  it('preserves explicit unknown at layout and incoming-pane boundaries', async () => {
    Object.defineProperty(window, 'ipc', { configurable: true, value: undefined })
    const restored = makeLeaf('C:\\restored', 'agent', 'claude')
    restored.sessionId = 'session-restored'
    restored.agentStatus = { status: 'unknown', updatedAt: 1 }
    await usePanesStore.getState().applyLayout(layoutFor({ id: 'tab-layout', rootNode: restored, focusedPaneId: restored.id }))
    expect(usePanesStore.getState().findPaneInAnyTab(restored.id)?.agentStatus?.status).toBe('unknown')

    const target = makeLeaf('C:\\target')
    const tabId = plantTab(target)
    const incoming = makeLeaf('C:\\incoming', 'agent', 'codex')
    incoming.agentStatus = { status: 'unknown', updatedAt: 1 }
    expect(usePanesStore.getState().addPaneToTab(incoming, tabId)).toBe(true)
    expect(usePanesStore.getState().findPaneInAnyTab(incoming.id)?.agentStatus?.status).toBe('unknown')

    const absent = makeLeaf('C:\\absent', 'agent', 'claude')
    expect(usePanesStore.getState().addPaneToTab(absent, tabId)).toBe(true)
    expect(usePanesStore.getState().findPaneInAnyTab(absent.id)?.agentStatus?.status).toBe('idle')

    const detached = makeLeaf('C:\\detached', 'agent', 'claude')
    usePanesStore.getState().initDetached({ id: 'detached-tab', rootNode: detached, focusedPaneId: detached.id }, [])
    expect(usePanesStore.getState().findPaneInAnyTab(detached.id)?.agentStatus?.status).toBe('idle')

    const received = makeLeaf('C:\\received', 'agent', 'codex')
    usePanesStore.getState().receiveTab({ id: 'received-tab', rootNode: received, focusedPaneId: received.id })
    expect(usePanesStore.getState().findPaneInAnyTab(received.id)?.agentStatus?.status).toBe('idle')

    const synced = makeLeaf('C:\\synced', 'agent', 'opencode')
    usePanesStore.getState().syncDetachedTabs(7, [{ id: 'synced-tab', rootNode: synced, focusedPaneId: synced.id }], 'synced-tab')
    expect(usePanesStore.getState().findPaneInAnyTab(synced.id)?.agentStatus?.status).toBe('idle')

    const splitTarget = makeLeaf('C:\\split-target')
    const splitTabId = plantTab(splitTarget)
    const splitIncoming = makeLeaf('C:\\split-incoming', 'agent', 'claude')
    expect(usePanesStore.getState().insertPaneAtSplit(splitIncoming, splitTarget.id, 'vertical', false)).toBe(true)
    expect(usePanesStore.getState().findPaneInAnyTab(splitIncoming.id)?.agentStatus?.status).toBe('idle')
    const replacement = makeLeaf('C:\\replacement', 'agent', 'codex')
    expect(usePanesStore.getState().replacePaneById(splitTarget.id, replacement)).toBe(true)
    expect(usePanesStore.getState().findPaneInAnyTab(replacement.id)?.agentStatus?.status).toBe('idle')
    expect(usePanesStore.getState().tabs.some((candidate) => candidate.id === splitTabId)).toBe(true)
  })

  it('resets an existing pane to idle before explicit resume IPC completes', async () => {
    const pane = makeLeaf('C:\\resume', 'agent', 'claude')
    pane.sessionId = 'session-1'
    pane.ptyId = 'pty-old'
    pane.agentStatus = { status: 'working', updatedAt: 1 }
    plantTab(pane)
    const ipc = installMockIpc()
    const waiting = deferred<{ ptyId: string }>()
    ipc.invoke.mockImplementation((channel: string) => channel === 'session:resume' ? waiting.promise : Promise.resolve(undefined))

    const resume = usePanesStore.getState().resumeAgentPane(pane.id)
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
    waiting.resolve({ ptyId: 'pty-new' })
    await resume
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
  })

  it('resets an existing pane to idle before starting a replacement session', async () => {
    const pane = makeLeaf('C:\\new', 'agent', 'codex')
    pane.sessionId = 'old-session'
    pane.ptyId = 'old-pty'
    pane.agentStatus = { status: 'error', updatedAt: 1 }
    plantTab(pane)
    const ipc = installMockIpc()
    const waiting = deferred<{ ptyId: string; sessionId: string }>()
    ipc.invoke.mockImplementation((channel: string) => channel === 'session:new' ? waiting.promise : Promise.resolve(undefined))

    const start = usePanesStore.getState().startNewAgentInPane(pane.id)
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
    waiting.resolve({ ptyId: 'new-pty', sessionId: 'new-session' })
    await start
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
  })

  it('resets to idle before retrying a failed resume', async () => {
    const pane = makeLeaf('C:\\retry-resume', 'agent', 'claude')
    pane.sessionId = 'retry-session'
    pane.agentStatus = { status: 'waiting', updatedAt: 1 }
    plantTab(pane)
    const ipc = installMockIpc()
    const retryWaiting = deferred<{ ptyId: string }>()
    ipc.invoke
      .mockImplementationOnce(() => Promise.reject(new Error('first resume failed')))
      .mockImplementationOnce(() => retryWaiting.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await usePanesStore.getState().resumeAgentPane(pane.id)
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.resumeError).toBeTruthy()
    const retry = usePanesStore.getState().resumeAgentPane(pane.id)
    const duringRetry = usePanesStore.getState().findPaneInAnyTab(pane.id)
    expect(duringRetry?.agentStatus?.status).toBe('idle')
    expect(duringRetry?.resumeError).toBeUndefined()
    retryWaiting.resolve({ ptyId: 'retry-pty' })
    await retry
  })

  it('resets to idle before retrying a failed new session', async () => {
    const pane = makeLeaf('C:\\retry-new', 'agent', 'codex')
    pane.agentStatus = { status: 'error', updatedAt: 1 }
    plantTab(pane)
    const ipc = installMockIpc()
    const retryWaiting = deferred<{ ptyId: string; sessionId: string }>()
    ipc.invoke
      .mockImplementationOnce(() => Promise.reject(new Error('first new session failed')))
      .mockImplementationOnce(() => retryWaiting.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await usePanesStore.getState().startNewAgentInPane(pane.id)
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.resumeError).toBeTruthy()
    const retry = usePanesStore.getState().startNewAgentInPane(pane.id)
    const duringRetry = usePanesStore.getState().findPaneInAnyTab(pane.id)
    expect(duringRetry?.agentStatus?.status).toBe('idle')
    expect(duringRetry?.resumeError).toBeUndefined()
    retryWaiting.resolve({ ptyId: 'retry-pty', sessionId: 'retry-session' })
    await retry
  })

  it('seeds both session-browser resume variants idle before resume IPC completes', async () => {
    const ipc = installMockIpc()
    const waiting = deferred<{ ptyId: string }>()
    ipc.invoke.mockImplementation((channel: string) => channel === 'session:resume' ? waiting.promise : Promise.resolve(undefined))

    const existingTabResume = usePanesStore.getState().resumeSession('claude', 'session-split', 'C:\\split')
    const splitPane = usePanesStore.getState().tabs[0].rootNode!
    const splitLeaf = collectLeaves(splitPane)[0]
    expect(splitLeaf.agentStatus?.status).toBe('idle')

    const newTabResume = usePanesStore.getState().resumeSessionInNewTab('codex', 'session-tab', 'C:\\tab')
    const newTab = usePanesStore.getState().tabs.at(-1)!
    const newTabRoot = newTab.rootNode
    expect(newTabRoot?.type).toBe('leaf')
    if (newTabRoot?.type === 'leaf') expect(newTabRoot.agentStatus?.status).toBe('idle')

    waiting.resolve({ ptyId: 'pty-resumed' })
    await Promise.all([existingTabResume, newTabResume])
  })
})

describe('usePanesStore — automatic idle suspension lifecycle', () => {
  it('marks intent before killing and consumes the expected exit without disconnect recovery', async () => {
    const pane = makeLeaf('C:\\repo', 'agent', 'claude')
    pane.sessionId = 'session-1'
    pane.ptyId = 'pty-1'
    pane.agentStatus = { status: 'idle', updatedAt: 1 }
    plantTab(pane)
    const ipc = installMockIpc()
    let resolveKill!: () => void
    ipc.invoke.mockImplementation((channel: string) => channel === 'pty:kill' ? new Promise<void>((resolve) => { resolveKill = resolve }) : Promise.resolve(undefined))

    usePanesStore.getState().suspendAgentPane(pane.id)
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentSuspension).toEqual({ reason: 'idle-policy', at: expect.any(Number) })
    expect(ipc.invoke).toHaveBeenCalledWith('pty:kill', 'pty-1')

    usePanesStore.getState().markPtyExited('pty-1', 0)
    const afterExit = usePanesStore.getState().findPaneInAnyTab(pane.id)
    expect(afterExit?.ptyId).toBeUndefined()
    expect(afterExit?.agentSuspension?.reason).toBe('idle-policy')
    expect(afterExit?.agentDisconnected).toBeUndefined()

    resolveKill()
    await Promise.resolve()
  })

  it('deduplicates resume attempts and clears policy intent only after success', async () => {
    const pane = makeLeaf('C:\\repo', 'agent', 'codex')
    pane.sessionId = 'session-1'
    pane.agentSuspension = { reason: 'idle-policy', at: 1 }
    plantTab(pane)
    const ipc = installMockIpc()
    let resolveResume!: (value: { ptyId: string }) => void
    ipc.invoke.mockImplementation((channel: string) => channel === 'session:resume'
      ? new Promise<{ ptyId: string }>((resolve) => { resolveResume = resolve })
      : Promise.resolve(undefined))

    const first = usePanesStore.getState().resumeAgentPane(pane.id)
    const second = usePanesStore.getState().resumeAgentPane(pane.id)
    expect(ipc.invoke.mock.calls.filter((call: unknown[]) => call[0] === 'session:resume')).toHaveLength(1)

    resolveResume({ ptyId: 'pty-resumed' })
    await Promise.all([first, second])
    const resumed = usePanesStore.getState().findPaneInAnyTab(pane.id)
    expect(resumed?.ptyId).toBe('pty-resumed')
    expect(resumed?.agentSuspension).toBeUndefined()
  })
})

describe('usePanesStore — bulk sidebar section state', () => {
  it('expands and collapses every project section without changing Recent', () => {
    const tabA = plantTab(makeLeaf('C:\\a'))
    const tabB = plantTab(makeLeaf('C:\\b'))
    usePanesStore.setState({
      sidebarSectionOpen: { recent: true, [`tab:${tabA}`]: true, [`tab:${tabB}`]: false },
    })

    usePanesStore.getState().setAllTabSidebarSectionsOpen(false)
    expect(usePanesStore.getState().sidebarSectionOpen).toMatchObject({
      recent: true,
      [`tab:${tabA}`]: false,
      [`tab:${tabB}`]: false,
    })

    usePanesStore.getState().setAllTabSidebarSectionsOpen(true)
    expect(usePanesStore.getState().sidebarSectionOpen).toMatchObject({
      recent: true,
      [`tab:${tabA}`]: true,
      [`tab:${tabB}`]: true,
    })
  })
})

describe('usePanesStore — focusPaneInTab atomicity', () => {
  beforeEach(() => {
    // Two tabs, each with two stacked panes. Active tab is tab A.
    const tabA = plantTab(makeSplit('vertical', makeLeaf('C:\\a'), makeLeaf('C:\\a')), 'a-pane')
    // fix ids for stable assertions
    const leafA1 = makeLeaf('C:\\a')
    const leafA2 = makeLeaf('C:\\a')
    usePanesStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabA ? { ...t, rootNode: makeSplit('vertical', leafA1, leafA2), focusedPaneId: leafA1.id } : t
      ),
    }))
    void tabA
  })

  it('applies activeTab + focusedPane in one coherent transition', () => {
    const { tabs } = usePanesStore.getState()
    const tabA = tabs[0]
    const leafA2 = collectLeafIds(tabA.rootNode!)[1]

    // Add a second tab and switch focus into one of tab A's panes from it.
    const tabB = plantTab(makeLeaf('C:\\b'))
    usePanesStore.setState({ activeTabId: tabB })
    usePanesStore.getState().focusPaneInTab(tabA.id, leafA2)

    const after = usePanesStore.getState()
    // Atomicity: BOTH the active tab and the focused pane reflect the call in a
    // single consistent snapshot — not a half-applied setActiveTab-only state.
    expect(after.activeTabId).toBe(tabA.id)
    const focusedTab = after.tabs.find((t) => t.id === tabA.id)!
    expect(focusedTab.focusedPaneId).toBe(leafA2)
    expect(after.localFocusArmed).toBe(true)
  })

  it('does not disturb the other tab', () => {
    const { tabs } = usePanesStore.getState()
    const tabA = tabs[0]
    const leafA2 = collectLeafIds(tabA.rootNode!)[1]
    const tabBLeaf = makeLeaf('C:\\b')
    const tabB = plantTab(tabBLeaf, tabBLeaf.id)

    usePanesStore.getState().focusPaneInTab(tabA.id, leafA2)

    const after = usePanesStore.getState()
    expect(after.tabs.find((t) => t.id === tabB)!.focusedPaneId).toBe(tabBLeaf.id)
  })
})

describe('usePanesStore — setPaneCwd', () => {
  it('updates the cwd of the leaf matching the ptyId', () => {
    const leaf = makeLeaf('C:\\old')
    leaf.ptyId = 'pty-1'
    const other = makeLeaf('C:\\other')
    other.ptyId = 'pty-2'
    const tabId = plantTab(makeSplit('vertical', leaf, other), leaf.id)

    usePanesStore.getState().setPaneCwd('pty-1', 'C:\\new')

    const root = tabRoot(tabId)!
    expect(findLeaf(root, leaf.id)!.cwd).toBe('C:\\new')
    // Unrelated pane untouched
    expect(findLeaf(root, other.id)!.cwd).toBe('C:\\other')
  })

  it('is a no-op when no leaf matches the ptyId', () => {
    const leaf = makeLeaf('C:\\old')
    leaf.ptyId = 'pty-1'
    const before = makeLeaf('C:\\before')
    const tabId = plantTab(makeSplit('vertical', leaf, before), leaf.id)
    void before

    usePanesStore.getState().setPaneCwd('pty-missing', 'C:\\new')

    expect(findLeaf(tabRoot(tabId)!, leaf.id)!.cwd).toBe('C:\\old')
  })
})

describe('usePanesStore — zoom', () => {
  it('zooms a pane and unzooms', () => {
    expect(usePanesStore.getState().zoomedPaneId).toBeNull()
    usePanesStore.getState().zoomPane('p1')
    expect(usePanesStore.getState().zoomedPaneId).toBe('p1')
    usePanesStore.getState().unzoom()
    expect(usePanesStore.getState().zoomedPaneId).toBeNull()
  })
})

describe('usePanesStore — cross-window ack booleans (spec 024)', () => {
  // insertPaneAtSplit / replacePaneById / addPaneToTab MUST return true only
  // when the change actually applied. A no-op (self-drop, vanished target) must
  // stay silent so main times out and rolls back instead of deleting the source.

  it('insertPaneAtSplit returns false on a self-drop and changes nothing', () => {
    const leaf = makeLeaf('C:\\a')
    const tabId = plantTab(leaf, leaf.id)
    const rootBefore = tabRoot(tabId)!

    const ok = usePanesStore.getState().insertPaneAtSplit(leaf, leaf.id, 'horizontal', false)

    expect(ok).toBe(false)
    expect(tabRoot(tabId)).toEqual(rootBefore)
  })

  it('insertPaneAtSplit returns false when the target pane has vanished', () => {
    const leaf = makeLeaf('C:\\a')
    plantTab(leaf, leaf.id)
    const incoming = makeLeaf('C:\\b')

    const ok = usePanesStore.getState().insertPaneAtSplit(incoming, 'does-not-exist', 'vertical', false)

    expect(ok).toBe(false)
  })

  it('insertPaneAtSplit returns true and inserts on a real target', () => {
    const target = makeLeaf('C:\\a')
    const tabId = plantTab(target, target.id)
    const incoming = makeLeaf('C:\\b')

    const ok = usePanesStore.getState().insertPaneAtSplit(incoming, target.id, 'vertical', false)

    expect(ok).toBe(true)
    const root = tabRoot(tabId)!
    expect(root.type).toBe('split')
    expect(collectLeafIds(root).sort()).toEqual([target.id, incoming.id].sort())
    // The incoming pane becomes focused.
    const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)!
    expect(tab.focusedPaneId).toBe(incoming.id)
  })

  it('replacePaneById returns false when the pane is not found', () => {
    const leaf = makeLeaf('C:\\a')
    plantTab(leaf, leaf.id)
    const replacement = makeLeaf('C:\\c')

    const ok = usePanesStore.getState().replacePaneById('missing', replacement)

    expect(ok).toBe(false)
  })

  it('replacePaneById returns true and swaps focus onto the replacement', () => {
    const leaf = makeLeaf('C:\\a')
    const tabId = plantTab(leaf, leaf.id)
    const replacement = makeLeaf('C:\\c')

    const ok = usePanesStore.getState().replacePaneById(leaf.id, replacement)

    expect(ok).toBe(true)
    expect(findLeaf(tabRoot(tabId)!, replacement.id)).not.toBeNull()
    const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)!
    expect(tab.focusedPaneId).toBe(replacement.id)
  })

  it('addPaneToTab returns false when the target tab does not exist', () => {
    const ok = usePanesStore.getState().addPaneToTab(makeLeaf('C:\\a'), 'no-such-tab')
    expect(ok).toBe(false)
  })
})

describe('usePanesStore — tree stays well-formed under edits', () => {
  it('removePaneKeepTab keeps the tab and collapses a split to the sibling', () => {
    const a = makeLeaf('C:\\a')
    const b = makeLeaf('C:\\b')
    const tabId = plantTab(makeSplit('vertical', a, b), a.id)

    usePanesStore.getState().removePaneKeepTab(a.id)

    const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)!
    expect(tab.rootNode).toBeDefined()
    expect(tab.rootNode!.type).toBe('leaf')
    expect(tab.rootNode!.id).toBe(b.id)
  })

  it('addPaneToTab splits an existing single-pane tab', () => {
    const existing = makeLeaf('C:\\a')
    const tabId = plantTab(existing, existing.id)
    const incoming = makeLeaf('C:\\b')

    const ok = usePanesStore.getState().addPaneToTab(incoming, tabId)

    expect(ok).toBe(true)
    const root = tabRoot(tabId)!
    expect(root.type).toBe('split')
    expect(collectLeafIds(root).sort()).toEqual([existing.id, incoming.id].sort())
  })

  it('reorderTab moves a tab before another without dropping any', () => {
    const t1 = plantTab(makeLeaf('C:\\1'))
    const t2 = plantTab(makeLeaf('C:\\2'))
    const t3 = plantTab(makeLeaf('C:\\3'))

    usePanesStore.getState().reorderTab(t3, t1)

    const ids = usePanesStore.getState().tabs.map((t) => t.id)
    expect(ids).toHaveLength(3)
    expect(ids.indexOf(t3)).toBeLessThan(ids.indexOf(t1))
    expect(new Set(ids)).toEqual(new Set([t1, t2, t3]))
  })
})

describe('usePanesStore — cwd-repair mapping (spec 009/015)', () => {
  it('applyCwdRepair rewrites leaf + default cwds by segment boundary', () => {
    const leaf = makeLeaf('C:\\old\\proj')
    const tabId = plantTab(leaf, leaf.id)
    usePanesStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, defaultCwd: 'C:\\old' } : t)),
    }))

    usePanesStore.getState().applyCwdRepair({ oldCwd: 'C:\\old', newCwd: 'C:\\new' })

    const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)!
    expect(tab.defaultCwd).toBe('C:\\new')
    expect(findLeaf(tab.rootNode!, leaf.id)!.cwd).toBe('C:\\new\\proj')
  })

  it('applyCwdRepair leaves an unrelated cwd untouched', () => {
    const leaf = makeLeaf('C:\\other')
    const tabId = plantTab(leaf, leaf.id)

    usePanesStore.getState().applyCwdRepair({ oldCwd: 'C:\\old', newCwd: 'C:\\new' })

    expect(findLeaf(tabRoot(tabId)!, leaf.id)!.cwd).toBe('C:\\other')
  })
})

describe('usePanesStore — tab close tears down PTYs', () => {
  const invoke = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    invoke.mockClear()
    invoke.mockResolvedValue(undefined)
    ;(window as unknown as { ipc: unknown }).ipc = {
      invoke,
      on: vi.fn(),
      send: vi.fn(),
    }
  })
  afterEach(() => {
    delete (window as unknown as { ipc?: unknown }).ipc
  })

  function plantLeavesTab(leaves: PaneNode[]): string {
    if (leaves.length === 0) throw new Error('plantLeavesTab needs >=1 leaf')
    let tree: PaneNode = leaves[0]
    for (let i = 1; i < leaves.length; i++) tree = makeSplit('vertical', tree, leaves[i])
    return plantTab(tree, leaves[0].type === 'leaf' ? leaves[0].id : '')
  }

  function shellLeaf(ptyId?: string): PaneNode {
    const l = makeLeaf('C:\shell')
    if (ptyId) l.ptyId = ptyId
    return l
  }
  function agentLeaf(ptyId: string, sessionId: string): PaneNode {
    const l = makeLeaf('C:\agent', 'agent', 'claude')
    l.ptyId = ptyId
    l.sessionId = sessionId
    return l
  }

  it('closeTab kills every leaf PTY in the closed tab', async () => {
    const keep = plantLeavesTab([shellLeaf('keep-1')])
    const close = plantLeavesTab([shellLeaf('c-1'), shellLeaf('c-2')])

    usePanesStore.getState().closeTab(close)

    // Microtasks for the synchronous invoke call sites.
    await Promise.resolve()
    const killed = invoke.mock.calls.filter((c) => c[0] === 'pty:kill').map((c) => c[1])
    expect(killed.sort()).toEqual(['c-1', 'c-2'])
    // Kept tab's PTY is not killed.
    expect(killed).not.toContain('keep-1')
    // The closed tab is gone.
    expect(usePanesStore.getState().tabs.find((t) => t.id === close)).toBeUndefined()
    expect(usePanesStore.getState().tabs.find((t) => t.id === keep)).toBeDefined()
    void keep
  })

  it('closeTab on a tab with an agent session refreshes sessions once after kills settle', async () => {
    const close = plantLeavesTab([agentLeaf('c-1', 'sess-1')])

    usePanesStore.getState().closeTab(close)

    // Refresh should only fire after kill promises settle.
    expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:refresh')).toHaveLength(0)
    await vi.waitFor(() => {
      expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:refresh')).toHaveLength(1)
    })
    // Exactly one refresh.
    await new Promise((r) => setTimeout(r, 10))
    expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:refresh')).toHaveLength(1)
  })

  it('closeTab on a tab with only shell leaves kills PTYs but does not refresh sessions', async () => {
    const close = plantLeavesTab([shellLeaf('c-1'), shellLeaf('c-2')])

    usePanesStore.getState().closeTab(close)

    await new Promise((r) => setTimeout(r, 10))
    expect(invoke.mock.calls.some((c) => c[0] === 'pty:kill')).toBe(true)
    expect(invoke.mock.calls.some((c) => c[0] === 'sessions:refresh')).toBe(false)
  })

  it('closeTab on agent-without-sessionId does not refresh', async () => {
    const l = makeLeaf('C:\agent', 'agent', 'claude')
    l.ptyId = 'a-1' // no sessionId
    const close = plantLeavesTab([l])

    usePanesStore.getState().closeTab(close)

    await new Promise((r) => setTimeout(r, 10))
    expect(invoke.mock.calls.some((c) => c[0] === 'sessions:refresh')).toBe(false)
  })

  it('closeOtherTabs kills every PTY outside the kept tab and none inside it', async () => {
    const keep = plantLeavesTab([shellLeaf('keep-1')])
    const other1 = plantLeavesTab([shellLeaf('o1-1')])
    const other2 = plantLeavesTab([agentLeaf('o2-1', 'sess-2')])
    void other1; void other2

    usePanesStore.getState().closeOtherTabs(keep)

    await new Promise((r) => setTimeout(r, 10))
    const killed = invoke.mock.calls.filter((c) => c[0] === 'pty:kill').map((c) => c[1])
    expect(killed.sort()).toEqual(['o1-1', 'o2-1'])
    expect(killed).not.toContain('keep-1')
    // One refresh at most (other2 had a session).
    expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:refresh').length).toBeLessThanOrEqual(1)
  })

  it('closeTabsToRight kills only PTYs in tabs after the given index', async () => {
    const t1 = plantLeavesTab([shellLeaf('t1-1')])
    const t2 = plantLeavesTab([shellLeaf('t2-1')])
    const t3 = plantLeavesTab([shellLeaf('t3-1')])
    void t1; void t3

    usePanesStore.getState().closeTabsToRight(t2)

    await new Promise((r) => setTimeout(r, 10))
    const killed = invoke.mock.calls.filter((c) => c[0] === 'pty:kill').map((c) => c[1])
    expect(killed).toEqual(['t3-1'])
    expect(killed).not.toContain('t2-1')
  })

  it('with window.ipc absent, all three actions still update state without throwing', () => {
    delete (window as unknown as { ipc?: unknown }).ipc
    const t1 = plantLeavesTab([shellLeaf('a-1')])
    const t2 = plantLeavesTab([shellLeaf('b-1')])
    const t3 = plantLeavesTab([shellLeaf('c-1')])

    expect(() => usePanesStore.getState().closeTab(t1)).not.toThrow()
    expect(() => usePanesStore.getState().closeOtherTabs(t2)).not.toThrow()
    expect(() => usePanesStore.getState().closeTabsToRight(t2)).not.toThrow()
    // t3 was the only one to the right of t2; both should still be present otherwise.
    const ids = usePanesStore.getState().tabs.map((t) => t.id)
    expect(ids).toContain(t2)
    expect(ids).not.toContain(t1)
    expect(ids).not.toContain(t3)
  })

  it('closePaneInTab on agent-with-sessionId-but-no-ptyId still refreshes', async () => {
    const l = makeLeaf('C:\agent', 'agent', 'claude')
    l.sessionId = 'sess-x' // no ptyId (already exited)
    const tabId = plantLeavesTab([l])

    usePanesStore.getState().closePaneInTab(tabId, l.id)

    await vi.waitFor(() => {
      expect(invoke.mock.calls.filter((c) => c[0] === 'sessions:refresh')).toHaveLength(1)
    })
  })
})

describe('usePanesStore — identity-preserving pane patches', () => {
  it('changes only the targeted tab and preserves no-op array identity', () => {
    const paneA = makeLeaf('C:\\a')
    const paneB = makeLeaf('C:\\b')
    const tabAId = plantTab(paneA)
    const tabBId = plantTab(paneB)
    const before = usePanesStore.getState().tabs
    const tabABefore = before.find((tab) => tab.id === tabAId)!
    const tabBBefore = before.find((tab) => tab.id === tabBId)!

    usePanesStore.getState().setPtyId(paneA.id, 'pty-1')
    const after = usePanesStore.getState().tabs
    expect(after.find((tab) => tab.id === tabAId)).not.toBe(tabABefore)
    expect(after.find((tab) => tab.id === tabBId)).toBe(tabBBefore)

    usePanesStore.getState().setPtyId(paneA.id, 'pty-1')
    expect(usePanesStore.getState().tabs).toBe(after)
    usePanesStore.getState().setPtyId('missing', 'pty-x')
    expect(usePanesStore.getState().tabs).toBe(after)
  })

  it('markPtyExited ignores shells and unknown PTYs, and changes only an agent tab', () => {
    const shell = makeLeaf('C:\\shell')
    shell.ptyId = 'shell-pty'
    const agent = makeLeaf('C:\\agent', 'agent', 'claude')
    agent.ptyId = 'agent-pty'
    agent.sessionId = 'session-1'
    const shellTabId = plantTab(shell)
    const agentTabId = plantTab(agent)
    const before = usePanesStore.getState().tabs

    usePanesStore.getState().markPtyExited('missing', 1)
    expect(usePanesStore.getState().tabs).toBe(before)
    usePanesStore.getState().markPtyExited('shell-pty', 1)
    expect(usePanesStore.getState().tabs).toBe(before)

    usePanesStore.getState().markPtyExited('agent-pty', 1)
    const after = usePanesStore.getState().tabs
    expect(after.find((tab) => tab.id === shellTabId)).toBe(before.find((tab) => tab.id === shellTabId))
    expect(after.find((tab) => tab.id === agentTabId)).not.toBe(before.find((tab) => tab.id === agentTabId))
  })

  it('host failure clears shell and agent PTYs while retaining known identity', () => {
    const shell = makeLeaf('C:\\shell')
    shell.ptyId = 'host-shell'
    const known = makeLeaf('C:\\agent', 'agent', 'claude')
    known.ptyId = 'host-known'
    known.sessionId = 'session-known'
    const pending = makeLeaf('C:\\pending', 'agent', 'codex')
    pending.ptyId = 'host-pending'
    pending.sessionId = 'speculative'
    const tabId = plantTab(makeSplit('vertical', shell, makeSplit('horizontal', known, pending)))

    usePanesStore.getState().handleTerminalHostStatus({
      state: 'recovering', incidentId: 'incident-1', code: 9,
      affectedPtyIds: ['host-shell', 'host-known', 'host-pending'],
      unreadyPtyIds: ['host-pending'], unreadyNewAgentPtyIds: ['host-pending'],
    })

    const root = tabRoot(tabId)!
    expect(collectLeaves(root).map((leaf) => leaf.ptyId)).toEqual([undefined, undefined, undefined])
    expect(usePanesStore.getState().findPaneInAnyTab(known.id)?.sessionId).toBe('session-known')
    expect(usePanesStore.getState().findPaneInAnyTab(pending.id)?.sessionId).toBeUndefined()
    expect(usePanesStore.getState().findPaneInAnyTab(shell.id)?.terminalHostRecovery?.action).toBe('shell')
    expect(usePanesStore.getState().findPaneInAnyTab(known.id)?.terminalHostRecovery?.action).toBe('resume')
    expect(usePanesStore.getState().findPaneInAnyTab(pending.id)?.terminalHostRecovery?.action).toBe('new')
  })

  it('does not let a primary renderer recover a detached tab runtime', () => {
    const shell = makeLeaf('C:\\detached')
    shell.ptyId = 'detached-pty'
    const tabId = plantTab(shell)
    usePanesStore.setState((s) => ({
      tabs: s.tabs.map((tab) => tab.id === tabId ? { ...tab, detached: true } : tab),
      isDetachedWindow: false,
    }))

    usePanesStore.getState().handleTerminalHostStatus({
      state: 'recovering', incidentId: 'incident-detached', code: 1,
      affectedPtyIds: ['detached-pty'], unreadyPtyIds: [], unreadyNewAgentPtyIds: [],
    })
    usePanesStore.getState().handleTerminalHostStatus({ state: 'recovered', incidentId: 'incident-detached' })

    expect(usePanesStore.getState().findPaneInAnyTab(shell.id)?.terminalHostRecovery?.state).toBe('recovering')
  })

  it('resumes a known agent exactly once after the host recovers', async () => {
    const agent = makeLeaf('C:\\agent', 'agent', 'claude')
    agent.ptyId = 'lost-agent'
    agent.sessionId = 'session-known'
    plantTab(agent)
    const invoke = vi.fn((channel: string) => channel === 'session:resume'
      ? Promise.resolve({ ptyId: 'fresh-agent' })
      : Promise.resolve(undefined))
    Object.defineProperty(window, 'ipc', { configurable: true, value: { invoke } })

    usePanesStore.getState().handleTerminalHostStatus({
      state: 'recovering', incidentId: 'incident-agent', code: 1,
      affectedPtyIds: ['lost-agent'], unreadyPtyIds: [], unreadyNewAgentPtyIds: [],
    })
    usePanesStore.getState().handleTerminalHostStatus({ state: 'recovered', incidentId: 'incident-agent' })

    await vi.waitFor(() => {
      expect(invoke.mock.calls.filter((call) => call[0] === 'session:resume')).toHaveLength(1)
    })
    expect(usePanesStore.getState().findPaneInAnyTab(agent.id)?.ptyId).toBe('fresh-agent')
  })
})

describe('usePanesStore — agent status badge (spec 032)', () => {
  it('setPaneAgentStatus sets and clears the in-memory agentStatus', () => {
    const pane = makeLeaf('C:\\work', 'agent', 'claude')
    pane.ptyId = 'pty-1'
    plantTab(pane)
    const store = usePanesStore.getState()
    store.setPaneAgentStatus(pane.id, { status: 'working', event: 'pre_tool_use', detail: 'Bash', updatedAt: 1 })
    expect(store.findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('working')
    store.setPaneAgentStatus(pane.id, undefined)
    expect(store.findPaneInAnyTab(pane.id)?.agentStatus).toBeUndefined()
  })

  it('promoteShellPaneToAgent seeds agentStatus working (CLI-launched agent detected)', () => {
    const shell = makeLeaf('C:\\repo', 'shell')
    shell.ptyId = 'shell-pty'
    plantTab(shell)
    usePanesStore.getState().promoteShellPaneToAgent(shell.id, 'claude')
    const pane = usePanesStore.getState().findPaneInAnyTab(shell.id)
    expect(pane?.paneType).toBe('agent')
    expect(pane?.agentStatus?.status).toBe('working')
    expect(pane?.agentStatus?.event).toBe('promote')
  })

  it('demoteAgentPaneToShell clears agentStatus (missed-Stop fallback)', () => {
    const shell = makeLeaf('C:\\repo', 'shell')
    shell.ptyId = 'shell-pty'
    plantTab(shell)
    const store = usePanesStore.getState()
    store.promoteShellPaneToAgent(shell.id, 'codex')
    expect(store.findPaneInAnyTab(shell.id)?.agentStatus?.status).toBe('working')
    store.demoteAgentPaneToShell(shell.id)
    expect(store.findPaneInAnyTab(shell.id)?.agentStatus).toBeUndefined()
  })

  it('pane:agent-event listener runs eventToState and stores the result by ptyId', () => {
    const pane = makeLeaf('C:\\work', 'agent', 'claude')
    pane.ptyId = 'pty-evt'
    plantTab(pane)
    // The handler was captured at module load (see paneAgentEventHandler below).
    expect(paneAgentEventHandler).toBeDefined()
    const handler = paneAgentEventHandler!
    handler('pty-evt', 'session_start', undefined, 'turn-1')
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
    handler('pty-evt', 'pre_tool_use', 'Bash', 'turn-1')
    const mid = usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus
    expect(mid?.status).toBe('working')
    expect(mid?.detail).toBe('Bash')
    handler('pty-evt', 'stop', undefined, 'turn-1')
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
    // Unknown ptyId is a no-op (no throw, no state change).
    handler('pty-missing', 'stop', undefined, 'turn-x')
    expect(usePanesStore.getState().findPaneInAnyTab(pane.id)?.agentStatus?.status).toBe('idle')
  })
})

describe('usePanesStore — CLI agent promotion/demotion (spec 047)', () => {
  afterEach(() => {
    Object.defineProperty(window, 'ipc', { configurable: true, value: undefined })
  })

  it('promoteShellPaneToAgent flips metadata and keeps the live ptyId', () => {
    const shell = makeLeaf('C:\repo', 'shell')
    shell.ptyId = 'shell-pty'
    plantTab(shell)

    usePanesStore.getState().promoteShellPaneToAgent(shell.id, 'claude')

    const pane = usePanesStore.getState().findPaneInAnyTab(shell.id)
    expect(pane?.paneType).toBe('agent')
    expect(pane?.agentKind).toBe('claude')
    expect(pane?.promotedFromShell).toBe(true)
    // The shell pty is still running — ptyId must be untouched (no remount/clear).
    expect(pane?.ptyId).toBe('shell-pty')
  })

  it('promoteShellPaneToAgent does not clobber a native (app-spawned) agent pane', () => {
    const agent = makeLeaf('C:\repo', 'agent', 'claude')
    agent.ptyId = 'agent-pty'
    agent.sessionId = 'session-1'
    plantTab(agent)

    usePanesStore.getState().promoteShellPaneToAgent(agent.id, 'codex')

    const pane = usePanesStore.getState().findPaneInAnyTab(agent.id)
    expect(pane?.agentKind).toBe('claude')            // unchanged
    expect(pane?.promotedFromShell).toBeUndefined()   // never set on a native agent pane
  })

  it('demoteAgentPaneToShell reverts a promoted pane and preserves the pty', () => {
    const shell = makeLeaf('C:\repo', 'shell')
    shell.ptyId = 'shell-pty'
    plantTab(shell)
    usePanesStore.getState().promoteShellPaneToAgent(shell.id, 'codex')
    // Simulate a phase-2 link, then demote when the agent exits.
    usePanesStore.getState().setSessionId(shell.id, 'linked-session')

    usePanesStore.getState().demoteAgentPaneToShell(shell.id)

    const pane = usePanesStore.getState().findPaneInAnyTab(shell.id)
    expect(pane?.paneType).toBe('shell')
    expect(pane?.agentKind).toBeUndefined()
    expect(pane?.sessionId).toBeUndefined()
    expect(pane?.promotedFromShell).toBeUndefined()
    // Pure metadata — no pty kill, ptyId intact.
    expect(pane?.ptyId).toBe('shell-pty')
  })

  it('demoteAgentPaneToShell never demotes a native agent pane', () => {
    const agent = makeLeaf('C:\repo', 'agent', 'claude')
    agent.ptyId = 'agent-pty'
    agent.sessionId = 'session-1'
    plantTab(agent)

    usePanesStore.getState().demoteAgentPaneToShell(agent.id)

    const pane = usePanesStore.getState().findPaneInAnyTab(agent.id)
    expect(pane?.paneType).toBe('agent')
    expect(pane?.agentKind).toBe('claude')
    expect(pane?.sessionId).toBe('session-1')
  })
})
