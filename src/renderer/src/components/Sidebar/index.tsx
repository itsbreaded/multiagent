import React, { useRef, useCallback, useState, useLayoutEffect } from 'react'
import type { AgentKind, SplitDirection } from '../../../../shared/types'
import { RECENT_SECTION_ID, usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import { SidebarSection } from './SidebarSection'
import { SessionRow } from './SessionRow'
import { TabSections } from './TabSections'
import { DirPicker } from '../DirPicker'
import { agentLabel } from '../../utils/agents'

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
  const sidebarBottomHeight = usePanesStore((s) => s.sidebarBottomHeight)
  const setSidebarWidth = usePanesStore((s) => s.setSidebarWidth)
  const setSidebarBottomHeight = usePanesStore((s) => s.setSidebarBottomHeight)
  const newSession = usePanesStore((s) => s.newSession)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const lastAgentKind = usePanesStore((s) => s.lastAgentKind)
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
      startBottomHeight.current = sidebarBottomHeight

      const onMove = (me: MouseEvent) => {
        if (!bottomDragging.current) return
        const delta = startY.current - me.clientY
        const containerHeight = sidebarRef.current?.clientHeight ?? window.innerHeight
        const max = Math.max(140, containerHeight - 64)
        const next = Math.max(96, Math.min(max, startBottomHeight.current + delta))
        setSidebarBottomHeight(next)
      }
      const onUp = () => {
        bottomDragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [recentOpen, sidebarBottomHeight, setSidebarBottomHeight]
  )

  function spawn(type: 'agent' | 'shell', direction: SplitDirection, cwd: string, agentKind?: AgentKind) {
    if (type === 'agent') newSession(cwd, direction, agentKind)
    else addShellPane(cwd, direction)
  }

  if (!sidebarOpen) return <></>

  return (
    <div
      ref={sidebarRef}
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        maxWidth: sidebarWidth,
        backgroundColor: '#1a1b1e',
        borderRight: '1px solid #2a2b2e',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {/* Action buttons */}
      <div style={{ padding: '8px 8px 6px', display: 'flex', gap: 5 }}>
        <SpawnButton
          label="+ Session"
          title={`Start ${agentLabel(lastAgentKind)} session`}
          onClick={() => spawn('agent', 'vertical', smartCwd(), lastAgentKind)}
        />
        <SpawnButton
          label="v"
          title="Choose session agent"
          compact
          onClick={(e) => setSpawnMenu({ type: 'agent', x: e.clientX, y: e.clientY })}
        />
        <SpawnButton
          label="+ Shell"
          title="Open shell"
          onClick={(e) => setSpawnMenu({ type: 'shell', x: e.clientX, y: e.clientY })}
        />
      </div>

      {/* Workspace sections */}
      <div className="dark-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && (
          <div style={{ padding: '12px 16px', fontSize: 11, color: '#4a4b4e' }}>
            Scanning sessions...
          </div>
        )}

        <TabSections />
      </div>

      {/* Static bottom sections */}
      {resumable.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            height: recentOpen ? sidebarBottomHeight : 32,
            minHeight: recentOpen ? 96 : 32,
            maxHeight: recentOpen ? 'calc(100% - 64px)' : 32,
            borderTop: '1px solid #2a2b2e',
            backgroundColor: '#18191c',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {recentOpen && (
            <div
              onMouseDown={onBottomResizeMouseDown}
              style={{
                position: 'absolute',
                top: -3,
                left: 0,
                right: 0,
                height: 6,
                cursor: 'row-resize',
                zIndex: 11,
              }}
            />
          )}
          <SidebarSection
            title="Recent"
            count={resumable.length}
            open={recentOpen}
            onOpenChange={(open) => setSidebarSectionOpen(RECENT_SECTION_ID, open)}
            style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
            contentClassName="dark-scrollbar"
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
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: 'col-resize',
          zIndex: 10,
        }}
      />

      {spawnMenu && (
        <SpawnMenuPopover
          type={spawnMenu.type}
          x={spawnMenu.x}
          y={spawnMenu.y}
          tabDefaultCwd={activeTab?.defaultCwd}
          onClose={() => setSpawnMenu(null)}
          onSpawn={(direction, agentKind) => {
            spawn(spawnMenu.type, direction, smartCwd(), agentKind)
            setSpawnMenu(null)
          }}
          onSpawnIn={(direction, agentKind) => {
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

// --- Spawn button ---

function SpawnButton({
  label,
  title,
  compact = false,
  onClick,
}: {
  label: string
  title?: string
  compact?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        flex: compact ? '0 0 30px' : 1,
        padding: '6px 6px',
        backgroundColor: '#242528',
        border: '1px solid #2a2b2e',
        borderRadius: 5,
        color: '#c9cdd1',
        fontSize: 12,
        cursor: 'pointer',
        fontWeight: 500,
        textAlign: 'center',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2e2f33' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#242528' }}
    >
      {label}
    </button>
  )
}

// --- Spawn menu popover ---

function SpawnMenuPopover({
  type,
  x,
  y,
  tabDefaultCwd,
  onClose,
  onSpawn,
  onSpawnIn,
}: {
  type: 'agent' | 'shell'
  x: number
  y: number
  tabDefaultCwd?: string
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

  const noun = type === 'agent' ? 'session' : 'shell'

  function row(
    label: string,
    hint: string,
    onClick: () => void,
    dimmed = false,
  ): JSX.Element {
    return (
      <button
        onClick={dimmed ? undefined : onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '7px 12px',
          background: 'none',
          border: 'none',
          textAlign: 'left',
          fontSize: 12,
          color: dimmed ? '#3a3b3e' : '#c9cdd1',
          cursor: dimmed ? 'default' : 'pointer',
          gap: 12,
        }}
        onMouseEnter={(e) => { if (!dimmed) (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#242528' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 13, opacity: dimmed ? 0.3 : 0.5 }}>{hint}</span>
      </button>
    )
  }

  function sep(): JSX.Element {
    return <div style={{ height: 1, backgroundColor: '#2a2b2e', margin: '3px 0' }} />
  }

  const dirHint = tabDefaultCwd
    ? tabDefaultCwd.split(/[\\/]/).pop()
    : null

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 200 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          zIndex: 201,
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 6,
          padding: '4px 0',
          minWidth: 200,
          boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
          visibility: pos.visible ? 'visible' : 'hidden',
        }}
      >
        {/* Section label with dir hint */}
        <div style={{
          padding: '4px 12px 5px',
          fontSize: 10,
          color: '#4a4b4e',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>New {noun}</span>
          {dirHint && (
            <span style={{ fontFamily: 'monospace', textTransform: 'none', letterSpacing: 0 }}>
              {dirHint}
            </span>
          )}
        </div>
        <div style={{ height: 1, backgroundColor: '#2a2b2e', margin: '0 0 3px' }} />

        {type === 'agent' && (
          <>
            <MenuLabel>Current Directory</MenuLabel>
            {row('Claude Code', 'C', () => onSpawn('vertical', 'claude'))}
            {row('Codex CLI', 'X', () => onSpawn('vertical', 'codex'))}
            {sep()}
            <MenuLabel>Choose Directory</MenuLabel>
            {row('Claude Code...', 'C', () => onSpawnIn('vertical', 'claude'))}
            {row('Codex CLI...', 'X', () => onSpawnIn('vertical', 'codex'))}
          </>
        )}

        {type === 'shell' && (
          <>
            {row('Current Directory', '>', () => onSpawn('vertical'))}
            {sep()}
            {row('Choose Directory...', '>', () => onSpawnIn('vertical'))}
          </>
        )}
      </div>
    </>
  )
}

function MenuLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        padding: '5px 12px 3px',
        fontSize: 10,
        color: '#4a4b4e',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  )
}
