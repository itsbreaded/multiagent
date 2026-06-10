import React, { useState, useEffect, useRef } from 'react'

interface SidebarSectionProps {
  title: string
  count?: number
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
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
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 12px',
          color: '#6b7280',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          userSelect: 'none',
          boxSizing: 'border-box',
          outline: headerDropActive ? '1px solid #4ade80' : 'none',
          outlineOffset: -1,
          backgroundColor: headerDropActive ? '#1e2022' : 'transparent',
        }}
      >
        <button
          onClick={() => !renaming && setOpen((o) => !o)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: renaming ? 'default' : 'pointer', color: 'inherit', flexShrink: 0, display: 'flex', alignItems: 'center' }}
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
              outline: '1px solid #4ade80',
              borderRadius: 2,
              color: '#c9cdd1',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              padding: '0 2px',
              textTransform: 'uppercase',
              minWidth: 0,
            }}
          />
        ) : (
          <button
            onClick={() => setOpen((o) => !o)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', flex: 1, textAlign: 'left' }}
          >
            {title}
          </button>
        )}

        {count !== undefined && !renaming && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: '#4a4b4e',
              fontWeight: 400,
              textTransform: 'none',
              letterSpacing: 0,
              flexShrink: 0,
            }}
          >
            {count}
          </span>
        )}
      </div>
      {open && <div className={contentClassName} style={contentStyle}>{children}</div>}
    </div>
  )
}
