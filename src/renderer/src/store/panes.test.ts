import { describe, it, expect, beforeEach } from 'vitest'
import { usePanesStore } from './panes'
import {
  makeLeaf,
  makeSplit,
  collectLeafIds,
  findLeaf,
} from '../../../shared/paneTree'
import type { PaneNode } from '../../../shared/types'

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
