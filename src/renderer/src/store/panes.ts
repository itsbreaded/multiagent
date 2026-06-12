import { create } from 'zustand'
import type { AgentKind, FocusTarget, Tab, PaneNode, PaneLeaf, PaneSplit, PaneType, SplitDirection } from '../../../shared/types'
import { collectLeaves } from '../utils/tabLabels'
import * as xtermRegistry from '../utils/xtermRegistry'

let pendingRemoteFocusWindowId: number | null = null
let pendingRemoteFocusTimer: ReturnType<typeof setTimeout> | null = null

function clearPendingRemoteFocus(): void {
  pendingRemoteFocusWindowId = null
  if (pendingRemoteFocusTimer !== null) {
    clearTimeout(pendingRemoteFocusTimer)
    pendingRemoteFocusTimer = null
  }
  usePanesStore.setState({ pendingFocusTarget: null })
}

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

export type ShellSpawnMode = 'current' | 'choose'

function initialLastShellSpawnMode(): ShellSpawnMode {
  if (typeof localStorage === 'undefined') return 'current'
  return localStorage.getItem('multiagent:lastShellSpawnMode') === 'choose' ? 'choose' : 'current'
}

function rememberShellSpawnMode(mode: ShellSpawnMode): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('multiagent:lastShellSpawnMode', mode)
  }
}

function reportCurrentFocusTarget(): void {
  if (typeof window === 'undefined' || !window.ipc) return
  const store = usePanesStore.getState()
  if (store.windowId === null || !store.activeTabId) return
  const tab = store.tabs.find((t) => t.id === store.activeTabId)
  const paneId = tab?.focusedPaneId ?? ''
  window.ipc.send('focus:target-report', store.activeTabId, paneId)
}

export const RECENT_SECTION_ID = 'recent'

export function tabSidebarSectionId(tabId: string): string {
  return `tab:${tabId}`
}

interface PanesStore {
  tabs: Tab[]
  activeTabId: string
  windowId: number | null
  setWindowId: (id: number) => void
  isDetachedWindow: boolean
  activeWindowId: number | null
  confirmedFocusTarget: FocusTarget | null
  pendingFocusTarget: { windowId: number; tabId: string; paneId?: string } | null
  initDetached: (tab: Tab, ptyIds: string[]) => void
  receiveTab: (tab: Tab, atIndex?: number) => void
  detachTab: (tabId: string, ownerWindowId?: number) => void
  returnTab: (tabId: string) => void
  removeTabLocally: (tabId: string) => void
  syncDetachedTabs: (windowId: number, tabs: Tab[], activeTabId?: string) => void
  addPaneToTab: (pane: PaneLeaf, tabId: string) => void
  removePaneKeepTab: (paneId: string) => void
  findPaneInAnyTab: (paneId: string) => PaneLeaf | undefined
  detachedWindowTabIds: Record<string, string[]>
  detachedWindowActiveTabIds: Record<string, string>
  zoomedPaneId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  sidebarPanelSizes: Record<string, number>
  sidebarSectionOpen: Record<string, boolean>
  sessionBrowserOpen: boolean
  commandPaletteOpen: boolean
  settingsOpen: boolean
  lastAgentKind: AgentKind
  lastShellSpawnMode: ShellSpawnMode
  vsCodeAvailable: boolean
  setVsCodeAvailable: (available: boolean) => void
  cwdGitBranches: Record<string, { status: 'loading' | 'ready'; branch: string | null }>
  requestGitBranch: (cwd: string) => void
  refreshGitBranch: (cwd: string) => void

  // Tab operations
  addTab: (defaultCwd?: string, name?: string) => string
  pendingRenameTabId: string | null
  setPendingRenameTabId: (id: string | null) => void
  setTabDefaultCwd: (tabId: string, cwd: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  renameTab: (tabId: string, label: string) => void
  duplicateTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  closeTabsToRight: (tabId: string) => void
  setSidebarSectionOpen: (sectionId: string, open: boolean) => void

  // Pane operations
  focusPane: (paneId: string) => void
  focusPaneInTab: (tabId: string, paneId: string) => void
  focusDetachedPaneOptimistically: (windowId: number, tabId: string, paneId?: string) => void
  splitPane: (paneId: string, direction: SplitDirection, paneType?: PaneType, cwdOverride?: string, agentKind?: AgentKind) => Promise<void>
  closePane: (paneId: string) => void
  closePaneInTab: (tabId: string, paneId: string) => void
  zoomPane: (paneId: string) => void
  unzoom: () => void
  updatePaneRatio: (splitId: string, ratio: number) => void
  setPtyId: (paneId: string, ptyId: string) => void
  setSessionId: (paneId: string, sessionId: string) => void
  updatePane: (paneId: string, patch: Partial<PaneLeaf>) => void

  // Session / PTY actions (Phase 2)
  resumeSession: (agentKind: AgentKind, sessionId: string, cwd: string) => Promise<void>
  resumeSessionInNewTab: (agentKind: AgentKind, sessionId: string, cwd: string) => Promise<void>
  newSession: (cwd: string, direction?: SplitDirection, agentKind?: AgentKind) => Promise<void>
  addShellPane: (cwd: string, direction?: SplitDirection) => Promise<void>
  setLastAgentKind: (agentKind: AgentKind) => void
  setLastShellSpawnMode: (mode: ShellSpawnMode) => void
  setPaneCwd: (ptyId: string, cwd: string) => void
  setPaneCustomName: (paneId: string, name: string) => void

  // Layout persistence
  applyLayout: (saved: { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean; sidebarBottomHeight?: number; sidebarPanelSizes?: Record<string, number>; activeTabId?: string; sidebarSectionOpen?: Record<string, boolean>; tabSectionOpen?: Record<string, boolean> }) => Promise<void>

  // UI toggles
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setSidebarPanelSize: (panelId: string, size: number) => void
  toggleSessionBrowser: () => void
  toggleCommandPalette: () => void
  toggleSettings: () => void
  closeOverlays: () => void

  // Drag state (pane rearrangement)
  draggedPaneId: string | null
  setDraggedPane: (paneId: string | null) => void
  movePaneToSplit: (sourcePaneId: string, targetPaneId: string, direction: SplitDirection, sourceBefore: boolean) => void
  movePaneToTab: (sourcePaneId: string, targetTabId: string) => void
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
  windowId: null,
  setWindowId: (id) => set({ windowId: id }),
  isDetachedWindow: false,
  activeWindowId: null,
  confirmedFocusTarget: null,
  pendingFocusTarget: null,

  detachedWindowTabIds: {},
  detachedWindowActiveTabIds: {},

  initDetached: (tab, ptyIds) => {
    set({
      tabs: [tab],
      activeTabId: tab.id,
      isDetachedWindow: true,
      sidebarOpen: false,
      sidebarSectionOpen: { [tabSidebarSectionId(tab.id)]: true },
    })
    if (typeof window !== 'undefined' && window.ipc) {
      const adoption = ptyIds.length > 0
        ? window.ipc.invoke('tab:adopt', ptyIds)
        : Promise.resolve(true)
      void adoption.then(() => {
        window.ipc.send('tab:detached-ready', tab.id)
      }).catch(() => {})
    }
  },

  receiveTab: (tab, atIndex) => {
    set((s) => {
      // If this tab was previously torn off from this window it still exists as detached:true.
      // Un-mark it rather than appending a duplicate. Preserve existing data (synced rootNode/ptyIds).
      const existing = s.tabs.find((t) => t.id === tab.id)
      const base = existing ? { ...existing, detached: false } : { ...tab, detached: false }
      const rest = s.tabs.filter((t) => t.id !== tab.id)

      let newTabs: typeof rest
      if (atIndex === undefined) {
        newTabs = [...rest, base]
      } else {
        // Insert at the atIndex-th position among the non-detached (visible) tabs in `rest`.
        let localCount = 0
        let insertAt = rest.length
        for (let i = 0; i < rest.length; i++) {
          if (!rest[i].detached) {
            if (localCount === atIndex) { insertAt = i; break }
            localCount++
          }
        }
        newTabs = [...rest]
        newTabs.splice(insertAt, 0, base)
      }

      return {
        tabs: newTabs,
        activeTabId: tab.id,
        sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
      }
    })
    reportCurrentFocusTarget()
  },

  detachTab: (tabId, ownerWindowId) => {
    // Mark as detached — keeps the tab in the store for sidebar navigation.
    // Do NOT dispose xterms: they stay in the off-screen registry so that when
    // the tab returns the terminals reattach with their full scrollback intact.
    set((s) => {
      const tabs = s.tabs.map((t) => t.id === tabId ? { ...t, detached: true } : t)
      const nonDetached = tabs.filter((t) => !t.detached)
      const activeTabId = s.activeTabId === tabId
        ? (nonDetached[nonDetached.length - 1]?.id ?? '')
        : s.activeTabId
      if (ownerWindowId === undefined) return { tabs, activeTabId }
      const key = String(ownerWindowId)
      const detachedWindowTabIds = Object.fromEntries(
        Object.entries(s.detachedWindowTabIds).map(([wid, ids]) => [
          wid,
          wid === key ? ids : ids.filter((id) => id !== tabId),
        ])
      )
      detachedWindowTabIds[key] = Array.from(new Set([...(detachedWindowTabIds[key] ?? []), tabId]))
      return {
        tabs,
        activeTabId,
        detachedWindowTabIds,
        detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [key]: tabId },
      }
    })
  },

  returnTab: (tabId) => {
    // Move the returning tab to the end of the tab bar and un-mark it.
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      const rest = s.tabs.filter((t) => t.id !== tabId)
      return {
        tabs: [...rest, { ...tab, detached: false }],
        activeTabId: tabId,
        sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tabId)]: true },
      }
    })
  },

  removeTabLocally: (tabId) => {
    // Remove the tab without marking as detached and without killing PTYs.
    // Used in detached windows when a tab is transferred to another window.
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId
        ? (tabs[tabs.length - 1]?.id ?? '')
        : s.activeTabId
      const { [tabSidebarSectionId(tabId)]: _r, ...sidebarSectionOpen } = s.sidebarSectionOpen
      return { tabs, activeTabId, sidebarSectionOpen }
    })
  },

  syncDetachedTabs: (windowId, incomingTabs, activeTabId) => {
    // Dispose xterms for tabs that were genuinely closed inside the detached window.
    // Guard: only dispose if the tab is still detached in our store. A tab that has
    // already been received/returned as local (detached:false) must not be disposed —
    // its Terminal may already be mounting and the xterm is live in the DOM.
    const key = String(windowId)
    const prevIds = get().detachedWindowTabIds[key] ?? []
    const newIds = new Set(incomingTabs.map((t) => t.id))
    for (const removedId of prevIds.filter((id) => !newIds.has(id))) {
      const tab = get().tabs.find((t) => t.id === removedId)
      if (tab?.rootNode && tab.detached) collectLeafIds(tab.rootNode).forEach((paneId) => xtermRegistry.dispose(paneId))
    }

    set((s) => {
      const key = String(windowId)
      const prevIds = new Set(s.detachedWindowTabIds[key] ?? [])
      const newIds = new Set(incomingTabs.map((t) => t.id))

      // Only remove a tab if:
      //   (a) it was previously owned by this window AND is no longer in the new list
      //   (b) it is still marked detached in our store (not already returned/absorbed as local)
      //   (c) no OTHER window's detachedWindowTabIds currently claims it
      const removedIds = [...prevIds].filter((id) => {
        if (newIds.has(id)) return false
        const existing = s.tabs.find((t) => t.id === id)
        if (!existing || !existing.detached) return false  // already local — never delete
        for (const [wid, wids] of Object.entries(s.detachedWindowTabIds)) {
          if (wid !== key && wids.includes(id)) return false  // another window owns it now
        }
        return true
      })

      // Remove tabs genuinely closed in the detached window
      let tabs = s.tabs.filter((t) => !removedIds.includes(t.id))

      // Update existing or insert new entries, all marked detached.
      // Never overwrite a tab that is already local (detached:false) — that means a
      // receiveTab/returnTab already claimed it; the sync is stale.
      for (const incoming of incomingTabs) {
        const idx = tabs.findIndex((t) => t.id === incoming.id)
        const synced: Tab = { ...incoming, detached: true }
        if (idx >= 0) {
          if (!tabs[idx].detached) continue  // already local — ignore stale sync
          tabs = [...tabs.slice(0, idx), synced, ...tabs.slice(idx + 1)]
        } else {
          tabs = [...tabs, synced]
        }
      }

      const detachedWindowTabIds = {
        ...s.detachedWindowTabIds,
        [key]: incomingTabs.map((t) => t.id),
      }

      const detachedWindowActiveTabIds = activeTabId
        ? { ...s.detachedWindowActiveTabIds, [key]: activeTabId }
        : s.detachedWindowActiveTabIds

      const newActiveTabId = removedIds.includes(s.activeTabId)
        ? (tabs.filter((t) => !t.detached).slice(-1)[0]?.id ?? '')
        : s.activeTabId

      return { tabs, detachedWindowTabIds, detachedWindowActiveTabIds, activeTabId: newActiveTabId }
    })
  },

  addPaneToTab: (pane, tabId) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        if (!t.rootNode) return { ...t, rootNode: pane, focusedPaneId: pane.id }
        return { ...t, rootNode: makeSplit('vertical', t.rootNode, pane), focusedPaneId: pane.id }
      }),
    }))
  },

  removePaneKeepTab: (paneId) => {
    // Remove the pane from whichever tab it's in; leave the tab open (blank if last pane).
    xtermRegistry.dispose(paneId)
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (!t.rootNode || !findLeaf(t.rootNode, paneId)) return t
        const newRoot = removeLeaf(t.rootNode, paneId)
        if (!newRoot) return { ...t, rootNode: undefined, focusedPaneId: '' }
        const leafIds = collectLeafIds(newRoot)
        return {
          ...t,
          rootNode: newRoot,
          focusedPaneId: t.focusedPaneId === paneId ? (leafIds[0] ?? '') : t.focusedPaneId,
        }
      }),
    }))
  },
  zoomedPaneId: null,
  sidebarOpen: true,
  sidebarWidth: 220,
  sidebarPanelSizes: {
    [RECENT_SECTION_ID]: 220,
  },
  sidebarSectionOpen: {
    [RECENT_SECTION_ID]: true,
  },
  sessionBrowserOpen: false,
  commandPaletteOpen: false,
  settingsOpen: false,
  lastAgentKind: initialLastAgent(),
  lastShellSpawnMode: initialLastShellSpawnMode(),
  vsCodeAvailable: false,
  setVsCodeAvailable: (available: boolean) => set({ vsCodeAvailable: available }),
  cwdGitBranches: {},
  requestGitBranch: (cwd) => {
    if (!cwd || typeof window === 'undefined' || !window.ipc) return
    const key = normalizeCwdKey(cwd)
    if (get().cwdGitBranches[key]) return
    get().refreshGitBranch(cwd)
  },
  refreshGitBranch: (cwd) => {
    if (!cwd || typeof window === 'undefined' || !window.ipc) return
    const key = normalizeCwdKey(cwd)
    set((s) => ({
      cwdGitBranches: {
        ...s.cwdGitBranches,
        [key]: { status: 'loading', branch: s.cwdGitBranches[key]?.branch ?? null },
      },
    }))
    void window.ipc.invoke('git:branch', cwd)
      .then((branch) => {
        set((s) => ({
          cwdGitBranches: {
            ...s.cwdGitBranches,
            [key]: { status: 'ready', branch: typeof branch === 'string' && branch.trim() ? branch : null },
          },
        }))
      })
      .catch(() => {
        set((s) => ({
          cwdGitBranches: {
            ...s.cwdGitBranches,
            [key]: { status: 'ready', branch: null },
          },
        }))
      })
  },
  draggedPaneId: null,
  pendingRenameTabId: null,
  setPendingRenameTabId: (id) => set({ pendingRenameTabId: id }),

  addTab: (defaultCwd?: string, name?: string) => {
    const tab: Tab = { id: uuid(), focusedPaneId: '', defaultCwd: defaultCwd || undefined, customLabel: name || undefined }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true } }))
    return tab.id
  },

  setTabDefaultCwd: (tabId, cwd) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, defaultCwd: cwd || undefined } : t),
    }))
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.rootNode) {
      collectLeafIds(tab.rootNode).forEach((id) => xtermRegistry.dispose(id))
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? '') : s.activeTabId
      const { [tabSidebarSectionId(tabId)]: _closed, [tabId]: _legacyClosed, ...sidebarSectionOpen } = s.sidebarSectionOpen
      return { tabs, activeTabId, sidebarSectionOpen }
    })
  },

  setActiveTab: (tabId) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      const zoomedPaneId = tab?.rootNode && s.zoomedPaneId && findLeaf(tab.rootNode, s.zoomedPaneId)
        ? s.zoomedPaneId
        : null
      return { activeTabId: tabId, zoomedPaneId }
    })
    // Immediately notify other windows when the active tab changes in a detached window.
    const { isDetachedWindow, windowId } = get()
    if (isDetachedWindow && windowId !== null && typeof window !== 'undefined' && window.ipc) {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab) window.ipc.send('pane:focus-changed', windowId, tabId, tab.focusedPaneId)
    }
    reportCurrentFocusTarget()
  },

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
      return { tabs, activeTabId: newTab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(newTab.id)]: true } }
    })
  },

  closeOtherTabs: (tabId) => {
    get().tabs.forEach((t) => {
      if (t.id !== tabId && t.rootNode) {
        collectLeafIds(t.rootNode).forEach((id) => xtermRegistry.dispose(id))
      }
    })
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id === tabId)
      const sectionId = tabSidebarSectionId(tabId)
      return {
        tabs,
        activeTabId: tabId,
        sidebarSectionOpen: {
          [RECENT_SECTION_ID]: s.sidebarSectionOpen[RECENT_SECTION_ID] ?? true,
          [sectionId]: s.sidebarSectionOpen[sectionId] ?? s.sidebarSectionOpen[tabId] ?? true,
        },
      }
    })
  },

  closeTabsToRight: (tabId) => {
    const { tabs } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx !== -1) {
      tabs.slice(idx + 1).forEach((t) => {
        if (t.rootNode) collectLeafIds(t.rootNode).forEach((id) => xtermRegistry.dispose(id))
      })
    }
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return s
      const tabs = s.tabs.slice(0, idx + 1)
      const activeTabId = tabs.find((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : tabId
      const kept = new Set(tabs.flatMap((t) => [tabSidebarSectionId(t.id), t.id]))
      const sidebarSectionOpen = Object.fromEntries(
        Object.entries(s.sidebarSectionOpen).filter(([id]) =>
          id === RECENT_SECTION_ID || kept.has(id)
        )
      )
      return { tabs, activeTabId, sidebarSectionOpen }
    })
  },

  setSidebarSectionOpen: (sectionId, open) => {
    set((s) => ({ sidebarSectionOpen: { ...s.sidebarSectionOpen, [sectionId]: open } }))
  },

  focusPane: (paneId) => {
    const { isDetachedWindow, windowId, activeTabId } = get()
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, focusedPaneId: paneId } : t
      )
      return { tabs }
    })
    // Immediately notify other windows — don't wait for the debounced tab:state-sync.
    if (isDetachedWindow && windowId !== null && typeof window !== 'undefined' && window.ipc) {
      window.ipc.send('pane:focus-changed', windowId, activeTabId, paneId)
    }
    reportCurrentFocusTarget()
  },

  focusPaneInTab: (tabId, paneId) => {
    const { isDetachedWindow, windowId } = get()
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      const zoomedPaneId = tab?.rootNode && s.zoomedPaneId && findLeaf(tab.rootNode, s.zoomedPaneId)
        ? s.zoomedPaneId
        : null
      return {
        activeTabId: tabId,
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, focusedPaneId: paneId } : t),
        zoomedPaneId,
      }
    })
    if (isDetachedWindow && windowId !== null && typeof window !== 'undefined' && window.ipc) {
      window.ipc.send('pane:focus-changed', windowId, tabId, paneId)
    }
    reportCurrentFocusTarget()
  },

  focusDetachedPaneOptimistically: (windowId, tabId, paneId) => {
    pendingRemoteFocusWindowId = windowId
    if (pendingRemoteFocusTimer !== null) clearTimeout(pendingRemoteFocusTimer)
    pendingRemoteFocusTimer = setTimeout(() => {
      pendingRemoteFocusWindowId = null
      pendingRemoteFocusTimer = null
    }, 1000)

    const key = String(windowId)
    set((s) => ({
      pendingFocusTarget: { windowId, tabId, paneId },
      detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [key]: tabId },
      tabs: paneId
        ? s.tabs.map((t) => t.id === tabId ? { ...t, focusedPaneId: paneId } : t)
        : s.tabs,
    }))
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
        const patch: Partial<PaneLeaf> = {}
        if (result?.ptyId) patch.ptyId = result.ptyId
        if (result?.sessionId) patch.sessionId = result.sessionId
        if (Object.keys(patch).length > 0) get().updatePane(newLeaf.id, patch)
      } catch (err) {
        console.error('session:new IPC failed', err)
      }
    }
    // shell panes: Terminal handles pty:create automatically on mount
  },

  closePane: (paneId) => {
    get().closePaneInTab(get().activeTabId, paneId)
  },

  closePaneInTab: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab?.rootNode ? findLeaf(tab.rootNode, paneId) : null
    if (!pane) return
    if (pane.ptyId && typeof window !== 'undefined' && window.ipc) {
      window.ipc.invoke('pty:kill', pane.ptyId).catch(() => {})
    }
    xtermRegistry.dispose(paneId)
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.id !== tabId || !t.rootNode) return t
        const newRoot = removeLeaf(t.rootNode, paneId)
        if (!newRoot) {
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

  updatePane: (paneId, patch) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, patch) } : t),
    }))
  },

  setLastAgentKind: (agentKind) => {
    rememberAgent(agentKind)
    set({ lastAgentKind: agentKind })
  },

  setLastShellSpawnMode: (mode) => {
    rememberShellSpawnMode(mode)
    set({ lastShellSpawnMode: mode })
  },

  resumeSession: async (agentKind, sessionId, cwd) => {
    get().setLastAgentKind(agentKind)
    const leaf = makeLeaf(cwd, 'agent', agentKind)
    leaf.sessionId = sessionId
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return { tabs: [tab], activeTabId: tab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true } }
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
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true } }))
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
        return { tabs: [tab], activeTabId: tab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true } }
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
        const patch: Partial<PaneLeaf> = {}
        if (result?.ptyId) patch.ptyId = result.ptyId
        if (result?.sessionId) patch.sessionId = result.sessionId
        if (Object.keys(patch).length > 0) get().updatePane(leaf.id, patch)
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
        return { tabs: [tab], activeTabId: tab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true } }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit(direction, t.rootNode, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs }
    })
  },

  applyLayout: async (saved) => {
    try {
      // Strip ptyIds and convert unresumable agent panes to shell panes up front.
      // A missing sessionId means the pane was never used (blank session), so
      // convert it to a shell pane rather than guessing which session to restore.
      function sanitizeNode(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          const legacy = node as Omit<PaneLeaf, 'paneType'> & { paneType: PaneType | 'claude' }
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
      const savedSectionOpen = saved.sidebarSectionOpen && typeof saved.sidebarSectionOpen === 'object'
        ? saved.sidebarSectionOpen
        : saved.tabSectionOpen && typeof saved.tabSectionOpen === 'object'
          ? saved.tabSectionOpen
          : {}
      const sidebarSectionOpen: Record<string, boolean> = {
        [RECENT_SECTION_ID]: typeof savedSectionOpen[RECENT_SECTION_ID] === 'boolean'
          ? savedSectionOpen[RECENT_SECTION_ID]
          : true,
      }
      for (const tab of tabs) {
        const sectionId = tabSidebarSectionId(tab.id)
        sidebarSectionOpen[sectionId] = typeof savedSectionOpen[sectionId] === 'boolean'
          ? savedSectionOpen[sectionId]
          : typeof savedSectionOpen[tab.id] === 'boolean'
            ? savedSectionOpen[tab.id]
            : tab.id === activeTabId
      }
      const savedPanelSizes = saved.sidebarPanelSizes && typeof saved.sidebarPanelSizes === 'object'
        ? Object.fromEntries(
            Object.entries(saved.sidebarPanelSizes).filter((entry): entry is [string, number] =>
              typeof entry[1] === 'number' && Number.isFinite(entry[1])
            )
          )
        : {}
      const legacyRecentHeight = typeof saved.sidebarBottomHeight === 'number' && Number.isFinite(saved.sidebarBottomHeight)
        ? saved.sidebarBottomHeight
        : 220
      const sidebarPanelSizes: Record<string, number> = {
        [RECENT_SECTION_ID]: savedPanelSizes[RECENT_SECTION_ID] ?? legacyRecentHeight,
        ...savedPanelSizes,
      }

      set({
        tabs,
        activeTabId,
        sidebarWidth: saved.sidebarWidth ?? 220,
        sidebarPanelSizes,
        sidebarOpen: saved.sidebarOpen ?? true,
        sidebarSectionOpen,
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

      return { tabs: updatedTabs, activeTabId: newTab.id, sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(newTab.id)]: true } }
    })
  },

  movePaneToTab: (sourcePaneId, targetTabId) => {
    set((s) => {
      let sourceTabIdx = -1
      let sourceLeaf: PaneLeaf | undefined
      for (let i = 0; i < s.tabs.length; i++) {
        const tab = s.tabs[i]
        if (!tab.rootNode) continue
        const leaf = findLeaf(tab.rootNode, sourcePaneId)
        if (leaf) { sourceTabIdx = i; sourceLeaf = leaf; break }
      }

      const targetTabIdx = s.tabs.findIndex((t) => t.id === targetTabId)
      if (sourceTabIdx === -1 || targetTabIdx === -1 || !sourceLeaf) return s
      if (s.tabs[sourceTabIdx].id === targetTabId) return s

      const updatedTabs = s.tabs.map((tab, idx) => {
        if (idx === sourceTabIdx) {
          const newRoot = removeLeaf(tab.rootNode!, sourcePaneId)
          if (!newRoot) return { ...tab, rootNode: undefined, focusedPaneId: '' }
          const leafIds = collectLeafIds(newRoot)
          return {
            ...tab,
            rootNode: newRoot,
            focusedPaneId: tab.focusedPaneId === sourcePaneId ? (leafIds[0] ?? '') : tab.focusedPaneId,
          }
        }

        if (idx === targetTabIdx) {
          if (!tab.rootNode) return { ...tab, rootNode: sourceLeaf, focusedPaneId: sourceLeaf.id }
          return {
            ...tab,
            rootNode: makeSplit('vertical', tab.rootNode, sourceLeaf),
            focusedPaneId: sourceLeaf.id,
          }
        }

        return tab
      })

      return {
        tabs: updatedTabs,
        activeTabId: targetTabId,
        zoomedPaneId: s.zoomedPaneId === sourcePaneId ? null : s.zoomedPaneId,
        sidebarSectionOpen: {
          ...s.sidebarSectionOpen,
          [tabSidebarSectionId(targetTabId)]: true,
        },
      }
    })
  },

  movePaneToSplit: (sourcePaneId, targetPaneId, direction, sourceBefore) => {
    if (sourcePaneId === targetPaneId) return
    set((s) => {
      let sourceTabIdx = -1
      let targetTabIdx = -1
      let sourceLeaf: PaneLeaf | undefined

      for (let i = 0; i < s.tabs.length; i++) {
        const tab = s.tabs[i]
        if (!tab.rootNode) continue
        if (!sourceLeaf) {
          const leaf = findLeaf(tab.rootNode, sourcePaneId)
          if (leaf) { sourceTabIdx = i; sourceLeaf = leaf }
        }
        if (findLeaf(tab.rootNode, targetPaneId)) targetTabIdx = i
      }

      if (sourceTabIdx === -1 || targetTabIdx === -1 || !sourceLeaf) return s

      const updatedTabs = s.tabs.map((tab, idx) => {
        if (!tab.rootNode) return tab

        if (idx === sourceTabIdx && idx === targetTabIdx) {
          const treeWithoutSource = removeLeaf(tab.rootNode, sourcePaneId)
          if (!treeWithoutSource || !findLeaf(treeWithoutSource, targetPaneId)) return tab
          const targetLeaf = findLeaf(treeWithoutSource, targetPaneId)!
          const newSplit = sourceBefore
            ? makeSplit(direction, sourceLeaf!, targetLeaf)
            : makeSplit(direction, targetLeaf, sourceLeaf!)
          return {
            ...tab,
            rootNode: replaceNode(treeWithoutSource, targetPaneId, newSplit),
            focusedPaneId: sourcePaneId,
          }
        }

        if (idx === sourceTabIdx) {
          const newRoot = removeLeaf(tab.rootNode, sourcePaneId)
          if (!newRoot) return { ...tab, rootNode: undefined, focusedPaneId: '' }
          const leafIds = collectLeafIds(newRoot)
          return {
            ...tab,
            rootNode: newRoot,
            focusedPaneId: tab.focusedPaneId === sourcePaneId ? (leafIds[0] ?? '') : tab.focusedPaneId,
          }
        }

        if (idx === targetTabIdx) {
          const targetLeaf = findLeaf(tab.rootNode, targetPaneId)
          if (!targetLeaf) return tab
          const newSplit = sourceBefore
            ? makeSplit(direction, sourceLeaf!, targetLeaf)
            : makeSplit(direction, targetLeaf, sourceLeaf!)
          return {
            ...tab,
            rootNode: replaceNode(tab.rootNode, targetPaneId, newSplit),
            focusedPaneId: sourcePaneId,
          }
        }

        return tab
      })

      const targetTabId = s.tabs[targetTabIdx].id
      return {
        tabs: updatedTabs,
        activeTabId: targetTabId,
        zoomedPaneId: s.zoomedPaneId === sourcePaneId ? null : s.zoomedPaneId,
        sidebarSectionOpen: {
          ...s.sidebarSectionOpen,
          [tabSidebarSectionId(targetTabId)]: true,
        },
      }
    })
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setSidebarPanelSize: (panelId, size) => set((s) => ({ sidebarPanelSizes: { ...s.sidebarPanelSizes, [panelId]: size } })),
  toggleSessionBrowser: () => set((s) => ({ sessionBrowserOpen: !s.sessionBrowserOpen, commandPaletteOpen: false, settingsOpen: false })),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen, sessionBrowserOpen: false, settingsOpen: false })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, sessionBrowserOpen: false, commandPaletteOpen: false })),
  closeOverlays: () => set({ sessionBrowserOpen: false, commandPaletteOpen: false, settingsOpen: false }),

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

  findPaneInAnyTab: (paneId) => {
    const s = get()
    for (const tab of s.tabs) {
      if (!tab.rootNode) continue
      const leaf = findLeaf(tab.rootNode, paneId)
      if (leaf) return leaf
    }
    return undefined
  },
}))

export function normalizeCwdKey(cwd: string): string {
  return cwd.replace(/\//g, '\\').toLowerCase()
}

// Wire up module-level IPC listeners once at module load.
if (typeof window !== 'undefined' && window.ipc) {
  window.ipc.on('pty:cwd', (ptyId: unknown, cwd: unknown) => {
    if (typeof ptyId === 'string' && typeof cwd === 'string') {
      usePanesStore.getState().setPaneCwd(ptyId, cwd)
    }
  })

  window.ipc.on('session:detected', (ptyId: unknown, agentKind: unknown, sessionId: unknown) => {
    if (typeof ptyId !== 'string' || (agentKind !== 'claude' && agentKind !== 'codex') || typeof sessionId !== 'string') return
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const leaves = collectLeaves(tab.rootNode)
      const pane = leaves.find((l) => l.ptyId === ptyId)
      if (pane) {
        rememberAgent(agentKind)
        usePanesStore.setState((s) => ({
          lastAgentKind: agentKind,
          tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, pane.id, { sessionId }) } : t),
        }))
        break
      }
    }
  })

  // Main tells this window to release a tab (it moved to another window).
  // In a detached window: just remove it locally (PTYs stay alive in the destination).
  // In the primary window: mark it as detached so the sidebar still shows it.
  window.ipc.on('tab:release', (tabId: unknown, ownerWindowId: unknown) => {
    if (typeof tabId !== 'string') return
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) {
      store.removeTabLocally(tabId)
    } else {
      store.detachTab(tabId, typeof ownerWindowId === 'number' ? ownerWindowId : undefined)
    }
  })

  // Main tells the primary window to un-mark a tab and move it to the end of the tab bar.
  window.ipc.on('tab:return', (tabId: unknown) => {
    if (typeof tabId !== 'string') return
    usePanesStore.getState().returnTab(tabId)
    // Re-adopt the PTYs for this tab so main routes PTY output to this window again.
    // (PTY routing was deleted by unregister() when the detached window closed.)
    const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)
    if (tab?.rootNode) {
      const ptyIds = collectLeaves(tab.rootNode)
        .map((l) => l.ptyId)
        .filter((id): id is string => typeof id === 'string')
      if (ptyIds.length > 0) {
        void window.ipc.invoke('tab:adopt', ptyIds)
      }
    }
  })

  // Cross-window pane click: activate the correct tab and pane in this window's renderer.
  window.ipc.on('pane:focus-remote', (tabId: unknown, paneId: unknown, requestId: unknown) => {
    if (typeof tabId !== 'string' || typeof paneId !== 'string') return
    const store = usePanesStore.getState()
    store.focusPaneInTab(tabId, paneId)
    if (typeof requestId === 'string') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.ipc.send('pane:focus-remote-applied', requestId)
        })
      })
    }
  })

  // Immediate focus update from a detached window — updates the synced tab's
  // focusedPaneId without waiting for the debounced tab:state-sync.
  window.ipc.on('pane:focus-changed', (windowId: unknown, tabId: unknown, paneId: unknown) => {
    if (typeof windowId !== 'number' || typeof tabId !== 'string' || typeof paneId !== 'string') return
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) return
    usePanesStore.setState((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, focusedPaneId: paneId } : t),
      detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [String(windowId)]: tabId },
    }))
  })

  // Track which OS window currently has focus — used to show exactly one focused pane.
  window.ipc.on('window:became-active', (winId: unknown) => {
    if (typeof winId !== 'number') return
    const { windowId } = usePanesStore.getState()
    if (pendingRemoteFocusWindowId !== null) {
      if (winId === pendingRemoteFocusWindowId) {
        clearPendingRemoteFocus()
      } else if (winId === windowId) {
        return
      } else {
        clearPendingRemoteFocus()
      }
    }
    usePanesStore.setState({ activeWindowId: winId, pendingFocusTarget: null })
    if (winId === windowId) reportCurrentFocusTarget()
  })

  window.ipc.on('window:focus-state-request', () => {
    reportCurrentFocusTarget()
  })

  window.ipc.on('focus:target-changed', (target: unknown) => {
    if (
      typeof target !== 'object' ||
      target === null ||
      typeof (target as FocusTarget).windowId !== 'number' ||
      typeof (target as FocusTarget).tabId !== 'string' ||
      typeof (target as FocusTarget).paneId !== 'string' ||
      typeof (target as FocusTarget).version !== 'number'
    ) return
    const next = target as FocusTarget
    const currentVersion = usePanesStore.getState().confirmedFocusTarget?.version ?? 0
    if (next.version <= currentVersion) return
    usePanesStore.setState((s) => ({
      activeWindowId: next.windowId,
      confirmedFocusTarget: next,
      pendingFocusTarget: null,
      tabs: next.paneId
        ? s.tabs.map((t) => t.id === next.tabId ? { ...t, focusedPaneId: next.paneId } : t)
        : s.tabs,
      detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [String(next.windowId)]: next.tabId },
    }))
  })

  // Live sync from a detached window — only the primary window processes this.
  window.ipc.on('tab:state-sync', (windowId: unknown, tabsJson: unknown, activeTabId: unknown) => {
    if (typeof windowId !== 'number' || typeof tabsJson !== 'string') return
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) return  // only primary merges syncs
    try {
      const tabs = JSON.parse(tabsJson) as Tab[]
      store.syncDetachedTabs(windowId, tabs, typeof activeTabId === 'string' ? activeTabId : undefined)
    } catch { /* ignore malformed */ }
  })

  // A pane has been transferred to this window from another window.
  window.ipc.on('pane:received', (paneJson: unknown, targetTabId: unknown, transferId: unknown) => {
    if (typeof paneJson !== 'string' || typeof targetTabId !== 'string') return
    try {
      const pane = JSON.parse(paneJson) as PaneLeaf
      usePanesStore.getState().addPaneToTab(pane, targetTabId)
      if (typeof transferId === 'string') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.ipc.send('pane:received-applied', transferId)
          })
        })
      }
    } catch { /* ignore */ }
  })
}

