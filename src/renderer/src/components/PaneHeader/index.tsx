import React, { useState, useRef, useEffect } from 'react'
import type { PaneLeaf, SplitDirection } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { paneLabelText } from '../../utils/tabLabels'
import { DirPicker } from '../DirPicker'
import { HOTKEYS } from '../../utils/hotkeys'
import { displayGitBranch } from '../../utils/git'
import { setPaneDragData } from '../../utils/paneDrag'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import { AgentIcon, ShellIcon } from '../AgentIcon'
import { SpawnChoiceMenu, spawnChoiceLabel, type SpawnChoice } from '../SpawnChoiceMenu'
import vsCodeIcon from '../../assets/vscode.png'
import folderOpenIcon from '../../assets/folderopen.png'
import addBoxIcon from '../../assets/addbox.png'
import fullscreenOpenIcon from '../../assets/fullscreenopen.png'
import fullscreenCloseIcon from '../../assets/fullscreenclose.png'
import closeSmallIcon from '../../assets/closesmall.png'

const ICON_IMG: React.CSSProperties = { width: 16, height: 16, display: 'block' }

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
  const startSwapDrag = usePanesStore((s) => s.startSwapDrag)
  const setSwapDragTarget = usePanesStore((s) => s.setSwapDragTarget)
  const clearSwapDrag = usePanesStore((s) => s.clearSwapDrag)
  const swapPanes = usePanesStore((s) => s.swapPanes)
  const vsCodeAvailable = usePanesStore((s) => s.vsCodeAvailable)
  const sessions = useSessionsStore((s) => s.sessions)
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)

  const activeTab = usePanesStore((s) => s.activeTab())
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const windowId = usePanesStore((s) => s.windowId)

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null)
  const [dirPickerForSplit, setDirPickerForSplit] = useState<{ direction: SplitDirection; choice: SpawnChoice } | null>(null)

  // Right-button drag on the handle swaps panes (native HTML5 DnD is left-button only, so
  // this is a manual pointer drag that runs alongside the left-drag-to-split gesture).
  const swapCleanupRef = useRef<(() => void) | null>(null)
  // Left-button native drag (split). Cleanup is driven from window-level listeners, not the
  // source element's onDragEnd, because a successful split remounts this PaneHeader (the
  // pane tree restructures) and the element's onDragEnd can be lost before it fires —
  // which left the grabbing cursor / drag state stuck.
  const nativeDragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { swapCleanupRef.current?.(); nativeDragCleanupRef.current?.() }, [])

  function beginNativeDrag(): void {
    nativeDragCleanupRef.current?.()
    document.body.classList.add('pane-dragging')
    // Class-only cleanup. Do NOT mutate the store here: this runs in the capture phase,
    // BEFORE the drop target's React onDrop, and clearing draggedPaneId synchronously
    // re-renders the target out of its drop-accepting state (Zustand/useSyncExternalStore),
    // which silently cancels the split. draggedPaneId is cleared in onDragEnd (fires after
    // the drop). `drop` (capture) survives source remount; `dragend` covers cancels.
    const end = (): void => {
      document.body.classList.remove('pane-dragging')
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, true)
      nativeDragCleanupRef.current = null
    }
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    nativeDragCleanupRef.current = end
  }

  function beginSwapDrag(e: React.MouseEvent): void {
    if (e.button !== 2) return
    e.preventDefault()
    e.stopPropagation()
    swapCleanupRef.current?.()
    const sourceId = pane.id
    startSwapDrag(sourceId)
    document.body.classList.add('pane-dragging')

    const resolveTarget = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      const id = el?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
      return id && id !== sourceId ? id : null
    }
    const onMove = (ev: MouseEvent): void => setSwapDragTarget(resolveTarget(ev.clientX, ev.clientY))
    const onUp = (ev: MouseEvent): void => {
      const target = resolveTarget(ev.clientX, ev.clientY)
      cleanup()
      clearSwapDrag()
      if (target) swapPanes(sourceId, target)
    }
    // Suppress the contextmenu that fires on right-button release; self-removes after firing.
    // preventDefault() alone only kills the native OS menu — the event still reaches React's
    // delegated handler on the root, so the Terminal's custom Copy/Paste menu would open.
    // stopImmediatePropagation() in the window capture phase stops it before React sees it.
    const onContextMenu = (ev: MouseEvent): void => {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      window.removeEventListener('contextmenu', onContextMenu, true)
    }
    const cleanup = (): void => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      // Defer removing the contextmenu suppressor so the trailing event is still caught.
      setTimeout(() => window.removeEventListener('contextmenu', onContextMenu, true), 0)
      document.body.classList.remove('pane-dragging')
      swapCleanupRef.current = null
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    swapCleanupRef.current = cleanup
  }

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
          if (windowId !== null && activeTabId) {
            setPaneDragData(e.dataTransfer, { pane, sourceTabId: activeTabId, sourceWindowId: windowId })
          }
          setDraggedPane(pane.id)
          beginNativeDrag()
        }}
        onDragEnd={() => { setDraggedPane(null); nativeDragCleanupRef.current?.() }}
        onMouseDown={beginSwapDrag}
        title="Left-drag to split · Right-drag to swap"
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
        <HeaderButton
          title="Split pane / new session"
          onClick={(e) => setSplitMenu({ x: e.clientX, y: e.clientY })}
        >
          <img src={addBoxIcon} alt="Split pane" style={ICON_IMG} />
        </HeaderButton>
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

      {/* Spawn choice context menu */}
      {splitMenu && (
        <SpawnChoiceMenu
          x={splitMenu.x}
          y={splitMenu.y}
          currentDirLabel="In current directory"
          onClose={() => setSplitMenu(null)}
          onSpawn={(choice, direction) => {
            splitPane(pane.id, direction, choice.paneType, pane.cwd, choice.agentKind)
            setSplitMenu(null)
          }}
          onBrowse={(choice, direction) => {
            setDirPickerForSplit({ direction, choice })
            setSplitMenu(null)
          }}
        />
      )}

      {/* DirPicker for one-off split directory */}
      {dirPickerForSplit && (
        <DirPicker
          title={`Start ${spawnChoiceLabel(dirPickerForSplit.choice)} in...`}
          initial={activeTab?.defaultCwd ?? pane.cwd}
          confirmLabel="Split"
          skipLabel="Cancel"
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
