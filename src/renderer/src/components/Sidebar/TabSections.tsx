import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PaneLeaf, Session, SpawnInTabPayload, SplitDirection, Tab } from '../../../../shared/types'
import { isTabVisibleInCurrentWindow, tabSidebarSectionId, usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { SidebarSection } from './SidebarSection'
import { computeLabels, paneLabelText } from '../../utils/tabLabels'
import { collectLeaves } from '../../../../shared/paneTree'
import { displayGitBranch } from '../../utils/git'
import { decodePaneDragPayload, paneDragSourceId, PANE_DRAG_MIME, setPaneDragData, type PaneDragPayload } from '../../utils/paneDrag'
import { decodeTabDragPayload, setTabDragData, TAB_DRAG_MIME, type TabDragPayload } from '../../utils/tabDrag'
import { DirPicker } from '../DirPicker'
import { SpawnChoiceMenu, spawnChoiceLabel, type SpawnChoice } from '../SpawnChoiceMenu'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import { useJiraStore } from '../../store/jira'
import { border, menuStyles, sidebarStyles, ui } from '../../styles/theme'
import { AgentIcon, ShellIcon } from '../AgentIcon'
import { isAgentPaneDisconnected, StatusDot } from '../PaneHeader/StatusDot'
import closeIcon from '../../assets/close.png'
import threeDotIcon from '../../assets/threedot.png'
import addBoxIcon from '../../assets/addbox.png'
import { PaneSplitDropTarget } from '../PaneGrid/PaneSplitDropTarget'
import { JiraStatusBadge } from './JiraStatusBadge'

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')
const TAB_REORDER_MIME = 'application/x-multiagent-tab-reorder'

export function TabSections(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const isDetachedWindow = usePanesStore((s) => s.isDetachedWindow)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const sidebarSectionOpen = usePanesStore((s) => s.sidebarSectionOpen)
  const sessions = useSessionsStore((s) => s.sessions)
  const closeTab = usePanesStore((s) => s.closeTab)
  const renameTab = usePanesStore((s) => s.renameTab)
  const setTabDefaultCwd = usePanesStore((s) => s.setTabDefaultCwd)
  const setSidebarSectionOpen = usePanesStore((s) => s.setSidebarSectionOpen)
  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const movePaneToTab = usePanesStore((s) => s.movePaneToTab)
  const windowId = usePanesStore((s) => s.windowId)
  const activeWindowId = usePanesStore((s) => s.activeWindowId)
  const pendingFocusTarget = usePanesStore((s) => s.pendingFocusTarget)
  const localFocusArmed = usePanesStore((s) => s.localFocusArmed)
  const focusLocalPaneFromSidebar = usePanesStore((s) => s.focusLocalPaneFromSidebar)
  const spawnInTab = usePanesStore((s) => s.spawnInTab)
  const moveTabToNewWindow = usePanesStore((s) => s.moveTabToNewWindow)
  // Which window is effectively active: pending remote click wins, otherwise OS focus.
  // Only one window shows a highlighted pane at a time — confirmedFocusTarget is
  // intentionally excluded so that OS focus changes immediately de-highlight the old window.
  const effectiveActiveWindowId = pendingFocusTarget?.windowId ?? activeWindowId
  const localWindowActive = effectiveActiveWindowId === null || effectiveActiveWindowId === windowId
  const reorderTab = usePanesStore((s) => s.reorderTab)
  const pendingRenameTabId = usePanesStore((s) => s.pendingRenameTabId)
  const setPendingRenameTabId = usePanesStore((s) => s.setPendingRenameTabId)
  const jiraRows = useJiraStore((s) => s.rows)
  const jiraProjects = useJiraStore((s) => s.projects)
  const refreshJiraTab = useJiraStore((s) => s.refreshTab)
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => isTabVisibleInCurrentWindow(isDetachedWindow, tab)),
    [tabs, isDetachedWindow],
  )

  const tabLabels = useMemo(() => computeLabels(visibleTabs, sessions), [visibleTabs, sessions])
  const leavesByTab = useMemo(
    () => new Map(visibleTabs.map((tab) => [tab.id, tab.rootNode ? collectLeaves(tab.rootNode) : []])),
    [visibleTabs],
  )

  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dirPickerTabId, setDirPickerTabId] = useState<string | null>(null)
  const [spawnMenu, setSpawnMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dirPickerSpawn, setDirPickerSpawn] = useState<{ tabId: string; choice: SpawnChoice; direction: SplitDirection } | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dropTabId, setDropTabId] = useState<string | null>(null)
  const [tabDropTabId, setTabDropTabId] = useState<string | null>(null)
  // undefined = no reorder drag; null = insert at end; string = insert before that tab id
  const [reorderInsertBeforeId, setReorderInsertBeforeId] = useState<string | null | undefined>(undefined)
  const draggedTabRef = useRef<Tab | null>(null)
  const tabDragHandledRef = useRef(false)
  const windowBoundsRef = useRef<Array<{ id: number; x: number; y: number; width: number; height: number }>>([])
  const tabDragCleanupRef = useRef<(() => void) | null>(null)
  const dragFocusWindowRef = useRef<number | null>(null)

  const dirPickerTab = dirPickerTabId ? visibleTabs.find((t) => t.id === dirPickerTabId) : null
  const spawnMenuTab = spawnMenu ? visibleTabs.find((t) => t.id === spawnMenu.tabId) : null
  const dirPickerSpawnTab = dirPickerSpawn ? visibleTabs.find((t) => t.id === dirPickerSpawn.tabId) : null

  function startRename(tabId: string) {
    setRenameValue(tabLabels.get(tabId) ?? '')
    setRenamingTabId(tabId)
  }

  function commitRename() {
    if (renamingTabId) renameTab(renamingTabId, renameValue)
    setRenamingTabId(null)
  }

  function transferPaneToTab(payload: PaneDragPayload, targetTabId: string, targetWindowId: number): void {
    if (payload.sourceWindowId === targetWindowId) {
      if (payload.sourceWindowId === windowId) {
        movePaneToTab(payload.pane.id, targetTabId)
      } else {
        window.ipc?.invoke('pane:transfer', { ...payload, targetTabId, targetWindowId }).catch(console.error)
      }
      return
    }
    window.ipc?.invoke('pane:transfer', { ...payload, targetTabId, targetWindowId }).catch(console.error)
  }

  function tabPayloadFromEvent(event: React.DragEvent): TabDragPayload | null {
    if (!event.dataTransfer.types.includes(TAB_DRAG_MIME)) return null
    return decodeTabDragPayload(event.dataTransfer)
  }

  function isLocalTabDrag(payload: TabDragPayload): boolean {
    return payload.sourceWindowId === (windowId ?? -1)
  }

  function focusWindowForTabDrag(payload: TabDragPayload | null): void {
    if (!payload || payload.sourceWindowId < 0 || isLocalTabDrag(payload) || windowId === null || dragFocusWindowRef.current === windowId) return
    dragFocusWindowRef.current = windowId
    void window.ipc?.invoke('window:focus').catch(() => {
      if (dragFocusWindowRef.current === windowId) dragFocusWindowRef.current = null
    })
  }

  function dropIndexForInsertion(insertBeforeId = reorderInsertBeforeId): number {
    if (insertBeforeId === null || insertBeforeId === undefined) return visibleTabs.length
    const index = visibleTabs.findIndex((tab) => tab.id === insertBeforeId)
    return index >= 0 ? index : visibleTabs.length
  }

  function insertionBeforeForHeader(event: React.DragEvent, tabId: string, tabIdx: number): string | null {
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientY - rect.top < rect.height / 2) return tabId
    return visibleTabs[tabIdx + 1]?.id ?? null
  }

  function insertionBeforeForContainer(event: React.DragEvent): string | null {
    const sections = Array.from(event.currentTarget.children) as HTMLElement[]
    for (let index = 0; index < visibleTabs.length; index += 1) {
      const section = sections[index]
      if (!section) continue
      if (event.clientY < section.getBoundingClientRect().top) return visibleTabs[index].id
    }
    return null
  }

  function absorbTab(payload: TabDragPayload, dropIndex: number): void {
    if (windowId === null || payload.sourceWindowId === windowId || payload.sourceWindowId < 0) return
    tabDragHandledRef.current = true
    void window.ipc?.invoke(
      'tab:absorb',
      JSON.stringify(payload.tab),
      payload.ptyIds,
      payload.sourceWindowId,
      dropIndex,
    ).catch(console.error)
  }

  function handleTabDragEnd(event: React.DragEvent): void {
    const tab = draggedTabRef.current
    // Do not use dropEffect as the completion signal: native drag-and-drop may
    // reset it when the pointer leaves every drop target. The pointer's screen
    // position distinguishes a window drop from a tear-off; tabDragHandledRef
    // covers drops whose destination explicitly handled them.
    const handled = tabDragHandledRef.current
    tabDragCleanupRef.current?.()
    tabDragCleanupRef.current = null
    draggedTabRef.current = null
    tabDragHandledRef.current = false
    setReorderInsertBeforeId(undefined)
    setTabDropTabId(null)
    if (!tab || handled) return

    const x = event.screenX
    const y = event.screenY
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const insideKnownWindow = windowBoundsRef.current.some((bounds) =>
      x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height,
    )
    if (insideKnownWindow) return
    // The existing tear-off protocol retains the source tab until detached-ready
    // commits adoption and routing. Passing screen coordinates makes the new
    // window open where the browser-like drag ended.
    moveTabToNewWindow(tab.id, Number.isFinite(x) ? x : undefined, Number.isFinite(y) ? y : undefined)
  }

  function projectCwd(tab: Tab): string {
    if (tab.defaultCwd) return tab.defaultCwd
    if (!tab.rootNode) return DEFAULT_CWD
    const leaves = collectLeaves(tab.rootNode)
    const focused = leaves.find((pane) => pane.id === tab.focusedPaneId)
    return focused?.cwd ?? leaves[leaves.length - 1]?.cwd ?? DEFAULT_CWD
  }

  function spawnInProject(tab: Tab, payload: SpawnInTabPayload): void {
    if (tab.detached) {
      window.ipc?.invoke('tab:spawn-in-project', tab.id, payload).catch(console.error)
      return
    }
    void spawnInTab(tab.id, payload)
  }

  useEffect(() => {
    if (pendingRenameTabId && visibleTabs.some((t) => t.id === pendingRenameTabId)) {
      startRename(pendingRenameTabId)
      setPendingRenameTabId(null)
    }
  }, [pendingRenameTabId, visibleTabs, startRename, setPendingRenameTabId])

  return (
    <>
      {/* Container catches TAB_REORDER_MIME drops that land on section content or gaps,
          using the last insertion position set by onHeaderDragOver. */}
      <div
        data-sidebar-tab-container="true"
        // Keep the trailing part of the scroll area as a real append target.
        style={{ minHeight: '100%' }}
        onDragEnter={(e) => {
          // Drag-enter/over bubbles from section children. Only the empty
          // trailing area should reset the insertion point to append.
          if (e.target !== e.currentTarget) return
          const payload = tabPayloadFromEvent(e)
          if (payload) {
            e.preventDefault()
            focusWindowForTabDrag(payload)
            e.dataTransfer.dropEffect = 'move'
            // Background gaps resolve to the next section; only the space
            // below the last section resolves to append.
            setReorderInsertBeforeId(insertionBeforeForContainer(e))
            setTabDropTabId(null)
          } else if (e.dataTransfer.types.includes(TAB_DRAG_MIME) || e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setReorderInsertBeforeId(insertionBeforeForContainer(e))
            setTabDropTabId(null)
          }
        }}
        onDragOver={(e) => {
          if (e.target !== e.currentTarget) return
          const payload = tabPayloadFromEvent(e)
          if (payload) {
            e.preventDefault()
            focusWindowForTabDrag(payload)
            e.dataTransfer.dropEffect = 'move'
            // Background gaps resolve to the next section; only the space
            // below the last section resolves to append.
            setReorderInsertBeforeId(insertionBeforeForContainer(e))
            setTabDropTabId(null)
          } else if (e.dataTransfer.types.includes(TAB_DRAG_MIME) || e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setReorderInsertBeforeId(insertionBeforeForContainer(e))
            setTabDropTabId(null)
          }
        }}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return
          const insertBeforeId = insertionBeforeForContainer(e)
          const payload = tabPayloadFromEvent(e)
          if (payload) {
            e.preventDefault()
            e.stopPropagation()
            tabDragHandledRef.current = true
            if (isLocalTabDrag(payload)) {
              reorderTab(payload.tab.id, insertBeforeId)
            } else {
              absorbTab(payload, dropIndexForInsertion(insertBeforeId))
            }
            setReorderInsertBeforeId(undefined)
            setTabDropTabId(null)
            return
          }
          if (!e.dataTransfer.types.includes(TAB_REORDER_MIME)) return
          e.preventDefault()
          e.stopPropagation()
          tabDragHandledRef.current = true
          try {
            const { tabId: sourceTabId } = JSON.parse(e.dataTransfer.getData(TAB_REORDER_MIME)) as { tabId: string }
            reorderTab(sourceTabId, insertBeforeId)
          } catch {}
          setReorderInsertBeforeId(undefined)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setReorderInsertBeforeId(undefined)
            dragFocusWindowRef.current = null
          }
        }}
      >
      {visibleTabs.map((tab) => {
        const label = tabLabels.get(tab.id) ?? 'Tab'
        const leaves = leavesByTab.get(tab.id) ?? []
        const isActive = tab.id === activeTabId
        const isRenaming = renamingTabId === tab.id
        const sectionId = tabSidebarSectionId(tab.id)
        const open = sidebarSectionOpen[sectionId] ?? sidebarSectionOpen[tab.id] ?? isActive
        const tabIdx = visibleTabs.findIndex((candidate) => candidate.id === tab.id)

        return (
          <SidebarSection
            key={tab.id}
            title={label}
            count={leaves.length > 1 ? leaves.length : undefined}
            open={open}
            onOpenChange={(next) => setSidebarSectionOpen(sectionId, next)}
            onTitleClick={() => setActiveTab(tab.id)}
            onTitleDoubleClick={() => startRename(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
            }}
            renaming={isRenaming}
            renameValue={isRenaming ? renameValue : undefined}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingTabId(null)}
            titleSuffix={jiraRows[tab.id] && <JiraStatusBadge row={jiraRows[tab.id]} />}
            headerDraggable={!isRenaming}
            onHeaderDragStart={(e) => {
              e.dataTransfer.setData(TAB_REORDER_MIME, JSON.stringify({ tabId: tab.id }))
              const ptyIds = leaves
                .map((leaf) => leaf.ptyId)
                .filter((ptyId): ptyId is string => typeof ptyId === 'string')
              setTabDragData(e.dataTransfer, { tab, ptyIds, sourceWindowId: windowId ?? -1 })
              tabDragCleanupRef.current?.()
              draggedTabRef.current = tab
              tabDragHandledRef.current = false
              const cleanup = (): void => {
                window.removeEventListener('drop', cleanup, true)
                window.removeEventListener('dragend', cleanup, true)
              }
              tabDragCleanupRef.current = cleanup
              window.addEventListener('drop', cleanup, true)
              window.addEventListener('dragend', cleanup, true)
              void window.ipc?.invoke('window:get-all-bounds').then((bounds) => {
                if (Array.isArray(bounds)) windowBoundsRef.current = bounds as Array<{ id: number; x: number; y: number; width: number; height: number }>
              }).catch(() => {})
            }}
            onHeaderDragEnd={handleTabDragEnd}
            headerActions={
              <SidebarHoverActions
                menuTitle="Tab menu"
                closeTitle="Close tab"
                onMenu={(e) => setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })}
                onClose={() => closeTab(tab.id)}
              />
            }
            headerActionsAlways={
              <ProjectSpawnButton
                onClick={(e) => setSpawnMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })}
              />
            }
            headerDropActive={dropTabId === tab.id || tabDropTabId === tab.id}
            headerInsertTop={reorderInsertBeforeId !== undefined && reorderInsertBeforeId === tab.id}
            sectionInsertBottom={reorderInsertBeforeId !== undefined && reorderInsertBeforeId === (visibleTabs[tabIdx + 1]?.id ?? null)}
            onSectionDragOver={(e) => {
              // Header drag-over owns the precise before/after split. The
              // section body is the broad target for the tab represented by
              // this section, so dropping in tab 1's panes means after tab 1.
              const tabPayload = tabPayloadFromEvent(e)
              const isTabDrag = Boolean(tabPayload) || e.dataTransfer.types.includes(TAB_REORDER_MIME)
              if (!isTabDrag) return
              e.preventDefault()
              e.stopPropagation()
              if (tabPayload) focusWindowForTabDrag(tabPayload)
              setReorderInsertBeforeId(visibleTabs[tabIdx + 1]?.id ?? null)
              if (tabPayload && !isLocalTabDrag(tabPayload)) setTabDropTabId(tab.id)
              e.dataTransfer.dropEffect = 'move'
            }}
            onSectionDrop={(e) => {
              const tabPayload = tabPayloadFromEvent(e)
              const insertBeforeId = visibleTabs[tabIdx + 1]?.id ?? null
              if (tabPayload) {
                e.preventDefault()
                e.stopPropagation()
                tabDragHandledRef.current = true
                if (isLocalTabDrag(tabPayload)) {
                  reorderTab(tabPayload.tab.id, insertBeforeId)
                } else {
                  absorbTab(tabPayload, dropIndexForInsertion(insertBeforeId))
                }
                setReorderInsertBeforeId(undefined)
                setTabDropTabId(null)
                return
              }
              if (!e.dataTransfer.types.includes(TAB_REORDER_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              tabDragHandledRef.current = true
              try {
                const { tabId: sourceTabId } = JSON.parse(e.dataTransfer.getData(TAB_REORDER_MIME)) as { tabId: string }
                reorderTab(sourceTabId, insertBeforeId)
              } catch {}
              setReorderInsertBeforeId(undefined)
            }}
            onHeaderDragOver={(e) => {
              const tabPayload = tabPayloadFromEvent(e)
              if (tabPayload && !isLocalTabDrag(tabPayload)) {
                e.preventDefault()
                e.stopPropagation()
                focusWindowForTabDrag(tabPayload)
                const rect = e.currentTarget.getBoundingClientRect()
                setTabDropTabId(tab.id)
                setReorderInsertBeforeId(e.clientY - rect.top < rect.height / 2 ? tab.id : (visibleTabs[tabIdx + 1]?.id ?? null))
                e.dataTransfer.dropEffect = 'move'
                return
              }
              // Project reorder — MIME-type check prevents collision with pane drops
              if (e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                if (e.clientY - rect.top < rect.height / 2) {
                  setReorderInsertBeforeId(tab.id)
                } else {
                    setReorderInsertBeforeId(visibleTabs[tabIdx + 1]?.id ?? null)
                }
                e.dataTransfer.dropEffect = 'move'
                return
              }
              // Pane drop
              if (!draggedPaneId && !e.dataTransfer.types.includes(PANE_DRAG_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              setDropTabId(tab.id)
            }}
            onHeaderDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropTabId(null)
                setTabDropTabId(null)
                dragFocusWindowRef.current = null
              }
            }}
            onHeaderDrop={(e) => {
              const tabPayload = tabPayloadFromEvent(e)
              if (tabPayload) {
                e.preventDefault()
                e.stopPropagation()
                tabDragHandledRef.current = true
                if (isLocalTabDrag(tabPayload)) {
                  reorderTab(tabPayload.tab.id, insertionBeforeForHeader(e, tab.id, tabIdx))
                } else {
                  absorbTab(tabPayload, dropIndexForInsertion(insertionBeforeForHeader(e, tab.id, tabIdx)))
                }
                setReorderInsertBeforeId(undefined)
                setTabDropTabId(null)
                return
              }
              // Project reorder
              if (e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
                e.preventDefault()
                e.stopPropagation()
                tabDragHandledRef.current = true
                try {
                  const { tabId: sourceTabId } = JSON.parse(e.dataTransfer.getData(TAB_REORDER_MIME)) as { tabId: string }
                  reorderTab(sourceTabId, insertionBeforeForHeader(e, tab.id, tabIdx))
                } catch {}
                setReorderInsertBeforeId(undefined)
                return
              }
              // Pane drop
              const payload = decodePaneDragPayload(e.dataTransfer)
              if (!draggedPaneId && !payload) return
              e.preventDefault()
              e.stopPropagation()
              if (payload && windowId !== null) {
                transferPaneToTab(payload, tab.id, windowId)
              } else if (draggedPaneId) {
                movePaneToTab(draggedPaneId, tab.id)
              }
              setDropTabId(null)
            }}
          >
            {leaves.map((pane) => (
              <PaneRow
                key={pane.id}
                pane={pane}
                tab={tab}
                sourceWindowId={windowId ?? undefined}
                isFocused={localWindowActive && localFocusArmed && isActive && pane.id === tab.focusedPaneId}
                isOnlyPane={leaves.length <= 1}
                sessions={sessions}
                onMouseDownOverride={() => focusLocalPaneFromSidebar(tab.id, pane.id)}
                onClickOverride={() => focusLocalPaneFromSidebar(tab.id, pane.id)}
              />
            ))}
          </SidebarSection>
        )
      })}
      </div>

      {tabMenu && (
        <TabContextMenu
          tabId={tabMenu.tabId}
          tabs={visibleTabs}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          onRename={(id) => { startRename(id); setTabMenu(null) }}
          onCloseTab={(id) => { closeTab(id); setTabMenu(null) }}
          onChangeDefaultDir={(id) => { setDirPickerTabId(id); setTabMenu(null) }}
          isDetachedWindow={isDetachedWindow}
          onMoveToNewWindow={(id) => { void moveTabToNewWindow(id); setTabMenu(null) }}
          onReturnToMain={(id) => {
            window.ipc?.invoke('tab:reattach-home', id).catch(console.error)
            setTabMenu(null)
          }}
          jiraMatch={jiraProjects[tabMenu.tabId] !== undefined}
          onRefreshJiraStatus={() => { void refreshJiraTab(tabMenu.tabId) }}
        />
      )}

      {dirPickerTabId && (
        <DirPicker
          title="Change project directory"
          description="New sessions and shells in this tab will start here by default."
          initial={dirPickerTab?.defaultCwd ?? ''}
          confirmLabel="Change"
          skipLabel="Cancel"
          validateDirectory
          onConfirm={(dir) => { setTabDefaultCwd(dirPickerTabId, dir); setDirPickerTabId(null) }}
          onSkip={() => setDirPickerTabId(null)}
        />
      )}

      {spawnMenu && spawnMenuTab && (
        <SpawnChoiceMenu
          x={spawnMenu.x}
          y={spawnMenu.y}
          currentDirLabel="In project directory"
          onClose={() => setSpawnMenu(null)}
          onSpawn={(choice, direction) => {
            spawnInProject(spawnMenuTab, { ...choice, cwd: projectCwd(spawnMenuTab), direction })
            setSpawnMenu(null)
          }}
          onBrowse={(choice, direction) => {
            setDirPickerSpawn({ tabId: spawnMenu.tabId, choice, direction })
            setSpawnMenu(null)
          }}
        />
      )}

      {dirPickerSpawn && dirPickerSpawnTab && (
        <DirPicker
          title={`Start ${spawnChoiceLabel(dirPickerSpawn.choice)} in...`}
          initial={projectCwd(dirPickerSpawnTab)}
          confirmLabel="Start"
          skipLabel="Cancel"
          onConfirm={(dir) => {
            const { tabId, choice, direction } = dirPickerSpawn
            const tab = visibleTabs.find((t) => t.id === tabId)
            if (tab) spawnInProject(tab, { ...choice, cwd: dir, direction })
            setDirPickerSpawn(null)
          }}
          onSkip={() => setDirPickerSpawn(null)}
        />
      )}
    </>
  )
}

// --- Pane row ---

function PaneRow({
  pane,
  tab,
  sourceWindowId,
  isFocused,
  isOnlyPane,
  sessions,
  onMouseDownOverride,
  onClickOverride,
}: {
  pane: PaneLeaf
  tab: Tab
  sourceWindowId?: number
  isFocused: boolean
  isOnlyPane: boolean
  sessions: Session[]
  onMouseDownOverride?: () => void
  onClickOverride?: () => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = React.useRef<HTMLInputElement>(null)

  const focusPaneInTab = usePanesStore((s) => s.focusPaneInTab)
  const closePaneInTab = usePanesStore((s) => s.closePaneInTab)
  const movePaneToNewTab = usePanesStore((s) => s.movePaneToNewTab)
  const setPaneCustomName = usePanesStore((s) => s.setPaneCustomName)
  const pendingRenamePaneId = usePanesStore((s) => s.pendingRenamePaneId)
  const setPendingRenamePaneId = usePanesStore((s) => s.setPendingRenamePaneId)
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const setDraggedPane = usePanesStore((s) => s.setDraggedPane)
  const swapDrag = usePanesStore((s) => s.swapDrag)
  const startSwapDrag = usePanesStore((s) => s.startSwapDrag)
  const setSwapDragTarget = usePanesStore((s) => s.setSwapDragTarget)
  const clearSwapDrag = usePanesStore((s) => s.clearSwapDrag)
  const swapPanesAcrossTabs = usePanesStore((s) => s.swapPanesAcrossTabs)
  const windowId = usePanesStore((s) => s.windowId)
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)

  const name = paneLabelText(pane, sessions)
  const session = pane.agentKind && pane.sessionId
    ? sessions.find((s) => s.agentKind === pane.agentKind && s.sessionId === pane.sessionId)
    : null
  const cwdBranch = useGitBranch(pane.cwd, showGitBranchBadges)
  const branch = showGitBranchBadges
    ? displayGitBranch(cwdBranch === undefined ? session?.gitBranch : cwdBranch)
    : null
  const isSwapTarget = swapDrag?.targetId === pane.id

  React.useEffect(() => {
    if (renaming) renameInputRef.current?.select()
  }, [renaming])

  React.useEffect(() => {
    if (pendingRenamePaneId === pane.id) {
      setRenameValue(pane.customName ?? '')
      setRenaming(true)
      setPendingRenamePaneId(null)
    }
  }, [pendingRenamePaneId, pane.id, pane.customName, setPendingRenamePaneId])

  function startRename() {
    setRenameValue(pane.customName ?? '')
    setRenaming(true)
  }

  function commitRename() {
    setPaneCustomName(pane.id, renameValue)
    setRenaming(false)
  }

  return (
    <>
      <div
        data-pane-id={pane.id}
        draggable={!renaming && sourceWindowId !== undefined}
        onDragStart={(e) => {
          if (renaming || sourceWindowId === undefined) return
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          setPaneDragData(e.dataTransfer, { pane, sourceTabId: tab.id, sourceWindowId })
          setDraggedPane(pane.id)
          // Capture-phase cleanup so draggedPaneId clears even when the source pane unmounts
          // before onDragEnd fires (spec-025 lesson — mirrors pane header beginNativeDrag)
          const cleanup = (): void => {
            setDraggedPane(null)
            window.removeEventListener('drop', cleanup, true)
            window.removeEventListener('dragend', cleanup, true)
          }
          window.addEventListener('drop', cleanup, true)
          window.addEventListener('dragend', cleanup, true)
        }}
        onDragEnd={() => { setDraggedPane(null) }}
        onDragOver={(e) => {
          const hasPaneDrag = e.dataTransfer.types.includes(PANE_DRAG_MIME)
          if (!hasPaneDrag && !draggedPaneId) return
          if ((paneDragSourceId(e.dataTransfer) ?? draggedPaneId) === pane.id) {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'none'
            setHovered(false)
            return
          }
          e.dataTransfer.dropEffect = 'move'
          e.preventDefault()
          e.stopPropagation()
          setHovered(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setHovered(false)
          }
        }}
        onDrop={(e) => {
          // All pane-split drops are handled by the PaneSplitDropTarget overlay inside this row.
          // This handler fires only for drags that miss the overlay (edge race).
          if (!e.dataTransfer.types.includes(PANE_DRAG_MIME) && !draggedPaneId) return
          e.preventDefault()
          e.stopPropagation()
        }}
        onMouseDown={(e) => {
          if (renaming) return
          if (e.button === 2) {
            // Arm the swap threshold — swap does not start until the cursor moves >5px.
            // A right-press released before that is a plain right-click and lets onContextMenu fire.
            const origin = { x: e.clientX, y: e.clientY }
            let dragging = false

            const resolveTarget = (x: number, y: number): string | null => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              const id = el?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
              return id && id !== pane.id ? id : null
            }

            const onContextMenu = (ce: MouseEvent): void => {
              ce.preventDefault()
              ce.stopImmediatePropagation()
              window.removeEventListener('contextmenu', onContextMenu, true)
            }

            const onMove = (ev: MouseEvent): void => {
              if (!dragging) {
                if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 5) return
                dragging = true
                startSwapDrag(pane.id)
                document.body.classList.add('pane-dragging')
                window.addEventListener('contextmenu', onContextMenu, true)
              }
              setSwapDragTarget(resolveTarget(ev.clientX, ev.clientY))
            }

            const onUp = (ev: MouseEvent): void => {
              window.removeEventListener('mousemove', onMove, true)
              window.removeEventListener('mouseup', onUp, true)
              if (!dragging) {
                // Plain right-click — let the contextmenu event reach onContextMenu
                setTimeout(() => window.removeEventListener('contextmenu', onContextMenu, true), 0)
                return
              }
              document.body.classList.remove('pane-dragging')
              const targetId = resolveTarget(ev.clientX, ev.clientY)
              clearSwapDrag()
              setTimeout(() => window.removeEventListener('contextmenu', onContextMenu, true), 0)
              if (!targetId || sourceWindowId === undefined || windowId === null) return

              // Resolve target pane info from store (needed for cross-window payload)
              const storeState = usePanesStore.getState()
              const { tabs: storeTabs, detachedWindowTabIds, windowId: myWin } = storeState
              let targetPane: PaneLeaf | null = null
              let targetTabId = ''
              let tgtWin: number = myWin!
              outer: for (const t of storeTabs) {
                if (!t.rootNode) continue
                for (const leaf of collectLeaves(t.rootNode)) {
                  if (leaf.id === targetId) {
                    targetPane = leaf
                    targetTabId = t.id
                    if (t.detached) {
                      const entry = Object.entries(detachedWindowTabIds).find(([, ids]) => ids.includes(t.id))
                      tgtWin = entry ? parseInt(entry[0], 10) : (myWin ?? 0)
                    }
                    break outer
                  }
                }
              }
              if (!targetPane) return

              if (sourceWindowId === myWin && tgtWin === myWin) {
                // Both panes local — use store action (handles same-tab and cross-tab)
                swapPanesAcrossTabs(pane.id, targetId)
              } else {
                window.ipc?.invoke('pane:swap-transfer', {
                  sourcePane: pane,
                  sourceTabId: tab.id,
                  sourceWindowId,
                  targetPane,
                  targetTabId,
                  targetWindowId: tgtWin,
                }).catch(console.error)
              }
            }

            window.addEventListener('mousemove', onMove, true)
            window.addEventListener('mouseup', onUp, true)
            return  // do NOT call onMouseDownOverride for right-press
          }
          onMouseDownOverride?.()
        }}
        onClick={() => { if (!renaming) { if (onClickOverride) { onClickOverride() } else { focusPaneInTab(tab.id, pane.id) } } }}
        onDoubleClick={() => startRename()}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={renaming ? undefined : pane.cwd}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px 5px 16px',
          margin: '1px 4px',
          borderRadius: 4,
          cursor: renaming ? 'default' : 'pointer',
          backgroundColor: isFocused ? ui.color.control : hovered ? ui.color.panelRaised : 'transparent',
          outline: isSwapTarget ? '2px solid #4ade80' : 'none',
          outlineOffset: -1,
          transition: 'background-color 0.1s',
          position: 'relative',
        }}
      >
        {/* Directional split overlay — same PaneSplitDropTarget as the pane grid, sized to this row */}
        <PaneSplitDropTarget pane={pane} overlayMode targetWindowId={sourceWindowId} />

        {pane.paneType === 'agent' && pane.agentKind ? (
          <span
            style={{
              width: 14,
              height: 14,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AgentIcon agentKind={pane.agentKind} size={14} />
            <StatusDot status={pane.agentStatus?.status ?? 'idle'} detail={pane.agentStatus?.detail} disconnected={isAgentPaneDisconnected(pane)} />
          </span>
        ) : (
          <span style={{ width: 14, height: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: 0.9 }}>
            <ShellIcon size={14} />
          </span>
        )}
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false) }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Label (optional)"
            style={{
              flex: 1,
              background: ui.color.input,
              border: border.accent,
              borderRadius: 3,
              color: ui.color.text,
              fontSize: 12,
              padding: '1px 4px',
              outline: 'none',
              minWidth: 0,
            }}
          />
        ) : (
          <div style={{ flex: 1, minWidth: 0, paddingRight: hovered ? 42 : 0 }}>
            <div style={{ fontSize: 12, color: isFocused ? ui.color.text : ui.color.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </div>
            {branch && (
              <div style={{ display: 'flex', marginTop: 2 }}>
                <span
                  style={{
                    fontSize: 10,
                    color: ui.color.textDim,
                    backgroundColor: ui.color.badge,
                    border: border.default,
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    maxWidth: 88,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {branch}
                </span>
              </div>
            )}
          </div>
        )}
        {!renaming && (
          <div
            style={{
              ...sidebarStyles.paneHoverActionGroup,
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
            }}
          >
            <SidebarIconButton
              title="Pane menu"
              icon={threeDotIcon}
              onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
            />
            <SidebarIconButton
              title="Close pane"
              icon={closeIcon}
              onClick={() => closePaneInTab(tab.id, pane.id)}
            />
          </div>
        )}
      </div>

      {menu && (
        <PaneContextMenu
          pane={pane}
          x={menu.x}
          y={menu.y}
          canMoveToNewTab={!isOnlyPane}
          onClose={() => setMenu(null)}
          onRename={() => { startRename(); setMenu(null) }}
          onClosePane={() => { closePaneInTab(tab.id, pane.id); setMenu(null) }}
          onMoveToNewTab={() => { movePaneToNewTab(pane.id); setMenu(null) }}
        />
      )}
    </>
  )
}

function SidebarHoverActions({
  menuTitle,
  closeTitle,
  onMenu,
  onClose,
}: {
  menuTitle: string
  closeTitle: string
  onMenu: (e: React.MouseEvent<HTMLButtonElement>) => void
  onClose: () => void
}): JSX.Element {
  return (
    <>
      <SidebarIconButton title={menuTitle} icon={threeDotIcon} onClick={onMenu} />
      <SidebarIconButton title={closeTitle} icon={closeIcon} onClick={onClose} />
    </>
  )
}

function ProjectSpawnButton({
  onClick,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  return (
    <SidebarIconButton
      title="Start in project"
      icon={addBoxIcon}
      onClick={onClick}
    />
  )
}

function SidebarIconButton({
  title,
  icon,
  onClick,
}: {
  title: string
  icon: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  return (
    <button
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick(e)
      }}
      style={sidebarStyles.hoverIconButton}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.controlHover }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
    >
      <img src={icon} alt="" style={sidebarStyles.hoverIconImage} />
    </button>
  )
}

// --- Pane context menu ---

function PaneContextMenu({
  pane,
  x,
  y,
  canMoveToNewTab,
  onClose,
  onRename,
  onClosePane,
  onMoveToNewTab,
}: {
  pane: PaneLeaf
  x: number
  y: number
  canMoveToNewTab: boolean
  onClose: () => void
  onRename: () => void
  onClosePane: () => void
  onMoveToNewTab: () => void
}): JSX.Element {
  function copyToClipboard(text: string) {
    if (window.ipc) {
      window.ipc.invoke('shell:copy-to-clipboard', text).catch(() => {})
    } else {
      navigator.clipboard.writeText(text).catch(() => {})
    }
  }

  const items: Array<{ label: string; action: () => void; danger?: boolean } | null> = [
    { label: 'Rename', action: onRename },
    ...(canMoveToNewTab ? [{ label: 'Open in new tab', action: onMoveToNewTab }] : []),
    null,
    { label: 'Close pane', action: onClosePane, danger: true },
    null,
    { label: 'Open folder', action: () => window.ipc?.invoke('shell:open-folder', pane.cwd).catch(() => {}) },
    { label: 'Copy path', action: () => copyToClipboard(pane.cwd) },
    ...(pane.sessionId
      ? [{ label: 'Copy session ID', action: () => copyToClipboard(pane.sessionId!) }]
      : []
    ),
  ]

  return (
    <>
      <div style={menuStyles.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ ...menuStyles.panel, left: x, top: y, minWidth: 180 }}>
        {items.map((item, i) =>
          item === null ? (
            <div key={i} style={{ ...menuStyles.separator, margin: '4px 0' }} />
          ) : (
            <button
              key={i}
              onClick={() => { item.action(); onClose() }}
              style={{ ...menuStyles.item, display: 'block', color: item.danger ? ui.color.danger : ui.color.text, cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.border }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  )
}

// --- Tab context menu (right-click on section header) ---

function TabContextMenu({
  tabId,
  tabs,
  x,
  y,
  onClose,
  onRename,
  onCloseTab,
  onChangeDefaultDir,
  isDetachedWindow,
  onMoveToNewWindow,
  onReturnToMain,
  jiraMatch,
  onRefreshJiraStatus,
}: {
  tabId: string
  tabs: Tab[]
  x: number
  y: number
  onClose: () => void
  onRename: (id: string) => void
  onCloseTab: (id: string) => void
  onChangeDefaultDir: (id: string) => void
  isDetachedWindow: boolean
  onMoveToNewWindow: (id: string) => void
  onReturnToMain: (id: string) => void
  jiraMatch: boolean
  onRefreshJiraStatus: () => void
}): JSX.Element {
  const tab = tabs.find((t) => t.id === tabId)
  const defaultDirLabel = tab?.defaultCwd
    ? `Change Project Directory  (${tab.defaultCwd.split(/[\\/]/).pop()})`
    : 'Set Project Directory'

  function btn(label: string, onClick: () => void, danger = false): JSX.Element {
    return (
      <button
        onClick={onClick}
        style={{ ...menuStyles.item, display: 'block', color: danger ? ui.color.danger : ui.color.text, cursor: 'pointer' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.border }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        {label}
      </button>
    )
  }

  return (
    <>
      <div style={menuStyles.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ ...menuStyles.panel, left: x, top: y, minWidth: 200 }}>
        {btn('Rename', () => { onRename(tabId); onClose() })}
        {btn(defaultDirLabel, () => { onChangeDefaultDir(tabId); onClose() })}
        {jiraMatch && btn('Refresh Jira status', () => { onRefreshJiraStatus(); onClose() })}
        {isDetachedWindow ? (
          <>
            <div style={{ ...menuStyles.separator, margin: '4px 0' }} />
            {btn('Bring to Main Window', () => {
              onReturnToMain(tabId)
              onClose()
            })}
          </>
        ) : (
          <>
            <div style={{ ...menuStyles.separator, margin: '4px 0' }} />
            {btn('Move Tab to New Window', () => { onMoveToNewWindow(tabId); onClose() })}
          </>
        )}
        <div style={{ ...menuStyles.separator, margin: '4px 0' }} />
        {btn('Close tab', () => onCloseTab(tabId), true)}
      </div>
    </>
  )
}
