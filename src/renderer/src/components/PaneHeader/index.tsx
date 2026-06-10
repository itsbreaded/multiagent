import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import type { PaneLeaf, SplitDirection } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { paneLabelText } from '../../utils/tabLabels'
import { DirPicker } from '../DirPicker'
import { HOTKEYS } from '../../utils/hotkeys'
import { agentAccent, agentBadge, agentLabel } from '../../utils/agents'
import { displayGitBranch } from '../../utils/git'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import vsCodeIcon from '../../assets/vscode.png'
import splitRightIcon from '../../assets/splitright.png'
import splitDownIcon from '../../assets/splitdown.png'

interface PaneHeaderProps {
  pane: PaneLeaf
  isFocused: boolean
}

export function PaneHeader({ pane, isFocused }: PaneHeaderProps): JSX.Element {
  const splitPane = usePanesStore((s) => s.splitPane)
  const closePane = usePanesStore((s) => s.closePane)
  const zoomPane = usePanesStore((s) => s.zoomPane)
  const unzoom = usePanesStore((s) => s.unzoom)
  const zoomedPaneId = usePanesStore((s) => s.zoomedPaneId)
  const setPaneCustomName = usePanesStore((s) => s.setPaneCustomName)
  const setDraggedPane = usePanesStore((s) => s.setDraggedPane)
  const vsCodeAvailable = usePanesStore((s) => s.vsCodeAvailable)
  const sessions = useSessionsStore((s) => s.sessions)
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)

  const activeTab = usePanesStore((s) => s.activeTab())

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const [splitMenu, setSplitMenu] = useState<{ direction: SplitDirection; x: number; y: number } | null>(null)
  const [dirPickerForSplit, setDirPickerForSplit] = useState<SplitDirection | null>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  function startRename(e: React.MouseEvent): void {
    e.stopPropagation()
    setRenameValue(pane.customName ?? '')
    setRenaming(true)
  }

  function commitRename(): void {
    setPaneCustomName(pane.id, renameValue)
    setRenaming(false)
  }

  const label = paneLabelText(pane, sessions)
  const isZoomed = zoomedPaneId === pane.id
  const isAgent = pane.paneType === 'agent'
  const icon = isAgent ? agentBadge(pane.agentKind ?? 'claude') : '>'
  const session = pane.agentKind && pane.sessionId
    ? sessions.find((s) => s.agentKind === pane.agentKind && s.sessionId === pane.sessionId)
    : null
  const cwdBranch = useGitBranch(pane.cwd, showGitBranchBadges, isFocused)
  const branch = showGitBranchBadges ? displayGitBranch(session?.gitBranch) ?? displayGitBranch(cwdBranch) : null

  return (
    <div
      style={{
        height: 28,
        backgroundColor: isFocused ? '#1e2022' : '#161819',
        borderTop: isFocused ? '2px solid #4ade80' : '2px solid transparent',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 4,
        gap: 6,
        flexShrink: 0,
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Drag handle */}
      <span
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', pane.id)
          setDraggedPane(pane.id)
        }}
        onDragEnd={() => setDraggedPane(null)}
        title="Drag to rearrange pane"
        style={{
          fontSize: 10,
          color: '#3a3b3e',
          cursor: 'grab',
          flexShrink: 0,
          lineHeight: 1,
          userSelect: 'none',
          paddingRight: 2,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#6b7280' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#3a3b3e' }}
      >
        ⠿
      </span>

      {/* Type icon */}
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: isAgent ? agentAccent(pane.agentKind ?? 'claude') : '#6b7280',
          flexShrink: 0,
          fontFamily: 'monospace',
          width: 14,
          textAlign: 'center',
        }}
      >
        {icon}
      </span>

      {/* Title — double-click to rename */}
      {renaming ? (
        <input
          ref={inputRef}
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
            background: '#141517',
            border: '1px solid #4ade80',
            borderRadius: 3,
            color: '#c9cdd1',
            fontSize: 12,
            padding: '1px 4px',
            outline: 'none',
            width: 120,
            flexShrink: 0,
          }}
        />
      ) : (
        <span
          onDoubleClick={startRename}
          title="Double-click to add a label"
          style={{
            fontSize: 12,
            color: isFocused ? '#d4d4d4' : '#6b7280',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
            cursor: 'default',
          }}
        >
          {label}
        </span>
      )}

      {/* Git branch */}
      {branch && !renaming && (
        <span
          style={{
            fontSize: 11,
            color: '#4a4b4e',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
          }}
        >
          {branch}
        </span>
      )}

      <div style={{ flex: 1 }} />

      {/* Session ID — click to copy full ID */}
      {isAgent && pane.sessionId && !renaming && (
        <SessionIdBadge sessionId={pane.sessionId} />
      )}

      {/* Action buttons */}
      {!renaming && (
        <HeaderButton
          title="Open in folder"
          onClick={() => window.ipc.invoke('shell:open-folder', pane.cwd).catch(() => {})}
        >
          <svg width="15" height="13" viewBox="0 0 13 11" fill="currentColor" style={{ display: 'block' }}>
            <rect x="0" y="2.5" width="13" height="8" rx="1.5" />
            <rect x="0" y="0" width="6" height="4" rx="1.5" />
          </svg>
        </HeaderButton>
      )}
      {vsCodeAvailable && !renaming && (
        <HeaderButton
          title="Open in VS Code"
          onClick={() => window.ipc.invoke('shell:open-vscode', pane.cwd).catch(() => {})}
        >
          <img src={vsCodeIcon} alt="VS Code" style={{ width: 21, height: 21, display: 'block' }} />
        </HeaderButton>
      )}
      {!isZoomed && (
        <>
          <HeaderButton
            title={`Split vertical (${HOTKEYS.splitVertical.display})`}
            onClick={(e) => setSplitMenu({ direction: 'vertical', x: e.clientX, y: e.clientY })}
          >
            <img src={splitRightIcon} alt="Split right" style={{ width: 15, height: 15, display: 'block' }} />
          </HeaderButton>
          <HeaderButton
            title={`Split horizontal (${HOTKEYS.splitHorizontal.display})`}
            onClick={(e) => setSplitMenu({ direction: 'horizontal', x: e.clientX, y: e.clientY })}
          >
            <img src={splitDownIcon} alt="Split down" style={{ width: 15, height: 15, display: 'block' }} />
          </HeaderButton>
        </>
      )}
      <HeaderButton
        title={isZoomed ? 'Unzoom' : `Zoom pane (${HOTKEYS.zoomPane.display})`}
        onClick={() => (isZoomed ? unzoom() : zoomPane(pane.id))}
      >
        {isZoomed ? '⊟' : '⤢'}
      </HeaderButton>
      <HeaderButton title={`Close pane (${HOTKEYS.closePane.display})`} onClick={() => closePane(pane.id)}>×</HeaderButton>

      {/* Split direction context menu */}
      {splitMenu && (
        <SplitDirMenu
          pane={pane}
          direction={splitMenu.direction}
          x={splitMenu.x}
          y={splitMenu.y}
          tabDefaultCwd={activeTab?.defaultCwd}
          onClose={() => setSplitMenu(null)}
          onSplit={(cwd) => { splitPane(pane.id, splitMenu.direction, pane.paneType, cwd, pane.agentKind); setSplitMenu(null) }}
          onBrowse={() => { setDirPickerForSplit(splitMenu.direction); setSplitMenu(null) }}
        />
      )}

      {/* DirPicker for one-off split directory */}
      {dirPickerForSplit && (
        <DirPicker
          title={`Start ${isAgent ? `${agentLabel(pane.agentKind ?? 'claude')} session` : 'shell'} in...`}
          initial={activeTab?.defaultCwd ?? pane.cwd}
          confirmLabel="Split"
          skipLabel="Cancel"
          onConfirm={(dir) => { splitPane(pane.id, dirPickerForSplit, pane.paneType, dir, pane.agentKind); setDirPickerForSplit(null) }}
          onSkip={() => setDirPickerForSplit(null)}
        />
      )}
    </div>
  )
}

// --- Split directory context menu ---

function SplitDirMenu({
  pane,
  direction,
  x,
  y,
  tabDefaultCwd,
  onClose,
  onSplit,
  onBrowse,
}: {
  pane: PaneLeaf
  direction: SplitDirection
  x: number
  y: number
  tabDefaultCwd?: string
  onClose: () => void
  onSplit: (cwd?: string) => void
  onBrowse: () => void
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({ left: x, top: y, visible: false })

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

  const dirLabel = direction === 'vertical' ? 'Split vertical' : 'Split horizontal'

  function menuBtn(label: string, sub: string | null, onClick: () => void, dimmed = false): JSX.Element {
    return (
      <button
        onClick={onClick}
        style={{
          display: 'block',
          width: '100%',
          padding: '6px 12px',
          background: 'none',
          border: 'none',
          textAlign: 'left',
          fontSize: 12,
          color: dimmed ? '#4a4b4e' : '#c9cdd1',
          cursor: dimmed ? 'default' : 'pointer',
        }}
        onMouseEnter={(e) => { if (!dimmed) (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        <div>{label}</div>
        {sub && <div style={{ fontSize: 10, color: '#4a4b4e', fontFamily: 'monospace', marginTop: 1 }}>{sub}</div>}
      </button>
    )
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 200 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        ref={menuRef}
        style={{
          position: 'fixed', left: pos.left, top: pos.top, zIndex: 201,
          backgroundColor: '#1a1b1e', border: '1px solid #2a2b2e',
          borderRadius: 6, padding: '4px 0', minWidth: 220,
          boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
          visibility: pos.visible ? 'visible' : 'hidden',
        }}
      >
        <div style={{ padding: '4px 12px 6px', fontSize: 10, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {dirLabel}
        </div>
        <div style={{ height: 1, backgroundColor: '#2a2b2e', margin: '0 0 4px' }} />
        {menuBtn('Same directory', pane.cwd, () => onSplit())}
        {menuBtn(
          tabDefaultCwd ? 'Tab default' : 'Tab default (not set)',
          tabDefaultCwd ?? null,
          tabDefaultCwd ? () => onSplit(tabDefaultCwd) : () => {},
          !tabDefaultCwd,
        )}
        <div style={{ height: 1, backgroundColor: '#2a2b2e', margin: '4px 0' }} />
        {menuBtn('Choose directory...', null, onBrowse)}
      </div>
    </>
  )
}

function SessionIdBadge({ sessionId }: { sessionId: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (window.ipc) {
      window.ipc.invoke('shell:copy-to-clipboard', sessionId).catch(() => {})
    } else {
      navigator.clipboard.writeText(sessionId).catch(() => {})
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <span
      onClick={handleClick}
      title={`Session ID: ${sessionId}\nClick to copy`}
      style={{
        fontSize: 10,
        fontFamily: 'monospace',
        color: copied ? '#4ade80' : '#3a3b3e',
        cursor: 'pointer',
        flexShrink: 0,
        letterSpacing: '0.02em',
        transition: 'color 0.15s',
      }}
      onMouseEnter={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = '#6b7280' }}
      onMouseLeave={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = '#3a3b3e' }}
    >
      {copied ? '✓' : sessionId.slice(0, 8)}
    </span>
  )
}

function HeaderButton({
  onClick,
  title,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'none',
        border: 'none',
        color: '#5a5c61',
        cursor: 'pointer',
        padding: '2px 3px',
        fontSize: 13,
        lineHeight: 1,
        borderRadius: 3,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = '#d4d4d4'
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = '#5a5c61'
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'
      }}
    >
      {children}
    </button>
  )
}
