import { create } from 'zustand'
import type { AgentKind, Tab, PaneNode, PaneLeaf, PaneSplit, PaneType, SplitDirection } from '../../../shared/types'
import { collectLeaves } from '../utils/tabLabels'

function uuid(): string {
  return crypto.randomUUID()
}

function makeLeaf(cwd: string, paneType: PaneType = 'shell', agentKind?: AgentKind): PaneLeaf {
  return {
    type: 'leaf',
    id: uuid(),
    paneType,
    agentKind: paneType === 'agent' ? (agentKind ?? 'claude') : undefined,
    cwd
  }
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

/** Find a leaf by its agent/session ID pair */
function findLeafBySessionId(node: PaneNode, agentKind: AgentKind, sessionId: string): PaneLeaf | null {
  if (node.type === 'leaf') {
    return node.agentKind === agentKind && node.sessionId === sessionId ? node : null
  }
  return findLeafBySessionId(node.first, agentKind, sessionId) ?? findLeafBySessionId(node.second, agentKind, sessionId)
}

function initialLastAgent(): AgentKind {
  if (typeof localStorage === 'undefined') return 'claude'
  return localStorage.getItem('multiagent:lastAgent') === 'codex' ? 'codex' : 'claude'
}

function rememberAgent(agentKind: AgentKind): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('multiagent:lastAgent', agentKind)
  }
}

interface PanesStore {
  tabs: Tab[]
  activeTabId: string
  zoomedPaneId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  sessionBrowserOpen: boolean
  commandPaletteOpen: boolean
  lastAgentKind: AgentKind

  // Tab operations
  addTab: (defaultCwd?: string, name?: string) => void
  setTabDefaultCwd: (tabId: string, cwd: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  renameTab: (tabId: string, label: string) => void
  duplicateTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  closeTabsToRight: (tabId: string) => void

  // Pane operations
  focusPane: (paneId: string) => void
  splitPane: (paneId: string, direction: SplitDirection, paneType?: PaneType, cwdOverride?: string, agentKind?: AgentKind) => Promise<void>
  closePane: (paneId: string) => void
  zoomPane: (paneId: string) => void
  unzoom: () => void
  updatePaneRatio: (splitId: string, ratio: number) => void
  setPtyId: (paneId: string, ptyId: string) => void
  setSessionId: (paneId: string, sessionId: string) => void

  // Session / PTY actions (Phase 2)
  resumeSession: (agentKind: AgentKind, sessionId: string, cwd: string) => Promise<void>
  resumeSessionInNewTab: (agentKind: AgentKind, sessionId: string, cwd: string) => Promise<void>
  newSession: (cwd: string, direction?: SplitDirection, agentKind?: AgentKind) => Promise<void>
  addShellPane: (cwd: string, direction?: SplitDirection) => Promise<void>
  setLastAgentKind: (agentKind: AgentKind) => void
  setPaneCwd: (ptyId: string, cwd: string) => void
  setPaneCustomName: (paneId: string, name: string) => void

  // Layout persistence
  applyLayout: (saved: { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean; activeTabId?: string }) => Promise<void>

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
  findPaneBySessionId: (agentKind: AgentKind, sessionId: string) => PaneLeaf | undefined
}

export const usePanesStore = create<PanesStore>((set, get) => ({
  tabs: [],
  activeTabId: '',
  zoomedPaneId: null,
  sidebarOpen: true,
  sidebarWidth: 220,
  sessionBrowserOpen: false,
  commandPaletteOpen: false,
  lastAgentKind: initialLastAgent(),
  draggedPaneId: null,

  addTab: (defaultCwd?: string, name?: string) => {
    const tab: Tab = { id: uuid(), focusedPaneId: '', defaultCwd: defaultCwd || undefined, customLabel: name || undefined }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
  },

  setTabDefaultCwd: (tabId, cwd) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, defaultCwd: cwd || undefined } : t),
    }))
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

  splitPane: async (paneId, direction, paneType, cwdOverride, agentKind) => {
    const existing = get().findPane(paneId)
    const tab = get().activeTab()
    const resolvedType: PaneType = paneType ?? existing?.paneType ?? 'shell'
    const resolvedAgent = resolvedType === 'agent'
      ? (agentKind ?? existing?.agentKind ?? get().lastAgentKind)
      : undefined
    const cwd = cwdOverride ?? existing?.cwd ?? tab?.defaultCwd ?? 'C:\\'
    const newLeaf = makeLeaf(cwd, resolvedType, resolvedAgent)

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

    if (resolvedType === 'agent' && resolvedAgent && typeof window !== 'undefined' && window.ipc) {
      get().setLastAgentKind(resolvedAgent)
      try {
        const result = await window.ipc.invoke('session:new', resolvedAgent, cwd) as { ptyId: string; sessionId: string | null }
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
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return t
        const newRoot = removeLeaf(t.rootNode, paneId)
        if (!newRoot) {
          // Preserve the tab's label by snapshotting the last pane's directory
          // as customLabel so it doesn't fall back to "New Tab".
          const closedLeaf = findLeaf(t.rootNode, paneId)
          const lastSegment = closedLeaf?.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop()
          const fallbackLabel = t.customLabel ?? lastSegment
          return { ...t, rootNode: undefined, focusedPaneId: '', customLabel: fallbackLabel }
        }
        const leafIds = collectLeafIds(newRoot)
        const focusedPaneId =
          t.focusedPaneId === paneId ? (leafIds[0] ?? '') : t.focusedPaneId
        return { ...t, rootNode: newRoot, focusedPaneId }
      })
      return {
        tabs,
        zoomedPaneId: s.zoomedPaneId === paneId ? null : s.zoomedPaneId,
      }
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

  setLastAgentKind: (agentKind) => {
    rememberAgent(agentKind)
    set({ lastAgentKind: agentKind })
  },

  resumeSession: async (agentKind, sessionId, cwd) => {
    get().setLastAgentKind(agentKind)
    const leaf = makeLeaf(cwd, 'agent', agentKind)
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
        const result = (await window.ipc.invoke('session:resume', agentKind, sessionId, cwd)) as { ptyId: string }
        if (result?.ptyId) {
          get().setPtyId(leaf.id, result.ptyId)
        }
      } catch (err) {
        console.error('session:resume IPC failed', err)
      }
    }
  },

  resumeSessionInNewTab: async (agentKind, sessionId, cwd) => {
    get().setLastAgentKind(agentKind)
    const leaf = makeLeaf(cwd, 'agent', agentKind)
    leaf.sessionId = sessionId
    const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:resume', agentKind, sessionId, cwd)) as { ptyId: string }
        if (result?.ptyId) get().setPtyId(leaf.id, result.ptyId)
      } catch (err) {
        console.error('session:resume IPC failed', err)
      }
    }
  },

  newSession: async (cwd, direction = 'vertical', agentKind) => {
    const resolvedAgent = agentKind ?? get().lastAgentKind
    get().setLastAgentKind(resolvedAgent)
    const leaf = makeLeaf(cwd, 'agent', resolvedAgent)
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
        const result = (await window.ipc.invoke('session:new', resolvedAgent, cwd)) as { ptyId: string; sessionId: string | null }
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
      // Strip ptyIds and convert unresumable agent panes to shell panes up front.
      // A missing sessionId means the pane was never used (blank session), so
      // convert it to a shell pane rather than guessing which session to restore.
      function sanitizeNode(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          const legacy = node as PaneLeaf & { paneType: PaneType | 'claude' }
          const migrated: PaneLeaf = legacy.paneType === 'claude'
            ? { ...legacy, paneType: 'agent', agentKind: 'claude' }
            : { ...node, agentKind: node.paneType === 'agent' ? (node.agentKind ?? 'claude') : undefined }
          if (migrated.paneType === 'agent' && !migrated.sessionId) {
            return { ...migrated, paneType: 'shell', agentKind: undefined, ptyId: undefined }
          }
          return { ...migrated, ptyId: undefined }
        }
        return { ...node, first: sanitizeNode(node.first), second: sanitizeNode(node.second) }
      }
      const tabs = saved.tabs.map((t) => {
        if (!t.rootNode) return { ...t, focusedPaneId: '' }
        const rootNode = sanitizeNode(t.rootNode)
        const focusedPaneId = findLeaf(rootNode, t.focusedPaneId)
          ? t.focusedPaneId
          : (collectLeafIds(rootNode)[0] ?? '')
        return { ...t, rootNode, focusedPaneId }
      })

      const savedActiveTabId = typeof saved.activeTabId === 'string' ? saved.activeTabId : ''
      const activeTabId = tabs.some((t) => t.id === savedActiveTabId)
        ? savedActiveTabId
        : (tabs.findLast((t) => t.rootNode)?.id ?? tabs[0]?.id ?? '')

      set({
        tabs,
        activeTabId,
        sidebarWidth: saved.sidebarWidth ?? 220,
        sidebarOpen: saved.sidebarOpen ?? true,
      })

      if (typeof window === 'undefined' || !window.ipc) return

      const leaves = tabs.flatMap((tab) => tab.rootNode ? collectLeaves(tab.rootNode) : [])
      for (const leaf of leaves) {
        if (leaf.paneType !== 'agent' || !leaf.agentKind || !leaf.sessionId) continue

        void window.ipc.invoke('session:resume', leaf.agentKind, leaf.sessionId, leaf.cwd)
          .then((result) => {
            const resume = result as { ptyId?: string } | null
            if (resume?.ptyId) get().setPtyId(leaf.id, resume.ptyId)
          })
          .catch(() => {
            set((s) => ({
              tabs: s.tabs.map((t) => t.rootNode
                ? { ...t, rootNode: updateLeaf(t.rootNode, leaf.id, { paneType: 'shell', agentKind: undefined, sessionId: undefined }) }
                : t
              ),
            }))
          })
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

  findPaneBySessionId: (agentKind, sessionId) => {
    const s = get()
    for (const tab of s.tabs) {
      if (!tab.rootNode) continue
      const leaf = findLeafBySessionId(tab.rootNode, agentKind, sessionId)
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

  // When the main process detects a new agent session file, link it to the pane
  // so the session can be persisted and auto-resumed on next launch.
  window.ipc.on('session:detected', (ptyId: unknown, agentKind: unknown, sessionId: unknown) => {
    if (typeof ptyId !== 'string' || (agentKind !== 'claude' && agentKind !== 'codex') || typeof sessionId !== 'string') return
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const leaves = collectLeaves(tab.rootNode)
      const pane = leaves.find((l) => l.ptyId === ptyId)
      if (pane) {
        store.setLastAgentKind(agentKind)
        store.setSessionId(pane.id, sessionId)
        break
      }
    }
  })
}

