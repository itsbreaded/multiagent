import { create } from 'zustand'
import type { Tab, PaneNode, PaneLeaf, PaneSplit, PaneType, SplitDirection } from '../../../shared/types'
import { collectLeaves } from '../utils/tabLabels'

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
  addTab: () => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  renameTab: (tabId: string, label: string) => void
  duplicateTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  closeTabsToRight: (tabId: string) => void

  // Pane operations
  focusPane: (paneId: string) => void
  splitPane: (paneId: string, direction: SplitDirection, paneType?: PaneType) => Promise<void>
  closePane: (paneId: string) => void
  zoomPane: (paneId: string) => void
  unzoom: () => void
  updatePaneRatio: (splitId: string, ratio: number) => void
  setPtyId: (paneId: string, ptyId: string) => void
  setSessionId: (paneId: string, sessionId: string) => void

  // Session / PTY actions (Phase 2)
  resumeSession: (sessionId: string, cwd: string) => Promise<void>
  resumeSessionInNewTab: (sessionId: string, cwd: string) => Promise<void>
  newSession: (cwd: string, direction?: SplitDirection) => Promise<void>
  addShellPane: (cwd: string, direction?: SplitDirection) => Promise<void>
  setPaneCwd: (ptyId: string, cwd: string) => void
  setPaneCustomName: (paneId: string, name: string) => void

  // Layout persistence
  applyLayout: (saved: { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean }) => Promise<void>

  // UI toggles
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  toggleSessionBrowser: () => void
  toggleCommandPalette: () => void
  closeOverlays: () => void

  // Drag state (pane rearrangement)
  draggedPaneId: string | null
  setDraggedPane: (paneId: string | null) => void
  movePaneToSplit: (sourcePaneId: string, targetPaneId: string, direction: SplitDirection, sourceBefore: boolean) => void
  movePaneToNewTab: (paneId: string) => void

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
  draggedPaneId: null,

  addTab: () => {
    const tab: Tab = { id: uuid(), focusedPaneId: '' }
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

  renameTab: (tabId, label) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, customLabel: label.trim() || undefined } : t
      ),
    }))
  },

  duplicateTab: (tabId) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      const focusedLeaf = tab.rootNode
        ? (findLeaf(tab.rootNode, tab.focusedPaneId) ?? (tab.rootNode.type === 'leaf' ? tab.rootNode : null))
        : null
      const cwd = focusedLeaf?.cwd ?? 'C:\\'
      const leaf = makeLeaf(cwd, 'shell')
      const newTab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      const tabs = [...s.tabs.slice(0, idx + 1), newTab, ...s.tabs.slice(idx + 1)]
      return { tabs, activeTabId: newTab.id }
    })
  },

  closeOtherTabs: (tabId) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id === tabId)
      return { tabs, activeTabId: tabId }
    })
  },

  closeTabsToRight: (tabId) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return s
      const tabs = s.tabs.slice(0, idx + 1)
      const activeTabId = tabs.find((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : tabId
      return { tabs, activeTabId }
    })
  },

  focusPane: (paneId) => {
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, focusedPaneId: paneId } : t
      )
      return { tabs }
    })
  },

  splitPane: async (paneId, direction, paneType) => {
    const existing = get().findPane(paneId)
    const resolvedType: PaneType = paneType ?? existing?.paneType ?? 'shell'
    const cwd = existing?.cwd ?? 'C:\\'
    const newLeaf = makeLeaf(cwd, resolvedType)

    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return t
        const existingNode = findLeaf(t.rootNode, paneId)
        if (!existingNode) return t
        const split = makeSplit(direction, existingNode, newLeaf)
        const rootNode = replaceNode(t.rootNode, paneId, split)
        return { ...t, rootNode, focusedPaneId: newLeaf.id }
      })
      return { tabs }
    })

    if (resolvedType === 'claude' && typeof window !== 'undefined' && window.ipc) {
      try {
        const result = await window.ipc.invoke('session:new', cwd) as { ptyId: string; sessionId: string | null }
        if (result?.ptyId) get().setPtyId(newLeaf.id, result.ptyId)
        if (result?.sessionId) get().setSessionId(newLeaf.id, result.sessionId)
      } catch (err) {
        console.error('session:new IPC failed', err)
      }
    }
    // shell panes: Terminal handles pty:create automatically on mount
  },

  closePane: (paneId) => {
    // Kill the PTY before removing the pane from the tree so the process is
    // cleaned up even though Terminal's unmount no longer calls pty:kill.
    const pane = get().findPane(paneId)
    if (pane?.ptyId && typeof window !== 'undefined' && window.ipc) {
      window.ipc.invoke('pty:kill', pane.ptyId).catch(() => {})
    }
    set((s) => {
      const tabsToRemove = new Set<string>()
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return t
        const newRoot = removeLeaf(t.rootNode, paneId)
        if (!newRoot) {
          tabsToRemove.add(t.id)
          return t
        }
        const leafIds = collectLeafIds(newRoot)
        const focusedPaneId =
          t.focusedPaneId === paneId ? (leafIds[0] ?? '') : t.focusedPaneId
        return { ...t, rootNode: newRoot, focusedPaneId }
      })
      const survivingTabs = tabs.filter((t) => !tabsToRemove.has(t.id))
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
        if (t.id !== s.activeTabId || !t.rootNode) return t
        return { ...t, rootNode: updateRatioInTree(t.rootNode, splitId, ratio) }
      })
      return { tabs }
    })
  },

  setPtyId: (paneId, ptyId) => {
    // Search all tabs — the active tab may have changed by the time the IPC call returns.
    set((s) => ({
      tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, { ptyId }) } : t),
    }))
  },

  setPaneCwd: (ptyId, cwd) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (!t.rootNode) return t
        function patchCwd(node: PaneNode): PaneNode {
          if (node.type === 'leaf') return node.ptyId === ptyId ? { ...node, cwd } : node
          return { ...node, first: patchCwd(node.first), second: patchCwd(node.second) }
        }
        return { ...t, rootNode: patchCwd(t.rootNode) }
      }),
    }))
  },

  setPaneCustomName: (paneId, name) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.rootNode
        ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, { customName: name.trim() || undefined }) }
        : t
      ),
    }))
  },

  setSessionId: (paneId, sessionId) => {
    // Search all tabs — the active tab may have changed by the time the IPC call returns.
    set((s) => ({
      tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, { sessionId }) } : t),
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
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit('vertical', t.rootNode, leaf)
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

  resumeSessionInNewTab: async (sessionId, cwd) => {
    const leaf = makeLeaf(cwd, 'claude')
    leaf.sessionId = sessionId
    const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:resume', sessionId, cwd)) as { ptyId: string }
        if (result?.ptyId) get().setPtyId(leaf.id, result.ptyId)
      } catch (err) {
        console.error('session:resume IPC failed', err)
      }
    }
  },

  newSession: async (cwd, direction = 'vertical') => {
    const leaf = makeLeaf(cwd, 'claude')
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return { tabs: [tab], activeTabId: tab.id }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit(direction, t.rootNode, leaf)
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

  addShellPane: async (cwd, direction = 'vertical') => {
    const leaf = makeLeaf(cwd, 'shell')
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return { tabs: [tab], activeTabId: tab.id }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit(direction, t.rootNode, leaf)
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

  applyLayout: async (saved) => {
    try {
      // Strip ptyIds and convert unresumable claude panes to shell panes up front.
      // A claude pane with no sessionId means the session file was never detected
      // before the layout saved — leaving it as-is would hang on "Starting session..."
      function sanitizeNode(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.paneType === 'claude' && !node.sessionId) {
            return { ...node, paneType: 'shell', ptyId: undefined }
          }
          return { ...node, ptyId: undefined }
        }
        return { ...node, first: sanitizeNode(node.first), second: sanitizeNode(node.second) }
      }
      const tabs = saved.tabs.map((t) => t.rootNode ? { ...t, rootNode: sanitizeNode(t.rootNode) } : t)

      set({
        tabs,
        activeTabId: tabs[0]?.id ?? '',
        sidebarWidth: saved.sidebarWidth ?? 220,
        sidebarOpen: saved.sidebarOpen ?? true,
      })

      if (typeof window === 'undefined' || !window.ipc) return

      // Auto-resume claude sessions that have a known sessionId
      for (const tab of tabs) {
        for (const leaf of (tab.rootNode ? collectLeaves(tab.rootNode) : [])) {
          if (leaf.paneType === 'claude' && leaf.sessionId) {
            try {
              const result = await window.ipc.invoke('session:resume', leaf.sessionId, leaf.cwd) as { ptyId: string }
              if (result?.ptyId) get().setPtyId(leaf.id, result.ptyId)
            } catch {
              // Session file deleted or corrupt — fall back to shell pane
              set((s) => ({
                tabs: s.tabs.map((t) => t.rootNode
                  ? { ...t, rootNode: updateLeaf(t.rootNode, leaf.id, { paneType: 'shell', sessionId: undefined }) }
                  : t
                ),
              }))
            }
          }
        }
      }
    } catch (err) {
      console.error('[MultiAgent] applyLayout failed:', err)
    }
  },

  setDraggedPane: (paneId) => set({ draggedPaneId: paneId }),

  movePaneToNewTab: (paneId) => {
    set((s) => {
      let sourceTabIdx = -1
      let sourceLeaf: PaneLeaf | undefined
      for (let i = 0; i < s.tabs.length; i++) {
        const tab = s.tabs[i]
        if (!tab.rootNode) continue
        const leaf = findLeaf(tab.rootNode, paneId)
        if (leaf) { sourceTabIdx = i; sourceLeaf = leaf; break }
      }
      if (sourceTabIdx === -1 || !sourceLeaf) return s

      const sourceTab = s.tabs[sourceTabIdx]
      const newRoot = removeLeaf(sourceTab.rootNode!, paneId)
      const newTab: Tab = { id: uuid(), rootNode: sourceLeaf, focusedPaneId: sourceLeaf.id }

      let updatedTabs: Tab[]
      if (!newRoot) {
        // Source tab had only this pane — replace it with the new tab in-place
        updatedTabs = [
          ...s.tabs.slice(0, sourceTabIdx),
          newTab,
          ...s.tabs.slice(sourceTabIdx + 1),
        ]
      } else {
        const leafIds = collectLeafIds(newRoot)
        const updatedSource: Tab = {
          ...sourceTab,
          rootNode: newRoot,
          focusedPaneId: sourceTab.focusedPaneId === paneId ? (leafIds[0] ?? '') : sourceTab.focusedPaneId,
        }
        updatedTabs = [
          ...s.tabs.slice(0, sourceTabIdx),
          updatedSource,
          newTab,
          ...s.tabs.slice(sourceTabIdx + 1),
        ]
      }

      return { tabs: updatedTabs, activeTabId: newTab.id }
    })
  },

  movePaneToSplit: (sourcePaneId, targetPaneId, direction, sourceBefore) => {
    if (sourcePaneId === targetPaneId) return
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId || !t.rootNode) return t
        const sourceLeaf = findLeaf(t.rootNode, sourcePaneId)
        if (!sourceLeaf) return t
        const treeWithoutSource = removeLeaf(t.rootNode, sourcePaneId)
        if (!treeWithoutSource) return t
        if (!findLeaf(treeWithoutSource, targetPaneId)) return t
        const newSplit = sourceBefore
          ? makeSplit(direction, sourceLeaf, findLeaf(treeWithoutSource, targetPaneId)!)
          : makeSplit(direction, findLeaf(treeWithoutSource, targetPaneId)!, sourceLeaf)
        const newRoot = replaceNode(treeWithoutSource, targetPaneId, newSplit)
        return { ...t, rootNode: newRoot, focusedPaneId: sourcePaneId }
      })
      return { tabs }
    })
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
    if (!tab || !tab.focusedPaneId || !tab.rootNode) return undefined
    return findLeaf(tab.rootNode, tab.focusedPaneId) ?? undefined
  },

  findPane: (paneId) => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || !tab.rootNode) return undefined
    return findLeaf(tab.rootNode, paneId) ?? undefined
  },

  findPaneBySessionId: (sessionId) => {
    const s = get()
    for (const tab of s.tabs) {
      if (!tab.rootNode) continue
      const leaf = findLeafBySessionId(tab.rootNode, sessionId)
      if (leaf) return leaf
    }
    return undefined
  },
}))

// Wire up the pty:cwd event once at module load so CWD changes update pane headers.
if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('pty:cwd', (ptyId: unknown, cwd: unknown) => {
    if (typeof ptyId === 'string' && typeof cwd === 'string') {
      usePanesStore.getState().setPaneCwd(ptyId, cwd)
    }
  })

  // When the main process detects a new claude session file, link it to the pane
  // so the session can be persisted and auto-resumed on next launch.
  window.ipc.on('session:detected', (ptyId: unknown, sessionId: unknown) => {
    if (typeof ptyId !== 'string' || typeof sessionId !== 'string') return
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const leaves = collectLeaves(tab.rootNode)
      const pane = leaves.find((l) => l.ptyId === ptyId)
      if (pane) {
        store.setSessionId(pane.id, sessionId)
        break
      }
    }
  })
}

