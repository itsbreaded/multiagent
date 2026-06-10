import React, { useMemo, useState } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'

type SettingsSection = 'general' | 'appearance'

export function SettingsPanel(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)
  const setShowGitBranchBadges = useSettingsStore((s) => s.setShowGitBranchBadges)
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance')
  const [query, setQuery] = useState('')

  const sections = useMemo(() => [
    { id: 'appearance' as const, label: 'Appearance', count: 1 },
    { id: 'general' as const, label: 'General', count: 0 },
  ], [])

  const normalizedQuery = query.trim().toLowerCase()
  const showBranchSetting = !normalizedQuery || 'git branch badges tabs panes'.includes(normalizedQuery)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        backgroundColor: 'rgba(0,0,0,0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={closeOverlays}
    >
      <div
        role="dialog"
        aria-label="Settings"
        style={{
          width: '85vw',
          maxWidth: 960,
          height: '75vh',
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          display: 'flex',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <aside
          style={{
            width: 200,
            borderRight: '1px solid #2a2b2e',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            padding: '8px 0',
          }}
        >
          <SectionLabel>Settings</SectionLabel>
          {sections.map((section) => {
            const active = activeSection === section.id
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '7px 12px',
                  background: active ? '#242528' : 'none',
                  border: 'none',
                  borderLeft: active ? '2px solid #4ade80' : '2px solid transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: active ? '#d4d4d4' : '#6b7280',
                }}
              >
                <span>{section.label}</span>
                {section.count > 0 && <span style={{ color: '#4a4b4e', fontSize: 11 }}>{section.count}</span>}
              </button>
            )
          })}
        </aside>

        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid #2a2b2e',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: '#d4d4d4' }}>Settings</span>
            <span style={{ fontSize: 11, color: '#4a4b4e' }}>ESC to close</span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid #2a2b2e',
              flexShrink: 0,
            }}
          >
            <span style={{ color: '#6b7280', fontSize: 14, marginRight: 8 }}>{'>'}</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder="Search settings"
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                outline: 'none',
                color: '#d4d4d4',
                fontSize: 14,
                caretColor: '#4ade80',
              }}
            />
          </div>

          <div className="dark-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            <SectionLabel>{activeSection === 'appearance' ? 'Appearance' : 'General'}</SectionLabel>

            {activeSection === 'appearance' && showBranchSetting && (
              <SettingRow
                title="Git branch badges"
                description="Show the current branch beside tab default directories and pane directories."
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c9cdd1', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={showGitBranchBadges}
                    onChange={(e) => setShowGitBranchBadges(e.target.checked)}
                  />
                  Enabled
                </label>
              </SettingRow>
            )}

            {activeSection === 'general' && (
              <div style={{ color: '#4a4b4e', fontSize: 12, padding: '14px' }}>
                No general settings yet.
              </div>
            )}

            {activeSection === 'appearance' && !showBranchSetting && (
              <div style={{ color: '#4a4b4e', fontSize: 12, padding: '14px' }}>
                No settings match your search.
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        padding: '6px 14px 3px',
        fontSize: 10,
        fontWeight: 600,
        color: '#4a4b4e',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  )
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section
      style={{
        padding: '10px 12px',
        marginBottom: 4,
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        backgroundColor: '#141517',
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 1fr) minmax(160px, auto)',
        gap: 24,
        alignItems: 'center',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#d4d4d4', fontSize: 13, marginBottom: 4 }}>{title}</div>
        <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.4 }}>{description}</div>
      </div>
      <div>{children}</div>
    </section>
  )
}
