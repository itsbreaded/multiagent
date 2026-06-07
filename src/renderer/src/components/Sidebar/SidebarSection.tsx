import React, { useState } from 'react'

interface SidebarSectionProps {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>
}

export function SidebarSection({
  title,
  count,
  defaultOpen = true,
  children,
  onContextMenu,
}: SidebarSectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div style={{ flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 12px',
          background: 'none',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          color: '#6b7280',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 9, transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        <span>{title}</span>
        {count !== undefined && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: '#4a4b4e',
              fontWeight: 400,
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            {count}
          </span>
        )}
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}
