import React, { useState, useEffect, useRef } from 'react'
import { border, sidebarStyles, ui } from '../../styles/theme'
import chevronDownIcon from '../../assets/chevrondown.png'
import chevronRightIcon from '../../assets/chevronright.png'

interface SidebarSectionProps {
  title: string
  count?: number
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onTitleClick?: () => void
  onTitleDoubleClick?: () => void
  children?: React.ReactNode
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>
  renaming?: boolean
  renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void
  headerDraggable?: boolean
  onHeaderDragStart?: React.DragEventHandler<HTMLDivElement>
  onHeaderDragEnd?: React.DragEventHandler<HTMLDivElement>
  onHeaderDragOver?: React.DragEventHandler<HTMLDivElement>
  onHeaderDragLeave?: React.DragEventHandler<HTMLDivElement>
  onHeaderDrop?: React.DragEventHandler<HTMLDivElement>
  headerDropActive?: boolean
  headerInsertTop?: boolean
  sectionInsertBottom?: boolean
  titleSuffix?: React.ReactNode
  headerActionsAlways?: React.ReactNode
  headerActions?: React.ReactNode
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
  headerDraggable,
  onHeaderDragStart,
  onHeaderDragEnd,
  onHeaderDragOver,
  onHeaderDragLeave,
  onHeaderDrop,
  headerDropActive,
  headerInsertTop,
  sectionInsertBottom,
  titleSuffix,
  headerActionsAlways,
  headerActions,
  style,
  contentStyle,
  contentClassName,
}: SidebarSectionProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const [hovered, setHovered] = useState(false)
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
    <div style={{ position: 'relative', flexShrink: 0, ...style }}>
      <div
        onContextMenu={onContextMenu}
        draggable={headerDraggable}
        onDragStart={onHeaderDragStart}
        onDragEnd={onHeaderDragEnd}
        onDragOver={onHeaderDragOver}
        onDragLeave={onHeaderDragLeave}
        onDrop={onHeaderDrop}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...sidebarStyles.sectionHeader,
          outline: headerDropActive ? border.accent : 'none',
          outlineOffset: -1,
          backgroundColor: headerDropActive ? ui.color.panelRaised : 'transparent',
          // Inset box-shadow for insertion line (no layout shift, distinct from pane-drop outline)
          boxShadow: headerInsertTop ? `inset 0 2px 0 ${ui.color.accent}` : 'none',
        }}
      >
        <button
          onClick={() => !renaming && setOpen((o) => !o)}
          style={{ ...sidebarStyles.sectionToggle, cursor: renaming ? 'default' : 'pointer' }}
        >
          <img src={open ? chevronDownIcon : chevronRightIcon} alt="" style={{ width: 12, height: 12, display: 'block', transform: 'scale(1.35)' }} />
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
        {titleSuffix && !renaming && titleSuffix}
        {headerActionsAlways && !renaming && (
          <div
            style={{
              marginLeft: count === undefined && !titleSuffix ? 'auto' : 0,
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {headerActionsAlways}
          </div>
        )}
        {headerActions && !renaming && (
          <div
            style={{
              ...sidebarStyles.hoverActionGroup,
              marginLeft: count === undefined && !titleSuffix && !headerActionsAlways ? 'auto' : 0,
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
            }}
          >
            {headerActions}
          </div>
        )}
      </div>
      {open && <div className={contentClassName} style={contentStyle}>{children}</div>}
      {sectionInsertBottom && (
        <div
          data-sidebar-insertion-edge="bottom"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            background: ui.color.accent,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}
