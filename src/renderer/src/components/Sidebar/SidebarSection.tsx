import React, { useState, useEffect, useRef } from 'react'
import { border, sidebarStyles, ui } from '../../styles/theme'

interface SidebarSectionProps {
  title: string
  count?: number
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onTitleClick?: () => void
  onTitleDoubleClick?: () => void
  children: React.ReactNode
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>
  renaming?: boolean
  renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void
  onHeaderDragOver?: React.DragEventHandler<HTMLDivElement>
  onHeaderDragLeave?: React.DragEventHandler<HTMLDivElement>
  onHeaderDrop?: React.DragEventHandler<HTMLDivElement>
  headerDropActive?: boolean
  style?: React.CSSProperties
  contentStyle?: React.CSSProperties
  contentClassName?: string
}

export function SidebarSection({
  title,
  count,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  onTitleClick,
  onTitleDoubleClick,
  children,
  onContextMenu,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onHeaderDragOver,
  onHeaderDragLeave,
  onHeaderDrop,
  headerDropActive,
  style,
  contentStyle,
  contentClassName,
}: SidebarSectionProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const inputRef = useRef<HTMLInputElement>(null)

  function setOpen(next: boolean | ((current: boolean) => boolean)) {
    const value = typeof next === 'function' ? next(open) : next
    if (controlledOpen === undefined) setUncontrolledOpen(value)
    onOpenChange?.(value)
  }

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  return (
    <div style={{ flexShrink: 0, ...style }}>
      <div
        onContextMenu={onContextMenu}
        onDragOver={onHeaderDragOver}
        onDragLeave={onHeaderDragLeave}
        onDrop={onHeaderDrop}
        style={{
          ...sidebarStyles.sectionHeader,
          outline: headerDropActive ? border.accent : 'none',
          outlineOffset: -1,
          backgroundColor: headerDropActive ? ui.color.panelRaised : 'transparent',
        }}
      >
        <button
          onClick={() => !renaming && setOpen((o) => !o)}
          style={{ ...sidebarStyles.sectionToggle, cursor: renaming ? 'default' : 'pointer' }}
        >
          <span style={{ fontSize: 9, transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            ▶
          </span>
        </button>

        {renaming ? (
          <input
            ref={inputRef}
            value={renameValue ?? ''}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onRenameCommit?.() }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onRenameCancel?.() }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: border.accent,
              borderRadius: ui.radius.xs,
              color: ui.color.text,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              padding: '0 2px',
              minWidth: 0,
            }}
          />
        ) : (
          <button
            onClick={() => {
              if (onTitleClick) onTitleClick()
              else setOpen((o) => !o)
            }}
            onDoubleClick={(e) => {
              if (!onTitleDoubleClick) return
              e.preventDefault()
              e.stopPropagation()
              onTitleDoubleClick()
            }}
            style={sidebarStyles.sectionTitleButton}
          >
            {title}
          </button>
        )}

        {count !== undefined && !renaming && (
          <span
            style={sidebarStyles.sectionCount}
          >
            {count}
          </span>
        )}
      </div>
      {open && <div className={contentClassName} style={contentStyle}>{children}</div>}
    </div>
  )
}
