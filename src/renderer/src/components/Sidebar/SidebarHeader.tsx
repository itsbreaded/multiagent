import React from 'react'

export function SidebarHeader(): JSX.Element {
  return (
    <div
      style={{
        padding: '10px 12px 8px',
        borderBottom: '1px solid #2a2b2e',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#8b8d91',
          userSelect: 'none',
          letterSpacing: '0.02em',
        }}
      >
        Sessions
      </span>
    </div>
  )
}
