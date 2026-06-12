import React, { useRef, useCallback, useState, useLayoutEffect } from 'react'
import type { AgentKind, SplitDirection } from '../../../../shared/types'
import { RECENT_SECTION_ID, usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import { SidebarSection } from './SidebarSection'
import { SessionRow } from './SessionRow'
import { TabSections } from './TabSections'
import { DirPicker } from '../DirPicker'
import { agentLabel } from '../../utils/agents'
import { border, controlStyles, menuStyles, sidebarStyles, ui } from '../../styles/theme'
import arrowDropdownIcon from '../../assets/arrowdropdown.png'
import newFolderIcon from '../../assets/newfolder.png'
import { AgentIcon, ShellIcon } from '../AgentIcon'

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')

interface SpawnMenu {
  type: 'agent' | 'shell'
  x: number
  y: number
}

interface DirPickerPending {
  type: 'agent' | 'shell'
  agentKind?: AgentKind
  direction: SplitDirection
}

export function Sidebar(): JSX.Element {
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const sidebarPanelSizes = usePanesStore((s) => s.sidebarPanelSizes)
  const setSidebarWidth = usePanesStore((s) => s.setSidebarWidth)
  const setSidebarPanelSize = usePanesStore((s) => s.setSidebarPanelSize)
  const newSession = usePanesStore((s) => s.newSession)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const lastAgentKind = usePanesStore((s) => s.lastAgentKind)
  const lastShellSpawnMode = usePanesStore((s) => s.lastShellSpawnMode)
  const setLastShellSpawnMode = usePanesStore((s) => s.setLastShellSpawnMode)
  const addTab = usePanesStore((s) => s.addTab)
  const setPendingRenameTabId = usePanesStore((s) => s.setPendingRenameTabId)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const sidebarSectionOpen = usePanesStore((s) => s.sidebarSectionOpen)
  const setSidebarSectionOpen = usePanesStore((s) => s.setSidebarSectionOpen)
  const { resumable, loading } = useSessions()

  const activeTab = tabs.find((t) => t.id === activeTabId)

  function activeCwd(): string {
    return getFocusedPane()?.cwd ?? DEFAULT_CWD
  }

  function smartCwd(): string {
    return activeTab?.defaultCwd ?? activeCwd()
  }

  const [spawnMenu, setSpawnMenu] = useState<SpawnMenu | null>(null)
  const [dirPickerPending, setDirPickerPending] = useState<DirPickerPending | null>(null)
  const recentOpen = sidebarSectionOpen[RECENT_SECTION_ID] ?? true
  const recentHeight = sidebarPanelSizes[RECENT_SECTION_ID] ?? 220

  // Resize drag
  const sidebarRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const bottomDragging = useRef(false)
  const startY = useRef(0)
  const startBottomHeight = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true
      startX.current = e.clientX
      startWidth.current = sidebarWidth

      const onMove = (me: MouseEvent) => {
        if (!dragging.current) return
        const delta = me.clientX - startX.current
        const next = Math.max(140, Math.min(400, startWidth.current + delta))
        setSidebarWidth(next)
      }
      const onUp = () => {
        dragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [sidebarWidth, setSidebarWidth]
  )

  const onBottomResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!recentOpen) return
      e.preventDefault()
      bottomDragging.current = true
      startY.current = e.clientY
      startBottomHeight.current = recentHeight

      const onMove = (me: MouseEvent) => {
        if (!bottomDragging.current) return
        const delta = startY.current - me.clientY
        const containerHeight = sidebarRef.current?.clientHeight ?? window.innerHeight
        const max = Math.max(140, containerHeight - 64)
        const next = Math.max(96, Math.min(max, startBottomHeight.current + delta))
        setSidebarPanelSize(RECENT_SECTION_ID, next)
      }
      const onUp = () => {
        bottomDragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [recentOpen, recentHeight, setSidebarPanelSize]
  )

  function spawn(type: 'agent' | 'shell', direction: SplitDirection, cwd: string, agentKind?: AgentKind) {
    if (type === 'agent') newSession(cwd, direction, agentKind)
    else addShellPane(cwd, direction)
  }

  function spawnShellFromSavedMode(): void {
    if (lastShellSpawnMode === 'choose') {
      setDirPickerPending({ type: 'shell', direction: 'vertical' })
      return
    }
    spawn('shell', 'vertical', smartCwd())
  }

  if (!sidebarOpen) return <></>

  return (
    <div
      ref={sidebarRef}
      style={{
        ...sidebarStyles.root,
        width: sidebarWidth,
        minWidth: sidebarWidth,
        maxWidth: sidebarWidth,
      }}
    >
      {/* Action buttons */}
      <div style={sidebarStyles.actionRow}>
        <SplitSpawnButton
          label={<><AgentIcon agentKind={lastAgentKind} size={14} /> Session</>}
          title={`Start ${agentLabel(lastAgentKind)} session`}
          onMain={() => spawn('agent', 'vertical', smartCwd(), lastAgentKind)}
          onDropdown={(e) => setSpawnMenu({ type: 'agent', x: e.clientX, y: e.clientY })}
        />
        <SplitSpawnButton
          label={<><ShellIcon size={14} /> Shell</>}
          title="Open shell"
          dropdownTitle="Choose shell location"
          onMain={spawnShellFromSavedMode}
          onDropdown={(e) => setSpawnMenu({ type: 'shell', x: e.clientX, y: e.clientY })}
        />
        <button
          title="New tab"
          onClick={() => { const id = addTab(activeCwd()); setPendingRenameTabId(id) }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            flexShrink: 0,
            background: 'none',
            border: border.default,
            borderRadius: 5,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <img src={newFolderIcon} alt="New tab" style={{ width: 14, height: 14, opacity: 0.7 }} />
        </button>
      </div>

      {/* Workspace sections */}
      <div className={ui.className.darkScrollbar} style={sidebarStyles.scrollArea}>
        {loading && (
          <div style={{ padding: '12px 16px', fontSize: 11, color: ui.color.textDim }}>
            Scanning sessions...
          </div>
        )}

        <TabSections />
      </div>

      {/* Static bottom sections */}
      {resumable.length > 0 && (
        <div
          style={{
            ...sidebarStyles.dock,
            height: recentOpen ? recentHeight : 32,
            minHeight: recentOpen ? 96 : 32,
            maxHeight: recentOpen ? 'calc(100% - 64px)' : 32,
          }}
        >
          {recentOpen && (
            <div
              onMouseDown={onBottomResizeMouseDown}
              style={sidebarStyles.resizeHandleHorizontal}
            />
          )}
          <SidebarSection
            title="Recent"
            count={resumable.length}
            open={recentOpen}
            onOpenChange={(open) => setSidebarSectionOpen(RECENT_SECTION_ID, open)}
            style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
            contentClassName={ui.className.darkScrollbar}
            contentStyle={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
          >
            {resumable.map((s) => (
              <SessionRow key={`${s.agentKind}:${s.sessionId}`} session={s} />
            ))}
          </SidebarSection>
        </div>
      )}

      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        style={sidebarStyles.resizeHandleVertical}
      />

      {spawnMenu && (
        <SpawnMenuPopover
          type={spawnMenu.type}
          x={spawnMenu.x}
          y={spawnMenu.y}
          onClose={() => setSpawnMenu(null)}
          onSpawn={(direction, agentKind) => {
            if (spawnMenu.type === 'shell') setLastShellSpawnMode('current')
            spawn(spawnMenu.type, direction, smartCwd(), agentKind)
            setSpawnMenu(null)
          }}
          onSpawnIn={(direction, agentKind) => {
            if (spawnMenu.type === 'shell') setLastShellSpawnMode('choose')
            setDirPickerPending({ type: spawnMenu.type, direction, agentKind })
            setSpawnMenu(null)
          }}
        />
      )}

      {dirPickerPending && (
        <DirPicker
          title={`Start ${dirPickerPending.type === 'agent' ? `${agentLabel(dirPickerPending.agentKind ?? lastAgentKind)} session` : 'shell'} in...`}
          initial={smartCwd()}
          confirmLabel="Start"
          skipLabel="Cancel"
          autoBrowse
          onConfirm={(dir) => {
            spawn(dirPickerPending.type, dirPickerPending.direction, dir, dirPickerPending.agentKind)
            setDirPickerPending(null)
          }}
          onSkip={() => setDirPickerPending(null)}
        />
      )}
    </div>
  )
}

// --- Split spawn button (main action + dropdown) ---

function SplitSpawnButton({
  label,
  title,
  dropdownTitle = 'Choose session agent',
  onMain,
  onDropdown,
}: {
  label: React.ReactNode
  title?: string
  dropdownTitle?: string
  onMain: () => void
  onDropdown: (e: React.MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const base = controlStyles.sidebarButton
  return (
    <div style={{ flex: 1, display: 'flex', borderRadius: ui.radius.md, overflow: 'hidden', border: border.default, backgroundColor: ui.color.control }}>
      <button
        onClick={onMain}
        title={title}
        style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', borderRight: border.default, color: base.color, fontSize: base.fontSize, fontWeight: base.fontWeight, cursor: 'pointer', padding: base.padding, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.controlHover }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        {label}
      </button>
      <button
        onClick={onDropdown}
        title={dropdownTitle}
        style={{ flex: '0 0 22px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.controlHover }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        <img src={arrowDropdownIcon} alt="More options" style={{ width: 16, height: 16, display: 'block' }} />
      </button>
    </div>
  )
}

// --- Spawn menu popover ---

function SpawnMenuPopover({
  type,
  x,
  y,
  onClose,
  onSpawn,
  onSpawnIn,
}: {
  type: 'agent' | 'shell'
  x: number
  y: number
  onClose: () => void
  onSpawn: (direction: SplitDirection, agentKind?: AgentKind) => void
  onSpawnIn: (direction: SplitDirection, agentKind?: AgentKind) => void
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({
    left: x, top: y, visible: false,
  })

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 6
    setPos({
      left: Math.min(x, window.innerWidth - width - margin),
      top: Math.min(y, window.innerHeight - height - margin),
      visible: true,
    })
  }, [x, y])

  function row(
    label: string,
    hint: React.ReactNode,
    onClick: () => void,
    dimmed = false,
  ): JSX.Element {
    return (
      <button
        onClick={dimmed ? undefined : onClick}
        style={{
          ...menuStyles.item,
          color: dimmed ? ui.color.textFaint : ui.color.text,
          cursor: dimmed ? 'default' : 'pointer',
        }}
        onMouseEnter={(e) => { if (!dimmed) (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.control }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 13, opacity: dimmed ? 0.3 : 0.8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16 }}>
          {hint}
        </span>
      </button>
    )
  }

  function sep(): JSX.Element {
    return <div style={menuStyles.separator} />
  }


  return (
    <>
      <div
        style={menuStyles.backdrop}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        ref={menuRef}
        style={{
          ...menuStyles.panel,
          left: pos.left,
          top: pos.top,
          visibility: pos.visible ? 'visible' : 'hidden',
        }}
      >

        {type === 'agent' && (
          <>
            <MenuLabel>Current Directory</MenuLabel>
            {row('Claude Code', <AgentIcon agentKind="claude" size={16} />, () => onSpawn('vertical', 'claude'))}
            {row('Codex CLI', <AgentIcon agentKind="codex" size={16} />, () => onSpawn('vertical', 'codex'))}
            {sep()}
            <MenuLabel>Choose Directory</MenuLabel>
            {row('Claude Code...', <AgentIcon agentKind="claude" size={16} />, () => onSpawnIn('vertical', 'claude'))}
            {row('Codex CLI...', <AgentIcon agentKind="codex" size={16} />, () => onSpawnIn('vertical', 'codex'))}
          </>
        )}

        {type === 'shell' && (
          <>
            {row('Current Directory', <ShellIcon size={16} />, () => onSpawn('vertical'))}
            {sep()}
            {row('Choose Directory...', <ShellIcon size={16} />, () => onSpawnIn('vertical'))}
          </>
        )}
      </div>
    </>
  )
}

function MenuLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={menuStyles.label}
    >
      {children}
    </div>
  )
}
