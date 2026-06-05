import { create } from 'zustand'
import type { Tab, PaneNode, PaneLeaf, PaneSplit, SplitDirection } from '../../../shared/types'

function uuid(): string {
  return crypto.randomUUID()
}

function makeLeaf(cwd: string, paneType: 'shell' | 'claude' = 'shell'): PaneLeaf {
  return { type: 'leaf', id: uuid(), paneType, cwd }
}

function makeSplit(
  direction: SplitDirection,
  first: PaneNode,
  second: PaneNode
): PaneSplit {
  return { type: 'split', id: uuid(), direction, ratio: 0.5, first, second }
}

/** Walk the tree and return the leaf with the given id, or null */
function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.first, id) ?? findLeaf(node.second, id)
}

/** Replace the node identified by `targetId` with `replacement` */
function replaceNode(node: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (node.id === targetId) return replacement
  if (node.type === 'leaf') return node
  return {
    ...node,
    first: replaceNode(node.first, targetId, replacement),
    second: replaceNode(node.second, targetId, replacement),
  }
}

/**
 * Remove the leaf with `removeId` from the tree.
 * Returns the updated subtree, or null if the entire subtree should be removed.
 */
function removeLeaf(node: PaneNode, removeId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === removeId ? null : node
  }
  // It's a split
  if (node.first.id === removeId || (node.first.type === 'leaf' && node.first.id === removeId)) {
    return node.second
  }
  if (node.second.id === removeId || (node.second.type === 'leaf' && node.second.id === removeId)) {
    return node.first
  }
  const newFirst = removeLeaf(node.first, removeId)
  const newSecond = removeLeaf(node.second, removeId)
  if (newFirst === null) return newSecond
  if (newSecond === null) return newFirst
  return { ...node, first: newFirst, second: newSecond }
}

/** Update ratio on the split with the given id */
function updateRatioInTree(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) return { ...node, ratio }
  return {
    ...node,
    first: updateRatioInTree(node.first, splitId, ratio),
    second: updateRatioInTree(node.second, splitId, ratio),
  }
}

/** Update a field on the leaf with the given id */
function updateLeaf(node: PaneNode, leafId: string, patch: Partial<PaneLeaf>): PaneNode {
  if (node.type === 'leaf') {
    return node.id === leafId ? { ...node, ...patch } : node
  }
  return {
    ...node,
    first: updateLeaf(node.first, leafId, patch),
    second: updateLeaf(node.second, leafId, patch),
  }
}

/** Collect all leaf ids in tree order */
function collectLeafIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id]
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

/** Find a leaf by its sessionId */
function findLeafBySessionId(node: PaneNode, sessionId: string): PaneLeaf | null {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? node : null
  }
  return findLeafBySessionId(node.first, sessionId) ?? findLeafBySessionId(node.second, sessionId)
}

interface PanesStore {
  tabs: Tab[]
  activeTabId: string
  zoomedPaneId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  sessionBrowserOpen: boolean
  commandPaletteOpen: boolean

  // Tab operations
  addTab: (initialCwd?: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void

  // Pane operations
  focusPane: (paneId: string) => void
  splitPane: (paneId: string, direction: SplitDirection) => void
  closePane: (paneId: string) => void
  zoomPane: (paneId: string) => void
  unzoom: () => void
  updatePaneRatio: (splitId: string, ratio: number) => void
  setPtyId: (paneId: string, ptyId: string) => void
  setSessionId: (paneId: string, sessionId: string) => void

  // Session / PTY actions (Phase 2)
  resumeSession: (sessionId: string, cwd: string) => Promise<void>
  newSession: (cwd: string) => Promise<void>
  addShellPane: (cwd: string) => Promise<void>

  // UI toggles
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  toggleSessionBrowser: () => void
  toggleCommandPalette: () => void
  closeOverlays: () => void

  // Getters
  activeTab: () => Tab | undefined
  getFocusedPane: () => PaneLeaf | undefined
  findPane: (paneId: string) => PaneLeaf | undefined
  findPaneBySessionId: (sessionId: string) => PaneLeaf | undefined
}

export const usePanesStore = create<PanesStore>((set, get) => ({
  tabs: [],
  activeTabId: '',
  zoomedPaneId: null,
  sidebarOpen: true,
  sidebarWidth: 220,
  sessionBrowserOpen: false,
  commandPaletteOpen: false,

  addTab: (initialCwd = 'C:\\') => {
    const leaf = makeLeaf(initialCwd, 'shell')
    const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
  },

  closeTab: (tabId) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? '') : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  focusPane: (paneId) => {
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, focusedPaneId: paneId } : t
      )
      return { tabs }
    })
  },

  splitPane: (paneId, direction) => {
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        const existing = findLeaf(t.rootNode, paneId)
        if (!existing) return t
        const newLeaf = makeLeaf(existing.cwd, 'shell')
        const split = makeSplit(direction, existing, newLeaf)
        const rootNode = replaceNode(t.rootNode, paneId, split)
        return { ...t, rootNode, focusedPaneId: newLeaf.id }
      })
      return { tabs }
    })
  },

  closePane: (paneId) => {
    // Kill the PTY before removing the pane from the tree so the process is
    // cleaned up even though Terminal's unmount no longer calls pty:kill.
    const pane = get().findPane(paneId)
    if (pane?.ptyId && typeof window !== 'undefined' && window.ipc) {
      window.ipc.invoke('pty:kill', pane.ptyId).catch(() => {})
    }
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        const newRoot = removeLeaf(t.rootNode, paneId)
        if (!newRoot) {
          // Last pane closed - remove the tab entirely (handled below)
          return { ...t, rootNode: t.rootNode, focusedPaneId: '' }
        }
        const leafIds = collectLeafIds(newRoot)
        const focusedPaneId =
          t.focusedPaneId === paneId ? (leafIds[0] ?? '') : t.focusedPaneId
        return { ...t, rootNode: newRoot, focusedPaneId }
      })
      // Clean up tabs that have no panes
      const survivingTabs = tabs.filter((t) => t.focusedPaneId !== '')
      const activeTabId = survivingTabs.find((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (survivingTabs[survivingTabs.length - 1]?.id ?? '')
      return { tabs: survivingTabs, activeTabId }
    })
  },

  zoomPane: (paneId) => set({ zoomedPaneId: paneId }),

  unzoom: () => set({ zoomedPaneId: null }),

  updatePaneRatio: (splitId, ratio) => {
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        return { ...t, rootNode: updateRatioInTree(t.rootNode, splitId, ratio) }
      })
      return { tabs }
    })
  },

  setPtyId: (paneId, ptyId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id !== s.activeTabId
          ? t
          : { ...t, rootNode: updateLeaf(t.rootNode, paneId, { ptyId }) }
      ),
    }))
  },

  setSessionId: (paneId, sessionId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id !== s.activeTabId
          ? t
          : { ...t, rootNode: updateLeaf(t.rootNode, paneId, { sessionId }) }
      ),
    }))
  },

  resumeSession: async (sessionId, cwd) => {
    const leaf = makeLeaf(cwd, 'claude')
    leaf.sessionId = sessionId
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return { tabs: [tab], activeTabId: tab.id }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        const existing = t.rootNode
        const split = makeSplit('vertical', existing, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs }
    })
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:resume', sessionId, cwd)) as { ptyId: string }
        if (result?.ptyId) {
          get().setPtyId(leaf.id, result.ptyId)
        }
      } catch (err) {
        console.error('session:resume IPC failed', err)
      }
    }
  },

  newSession: async (cwd) => {
    const leaf = makeLeaf(cwd, 'claude')
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return { tabs: [tab], activeTabId: tab.id }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        const existing = t.rootNode
        const split = makeSplit('vertical', existing, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs }
    })
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:new', cwd)) as { ptyId: string; sessionId: string | null }
        if (result?.ptyId) {
          get().setPtyId(leaf.id, result.ptyId)
        }
        if (result?.sessionId) {
          get().setSessionId(leaf.id, result.sessionId)
        }
      } catch (err) {
        console.error('session:new IPC failed', err)
      }
    }
  },

  addShellPane: async (cwd) => {
    const leaf = makeLeaf(cwd, 'shell')
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return { tabs: [tab], activeTabId: tab.id }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        const existing = t.rootNode
        const split = makeSplit('vertical', existing, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs }
    })
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('pty:create', cwd)) as { ptyId: string }
        if (result?.ptyId) {
          get().setPtyId(leaf.id, result.ptyId)
        }
      } catch (err) {
        console.error('pty:create IPC failed', err)
      }
    }
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  toggleSessionBrowser: () => set((s) => ({ sessionBrowserOpen: !s.sessionBrowserOpen, commandPaletteOpen: false })),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen, sessionBrowserOpen: false })),
  closeOverlays: () => set({ sessionBrowserOpen: false, commandPaletteOpen: false }),

  activeTab: () => {
    const s = get()
    return s.tabs.find((t) => t.id === s.activeTabId)
  },

  getFocusedPane: () => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || !tab.focusedPaneId) return undefined
    return findLeaf(tab.rootNode, tab.focusedPaneId) ?? undefined
  },

  findPane: (paneId) => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return undefined
    return findLeaf(tab.rootNode, paneId) ?? undefined
  },

  findPaneBySessionId: (sessionId) => {
    const s = get()
    for (const tab of s.tabs) {
      const leaf = findLeafBySessionId(tab.rootNode, sessionId)
      if (leaf) return leaf
    }
    return undefined
  },
}))
