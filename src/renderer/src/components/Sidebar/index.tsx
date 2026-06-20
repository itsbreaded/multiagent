import React, { useRef, useCallback } from 'react'
import { RECENT_SECTION_ID, usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import { SidebarSection } from './SidebarSection'
import { SessionRow } from './SessionRow'
import { TabSections } from './TabSections'
import { border, sidebarStyles, ui } from '../../styles/theme'
import newFolderIcon from '../../assets/newfolder.png'

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')

export function Sidebar(): JSX.Element {
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const sidebarPanelSizes = usePanesStore((s) => s.sidebarPanelSizes)
  const setSidebarWidth = usePanesStore((s) => s.setSidebarWidth)
  const setSidebarPanelSize = usePanesStore((s) => s.setSidebarPanelSize)
  const addTab = usePanesStore((s) => s.addTab)
  const setPendingRenameTabId = usePanesStore((s) => s.setPendingRenameTabId)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)
  const sidebarSectionOpen = usePanesStore((s) => s.sidebarSectionOpen)
  const setSidebarSectionOpen = usePanesStore((s) => s.setSidebarSectionOpen)
  const { resumable, loading } = useSessions()

  function activeCwd(): string {
    return getFocusedPane()?.cwd ?? DEFAULT_CWD
  }

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
        <button
          title="New Project Folder"
          onClick={() => { const id = addTab(activeCwd()); setPendingRenameTabId(id) }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            width: '100%',
            height: 26,
            flexShrink: 0,
            background: 'none',
            border: border.default,
            borderRadius: 5,
            cursor: 'pointer',
            padding: '0 8px',
            color: ui.color.text,
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          <img src={newFolderIcon} alt="" style={{ width: 14, height: 14, opacity: 0.8, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            New Project Folder
          </span>
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
    </div>
  )
}
