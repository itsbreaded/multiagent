import React, { useState, useEffect, useRef } from 'react'

interface SidebarSectionProps {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>
  renaming?: boolean
  renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void
}

export function SidebarSection({
  title,
  count,
  defaultOpen = true,
  children,
  onContextMenu,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: SidebarSectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  return (
    <div style={{ flexShrink: 0 }}>
      <div
        onContextMenu={onContextMenu}
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
      {open && <div>{children}</div>}
    </div>
  )
}
