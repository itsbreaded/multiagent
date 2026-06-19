import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import type { AgentKind, PaneLeaf, PaneType, SplitDirection } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { paneLabelText } from '../../utils/tabLabels'
import { DirPicker } from '../DirPicker'
import { HOTKEYS } from '../../utils/hotkeys'
import { displayGitBranch } from '../../utils/git'
import { encodePaneDragPayload, PANE_DRAG_MIME } from '../../utils/paneDrag'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import { menuStyles, ui } from '../../styles/theme'
import { AgentIcon, ShellIcon } from '../AgentIcon'
import vsCodeIcon from '../../assets/vscode.png'
import folderOpenIcon from '../../assets/folderopen.png'
import splitRightIcon from '../../assets/splitright.png'
import splitDownIcon from '../../assets/splitdown.png'
import fullscreenOpenIcon from '../../assets/fullscreenopen.png'
import fullscreenCloseIcon from '../../assets/fullscreenclose.png'
import closeSmallIcon from '../../assets/closesmall.png'

const ICON_IMG: React.CSSProperties = { width: 16, height: 16, display: 'block' }

type SplitSpawnChoice = {
  paneType: PaneType
  agentKind?: AgentKind
}

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
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const windowId = usePanesStore((s) => s.windowId)

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const [splitMenu, setSplitMenu] = useState<{ direction: SplitDirection; x: number; y: number } | null>(null)
  const [dirPickerForSplit, setDirPickerForSplit] = useState<{ direction: SplitDirection; choice: SplitSpawnChoice } | null>(null)

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
  const session = pane.agentKind && pane.sessionId
    ? sessions.find((s) => s.agentKind === pane.agentKind && s.sessionId === pane.sessionId)
    : null
  const cwdBranch = useGitBranch(pane.cwd, showGitBranchBadges, isFocused)
  const branch = showGitBranchBadges ? displayGitBranch(cwdBranch) ?? displayGitBranch(session?.gitBranch) : null

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
          if (windowId !== null && activeTabId) {
            e.dataTransfer.setData(PANE_DRAG_MIME, encodePaneDragPayload({ pane, sourceTabId: activeTabId, sourceWindowId: windowId }))
          }
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
          color: '#6b7280',
          flexShrink: 0,
          fontFamily: 'monospace',
          width: 16,
          textAlign: 'center',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isAgent ? <AgentIcon agentKind={pane.agentKind ?? 'claude'} size={16} /> : <ShellIcon size={16} />}
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
          <img src={folderOpenIcon} alt="Open in folder" style={ICON_IMG} />
        </HeaderButton>
      )}
      {vsCodeAvailable && !renaming && (
        <HeaderButton
          title="Open in VS Code"
          onClick={() => window.ipc.invoke('shell:open-vscode', pane.cwd).catch(() => {})}
        >
          <img src={vsCodeIcon} alt="VS Code" style={ICON_IMG} />
        </HeaderButton>
      )}
      {!isZoomed && (
        <>
          <HeaderButton
            title={`Split vertical (${HOTKEYS.splitVertical.display})`}
            onClick={(e) => setSplitMenu({ direction: 'vertical', x: e.clientX, y: e.clientY })}
          >
            <img src={splitRightIcon} alt="Split right" style={ICON_IMG} />
          </HeaderButton>
          <HeaderButton
            title={`Split horizontal (${HOTKEYS.splitHorizontal.display})`}
            onClick={(e) => setSplitMenu({ direction: 'horizontal', x: e.clientX, y: e.clientY })}
          >
            <img src={splitDownIcon} alt="Split down" style={ICON_IMG} />
          </HeaderButton>
        </>
      )}
      <HeaderButton
        title={isZoomed ? 'Unzoom' : `Zoom pane (${HOTKEYS.zoomPane.display})`}
        onClick={() => (isZoomed ? unzoom() : zoomPane(pane.id))}
      >
        <img src={isZoomed ? fullscreenCloseIcon : fullscreenOpenIcon} alt={isZoomed ? 'Unzoom' : 'Zoom'} style={ICON_IMG} />
      </HeaderButton>
      <HeaderButton title={`Close pane (${HOTKEYS.closePane.display})`} onClick={() => closePane(pane.id)}>
        <img src={closeSmallIcon} alt="Close pane" style={{ ...ICON_IMG, opacity: 0.5 }} />
      </HeaderButton>

      {/* Split direction context menu */}
      {splitMenu && (
        <SplitDirMenu
          direction={splitMenu.direction}
          x={splitMenu.x}
          y={splitMenu.y}
          onClose={() => setSplitMenu(null)}
          onSplit={(choice) => {
            splitPane(pane.id, splitMenu.direction, choice.paneType, pane.cwd, choice.agentKind)
            setSplitMenu(null)
          }}
          onBrowse={(choice) => {
            setDirPickerForSplit({ direction: splitMenu.direction, choice })
            setSplitMenu(null)
          }}
        />
      )}

      {/* DirPicker for one-off split directory */}
      {dirPickerForSplit && (
        <DirPicker
          title={`Start ${splitChoiceLabel(dirPickerForSplit.choice)} in...`}
          initial={activeTab?.defaultCwd ?? pane.cwd}
          confirmLabel="Split"
          skipLabel="Cancel"
          autoBrowse
          onConfirm={(dir) => {
            const { direction, choice } = dirPickerForSplit
            splitPane(pane.id, direction, choice.paneType, dir, choice.agentKind)
            setDirPickerForSplit(null)
          }}
          onSkip={() => setDirPickerForSplit(null)}
        />
      )}
    </div>
  )
}

// --- Split directory context menu ---

function SplitDirMenu({
  direction,
  x,
  y,
  onClose,
  onSplit,
  onBrowse,
}: {
  direction: SplitDirection
  x: number
  y: number
  onClose: () => void
  onSplit: (choice: SplitSpawnChoice) => void
  onBrowse: (choice: SplitSpawnChoice) => void
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
  const choices: SplitSpawnChoice[] = [
    { paneType: 'agent', agentKind: 'claude' },
    { paneType: 'agent', agentKind: 'codex' },
    { paneType: 'shell' },
  ]

  function row(choice: SplitSpawnChoice, label: string, onClick: () => void): JSX.Element {
    return (
      <button
        onClick={onClick}
        style={{
          ...menuStyles.item,
          color: ui.color.text,
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.control }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 13, opacity: 0.8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16 }}>
          {choice.paneType === 'agent'
            ? <AgentIcon agentKind={choice.agentKind ?? 'claude'} size={16} />
            : <ShellIcon size={16} />}
        </span>
      </button>
    )
  }

  function sep(): JSX.Element {
    return <div style={menuStyles.separator} />
  }

  return (
    <>
      <div style={menuStyles.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        ref={menuRef}
        style={{
          ...menuStyles.panel,
          left: pos.left,
          top: pos.top,
          minWidth: 220,
          visibility: pos.visible ? 'visible' : 'hidden',
        }}
      >
        <div style={menuStyles.label}>
          {dirLabel}
        </div>
        {sep()}
        <MenuLabel>Current Directory</MenuLabel>
        {choices.map((choice) => (
          <React.Fragment key={`current:${splitChoiceKey(choice)}`}>
            {row(choice, splitChoiceLabel(choice), () => onSplit(choice))}
          </React.Fragment>
        ))}
        {sep()}
        <MenuLabel>Choose Directory</MenuLabel>
        {choices.map((choice) => (
          <React.Fragment key={`browse:${splitChoiceKey(choice)}`}>
            {row(choice, `${splitChoiceLabel(choice)}...`, () => onBrowse(choice))}
          </React.Fragment>
        ))}
      </div>
    </>
  )
}

function MenuLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={menuStyles.label}>{children}</div>
}

function splitChoiceLabel(choice: SplitSpawnChoice): string {
  if (choice.paneType === 'shell') return 'Shell'
  return choice.agentKind === 'codex' ? 'Codex CLI' : 'Claude Code'
}

function splitChoiceKey(choice: SplitSpawnChoice): string {
  return choice.paneType === 'shell' ? 'shell' : `agent:${choice.agentKind ?? 'claude'}`
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
        color: copied ? '#4ade80' : '#6b7280',
        cursor: 'pointer',
        flexShrink: 0,
        letterSpacing: '0.02em',
        transition: 'color 0.15s',
      }}
      onMouseEnter={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = '#9ca3af' }}
      onMouseLeave={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = '#6b7280' }}
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
