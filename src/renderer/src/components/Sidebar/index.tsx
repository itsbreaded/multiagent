import React, { useRef, useCallback, useState, useLayoutEffect } from 'react'
import type { SplitDirection } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import { SidebarHeader } from './SidebarHeader'
import { SidebarSection } from './SidebarSection'
import { SessionRow } from './SessionRow'
import { TabSections } from './TabSections'
import { DirPicker } from '../DirPicker'

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')

interface SpawnMenu {
  type: 'claude' | 'shell'
  x: number
  y: number
}

interface DirPickerPending {
  type: 'claude' | 'shell'
  direction: SplitDirection
}

export function Sidebar(): JSX.Element {
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const setSidebarWidth = usePanesStore((s) => s.setSidebarWidth)
  const newSession = usePanesStore((s) => s.newSession)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const { resumable, archived, loading } = useSessions()

  const activeTab = tabs.find((t) => t.id === activeTabId)

  function activeCwd(): string {
    return getFocusedPane()?.cwd ?? DEFAULT_CWD
  }

  function smartCwd(): string {
    return activeTab?.defaultCwd ?? activeCwd()
  }

  const [spawnMenu, setSpawnMenu] = useState<SpawnMenu | null>(null)
  const [dirPickerPending, setDirPickerPending] = useState<DirPickerPending | null>(null)

  // Resize drag
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

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

  function spawn(type: 'claude' | 'shell', direction: SplitDirection, cwd: string) {
    if (type === 'claude') newSession(cwd, direction)
    else addShellPane(cwd, direction)
  }

  if (!sidebarOpen) return <></>

  return (
    <div
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
      <SidebarHeader />

      {/* Action buttons */}
      <div style={{ padding: '8px 8px 6px', display: 'flex', gap: 5 }}>
        <SpawnButton
          label="+ Session"
          onClick={(e) => setSpawnMenu({ type: 'claude', x: e.clientX, y: e.clientY })}
        />
        <SpawnButton
          label="+ Shell"
          onClick={(e) => setSpawnMenu({ type: 'shell', x: e.clientX, y: e.clientY })}
        />
      </div>

      {/* Scrollable session list */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && (
          <div style={{ padding: '12px 16px', fontSize: 11, color: '#4a4b4e' }}>
            Scanning sessions...
          </div>
        )}

        <TabSections />

        {resumable.length > 0 && (
          <SidebarSection title="Recent" count={resumable.length} defaultOpen>
            {resumable.map((s) => (
              <SessionRow key={s.sessionId} session={s} />
            ))}
          </SidebarSection>
        )}

        {archived.length > 0 && (
          <SidebarSection title="Archived" count={archived.length} defaultOpen={false}>
            {archived.map((s) => (
              <SessionRow key={s.sessionId} session={s} />
            ))}
          </SidebarSection>
        )}
      </div>

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
          onSpawn={(direction) => {
            spawn(spawnMenu.type, direction, smartCwd())
            setSpawnMenu(null)
          }}
          onSpawnIn={(direction) => {
            setDirPickerPending({ type: spawnMenu.type, direction })
            setSpawnMenu(null)
          }}
        />
      )}

      {dirPickerPending && (
        <DirPicker
          title={`Start ${dirPickerPending.type === 'claude' ? 'session' : 'shell'} in...`}
          initial={smartCwd()}
          confirmLabel="Start"
          skipLabel="Cancel"
          onConfirm={(dir) => {
            spawn(dirPickerPending.type, dirPickerPending.direction, dir)
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
  onClick,
}: {
  label: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
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
  type: 'claude' | 'shell'
  x: number
  y: number
  tabDefaultCwd?: string
  onClose: () => void
  onSpawn: (direction: SplitDirection) => void
  onSpawnIn: (direction: SplitDirection) => void
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

  const noun = type === 'claude' ? 'session' : 'shell'

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

        {row(`Split right`, '→', () => onSpawn('vertical'))}
        {row(`Split below`, '↓', () => onSpawn('horizontal'))}

        {sep()}

        {row(`Split right in…`, '→', () => onSpawnIn('vertical'))}
        {row(`Split below in…`, '↓', () => onSpawnIn('horizontal'))}
      </div>
    </>
  )
}
