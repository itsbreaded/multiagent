import React, { useEffect, useState } from 'react'
import type { PaneLeaf, Session, SpawnInTabPayload, SplitDirection, Tab } from '../../../../shared/types'
import { tabSidebarSectionId, usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { SidebarSection } from './SidebarSection'
import { computeLabels, paneLabelText } from '../../utils/tabLabels'
import { collectLeaves } from '../../../../shared/paneTree'
import { displayGitBranch } from '../../utils/git'
import { decodePaneDragPayload, paneDragSourceId, PANE_DRAG_MIME, setPaneDragData, type PaneDragPayload } from '../../utils/paneDrag'
import { DirPicker } from '../DirPicker'
import { SpawnChoiceMenu, spawnChoiceLabel, type SpawnChoice } from '../SpawnChoiceMenu'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import { border, menuStyles, sidebarStyles, ui } from '../../styles/theme'
import { AgentIcon, ShellIcon } from '../AgentIcon'
import closeIcon from '../../assets/close.png'
import threeDotIcon from '../../assets/threedot.png'
import addBoxIcon from '../../assets/addbox.png'
import { PaneSplitDropTarget } from '../PaneGrid/PaneSplitDropTarget'

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')
const TAB_REORDER_MIME = 'application/x-multiagent-tab-reorder'

export function TabSections(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
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
  const findPaneInAnyTab = usePanesStore((s) => s.findPaneInAnyTab)
  const detachedWindowTabIds = usePanesStore((s) => s.detachedWindowTabIds)
  const detachedWindowActiveTabIds = usePanesStore((s) => s.detachedWindowActiveTabIds)
  const windowId = usePanesStore((s) => s.windowId)
  const activeWindowId = usePanesStore((s) => s.activeWindowId)
  const pendingFocusTarget = usePanesStore((s) => s.pendingFocusTarget)
  const localFocusArmed = usePanesStore((s) => s.localFocusArmed)
  const focusDetachedPaneOptimistically = usePanesStore((s) => s.focusDetachedPaneOptimistically)
  const focusLocalPaneFromSidebar = usePanesStore((s) => s.focusLocalPaneFromSidebar)
  const spawnInTab = usePanesStore((s) => s.spawnInTab)
  // Which window is effectively active: pending remote click wins, otherwise OS focus.
  // Only one window shows a highlighted pane at a time — confirmedFocusTarget is
  // intentionally excluded so that OS focus changes immediately de-highlight the old window.
  const effectiveActiveWindowId = pendingFocusTarget?.windowId ?? activeWindowId
  const localWindowActive = effectiveActiveWindowId === null || effectiveActiveWindowId === windowId
  const reorderTab = usePanesStore((s) => s.reorderTab)
  const pendingRenameTabId = usePanesStore((s) => s.pendingRenameTabId)
  const setPendingRenameTabId = usePanesStore((s) => s.setPendingRenameTabId)

  const tabLabels = computeLabels(tabs, sessions)

  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dirPickerTabId, setDirPickerTabId] = useState<string | null>(null)
  const [spawnMenu, setSpawnMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dirPickerSpawn, setDirPickerSpawn] = useState<{ tabId: string; choice: SpawnChoice; direction: SplitDirection } | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dropTabId, setDropTabId] = useState<string | null>(null)
  // undefined = no reorder drag; null = insert at end; string = insert before that tab id
  const [reorderInsertBeforeId, setReorderInsertBeforeId] = useState<string | null | undefined>(undefined)

  const dirPickerTab = dirPickerTabId ? tabs.find((t) => t.id === dirPickerTabId) : null
  const spawnMenuTab = spawnMenu ? tabs.find((t) => t.id === spawnMenu.tabId) : null
  const dirPickerSpawnTab = dirPickerSpawn ? tabs.find((t) => t.id === dirPickerSpawn.tabId) : null

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
    if (pendingRenameTabId && tabs.some((t) => t.id === pendingRenameTabId)) {
      startRename(pendingRenameTabId)
      setPendingRenameTabId(null)
    }
  }, [pendingRenameTabId])

  if (tabs.length === 0) return <></>

  return (
    <>
      {/* Container catches TAB_REORDER_MIME drops that land on section content or gaps,
          using the last insertion position set by onHeaderDragOver. */}
      <div
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
            e.preventDefault()
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
            e.preventDefault()
          }
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(TAB_REORDER_MIME) || reorderInsertBeforeId === undefined) return
          e.preventDefault()
          e.stopPropagation()
          try {
            const { tabId: sourceTabId } = JSON.parse(e.dataTransfer.getData(TAB_REORDER_MIME)) as { tabId: string }
            reorderTab(sourceTabId, reorderInsertBeforeId)
          } catch {}
          setReorderInsertBeforeId(undefined)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setReorderInsertBeforeId(undefined)
          }
        }}
      >
      {tabs.map((tab) => {
        const label = tabLabels.get(tab.id) ?? 'Tab'
        const leaves = tab.rootNode ? collectLeaves(tab.rootNode) : []
        const isActive = tab.id === activeTabId
        const isRenaming = renamingTabId === tab.id
        const sectionId = tabSidebarSectionId(tab.id)
        const open = sidebarSectionOpen[sectionId] ?? sidebarSectionOpen[tab.id] ?? isActive
        const isDetached = !!tab.detached

        // Detached tabs: same visual treatment as local tabs.
        // Header/pane clicks focus the external window.
        // Pane drag onto header transfers the pane cross-window.
        if (isDetached) {
          const ownerWindowId = Object.entries(detachedWindowTabIds).find(([, ids]) => ids.includes(tab.id))?.[0]
          const ownerWindowNumId = ownerWindowId !== undefined ? parseInt(ownerWindowId, 10) : undefined
          const focusTab = () => {
            if (ownerWindowNumId !== undefined) focusDetachedPaneOptimistically(ownerWindowNumId, tab.id)
            window.ipc?.invoke('window:focus-for-tab', tab.id).catch(() => {})
          }
          const isOwnerWindowActive = ownerWindowNumId !== undefined && effectiveActiveWindowId === ownerWindowNumId
          const focusTargetForTab = pendingFocusTarget !== null && pendingFocusTarget.windowId === ownerWindowNumId && pendingFocusTarget.tabId === tab.id
            ? pendingFocusTarget
            : null
          const isTabActiveInWindow = focusTargetForTab !== null || (ownerWindowId ? detachedWindowActiveTabIds[ownerWindowId] === tab.id : leaves.length > 0)
          return (
            <SidebarSection
              key={tab.id}
              title={label}
              count={leaves.length > 1 ? leaves.length : undefined}
              open={open}
              onOpenChange={(next) => setSidebarSectionOpen(sectionId, next)}
              onTitleClick={focusTab}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
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
              titleSuffix={
                <span title="In separate window — click to focus" style={{ fontSize: 11, color: '#5a6050', marginLeft: 4, flexShrink: 0 }}>↗</span>
              }
              headerDropActive={dropTabId === tab.id}
              onHeaderDragOver={(e) => {
                if (!draggedPaneId && !e.dataTransfer.types.includes(PANE_DRAG_MIME)) return
                e.preventDefault()
                e.stopPropagation()
                setDropTabId(tab.id)
              }}
              onHeaderDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTabId(null)
              }}
              onHeaderDrop={(e) => {
                const payload = decodePaneDragPayload(e.dataTransfer)
                if (!draggedPaneId && !payload) return
                e.preventDefault()
                e.stopPropagation()
                if (payload && ownerWindowNumId !== undefined) {
                  transferPaneToTab(payload, tab.id, ownerWindowNumId)
                } else if (draggedPaneId) {
                  const pane = findPaneInAnyTab(draggedPaneId)
                  const sourceWindowId = windowId
                  if (pane && sourceWindowId !== null && ownerWindowNumId !== undefined) {
                    transferPaneToTab({ pane, sourceTabId: activeTabId, sourceWindowId }, tab.id, ownerWindowNumId)
                  }
                }
                setDropTabId(null)
              }}
            >
              {leaves.map((pane) => (
                <PaneRow
                  key={pane.id}
                  pane={pane}
                  tab={tab}
                  sourceWindowId={ownerWindowNumId}
                  isFocused={isOwnerWindowActive && isTabActiveInWindow && pane.id === (focusTargetForTab?.paneId ?? tab.focusedPaneId)}
                  sessions={sessions}
                  onMouseDownOverride={() => {
                    if (ownerWindowNumId !== undefined) focusDetachedPaneOptimistically(ownerWindowNumId, tab.id, pane.id)
                  }}
                  onClickOverride={() => {
                    if (ownerWindowNumId !== undefined) focusDetachedPaneOptimistically(ownerWindowNumId, tab.id, pane.id)
                    window.ipc?.invoke('window:focus-pane', tab.id, pane.id).catch(() => {})
                  }}
                />
              ))}
            </SidebarSection>
          )
        }

        const localTabs = tabs.filter((t) => !t.detached)
        const localTabIdx = localTabs.findIndex((t) => t.id === tab.id)
        const isLastLocalTab = localTabIdx === localTabs.length - 1
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
            headerDraggable={!isRenaming}
            onHeaderDragStart={(e) => {
              e.dataTransfer.setData(TAB_REORDER_MIME, JSON.stringify({ tabId: tab.id }))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onHeaderDragEnd={() => {
              setReorderInsertBeforeId(undefined)
            }}
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
            headerDropActive={dropTabId === tab.id}
            headerInsertTop={reorderInsertBeforeId !== undefined && reorderInsertBeforeId === tab.id}
            sectionInsertBottom={reorderInsertBeforeId !== undefined && reorderInsertBeforeId === null && isLastLocalTab}
            onHeaderDragOver={(e) => {
              // Project reorder — MIME-type check prevents collision with pane drops
              if (e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                if (e.clientY - rect.top < rect.height / 2) {
                  setReorderInsertBeforeId(tab.id)
                } else {
                  setReorderInsertBeforeId(localTabs[localTabIdx + 1]?.id ?? null)
                }
                return
              }
              // Pane drop
              if (!draggedPaneId && !e.dataTransfer.types.includes(PANE_DRAG_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              setDropTabId(tab.id)
            }}
            onHeaderDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTabId(null)
            }}
            onHeaderDrop={(e) => {
              // Project reorder
              if (e.dataTransfer.types.includes(TAB_REORDER_MIME)) {
                e.preventDefault()
                e.stopPropagation()
                try {
                  const { tabId: sourceTabId } = JSON.parse(e.dataTransfer.getData(TAB_REORDER_MIME)) as { tabId: string }
                  reorderTab(sourceTabId, reorderInsertBeforeId ?? null)
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
          tabs={tabs}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          onRename={(id) => { startRename(id); setTabMenu(null) }}
          onCloseTab={(id) => { closeTab(id); setTabMenu(null) }}
          onChangeDefaultDir={(id) => { setDirPickerTabId(id); setTabMenu(null) }}
        />
      )}

      {dirPickerTabId && (
        <DirPicker
          title="Change project directory"
          description="New sessions and shells in this tab will start here by default."
          initial={dirPickerTab?.defaultCwd ?? ''}
          confirmLabel="Change"
          skipLabel="Cancel"
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
            const tab = tabs.find((t) => t.id === tabId)
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
  sessions,
  onMouseDownOverride,
  onClickOverride,
}: {
  pane: PaneLeaf
  tab: Tab
  sourceWindowId?: number
  isFocused: boolean
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
  const isOnlyPane = !tab.rootNode || collectLeaves(tab.rootNode).length <= 1
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
}: {
  tabId: string
  tabs: Tab[]
  x: number
  y: number
  onClose: () => void
  onRename: (id: string) => void
  onCloseTab: (id: string) => void
  onChangeDefaultDir: (id: string) => void
}): JSX.Element {
  const tab = tabs.find((t) => t.id === tabId)
  const isDetached = !!tab?.detached
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
        {!isDetached && btn(defaultDirLabel, () => { onChangeDefaultDir(tabId); onClose() })}
        {isDetached && (
          <>
            <div style={{ ...menuStyles.separator, margin: '4px 0' }} />
            {btn('Bring to This Window', () => {
              window.ipc?.invoke('tab:bring-home', tabId).catch(console.error)
              onClose()
            })}
          </>
        )}
        <div style={{ ...menuStyles.separator, margin: '4px 0' }} />
        {btn('Close tab', () => onCloseTab(tabId), true)}
      </div>
    </>
  )
}
