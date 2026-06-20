import { create } from 'zustand'
import type { AgentKind, CwdRepairMapping, FocusTarget, Tab, PaneNode, PaneLeaf, PaneSplit, PaneType, SplitDirection } from '../../../shared/types'
import { collectLeaves } from '../utils/tabLabels'
import * as xtermRegistry from '../utils/xtermRegistry'

let pendingRemoteFocusWindowId: number | null = null
let pendingRemoteFocusTimer: ReturnType<typeof setTimeout> | null = null

// Local sidebar focus arming. When OS focus moves into this window FROM another
// window, the local sidebar highlight is disarmed until we know which pane is
// actually focused — otherwise the stale focusedPaneId flashes before a pending
// click resolves (and two windows can briefly highlight at once during the
// cross-window became-active skew). It is re-armed by an explicit local focus
// action, or by a short grace timer for plain window activation.
let localRearmTimer: ReturnType<typeof setTimeout> | null = null
// One-shot: set on a local sidebar pane mousedown so the became-active that the OS
// fires for this same click does not disarm the highlight we are about to set.
// became-active consumes it; the timer is a backstop so it can never linger and
// wrongly suppress a later, unrelated cross-window disarm (e.g. when the pane was
// clicked while this window was already active, so no became-active follows).
let skipNextActivationDisarm = false
let skipDisarmClearTimer: ReturnType<typeof setTimeout> | null = null
const LOCAL_REARM_MS = 150
const SKIP_DISARM_TTL_MS = 400
const hydratingPaneSessions: Record<string, string> = {}
const hydratingTabs = new Map<string, Promise<void>>()

function clearPendingRemoteFocus(): void {
  pendingRemoteFocusWindowId = null
  if (pendingRemoteFocusTimer !== null) {
    clearTimeout(pendingRemoteFocusTimer)
    pendingRemoteFocusTimer = null
  }
  // pendingFocusTarget is intentionally not cleared here — it should remain visible
  // until focus:target-changed arrives with the confirmed target, or the timeout fires.
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

function updateCwdsInTree(node: PaneNode, mapping: CwdRepairMapping): { node: PaneNode; changed: boolean } {
  if (node.type === 'leaf') {
    const cwd = replaceCwdPrefix(node.cwd, mapping)
    const sessionDetectionCwd = node.sessionDetectionCwd
      ? replaceCwdPrefix(node.sessionDetectionCwd, mapping)
      : undefined
    const changed = cwd !== node.cwd || sessionDetectionCwd !== node.sessionDetectionCwd
    return {
      node: changed ? { ...node, cwd, sessionDetectionCwd } : node,
      changed,
    }
  }
  const first = updateCwdsInTree(node.first, mapping)
  const second = updateCwdsInTree(node.second, mapping)
  if (!first.changed && !second.changed) return { node, changed: false }
  return { node: { ...node, first: first.node, second: second.node }, changed: true }
}

function replaceCwdPrefix(value: string, mapping: CwdRepairMapping): string {
  const oldRoot = normalizeRepairPath(mapping.oldCwd)
  const newRoot = normalizeRepairPath(mapping.newCwd)
  const candidate = normalizeRepairPath(value)
  const oldKey = comparableRepairPath(oldRoot)
  const candidateKey = comparableRepairPath(candidate)
  if (candidateKey === oldKey) return newRoot

  const sep = repairSeparator(oldRoot)
  const oldPrefix = oldKey.endsWith(sep) ? oldKey : `${oldKey}${sep}`
  if (!candidateKey.startsWith(oldPrefix)) return value
  const suffix = candidate.slice(oldRoot.length)
  return joinRepairPath(newRoot, suffix)
}

function normalizeRepairPath(value: string): string {
  const windows = isWindowsPath(value)
  const sep = windows ? '\\' : '/'
  const normalized = value.replace(/[\\/]+/g, sep)
  const prefix = windows && /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 2) : normalized.startsWith(sep) ? sep : ''
  const rest = prefix ? normalized.slice(prefix.length) : normalized
  const parts: string[] = []
  for (const part of rest.split(sep)) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop()
    } else if (part !== '..' || !prefix) {
      parts.push(part)
    }
  }
  const joined = parts.join(sep)
  if (prefix === sep) return `${sep}${joined}`
  return joined ? `${prefix}${prefix && prefix !== sep ? sep : ''}${joined}` : prefix || '.'
}

function comparableRepairPath(value: string): string {
  return isWindowsPath(value) ? value.toLowerCase() : value
}

function repairSeparator(value: string): '\\' | '/' {
  return isWindowsPath(value) ? '\\' : '/'
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.includes('\\')
}

function joinRepairPath(root: string, suffix: string): string {
  const sep = repairSeparator(root)
  let cleanSuffix = suffix.replace(/[\\/]+/g, sep)
  while (cleanSuffix.startsWith(sep)) cleanSuffix = cleanSuffix.slice(1)
  if (!cleanSuffix) return root
  return root.endsWith(sep) ? `${root}${cleanSuffix}` : `${root}${sep}${cleanSuffix}`
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

function agentIpcErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cwdIndex = raw.indexOf('Working directory')
  if (cwdIndex >= 0) return `${raw.slice(cwdIndex)}. Repair the project directory from Session Browser.`
  return raw || fallback
}

function markSessionDetectionPending(leaf: PaneLeaf, startedAt = Date.now()): PaneLeaf {
  return {
    ...leaf,
    sessionDetectionState: 'pending',
    sessionDetectionStartedAt: startedAt,
    sessionDetectionCwd: leaf.cwd,
    sessionDetectionError: undefined,
    resumeError: undefined,
  }
}

function markHydrated(hydratedTabIds: Record<string, true>, tabId: string): Record<string, true> {
  return hydratedTabIds[tabId] ? hydratedTabIds : { ...hydratedTabIds, [tabId]: true }
}

function removeHydratedTabs(hydratedTabIds: Record<string, true>, tabIds: string[]): Record<string, true> {
  if (tabIds.length === 0) return hydratedTabIds
  const remove = new Set(tabIds)
  let changed = false
  const next: Record<string, true> = {}
  for (const [id, value] of Object.entries(hydratedTabIds)) {
    if (remove.has(id)) {
      changed = true
    } else {
      next[id] = value
    }
  }
  return changed ? next : hydratedTabIds
}

function reportCurrentFocusTarget(): void {
  if (typeof window === 'undefined' || !window.ipc) return
  const store = usePanesStore.getState()
  if (store.windowId === null || !store.activeTabId) return
  const tab = store.tabs.find((t) => t.id === store.activeTabId)
  const paneId = tab?.focusedPaneId ?? ''
  window.ipc.send('focus:target-report', store.activeTabId, paneId)
}

function markTabHydrated(tabId: string): void {
  usePanesStore.setState((s) => ({ hydratedTabIds: markHydrated(s.hydratedTabIds, tabId) }))
}

function hydrateTabRuntime(tabId: string, markReadyAfterRuntime = false): Promise<void> {
  const existing = hydratingTabs.get(tabId)
  if (existing) {
    if (markReadyAfterRuntime) void existing.then(() => markTabHydrated(tabId))
    return existing
  }

  if (typeof window === 'undefined' || !window.ipc) {
    if (markReadyAfterRuntime) markTabHydrated(tabId)
    return Promise.resolve()
  }
  const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab?.rootNode) {
    if (markReadyAfterRuntime) markTabHydrated(tabId)
    return Promise.resolve()
  }

  const resumes: Promise<void>[] = []

  for (const leaf of collectLeaves(tab.rootNode)) {
    if (leaf.paneType !== 'agent' || !leaf.agentKind || !leaf.sessionId || leaf.ptyId) continue
    if (hydratingPaneSessions[leaf.id] === leaf.sessionId) continue

    const { id: paneId, agentKind, sessionId, cwd } = leaf
    hydratingPaneSessions[paneId] = sessionId
    const resumePromise = (async () => {
      try {
        // Validate the session transcript exists before spawning a CLI process.
        // A missing transcript would cause a doomed spawn; catch it early so we get
        // recoverable UI instead of a repeated failure loop on every startup.
        const validation = await window.ipc.invoke('sessions:validate', agentKind, sessionId, cwd)
          .catch(() => null) as { found: boolean; cwdMatch: boolean } | null
        if (!validation?.found) {
          const current = usePanesStore.getState().findPaneInAnyTab(paneId)
          if (
            current?.paneType === 'agent' &&
            current.agentKind === agentKind &&
            current.sessionId === sessionId &&
            !current.ptyId
          ) {
            usePanesStore.getState().updatePane(paneId, {
              resumeError: 'Session not found — the transcript may have been deleted',
            })
          }
          return
        }
        const result = await window.ipc.invoke('session:resume', agentKind, sessionId, cwd) as { ptyId?: string } | null
        if (!result?.ptyId) return
        const current = usePanesStore.getState().findPaneInAnyTab(paneId)
        if (
          current?.paneType === 'agent' &&
          current.agentKind === agentKind &&
          current.sessionId === sessionId &&
          !current.ptyId
        ) {
          usePanesStore.getState().updatePane(paneId, { ptyId: result.ptyId, resumeError: undefined })
        }
      } catch (err) {
        const current = usePanesStore.getState().findPaneInAnyTab(paneId)
        if (
          current?.paneType === 'agent' &&
          current.agentKind === agentKind &&
          current.sessionId === sessionId &&
          !current.ptyId
        ) {
          usePanesStore.getState().updatePane(paneId, {
            resumeError: agentIpcErrorMessage(err, 'Session resume failed'),
          })
        }
      } finally {
        if (hydratingPaneSessions[paneId] === sessionId) delete hydratingPaneSessions[paneId]
      }
    })()
    resumes.push(resumePromise)
  }

  const hydration = resumes.length === 0
    ? Promise.resolve()
    : Promise.allSettled(resumes).then(() => undefined)

  hydratingTabs.set(tabId, hydration)
  void hydration.finally(() => {
    if (hydratingTabs.get(tabId) === hydration) hydratingTabs.delete(tabId)
  })
  if (markReadyAfterRuntime) void hydration.then(() => markTabHydrated(tabId))
  return hydration
}

function hydrateTabForActivation(tabId: string, previousHydrated?: Record<string, true>): void {
  if (!tabId) return
  const hydrated = previousHydrated ? previousHydrated[tabId] === true : usePanesStore.getState().hydratedTabIds[tabId] === true
  if (!hydrated) void hydrateTabRuntime(tabId, true)
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
  // Whether this window's local sidebar pane highlight may be shown. Disarmed
  // transiently when OS focus arrives from another window (see notes above).
  localFocusArmed: boolean
  hydratedTabIds: Record<string, true>
  hydrateTab: (tabId: string) => void
  isTabHydrated: (tabId: string) => boolean
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
  focusLocalPaneFromSidebar: (tabId: string, paneId: string) => void
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
  markPtyExited: (ptyId: string, exitCode: number | null, signal?: number) => void
  applyCwdRepair: (mapping: CwdRepairMapping) => void

  // Session / PTY actions (Phase 2)
  resumeSession: (agentKind: AgentKind, sessionId: string, cwd: string) => Promise<void>
  resumeSessionInNewTab: (agentKind: AgentKind, sessionId: string, cwd: string) => Promise<void>
  resumeAgentPane: (paneId: string) => Promise<void>
  startNewAgentInPane: (paneId: string) => Promise<void>
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
  localFocusArmed: true,
  hydratedTabIds: {},
  hydrateTab: (tabId) => {
    const wasHydrated = get().hydratedTabIds[tabId] === true
    if (!wasHydrated) {
      hydrateTabRuntime(tabId, true)
    }
  },
  isTabHydrated: (tabId) => get().hydratedTabIds[tabId] === true,

  detachedWindowTabIds: {},
  detachedWindowActiveTabIds: {},

  initDetached: (tab, ptyIds) => {
    set({
      tabs: [tab],
      activeTabId: tab.id,
      isDetachedWindow: true,
      sidebarOpen: false,
      hydratedTabIds: {},
      sidebarSectionOpen: { [tabSidebarSectionId(tab.id)]: true },
    })
    hydrateTabRuntime(tab.id, true)
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
        hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [tab.id]),
        sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
      }
    })
    hydrateTabRuntime(tab.id, true)
    reportCurrentFocusTarget()
  },

  detachTab: (tabId, ownerWindowId) => {
    const previousHydrated = get().hydratedTabIds
    // Mark as detached — keeps the tab in the store for sidebar navigation.
    // Do NOT dispose xterms: they stay in the off-screen registry so that when
    // the tab returns the terminals reattach with their full scrollback intact.
    set((s) => {
      const tabs = s.tabs.map((t) => t.id === tabId ? { ...t, detached: true } : t)
      const nonDetached = tabs.filter((t) => !t.detached)
      const activeTabId = s.activeTabId === tabId
        ? (nonDetached[nonDetached.length - 1]?.id ?? '')
        : s.activeTabId
      const hydratedTabIds = s.hydratedTabIds
      if (ownerWindowId === undefined) return { tabs, activeTabId, hydratedTabIds }
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
        hydratedTabIds,
        detachedWindowTabIds,
        detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [key]: tabId },
      }
    })
    hydrateTabForActivation(get().activeTabId, previousHydrated)
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
        hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [tabId]),
        sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tabId)]: true },
      }
    })
    hydrateTabRuntime(tabId, true)
  },

  removeTabLocally: (tabId) => {
    const previousHydrated = get().hydratedTabIds
    // Remove the tab without marking as detached and without killing PTYs.
    // Used in detached windows when a tab is transferred to another window.
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId
        ? (tabs[tabs.length - 1]?.id ?? '')
        : s.activeTabId
      const { [tabSidebarSectionId(tabId)]: _r, ...sidebarSectionOpen } = s.sidebarSectionOpen
      const hydratedTabIds = removeHydratedTabs(
        s.hydratedTabIds,
        [tabId]
      )
      return { tabs, activeTabId, hydratedTabIds, sidebarSectionOpen }
    })
    hydrateTabForActivation(get().activeTabId, previousHydrated)
  },

  syncDetachedTabs: (windowId, incomingTabs, activeTabId) => {
    // Dispose xterms for tabs that were genuinely closed inside the detached window.
    // Guard: only dispose if the tab is still detached in our store. A tab that has
    // already been received/returned as local (detached:false) must not be disposed —
    // its Terminal may already be mounting and the xterm is live in the DOM.
    const key = String(windowId)
    const prevIds = get().detachedWindowTabIds[key] ?? []
    const previousHydrated = get().hydratedTabIds
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

      const hydratedTabIds = removeHydratedTabs(
        s.hydratedTabIds,
        removedIds
      )

      return { tabs, detachedWindowTabIds, detachedWindowActiveTabIds, activeTabId: newActiveTabId, hydratedTabIds }
    })
    hydrateTabForActivation(get().activeTabId, previousHydrated)
  },

  addPaneToTab: (pane, tabId) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        if (!t.rootNode) return { ...t, rootNode: pane, focusedPaneId: pane.id }
        return { ...t, rootNode: makeSplit('vertical', t.rootNode, pane), focusedPaneId: pane.id }
      }),
      hydratedTabIds: s.hydratedTabIds[tabId] ? removeHydratedTabs(s.hydratedTabIds, [tabId]) : s.hydratedTabIds,
    }))
    hydrateTabRuntime(tabId, true)
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
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      hydratedTabIds: markHydrated(s.hydratedTabIds, tab.id),
      sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
    }))
    return tab.id
  },

  setTabDefaultCwd: (tabId, cwd) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, defaultCwd: cwd || undefined } : t),
    }))
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const previousHydrated = get().hydratedTabIds
    if (tab?.rootNode) {
      collectLeafIds(tab.rootNode).forEach((id) => xtermRegistry.dispose(id))
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? '') : s.activeTabId
      const { [tabSidebarSectionId(tabId)]: _closed, [tabId]: _legacyClosed, ...sidebarSectionOpen } = s.sidebarSectionOpen
      const hydratedTabIds = removeHydratedTabs(
        s.hydratedTabIds,
        [tabId]
      )
      return { tabs, activeTabId, hydratedTabIds, sidebarSectionOpen }
    })
    hydrateTabForActivation(get().activeTabId, previousHydrated)
  },

  setActiveTab: (tabId) => {
    const wasHydrated = get().hydratedTabIds[tabId] === true
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      const zoomedPaneId = tab?.rootNode && s.zoomedPaneId && findLeaf(tab.rootNode, s.zoomedPaneId)
        ? s.zoomedPaneId
        : null
      return {
        activeTabId: tabId,
        zoomedPaneId,
      }
    })
    if (!wasHydrated) hydrateTabRuntime(tabId, true)
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
      const fallbackLabel = focusedLeaf
        ? (focusedLeaf.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Shell')
        : undefined
      const newTab: Tab = {
        id: uuid(),
        focusedPaneId: '',
        customLabel: tab.customLabel ?? fallbackLabel,
        defaultCwd: tab.defaultCwd,
      }
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      const tabs = [...s.tabs.slice(0, idx + 1), newTab, ...s.tabs.slice(idx + 1)]
      return {
        tabs,
        activeTabId: newTab.id,
        hydratedTabIds: markHydrated(s.hydratedTabIds, newTab.id),
        sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(newTab.id)]: true },
      }
    })
  },

  closeOtherTabs: (tabId) => {
    const wasHydrated = get().hydratedTabIds[tabId] === true
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
        hydratedTabIds: wasHydrated ? { [tabId]: true } : {},
        sidebarSectionOpen: {
          [RECENT_SECTION_ID]: s.sidebarSectionOpen[RECENT_SECTION_ID] ?? true,
          [sectionId]: s.sidebarSectionOpen[sectionId] ?? s.sidebarSectionOpen[tabId] ?? true,
        },
      }
    })
    if (!wasHydrated) hydrateTabRuntime(tabId, true)
  },

  closeTabsToRight: (tabId) => {
    const { tabs } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    const previousHydrated = get().hydratedTabIds
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
      const removedIds = s.tabs.slice(idx + 1).map((t) => t.id)
      const kept = new Set(tabs.flatMap((t) => [tabSidebarSectionId(t.id), t.id]))
      const sidebarSectionOpen = Object.fromEntries(
        Object.entries(s.sidebarSectionOpen).filter(([id]) =>
          id === RECENT_SECTION_ID || kept.has(id)
        )
      )
      const hydratedTabIds = removeHydratedTabs(
        s.hydratedTabIds,
        removedIds
      )
      return { tabs, activeTabId, hydratedTabIds, sidebarSectionOpen }
    })
    hydrateTabForActivation(get().activeTabId, previousHydrated)
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
      return { tabs, localFocusArmed: true }
    })
    // Immediately notify other windows — don't wait for the debounced tab:state-sync.
    if (isDetachedWindow && windowId !== null && typeof window !== 'undefined' && window.ipc) {
      window.ipc.send('pane:focus-changed', windowId, activeTabId, paneId)
    }
    reportCurrentFocusTarget()
  },

  focusPaneInTab: (tabId, paneId) => {
    const { isDetachedWindow, windowId } = get()
    const wasHydrated = get().hydratedTabIds[tabId] === true
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      const zoomedPaneId = tab?.rootNode && s.zoomedPaneId && findLeaf(tab.rootNode, s.zoomedPaneId)
        ? s.zoomedPaneId
        : null
      return {
        activeTabId: tabId,
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, focusedPaneId: paneId } : t),
        zoomedPaneId,
        localFocusArmed: true,
      }
    })
    if (!wasHydrated) hydrateTabRuntime(tabId, true)
    if (isDetachedWindow && windowId !== null && typeof window !== 'undefined' && window.ipc) {
      window.ipc.send('pane:focus-changed', windowId, tabId, paneId)
    }
    reportCurrentFocusTarget()
  },

  // Local sidebar pane click. Mark the upcoming OS activation as click-driven so
  // it does not disarm the highlight, then focus the pane (which arms it).
  focusLocalPaneFromSidebar: (tabId, paneId) => {
    skipNextActivationDisarm = true
    if (skipDisarmClearTimer !== null) clearTimeout(skipDisarmClearTimer)
    skipDisarmClearTimer = setTimeout(() => {
      skipNextActivationDisarm = false
      skipDisarmClearTimer = null
    }, SKIP_DISARM_TTL_MS)
    get().focusPaneInTab(tabId, paneId)
  },

  focusDetachedPaneOptimistically: (windowId, tabId, paneId) => {
    pendingRemoteFocusWindowId = windowId
    if (pendingRemoteFocusTimer !== null) clearTimeout(pendingRemoteFocusTimer)
    pendingRemoteFocusTimer = setTimeout(() => {
      pendingRemoteFocusWindowId = null
      pendingRemoteFocusTimer = null
      usePanesStore.setState({ pendingFocusTarget: null })
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
    const newLeaf = resolvedType === 'agent'
      ? markSessionDetectionPending(makeLeaf(cwd, resolvedType, resolvedAgent))
      : makeLeaf(cwd, resolvedType, resolvedAgent)

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
        const result = await window.ipc.invoke('session:new', resolvedAgent, cwd) as { ptyId: string; sessionId: string | null; detectionStartedAt?: number }
        const patch: Partial<PaneLeaf> = {}
        if (result?.ptyId) patch.ptyId = result.ptyId
        if (typeof result?.detectionStartedAt === 'number') patch.sessionDetectionStartedAt = result.detectionStartedAt
        if (result?.sessionId) {
          patch.sessionId = result.sessionId
          patch.sessionDetectionState = 'detected'
          patch.sessionDetectionError = undefined
        }
        if (Object.keys(patch).length > 0) get().updatePane(newLeaf.id, patch)
      } catch (err) {
        console.error('session:new IPC failed', err)
        const message = agentIpcErrorMessage(err, 'Session detection failed to start')
        get().updatePane(newLeaf.id, {
          sessionDetectionState: 'failed',
          sessionDetectionError: message,
          resumeError: message,
        })
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
      window.ipc.invoke('pty:kill', pane.ptyId)
        .catch(() => {})
        .finally(() => {
          if (pane.paneType === 'agent' && pane.sessionId) {
            window.ipc.invoke('sessions:refresh').catch(() => {})
          }
        })
    } else if (pane.paneType === 'agent' && pane.sessionId && typeof window !== 'undefined' && window.ipc) {
      window.ipc.invoke('sessions:refresh').catch(() => {})
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
      tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, {
        ptyId,
        agentDisconnected: undefined,
        resumeError: undefined,
      }) } : t),
    }))
  },

  setPaneCwd: (ptyId, cwd) => {
    set((s) => {
      let changed = false
      const tabs = s.tabs.map((t) => {
        if (!t.rootNode) return t
        function patchCwd(node: PaneNode): PaneNode {
          if (node.type === 'leaf') {
            if (node.ptyId !== ptyId || node.cwd === cwd) return node
            changed = true
            return { ...node, cwd }
          }
          const first = patchCwd(node.first)
          const second = patchCwd(node.second)
          return first === node.first && second === node.second ? node : { ...node, first, second }
        }
        const rootNode = patchCwd(t.rootNode)
        return rootNode === t.rootNode ? t : { ...t, rootNode }
      })
      return changed ? { tabs } : s
    })
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
      tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, {
        sessionId,
        sessionDetectionState: 'detected',
        sessionDetectionError: undefined,
        resumeError: undefined,
      }) } : t),
    }))
  },

  updatePane: (paneId, patch) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, paneId, patch) } : t),
    }))
  },

  markPtyExited: (ptyId, exitCode, signal) => {
    let shouldRefreshSessions = false
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (!t.rootNode) return t
        function patchExited(node: PaneNode): PaneNode {
          if (node.type === 'leaf') {
            if (node.ptyId !== ptyId || node.paneType !== 'agent') return node
            shouldRefreshSessions = !!node.sessionId
            return {
              ...node,
              ptyId: undefined,
              agentDisconnected: { exitCode, signal, at: Date.now() },
            }
          }
          return { ...node, first: patchExited(node.first), second: patchExited(node.second) }
        }
        return { ...t, rootNode: patchExited(t.rootNode) }
      }),
    }))
    if (shouldRefreshSessions && typeof window !== 'undefined' && window.ipc) {
      window.ipc.invoke('sessions:refresh').catch(() => {})
    }
  },

  applyCwdRepair: (mapping) => {
    set((s) => {
      let changed = false
      const tabs = s.tabs.map((tab) => {
        const defaultCwd = tab.defaultCwd ? replaceCwdPrefix(tab.defaultCwd, mapping) : undefined
        const defaultChanged = defaultCwd !== tab.defaultCwd
        if (!tab.rootNode) {
          if (!defaultChanged) return tab
          changed = true
          return { ...tab, defaultCwd }
        }
        const root = updateCwdsInTree(tab.rootNode, mapping)
        if (!defaultChanged && !root.changed) return tab
        changed = true
        return { ...tab, defaultCwd, rootNode: root.node }
      })
      return changed ? { tabs } : s
    })
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
    let targetTabId = ''
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        targetTabId = tab.id
        return {
          tabs: [tab],
          activeTabId: tab.id,
          hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [tab.id]),
          sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
        }
      }
      targetTabId = s.activeTabId
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit('vertical', t.rootNode, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs, hydratedTabIds: s.activeTabId ? removeHydratedTabs(s.hydratedTabIds, [s.activeTabId]) : s.hydratedTabIds }
    })
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:resume', agentKind, sessionId, cwd)) as { ptyId: string }
        if (result?.ptyId) {
          get().setPtyId(leaf.id, result.ptyId)
        }
      } catch (err) {
        console.error('session:resume IPC failed', err)
        get().updatePane(leaf.id, { resumeError: agentIpcErrorMessage(err, 'Session resume failed') })
      } finally {
        if (targetTabId) markTabHydrated(targetTabId)
      }
    } else if (targetTabId) {
      markTabHydrated(targetTabId)
    }
  },

  resumeSessionInNewTab: async (agentKind, sessionId, cwd) => {
    get().setLastAgentKind(agentKind)
    const leaf = makeLeaf(cwd, 'agent', agentKind)
    leaf.sessionId = sessionId
    const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [tab.id]),
      sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
    }))
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:resume', agentKind, sessionId, cwd)) as { ptyId: string }
        if (result?.ptyId) get().setPtyId(leaf.id, result.ptyId)
      } catch (err) {
        console.error('session:resume IPC failed', err)
        get().updatePane(leaf.id, { resumeError: agentIpcErrorMessage(err, 'Session resume failed') })
      } finally {
        markTabHydrated(tab.id)
      }
    } else {
      markTabHydrated(tab.id)
    }
  },

  resumeAgentPane: async (paneId) => {
    const pane = get().findPaneInAnyTab(paneId)
    if (!pane || pane.paneType !== 'agent' || !pane.agentKind) return
    if (!pane.sessionId) {
      get().updatePane(paneId, { resumeError: 'No session id is available for this pane' })
      return
    }
    const { agentKind, sessionId, cwd } = pane
    get().setLastAgentKind(agentKind)
    get().updatePane(paneId, {
      ptyId: undefined,
      agentDisconnected: undefined,
      resumeError: undefined,
      sessionDetectionError: undefined,
    })
    try {
      const result = await window.ipc.invoke('session:resume', agentKind, sessionId, cwd) as { ptyId: string }
      const current = get().findPaneInAnyTab(paneId)
      if (
        current?.paneType === 'agent' &&
        current.agentKind === agentKind &&
        current.sessionId === sessionId &&
        result?.ptyId
      ) {
        get().updatePane(paneId, {
          ptyId: result.ptyId,
          agentDisconnected: undefined,
          resumeError: undefined,
          sessionDetectionError: undefined,
        })
      }
    } catch (err) {
      console.error('session:resume IPC failed', err)
      get().updatePane(paneId, {
        resumeError: agentIpcErrorMessage(err, 'Session resume failed'),
        agentDisconnected: pane.agentDisconnected,
      })
    }
  },

  startNewAgentInPane: async (paneId) => {
    const pane = get().findPaneInAnyTab(paneId)
    if (!pane || pane.paneType !== 'agent' || !pane.agentKind) return
    const { agentKind, cwd } = pane
    get().setLastAgentKind(agentKind)
    get().updatePane(paneId, {
      ptyId: undefined,
      sessionId: undefined,
      agentDisconnected: undefined,
      resumeError: undefined,
      sessionDetectionState: 'pending',
      sessionDetectionStartedAt: Date.now(),
      sessionDetectionCwd: cwd,
      sessionDetectionError: undefined,
    })
    try {
      const result = await window.ipc.invoke('session:new', agentKind, cwd) as { ptyId: string; sessionId: string | null; detectionStartedAt?: number }
      const patch: Partial<PaneLeaf> = {
        ptyId: result.ptyId,
        agentDisconnected: undefined,
        resumeError: undefined,
        sessionDetectionError: undefined,
      }
      if (typeof result.detectionStartedAt === 'number') patch.sessionDetectionStartedAt = result.detectionStartedAt
      if (result.sessionId) {
        patch.sessionId = result.sessionId
        patch.sessionDetectionState = 'detected'
      } else {
        patch.sessionDetectionState = 'pending'
      }
      get().updatePane(paneId, patch)
    } catch (err) {
      console.error('session:new IPC failed', err)
      const message = agentIpcErrorMessage(err, 'Session detection failed to start')
      get().updatePane(paneId, {
        sessionDetectionState: 'failed',
        sessionDetectionError: message,
        resumeError: message,
        agentDisconnected: pane.agentDisconnected,
      })
    }
  },

  newSession: async (cwd, direction = 'vertical', agentKind) => {
    const resolvedAgent = agentKind ?? get().lastAgentKind
    get().setLastAgentKind(resolvedAgent)
    const leaf = markSessionDetectionPending(makeLeaf(cwd, 'agent', resolvedAgent))
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return {
          tabs: [tab],
          activeTabId: tab.id,
          hydratedTabIds: markHydrated(s.hydratedTabIds, tab.id),
          sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
        }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit(direction, t.rootNode, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs, hydratedTabIds: s.activeTabId ? markHydrated(s.hydratedTabIds, s.activeTabId) : s.hydratedTabIds }
    })
    if (typeof window !== 'undefined' && window.ipc) {
      try {
        const result = (await window.ipc.invoke('session:new', resolvedAgent, cwd)) as { ptyId: string; sessionId: string | null; detectionStartedAt?: number }
        const patch: Partial<PaneLeaf> = {}
        if (result?.ptyId) patch.ptyId = result.ptyId
        if (typeof result?.detectionStartedAt === 'number') patch.sessionDetectionStartedAt = result.detectionStartedAt
        if (result?.sessionId) {
          patch.sessionId = result.sessionId
          patch.sessionDetectionState = 'detected'
          patch.sessionDetectionError = undefined
        }
        if (Object.keys(patch).length > 0) get().updatePane(leaf.id, patch)
      } catch (err) {
        console.error('session:new IPC failed', err)
        const message = agentIpcErrorMessage(err, 'Session detection failed to start')
        get().updatePane(leaf.id, {
          sessionDetectionState: 'failed',
          sessionDetectionError: message,
          resumeError: message,
        })
      }
    }
  },

  addShellPane: async (cwd, direction = 'vertical') => {
    const leaf = makeLeaf(cwd, 'shell')
    set((s) => {
      if (s.tabs.length === 0) {
        const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
        return {
          tabs: [tab],
          activeTabId: tab.id,
          hydratedTabIds: markHydrated(s.hydratedTabIds, tab.id),
          sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
        }
      }
      const tabs = s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        if (!t.rootNode) return { ...t, rootNode: leaf, focusedPaneId: leaf.id }
        const split = makeSplit(direction, t.rootNode, leaf)
        return { ...t, rootNode: split, focusedPaneId: leaf.id }
      })
      return { tabs, hydratedTabIds: s.activeTabId ? markHydrated(s.hydratedTabIds, s.activeTabId) : s.hydratedTabIds }
    })
  },

  applyLayout: async (saved) => {
    try {
      // Strip ptyIds and convert legacy unresumable agent panes to shell panes.
      // Panes explicitly saved while detection was pending stay recoverable.
      async function sanitizeNode(node: PaneNode): Promise<PaneNode> {
        if (node.type === 'leaf') {
          const legacy = node as Omit<PaneLeaf, 'paneType'> & { paneType: PaneType | 'claude' }
          const migrated: PaneLeaf = legacy.paneType === 'claude'
            ? { ...legacy, paneType: 'agent', agentKind: 'claude' }
            : { ...node, agentKind: node.paneType === 'agent' ? (node.agentKind ?? 'claude') : undefined }
          if (migrated.paneType === 'agent' && !migrated.sessionId) {
            const isRecoverablePending =
              migrated.sessionDetectionState === 'pending' &&
              migrated.agentKind &&
              typeof migrated.sessionDetectionStartedAt === 'number'

            if (isRecoverablePending && typeof window !== 'undefined' && window.ipc) {
              const recovered = await window.ipc.invoke(
                'sessions:recover-pending',
                migrated.agentKind,
                migrated.sessionDetectionCwd ?? migrated.cwd,
                migrated.sessionDetectionStartedAt,
              ).catch(() => null)
              if (typeof recovered === 'string' && recovered) {
                return {
                  ...migrated,
                  sessionId: recovered,
                  ptyId: undefined,
                  sessionDetectionState: 'detected',
                  sessionDetectionError: undefined,
                  resumeError: undefined,
                }
              }
            }

            if (migrated.sessionDetectionState === 'pending' || migrated.sessionDetectionState === 'failed') {
              return {
                ...migrated,
                ptyId: undefined,
                sessionDetectionState: 'failed',
                sessionDetectionError: migrated.sessionDetectionError ?? 'Session detection did not finish before shutdown',
                resumeError: migrated.resumeError ?? 'Session detection did not finish before shutdown',
              }
            }

            return { ...migrated, paneType: 'shell', agentKind: undefined, ptyId: undefined }
          }
          return { ...migrated, ptyId: undefined }
        }
        const [first, second] = await Promise.all([sanitizeNode(node.first), sanitizeNode(node.second)])
        return { ...node, first, second }
      }
      const tabs = await Promise.all(saved.tabs.map(async (t) => {
        const baseTab = { ...t, detached: false }
        if (!baseTab.rootNode) return { ...baseTab, focusedPaneId: '' }
        const rootNode = await sanitizeNode(baseTab.rootNode)
        const focusedPaneId = findLeaf(rootNode, baseTab.focusedPaneId)
          ? baseTab.focusedPaneId
          : (collectLeafIds(rootNode)[0] ?? '')
        return { ...baseTab, rootNode, focusedPaneId }
      }))

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
        hydratedTabIds: {},
        sidebarWidth: saved.sidebarWidth ?? 220,
        sidebarPanelSizes,
        sidebarOpen: saved.sidebarOpen ?? true,
        sidebarSectionOpen,
        detachedWindowTabIds: {},
        detachedWindowActiveTabIds: {},
      })
      if (activeTabId) hydrateTabRuntime(activeTabId, true)
    } catch (err) {
      console.error('[MultiAgent] applyLayout failed:', err)
    }
  },

  setDraggedPane: (paneId) => set({ draggedPaneId: paneId }),

  movePaneToNewTab: (paneId) => {
    let newTabId = ''
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
      newTabId = newTab.id

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

      return {
        tabs: updatedTabs,
        activeTabId: newTab.id,
        hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [newTab.id]),
        sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(newTab.id)]: true },
      }
    })
    if (newTabId) hydrateTabRuntime(newTabId, true)
  },

  movePaneToTab: (sourcePaneId, targetTabId) => {
    let moved = false
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
      moved = true

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
        hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [targetTabId]),
        zoomedPaneId: s.zoomedPaneId === sourcePaneId ? null : s.zoomedPaneId,
        sidebarSectionOpen: {
          ...s.sidebarSectionOpen,
          [tabSidebarSectionId(targetTabId)]: true,
        },
      }
    })
    if (moved) hydrateTabRuntime(targetTabId, true)
  },

  movePaneToSplit: (sourcePaneId, targetPaneId, direction, sourceBefore) => {
    if (sourcePaneId === targetPaneId) return
    let activatedTabId = ''
    let moved = false
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
      activatedTabId = targetTabId
      moved = true
      return {
        tabs: updatedTabs,
        activeTabId: targetTabId,
        hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [targetTabId]),
        zoomedPaneId: s.zoomedPaneId === sourcePaneId ? null : s.zoomedPaneId,
        sidebarSectionOpen: {
          ...s.sidebarSectionOpen,
          [tabSidebarSectionId(targetTabId)]: true,
        },
      }
    })
    if (moved && activatedTabId) hydrateTabRuntime(activatedTabId, true)
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

  window.ipc.on('pty:exit', (ptyId: unknown, exitCode: unknown, signal: unknown) => {
    if (typeof ptyId !== 'string') return
    const code = typeof exitCode === 'number' ? exitCode : null
    usePanesStore.getState().markPtyExited(ptyId, code, typeof signal === 'number' ? signal : undefined)
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
          tabs: s.tabs.map((t) => t.rootNode ? { ...t, rootNode: updateLeaf(t.rootNode, pane.id, {
            sessionId,
            sessionDetectionState: 'detected',
            sessionDetectionError: undefined,
            resumeError: undefined,
          }) } : t),
        }))
        break
      }
    }
  })

  window.ipc.on('session:detection-failed', (ptyId: unknown, agentKind: unknown, reason: unknown, mode: unknown) => {
    if (typeof ptyId !== 'string' || (agentKind !== 'claude' && agentKind !== 'codex')) return
    const message = mode === 'resume'
      ? 'Session resumed, but the live session id could not be confirmed'
      : 'Session detection timed out'
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const pane = collectLeaves(tab.rootNode).find((l) => l.ptyId === ptyId)
      if (!pane || pane.agentKind !== agentKind) continue
      store.updatePane(pane.id, {
        sessionDetectionState: 'failed',
        sessionDetectionError: typeof reason === 'string' ? `${message}: ${reason}` : message,
        ...(mode === 'resume' ? {} : { resumeError: message }),
      })
      break
    }
  })

  window.ipc.on('layout:cwd-repaired', (mapping: unknown) => {
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      typeof (mapping as CwdRepairMapping).oldCwd !== 'string' ||
      typeof (mapping as CwdRepairMapping).newCwd !== 'string'
    ) return
    usePanesStore.getState().applyCwdRepair(mapping as CwdRepairMapping)
  })

  // Main tells this window to release a tab (it moved to another window).
  // In a detached window: just remove it locally (PTYs stay alive in the destination).
  // In the primary window: mark it as detached so the sidebar still shows it.
  //
  // Two-phase (absorb) vs one-phase (bring-home / reattach-home):
  // - With a releaseId, this is the absorb handshake. We only ACK here and DEFER the actual
  //   removal/detach to tab:absorb-committed. Acting now would permanently lose the tab (and
  //   orphan its PTYs) if the absorb later timed out — the source dropped its copy and the
  //   absorber rolled back its optimistic copy. See specs/atomic-state-audit-followup #1.
  // - Without a releaseId (bring-home / reattach-home), there is no commit step, so apply
  //   immediately as before.
  window.ipc.on('tab:release', (tabId: unknown, ownerWindowId: unknown, releaseId: unknown) => {
    if (typeof tabId !== 'string') return
    if (typeof releaseId === 'string') {
      window.ipc.send('tab:release-applied', releaseId)
      return
    }
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) {
      store.removeTabLocally(tabId)
    } else {
      store.detachTab(tabId, typeof ownerWindowId === 'number' ? ownerWindowId : undefined)
    }
  })

  // Absorb committed: the PTYs have been transferred to the absorbing window, so it is now
  // safe to finalize releasing our copy of the tab (deferred from tab:release above).
  window.ipc.on('tab:absorb-committed', (tabId: unknown, ownerWindowId: unknown) => {
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
    const { windowId, activeWindowId: prevActive } = usePanesStore.getState()

    // Disarm the local sidebar highlight only when focus genuinely moves into THIS
    // window from a different window. Plain re-focus of an already-active window and
    // first focus at startup (prevActive === null) keep the highlight armed, so the
    // single-window case is never affected. A click on a local sidebar pane sets
    // skipNextActivationDisarm so the activation it triggers does not disarm.
    const movedHereFromOtherWindow =
      winId === windowId && prevActive !== null && prevActive !== windowId
    const disarm = movedHereFromOtherWindow && !skipNextActivationDisarm
    if (winId === windowId) skipNextActivationDisarm = false

    if (disarm) {
      // Re-arm shortly after, so plain window activation still restores the last
      // focused pane. An intervening explicit focus arms it immediately and the
      // guard below leaves that alone. The content focus ring stays visible
      // throughout, so this only briefly defers the sidebar row highlight.
      if (localRearmTimer !== null) clearTimeout(localRearmTimer)
      localRearmTimer = setTimeout(() => {
        localRearmTimer = null
        const s = usePanesStore.getState()
        if (s.activeWindowId === s.windowId && !s.localFocusArmed) {
          usePanesStore.setState({ localFocusArmed: true })
        }
      }, LOCAL_REARM_MS)
    }

    if (pendingRemoteFocusWindowId !== null) {
      if (winId === pendingRemoteFocusWindowId) {
        // The correct remote window received OS focus. Clear the guard but keep
        // pendingFocusTarget visible — focus:target-changed will replace it with
        // the confirmed target once the detached window acks the focused pane.
        clearPendingRemoteFocus()
        usePanesStore.setState({ activeWindowId: winId })
        return
      } else if (winId === windowId) {
        if (disarm) usePanesStore.setState({ localFocusArmed: false })
        return
      } else {
        // A third window got focus; the pending focus request is stale.
        clearPendingRemoteFocus()
        usePanesStore.setState({ activeWindowId: winId, pendingFocusTarget: null })
        return
      }
    }
    usePanesStore.setState({
      activeWindowId: winId,
      pendingFocusTarget: null,
      ...(disarm ? { localFocusArmed: false } : {}),
    })
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
      // Only clear pendingFocusTarget when the confirmed target is for the same window
      // we were targeting. If a stale self-focus report from the main window arrives
      // after the user has already clicked a detached pane (pendingFocusTarget set),
      // leave pendingFocusTarget intact so the sidebar doesn't flash the wrong pane.
      pendingFocusTarget: s.pendingFocusTarget?.windowId === next.windowId ? null : s.pendingFocusTarget,
      // Only sync focusedPaneId for tabs owned by a different window.
      // For the local window, focusPaneInTab is the ground truth — overwriting here
      // with a stale self-focus report would revert a pane click that already fired.
      tabs: next.paneId && next.windowId !== s.windowId
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

  window.ipc.on('pane:remove-remote', (paneId: unknown) => {
    if (typeof paneId !== 'string') return
    usePanesStore.getState().removePaneKeepTab(paneId)
  })

  // The transfer that delivered this pane (via pane:received) never committed; discard the
  // optimistically-added pane so it does not linger without PTY output.
  window.ipc.on('pane:transfer-rolledback', (paneId: unknown) => {
    if (typeof paneId !== 'string') return
    usePanesStore.getState().removePaneKeepTab(paneId)
  })

  window.ipc.on('pane:move-remote', (paneId: unknown, targetTabId: unknown) => {
    if (typeof paneId !== 'string' || typeof targetTabId !== 'string') return
    usePanesStore.getState().movePaneToTab(paneId, targetTabId)
  })
}

