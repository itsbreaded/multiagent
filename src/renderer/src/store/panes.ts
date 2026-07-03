import { create } from 'zustand'
import type { AgentKind, CwdRepairMapping, FocusTarget, Tab, PaneNode, PaneLeaf, PaneType, SpawnInTabPayload, SplitDirection } from '../../../shared/types'
import {
  uuid, makeLeaf, makeSplit, findLeaf, replaceNode, removeLeaf, swapLeaves,
  updateRatioInTree, updateLeaf, updateCwdsInTree, collectLeafIds, findLeafBySessionId,
  collectLeaves, markLeafExitedByPtyId,
} from '../../../shared/paneTree'
import { replaceCwdPrefix } from '../../../shared/cwdRepair'
import * as xtermRegistry from '../utils/xtermRegistry'
import type { SettingsSection } from './settings'
import { focusArming, SKIP_DISARM_TTL_MS } from './focusArming'
import { wirePanesIpc } from './panesIpc'

// Local sidebar focus arming. When OS focus moves into this window FROM another
// window, the local sidebar highlight is disarmed until we know which pane is
// actually focused — otherwise the stale focusedPaneId flashes before a pending
// click resolves (and two windows can briefly highlight at once during the
// cross-window became-active skew). It is re-armed by an explicit local focus
// action, or by a short grace timer for plain window activation.
// One-shot: set on a local sidebar pane mousedown so the became-active that the OS
// fires for this same click does not disarm the highlight we are about to set.
// became-active consumes it; the timer is a backstop so it can never linger and
// wrongly suppress a later, unrelated cross-window disarm (e.g. when the pane was
// clicked while this window was already active, so no became-active follows).
const hydratingPaneSessions: Record<string, string> = {}
const hydratingTabs = new Map<string, Promise<void>>()
const DEFAULT_AGENT_KIND: AgentKind = 'claude'

export function clearPendingRemoteFocus(): void {
  focusArming.pendingRemoteFocusWindowId = null
  if (focusArming.pendingRemoteFocusTimer !== null) {
    clearTimeout(focusArming.pendingRemoteFocusTimer)
    focusArming.pendingRemoteFocusTimer = null
  }
  // pendingFocusTarget is intentionally not cleared here — it should remain visible
  // until focus:target-changed arrives with the confirmed target, or the timeout fires.
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

function patchLeafInTabs(tabs: Tab[], paneId: string, patch: Partial<PaneLeaf>): Tab[] | null {
  let changed = false
  const next = tabs.map((tab) => {
    if (!tab.rootNode) return tab
    const rootNode = updateLeaf(tab.rootNode, paneId, patch)
    if (rootNode === tab.rootNode) return tab
    changed = true
    return { ...tab, rootNode }
  })
  return changed ? next : null
}

/**
 * Tear down a single pane's PTY + xterm runtime. Shared by every close path so
 * tab/bulk-close teardown matches the per-pane `closePaneInTab` model (spec 034).
 *
 * Returns:
 *   - killPromise: resolves when pty:kill settles (null when there is no ptyId
 *     or no IPC layer, e.g. in tests). Callers must NOT await this inside a
 *     set() — it is collected and awaited after the state update.
 *   - needsSessionRefresh: true when the pane was an agent with a known
 *     sessionId. The caller batches one `sessions:refresh` per close action
 *     (not per pane) after the kills settle.
 */
function teardownPaneRuntime(pane: PaneLeaf): {
  killPromise: Promise<unknown> | null
  needsSessionRefresh: boolean
} {
  const hasIpc = typeof window !== 'undefined' && !!window.ipc
  const killPromise = pane.ptyId && hasIpc
    ? window.ipc.invoke('pty:kill', pane.ptyId).catch(() => {})
    : null
  xtermRegistry.dispose(pane.id)
  return { killPromise, needsSessionRefresh: pane.paneType === 'agent' && !!pane.sessionId }
}

/**
 * Tear down every leaf of a tab's tree. Returns the kill promises and the OR
 * of `needsSessionRefresh` across all leaves, so the caller can issue a single
 * `sessions:refresh` per close action after the kills settle.
 */
function teardownTabRuntime(tab: Tab): {
  killPromises: Promise<unknown>[]
  needsSessionRefresh: boolean
} {
  if (!tab.rootNode) return { killPromises: [], needsSessionRefresh: false }
  const leaves = collectLeaves(tab.rootNode)
  let needsSessionRefresh = false
  const killPromises: Promise<unknown>[] = []
  for (const leaf of leaves) {
    const result = teardownPaneRuntime(leaf)
    if (result.killPromise) killPromises.push(result.killPromise)
    if (result.needsSessionRefresh) needsSessionRefresh = true
  }
  return { killPromises, needsSessionRefresh }
}

/**
 * After all tab-close kill promises have settled, issue exactly one
 * `sessions:refresh` if any closed pane was an agent with a known session.
 * `sessions:refresh` is a full forced poll — one per close action, not per pane.
 */
function scheduleSessionRefreshAfter(killPromises: Promise<unknown>[], needsSessionRefresh: boolean): void {
  if (!needsSessionRefresh) return
  if (typeof window === 'undefined' || !window.ipc) return
  Promise.allSettled(killPromises).then(() => {
    window.ipc.invoke('sessions:refresh').catch(() => {})
  })
}

export function reportCurrentFocusTarget(): void {
  if (typeof window === 'undefined' || !window.ipc) return
  const store = usePanesStore.getState()
  if (store.windowId === null || !store.activeTabId) return
  const tab = store.tabs.find((t) => t.id === store.activeTabId)
  const paneId = tab?.focusedPaneId ?? ''
  window.ipc.send('focus:target-report', store.activeTabId, paneId)
}

function blurActiveElement(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}

function focusTerminalWhenMounted(paneId: string, attempts = 10): void {
  if (typeof window === 'undefined') return
  blurActiveElement()

  const tryFocus = (remaining: number): void => {
    if (xtermRegistry.focus(paneId)) return
    if (remaining <= 0) {
      blurActiveElement()
      return
    }
    window.requestAnimationFrame(() => tryFocus(remaining - 1))
  }

  window.requestAnimationFrame(() => tryFocus(attempts))
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
    const resumePromise = resumeIntoPane(
      () => usePanesStore.getState(), paneId, agentKind, sessionId, cwd,
      {
        validateFirst: true,
        onSettled: () => {
          if (hydratingPaneSessions[paneId] === sessionId) delete hydratingPaneSessions[paneId]
        },
      },
    )
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

export function isSpawnInTabPayload(value: unknown): value is SpawnInTabPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as SpawnInTabPayload
  return (
    (payload.paneType === 'agent' || payload.paneType === 'shell') &&
    (payload.agentKind === undefined || payload.agentKind === 'claude' || payload.agentKind === 'codex') &&
    typeof payload.cwd === 'string' &&
    (payload.direction === 'vertical' || payload.direction === 'horizontal')
  )
}

function nextDefaultTabLabel(tabs: Tab[]): string {
  const used = new Set(
    tabs
      .map((tab) => tab.customLabel?.trim().toLowerCase())
      .filter((label): label is string => !!label)
  )
  let n = tabs.length + 1
  while (used.has(`tab ${n}`)) n++
  return `Tab ${n}`
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
  addPaneToTab: (pane: PaneLeaf, tabId: string) => boolean
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
  settingsInitialSection: SettingsSection | null
  pendingRenamePaneId: string | null
  dirPickerTabId: string | null
  vsCodeAvailable: boolean
  setVsCodeAvailable: (available: boolean) => void
  cwdGitBranches: Record<string, { status: 'loading' | 'ready'; branch: string | null }>
  requestGitBranch: (cwd: string) => void

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
  setAllTabSidebarSectionsOpen: (open: boolean) => void

  // Pane operations
  focusPane: (paneId: string) => void
  focusPaneInTab: (tabId: string, paneId: string) => void
  focusLocalPaneFromSidebar: (tabId: string, paneId: string) => void
  focusDetachedPaneOptimistically: (windowId: number, tabId: string, paneId?: string) => void
  splitPane: (paneId: string, direction: SplitDirection, paneType?: PaneType, cwdOverride?: string, agentKind?: AgentKind) => Promise<void>
  spawnInTab: (tabId: string, opts: { paneType: PaneType; agentKind?: AgentKind; cwd: string; direction: SplitDirection }) => Promise<void>
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
  openSettings: (section?: SettingsSection) => void
  closeOverlays: () => void
  setPendingRenamePaneId: (id: string | null) => void
  openDirPickerForTab: (tabId: string) => void
  closeDirPicker: () => void

  // Drag state (pane rearrangement)
  draggedPaneId: string | null
  setDraggedPane: (paneId: string | null) => void
  // True while ANY pane drag (including cross-window, where draggedPaneId is null in this
  // renderer) is over this window. Set by document-level drag listeners so the always-mounted
  // sidebar split overlay can enable pointer events without the cross-window bootstrap deadlock.
  paneDragActive: boolean
  movePaneToSplit: (sourcePaneId: string, targetPaneId: string, direction: SplitDirection, sourceBefore: boolean) => void
  swapPanes: (sourcePaneId: string, targetPaneId: string) => void
  swapPanesAcrossTabs: (sourcePaneId: string, targetPaneId: string) => void
  swapDrag: { sourceId: string; targetId: string | null } | null
  startSwapDrag: (sourceId: string) => void
  setSwapDragTarget: (targetId: string | null) => void
  clearSwapDrag: () => void
  movePaneToTab: (sourcePaneId: string, targetTabId: string) => void
  movePaneToNewTab: (paneId: string) => void
  reorderTab: (tabId: string, beforeTabId: string | null) => void
  removePaneById: (paneId: string) => void
  // Return true only if the pane was actually inserted/replaced. Cross-window transfer relies on
  // this: the source pane is removed only after a confirmed insert, so a no-op (self-drop, or a
  // target that vanished mid-drag) must NOT ack — otherwise the source is removed and the pane lost.
  insertPaneAtSplit: (pane: PaneLeaf, targetPaneId: string, direction: SplitDirection, sourceBefore: boolean) => boolean
  replacePaneById: (paneId: string, replacement: PaneLeaf) => boolean

  // Getters
  activeTab: () => Tab | undefined
  getFocusedPane: () => PaneLeaf | undefined
  findPane: (paneId: string) => PaneLeaf | undefined
  findPaneBySessionId: (agentKind: AgentKind, sessionId: string) => PaneLeaf | undefined
}

type PanesGet = () => PanesStore
type PanesSet = (
  partial: Partial<PanesStore> | PanesStore | ((state: PanesStore) => Partial<PanesStore> | PanesStore)
) => void

interface SpawnPaneCoreArgs {
  tabId: string
  basePaneId: string | null
  paneType: PaneType
  agentKind?: AgentKind
  cwd: string
  direction: SplitDirection
}

function findTabContainingPane(tabs: Tab[], paneId: string): { tab: Tab; pane: PaneLeaf } | null {
  for (const tab of tabs) {
    if (!tab.rootNode) continue
    const pane = findLeaf(tab.rootNode, paneId)
    if (pane) return { tab, pane }
  }
  return null
}

function lastLeafInTab(tab: Tab): PaneLeaf | null {
  if (!tab.rootNode) return null
  const leaves = collectLeaves(tab.rootNode)
  return leaves[leaves.length - 1] ?? null
}

function liveBasePaneId(tab: Tab): string | null {
  if (!tab.rootNode || !tab.focusedPaneId) return lastLeafInTab(tab)?.id ?? null
  return findLeaf(tab.rootNode, tab.focusedPaneId)?.id ?? lastLeafInTab(tab)?.id ?? null
}

async function runNewAgentSession(get: PanesGet, paneId: string, agentKind: AgentKind, cwd: string, extraFailurePatch: Partial<PaneLeaf> = {}): Promise<void> {
  if (typeof window === 'undefined' || !window.ipc) return
  try {
    const result = await window.ipc.invoke('session:new', agentKind, cwd)
    const patch: Partial<PaneLeaf> = {
      agentDisconnected: undefined,
      resumeError: undefined,
      sessionDetectionError: undefined,
    }
    if (result?.ptyId) patch.ptyId = result.ptyId
    if (typeof result?.detectionStartedAt === 'number') patch.sessionDetectionStartedAt = result.detectionStartedAt
    if (result?.sessionId) {
      patch.sessionId = result.sessionId
      patch.sessionDetectionState = 'detected'
      patch.sessionDetectionError = undefined
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
      ...extraFailurePatch,
    })
  }
}

async function resumeIntoPane(
  get: PanesGet,
  paneId: string,
  agentKind: AgentKind,
  sessionId: string,
  cwd: string,
  opts: { validateFirst?: boolean; onSettled?: () => void; extraFailurePatch?: Partial<PaneLeaf> } = {},
): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.ipc) return
    if (opts.validateFirst) {
      const validation = await window.ipc.invoke('sessions:validate', agentKind, sessionId, cwd).catch(() => null)
      if (!validation?.found) {
        const current = get().findPaneInAnyTab(paneId)
        if (current?.paneType === 'agent' && current.agentKind === agentKind && current.sessionId === sessionId && !current.ptyId) {
          get().updatePane(paneId, { resumeError: 'Session not found — the transcript may have been deleted' })
        }
        return
      }
    }
    const result = await window.ipc.invoke('session:resume', agentKind, sessionId, cwd)
    const current = get().findPaneInAnyTab(paneId)
    if (current?.paneType === 'agent' && current.agentKind === agentKind && current.sessionId === sessionId && !current.ptyId && result?.ptyId) {
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
      ...opts.extraFailurePatch,
    })
  } finally {
    opts.onSettled?.()
  }
}

async function spawnPaneCore(get: PanesGet, set: PanesSet, args: SpawnPaneCoreArgs): Promise<void> {
  const resolvedAgent = args.paneType === 'agent' ? (args.agentKind ?? DEFAULT_AGENT_KIND) : undefined
  const newLeaf = args.paneType === 'agent'
    ? markSessionDetectionPending(makeLeaf(args.cwd, args.paneType, resolvedAgent))
    : makeLeaf(args.cwd, args.paneType)

  set((s) => {
    let foundTab = false
    const tabs = s.tabs.map((tab) => {
      if (tab.id !== args.tabId) return tab
      foundTab = true
      if (!tab.rootNode) return { ...tab, rootNode: newLeaf, focusedPaneId: newLeaf.id }

      const baseLeaf = args.basePaneId ? findLeaf(tab.rootNode, args.basePaneId) : null
      const fallbackLeaf = baseLeaf ?? lastLeafInTab(tab)
      if (!fallbackLeaf) return { ...tab, rootNode: newLeaf, focusedPaneId: newLeaf.id }

      const split = makeSplit(args.direction, fallbackLeaf, newLeaf)
      return {
        ...tab,
        rootNode: replaceNode(tab.rootNode, fallbackLeaf.id, split),
        focusedPaneId: newLeaf.id,
      }
    })

    if (!foundTab) return s
    return {
      tabs,
      activeTabId: args.tabId,
      hydratedTabIds: markHydrated(s.hydratedTabIds, args.tabId),
      sidebarSectionOpen: {
        ...s.sidebarSectionOpen,
        [tabSidebarSectionId(args.tabId)]: true,
      },
      localFocusArmed: true,
    }
  })

  focusTerminalWhenMounted(newLeaf.id)
  const current = get()
  if (current.isDetachedWindow && current.windowId !== null && typeof window !== 'undefined' && window.ipc) {
    window.ipc.send('pane:focus-changed', current.windowId, args.tabId, newLeaf.id)
  }
  reportCurrentFocusTarget()

  if (args.paneType === 'agent' && resolvedAgent) {
    await runNewAgentSession(get, newLeaf.id, resolvedAgent, args.cwd)
  }
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
    let found = false
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        found = true
        if (!t.rootNode) return { ...t, rootNode: pane, focusedPaneId: pane.id }
        return { ...t, rootNode: makeSplit('vertical', t.rootNode, pane), focusedPaneId: pane.id }
      }),
      hydratedTabIds: s.hydratedTabIds[tabId] ? removeHydratedTabs(s.hydratedTabIds, [tabId]) : s.hydratedTabIds,
    }))
    if (found) hydrateTabRuntime(tabId, true)
    return found
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
  settingsInitialSection: null,
  pendingRenamePaneId: null,
  dirPickerTabId: null,
  vsCodeAvailable: false,
  setVsCodeAvailable: (available: boolean) => set({ vsCodeAvailable: available }),
  cwdGitBranches: {},
  requestGitBranch: (cwd) => {
    if (!cwd || typeof window === 'undefined' || !window.ipc) return
    const key = normalizeCwdKey(cwd)
    if (!get().cwdGitBranches[key]) {
      set((s) => ({
        cwdGitBranches: {
          ...s.cwdGitBranches,
          [key]: { status: 'loading', branch: null },
        },
      }))
    }
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
  paneDragActive: false,
  swapDrag: null,
  pendingRenameTabId: null,
  setPendingRenameTabId: (id) => set({ pendingRenameTabId: id }),

  addTab: (defaultCwd?: string, name?: string) => {
    const customLabel = name?.trim() || nextDefaultTabLabel(get().tabs)
    const tab: Tab = { id: uuid(), focusedPaneId: '', defaultCwd: defaultCwd || undefined, customLabel }
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
    const teardown = tab?.rootNode ? teardownTabRuntime(tab) : { killPromises: [], needsSessionRefresh: false }
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
    scheduleSessionRefreshAfter(teardown.killPromises, teardown.needsSessionRefresh)
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
    set((s) => {
      const trimmed = label.trim()
      if (!trimmed) {
        const tab = s.tabs.find(t => t.id === tabId)
        if (tab && !tab.rootNode) {
          const regen = nextDefaultTabLabel(s.tabs.filter(t => t.id !== tabId))
          return { tabs: s.tabs.map(t => t.id === tabId ? { ...t, customLabel: regen } : t) }
        }
      }
      return {
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, customLabel: trimmed || undefined } : t),
      }
    })
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
    const killPromises: Promise<unknown>[] = []
    let needsSessionRefresh = false
    get().tabs.forEach((t) => {
      if (t.id !== tabId && t.rootNode) {
        const teardown = teardownTabRuntime(t)
        killPromises.push(...teardown.killPromises)
        if (teardown.needsSessionRefresh) needsSessionRefresh = true
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
    scheduleSessionRefreshAfter(killPromises, needsSessionRefresh)
    if (!wasHydrated) hydrateTabRuntime(tabId, true)
  },

  closeTabsToRight: (tabId) => {
    const { tabs } = get()
    const idx = tabs.findIndex((t) => t.id === tabId)
    const previousHydrated = get().hydratedTabIds
    const killPromises: Promise<unknown>[] = []
    let needsSessionRefresh = false
    if (idx !== -1) {
      tabs.slice(idx + 1).forEach((t) => {
        if (!t.rootNode) return
        const teardown = teardownTabRuntime(t)
        killPromises.push(...teardown.killPromises)
        if (teardown.needsSessionRefresh) needsSessionRefresh = true
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
    scheduleSessionRefreshAfter(killPromises, needsSessionRefresh)
    hydrateTabForActivation(get().activeTabId, previousHydrated)
  },

  setSidebarSectionOpen: (sectionId, open) => {
    set((s) => ({ sidebarSectionOpen: { ...s.sidebarSectionOpen, [sectionId]: open } }))
  },

  setAllTabSidebarSectionsOpen: (open) => {
    set((s) => ({
      sidebarSectionOpen: s.tabs.reduce(
        (sections, tab) => ({ ...sections, [tabSidebarSectionId(tab.id)]: open }),
        { ...s.sidebarSectionOpen }
      ),
    }))
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
    focusArming.skipNextActivationDisarm = true
    if (focusArming.skipDisarmClearTimer !== null) clearTimeout(focusArming.skipDisarmClearTimer)
    focusArming.skipDisarmClearTimer = setTimeout(() => {
      focusArming.skipNextActivationDisarm = false
      focusArming.skipDisarmClearTimer = null
    }, SKIP_DISARM_TTL_MS)
    get().focusPaneInTab(tabId, paneId)
  },

  focusDetachedPaneOptimistically: (windowId, tabId, paneId) => {
    focusArming.pendingRemoteFocusWindowId = windowId
    if (focusArming.pendingRemoteFocusTimer !== null) clearTimeout(focusArming.pendingRemoteFocusTimer)
    focusArming.pendingRemoteFocusTimer = setTimeout(() => {
      focusArming.pendingRemoteFocusWindowId = null
      focusArming.pendingRemoteFocusTimer = null
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
    const found = findTabContainingPane(get().tabs, paneId)
    const activeTab = get().activeTab()
    const targetTab = found?.tab ?? activeTab
    if (!targetTab) return
    const existing = found?.pane
    const resolvedType: PaneType = paneType ?? existing?.paneType ?? 'shell'
    const resolvedAgent = resolvedType === 'agent'
      ? (agentKind ?? existing?.agentKind ?? DEFAULT_AGENT_KIND)
      : undefined
    const cwd = cwdOverride ?? existing?.cwd ?? targetTab.defaultCwd ?? 'C:\\'
    await spawnPaneCore(get, set, {
      tabId: targetTab.id,
      basePaneId: found ? paneId : liveBasePaneId(targetTab),
      paneType: resolvedType,
      agentKind: resolvedAgent,
      cwd,
      direction,
    })
  },

  spawnInTab: async (tabId, opts) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    await spawnPaneCore(get, set, {
      tabId,
      basePaneId: liveBasePaneId(tab),
      paneType: opts.paneType,
      agentKind: opts.agentKind,
      cwd: opts.cwd,
      direction: opts.direction,
    })
  },

  closePane: (paneId) => {
    get().closePaneInTab(get().activeTabId, paneId)
  },

  closePaneInTab: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab?.rootNode ? findLeaf(tab.rootNode, paneId) : null
    if (!pane) return
    const teardown = teardownPaneRuntime(pane)
    // Preserve the exact pre-spec behavior: an agent pane whose PTY already
    // exited (no ptyId) still needs its session moved to Recent on close, so
    // schedule the refresh even when there was no kill.
    if (teardown.needsSessionRefresh) {
      scheduleSessionRefreshAfter(
        teardown.killPromise ? [teardown.killPromise] : [],
        true,
      )
    }
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
    set((s) => {
      const tabs = patchLeafInTabs(s.tabs, paneId, {
        ptyId,
        agentDisconnected: undefined,
        resumeError: undefined,
      })
      return tabs ? { tabs } : s
    })
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
    set((s) => {
      const tabs = patchLeafInTabs(s.tabs, paneId, { customName: name.trim() || undefined })
      return tabs ? { tabs } : s
    })
  },

  setSessionId: (paneId, sessionId) => {
    // Search all tabs — the active tab may have changed by the time the IPC call returns.
    set((s) => {
      const tabs = patchLeafInTabs(s.tabs, paneId, {
        sessionId,
        sessionDetectionState: 'detected',
        sessionDetectionError: undefined,
        resumeError: undefined,
      })
      return tabs ? { tabs } : s
    })
  },

  updatePane: (paneId, patch) => {
    set((s) => {
      const tabs = patchLeafInTabs(s.tabs, paneId, patch)
      return tabs ? { tabs } : s
    })
  },

  markPtyExited: (ptyId, exitCode, signal) => {
    let shouldRefreshSessions = false
    const disconnected = { exitCode, signal, at: Date.now() }
    set((s) => {
      let changed = false
      const tabs = s.tabs.map((t) => {
        if (!t.rootNode) return t
        const result = markLeafExitedByPtyId(t.rootNode, ptyId, disconnected)
        if (!result.exitedLeaf) return t
        changed = true
        shouldRefreshSessions ||= !!result.exitedLeaf.sessionId
        return { ...t, rootNode: result.node }
      })
      return changed ? { tabs } : s
    })
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
        const root = updateCwdsInTree(tab.rootNode, mapping, replaceCwdPrefix)
        if (!defaultChanged && !root.changed) return tab
        changed = true
        return { ...tab, defaultCwd, rootNode: root.node }
      })
      return changed ? { tabs } : s
    })
  },

  resumeSession: async (agentKind, sessionId, cwd) => {
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
    await resumeIntoPane(get, leaf.id, agentKind, sessionId, cwd, {
      onSettled: () => { if (targetTabId) markTabHydrated(targetTabId) },
    })
  },

  resumeSessionInNewTab: async (agentKind, sessionId, cwd) => {
    const leaf = makeLeaf(cwd, 'agent', agentKind)
    leaf.sessionId = sessionId
    const tab: Tab = { id: uuid(), rootNode: leaf, focusedPaneId: leaf.id }
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [tab.id]),
      sidebarSectionOpen: { ...s.sidebarSectionOpen, [tabSidebarSectionId(tab.id)]: true },
    }))
    await resumeIntoPane(get, leaf.id, agentKind, sessionId, cwd, { onSettled: () => markTabHydrated(tab.id) })
  },

  resumeAgentPane: async (paneId) => {
    const pane = get().findPaneInAnyTab(paneId)
    if (!pane || pane.paneType !== 'agent' || !pane.agentKind) return
    if (!pane.sessionId) {
      get().updatePane(paneId, { resumeError: 'No session id is available for this pane' })
      return
    }
    const { agentKind, sessionId, cwd } = pane
    get().updatePane(paneId, {
      ptyId: undefined,
      agentDisconnected: undefined,
      resumeError: undefined,
      sessionDetectionError: undefined,
    })
    await resumeIntoPane(get, paneId, agentKind, sessionId, cwd, {
      extraFailurePatch: { agentDisconnected: pane.agentDisconnected },
    })
  },

  startNewAgentInPane: async (paneId) => {
    const pane = get().findPaneInAnyTab(paneId)
    if (!pane || pane.paneType !== 'agent' || !pane.agentKind) return
    const { agentKind, cwd } = pane
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
    await runNewAgentSession(get, paneId, agentKind, cwd, { agentDisconnected: pane.agentDisconnected })
  },

  newSession: async (cwd, direction = 'vertical', agentKind) => {
    let tabId = get().activeTabId
    if (get().tabs.length === 0) {
      const tab: Tab = { id: uuid(), focusedPaneId: '' }
      tabId = tab.id
      set({ tabs: [tab], activeTabId: tab.id })
    }
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    await spawnPaneCore(get, set, {
      tabId,
      basePaneId: liveBasePaneId(tab),
      paneType: 'agent',
      agentKind: agentKind ?? DEFAULT_AGENT_KIND,
      cwd,
      direction,
    })
  },

  addShellPane: async (cwd, direction = 'vertical') => {
    let tabId = get().activeTabId
    if (get().tabs.length === 0) {
      const tab: Tab = { id: uuid(), focusedPaneId: '' }
      tabId = tab.id
      set({ tabs: [tab], activeTabId: tab.id })
    }
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    await spawnPaneCore(get, set, {
      tabId,
      basePaneId: liveBasePaneId(tab),
      paneType: 'shell',
      cwd,
      direction,
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
              migrated.agentKind !== undefined &&
              typeof migrated.sessionDetectionStartedAt === 'number'

            if (isRecoverablePending && typeof window !== 'undefined' && window.ipc) {
              const agentKind = migrated.agentKind
              const startedAt = migrated.sessionDetectionStartedAt
              if (!agentKind || startedAt === undefined) return migrated
              const recovered = await window.ipc.invoke(
                'sessions:recover-pending',
                agentKind,
                migrated.sessionDetectionCwd ?? migrated.cwd,
                startedAt,
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
  startSwapDrag: (sourceId) => set({ swapDrag: { sourceId, targetId: null } }),
  setSwapDragTarget: (targetId) =>
    set((s) => (s.swapDrag ? { swapDrag: { ...s.swapDrag, targetId } } : s)),
  clearSwapDrag: () => set({ swapDrag: null }),

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
        // Clear after the drop has already been consumed — safe here, cannot cancel the operation.
        draggedPaneId: null,
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
        // Clear after the drop has already been consumed — safe here, cannot cancel the operation.
        draggedPaneId: null,
        sidebarSectionOpen: {
          ...s.sidebarSectionOpen,
          [tabSidebarSectionId(targetTabId)]: true,
        },
      }
    })
    if (moved && activatedTabId) hydrateTabRuntime(activatedTabId, true)
  },

  swapPanes: (sourcePaneId, targetPaneId) => {
    if (sourcePaneId === targetPaneId) return
    set((s) => {
      const tabIdx = s.tabs.findIndex(
        (t) => t.rootNode && findLeaf(t.rootNode, sourcePaneId) && findLeaf(t.rootNode, targetPaneId)
      )
      if (tabIdx === -1) return s
      const root = s.tabs[tabIdx].rootNode!

      // Exchange the two panes' positions. The split structure (ids/directions/ratios) is
      // frozen and every other pane stays exactly where it is at the same size; only these
      // two leaves trade slots. Each leaf keeps its id/ptyId/sessionId so PTYs follow.
      const sourceLeaf = findLeaf(root, sourcePaneId)
      const targetLeaf = findLeaf(root, targetPaneId)
      if (!sourceLeaf || !targetLeaf) return s

      const newRoot = swapLeaves(root, sourcePaneId, targetPaneId, sourceLeaf, targetLeaf)
      const updatedTabs = s.tabs.map((t, i) =>
        i === tabIdx ? { ...t, rootNode: newRoot, focusedPaneId: sourcePaneId } : t
      )
      return { ...s, tabs: updatedTabs, draggedPaneId: null }
    })
  },

  swapPanesAcrossTabs: (sourcePaneId, targetPaneId) => {
    if (sourcePaneId === targetPaneId) return
    set((s) => {
      let sourceTabIdx = -1
      let sourceLeaf: PaneLeaf | null = null
      let targetTabIdx = -1
      let targetLeaf: PaneLeaf | null = null
      for (let i = 0; i < s.tabs.length; i++) {
        const root = s.tabs[i].rootNode
        if (!root) continue
        if (!sourceLeaf) {
          const leaf = findLeaf(root, sourcePaneId)
          if (leaf) { sourceTabIdx = i; sourceLeaf = leaf }
        }
        if (!targetLeaf) {
          const leaf = findLeaf(root, targetPaneId)
          if (leaf) { targetTabIdx = i; targetLeaf = leaf }
        }
        if (sourceLeaf && targetLeaf) break
      }
      if (sourceTabIdx === -1 || targetTabIdx === -1 || !sourceLeaf || !targetLeaf) return s

      if (sourceTabIdx === targetTabIdx) {
        const root = s.tabs[sourceTabIdx].rootNode!
        const newRoot = swapLeaves(root, sourcePaneId, targetPaneId, sourceLeaf, targetLeaf)
        return { ...s, tabs: s.tabs.map((t, i) =>
          i === sourceTabIdx ? { ...t, rootNode: newRoot, focusedPaneId: sourcePaneId } : t
        ), draggedPaneId: null }
      }

      // Replace source leaf's slot with target leaf, and target leaf's slot with source leaf.
      // replaceNode matches by node id, so each leaf's own id is used as the replacement key.
      const newSourceRoot = replaceNode(s.tabs[sourceTabIdx].rootNode!, sourcePaneId, targetLeaf)
      const newTargetRoot = replaceNode(s.tabs[targetTabIdx].rootNode!, targetPaneId, sourceLeaf)

      const updatedTabs = s.tabs.map((t, i) => {
        if (i === sourceTabIdx) {
          const newFocus = t.focusedPaneId === sourcePaneId ? targetLeaf!.id : t.focusedPaneId
          return { ...t, rootNode: newSourceRoot, focusedPaneId: newFocus }
        }
        if (i === targetTabIdx) {
          const newFocus = t.focusedPaneId === targetPaneId ? sourceLeaf!.id : t.focusedPaneId
          return { ...t, rootNode: newTargetRoot, focusedPaneId: newFocus }
        }
        return t
      })
      return { ...s, tabs: updatedTabs, draggedPaneId: null }
    })
  },

  reorderTab: (tabId, beforeTabId) => {
    if (tabId === beforeTabId) return
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === tabId)
      if (from === -1) return s
      const next = [...s.tabs]
      const [moved] = next.splice(from, 1)
      if (beforeTabId === null) {
        // Insert after the last local (non-detached) tab, not at absolute end —
        // otherwise a local tab could land after detached entries in the array.
        const lastLocalIdx = next.reduce((last, t, i) => (!t.detached ? i : last), -1)
        next.splice(lastLocalIdx + 1, 0, moved)
      } else {
        const toIdx = next.findIndex((t) => t.id === beforeTabId)
        next.splice(toIdx === -1 ? next.length : toIdx, 0, moved)
      }
      return { tabs: next }
    })
  },

  removePaneById: (paneId) => {
    // Move-not-close: detach the leaf from its tab tree without killing the PTY or xterm.
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

  insertPaneAtSplit: (pane, targetPaneId, direction, sourceBefore) => {
    if (pane.id === targetPaneId) return false  // defensive: never split a pane against itself
    let activatedTabId = ''
    set((s) => {
      let targetTabIdx = -1
      for (let i = 0; i < s.tabs.length; i++) {
        if (s.tabs[i].rootNode && findLeaf(s.tabs[i].rootNode!, targetPaneId)) {
          targetTabIdx = i; break
        }
      }
      if (targetTabIdx === -1) return s
      const updatedTabs = s.tabs.map((tab, idx) => {
        if (idx !== targetTabIdx || !tab.rootNode) return tab
        const targetLeaf = findLeaf(tab.rootNode, targetPaneId)
        if (!targetLeaf) return tab
        const newSplit = sourceBefore
          ? makeSplit(direction, pane, targetLeaf)
          : makeSplit(direction, targetLeaf, pane)
        return {
          ...tab,
          rootNode: replaceNode(tab.rootNode, targetPaneId, newSplit),
          focusedPaneId: pane.id,
        }
      })
      activatedTabId = s.tabs[targetTabIdx].id
      return {
        tabs: updatedTabs,
        activeTabId: activatedTabId,
        hydratedTabIds: removeHydratedTabs(s.hydratedTabIds, [activatedTabId]),
        sidebarSectionOpen: {
          ...s.sidebarSectionOpen,
          [tabSidebarSectionId(activatedTabId)]: true,
        },
        localFocusArmed: true,
      }
    })
    if (activatedTabId) hydrateTabRuntime(activatedTabId, true)
    return activatedTabId !== ''
  },

  replacePaneById: (paneId, replacement) => {
    let found = false
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (!t.rootNode || !findLeaf(t.rootNode, paneId)) return t
        found = true
        const newRoot = replaceNode(t.rootNode, paneId, replacement)
        return {
          ...t,
          rootNode: newRoot,
          focusedPaneId: t.focusedPaneId === paneId ? replacement.id : t.focusedPaneId,
        }
      }),
    }))
    return found
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setSidebarPanelSize: (panelId, size) => set((s) => ({ sidebarPanelSizes: { ...s.sidebarPanelSizes, [panelId]: size } })),
  toggleSessionBrowser: () => set((s) => ({ sessionBrowserOpen: !s.sessionBrowserOpen, commandPaletteOpen: false, settingsOpen: false })),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen, sessionBrowserOpen: false, settingsOpen: false })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, sessionBrowserOpen: false, commandPaletteOpen: false })),
  openSettings: (section) => set({ settingsOpen: true, settingsInitialSection: section ?? null, sessionBrowserOpen: false, commandPaletteOpen: false }),
  closeOverlays: () => set({ sessionBrowserOpen: false, commandPaletteOpen: false, settingsOpen: false }),
  setPendingRenamePaneId: (id) => set({ pendingRenamePaneId: id }),
  openDirPickerForTab: (tabId) => set({ dirPickerTabId: tabId }),
  closeDirPicker: () => set({ dirPickerTabId: null }),

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

wirePanesIpc()

