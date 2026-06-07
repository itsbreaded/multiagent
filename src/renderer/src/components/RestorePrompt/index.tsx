import { useEffect, useRef } from 'react'
import type { Tab } from '../../../../shared/types'

interface Props {
  tabs: Tab[]
  onRestore: () => void
  onDiscard: () => void
}

export function RestorePrompt({ tabs, onRestore, onDiscard }: Props): JSX.Element {
  const restoreRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    restoreRef.current?.focus()
  }, [])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Enter') { e.preventDefault(); onRestore() }
      if (e.key === 'Escape') { e.preventDefault(); onDiscard() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onRestore, onDiscard])

  const tabCount = tabs.length
  const label = tabCount === 1 ? '1 tab' : `${tabCount} tabs`

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        backgroundColor: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          padding: '28px 32px',
          width: 360,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#d4d4d4', marginBottom: 6 }}>
            Restore previous session?
          </div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            You had {label} open. Restore them, or start fresh.
          </div>
        </div>

        {tabCount > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tabs.slice(0, 5).map((tab) => (
              <div
                key={tab.id}
                style={{
                  fontSize: 12,
                  color: '#4a4b4e',
                  padding: '3px 8px',
                  backgroundColor: '#141517',
                  borderRadius: 4,
                  border: '1px solid #232427',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.customLabel ?? tabSummary(tab)}
              </div>
            ))}
            {tabCount > 5 && (
              <div style={{ fontSize: 11, color: '#4a4b4e', paddingLeft: 4 }}>
                +{tabCount - 5} more
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onDiscard}
            style={{
              padding: '7px 16px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid #2a2b2e',
              backgroundColor: 'transparent',
              color: '#6b7280',
              cursor: 'pointer',
            }}
          >
            Start Fresh
          </button>
          <button
            ref={restoreRef}
            onClick={onRestore}
            style={{
              padding: '7px 18px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid #3a6b3a',
              backgroundColor: '#1e3a1e',
              color: '#4ade80',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Restore
          </button>
        </div>
      </div>
    </div>
  )
}

function tabSummary(tab: Tab): string {
  // Best-effort: pull cwd from the focused pane or first leaf
  function firstLeafCwd(node: import('../../../../shared/types').PaneNode): string | null {
    if (node.type === 'leaf') return node.cwd
    return firstLeafCwd(node.first) ?? firstLeafCwd(node.second)
  }
  const cwd = tab.rootNode ? firstLeafCwd(tab.rootNode) : null
  if (!cwd) return 'Tab'
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}
