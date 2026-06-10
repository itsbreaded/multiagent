import React, { useMemo, useState } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'

type SettingsSection = 'general' | 'appearance'

export function SettingsPanel(): JSX.Element {
  const toggleSettings = usePanesStore((s) => s.toggleSettings)
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
    <>
      <div
        onClick={toggleSettings}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 300,
          backgroundColor: 'rgba(0,0,0,0.35)',
        }}
      />
      <div
        role="dialog"
        aria-label="Settings"
        style={{
          position: 'fixed',
          top: 56,
          right: 24,
          bottom: 24,
          width: 'min(920px, calc(100vw - 48px))',
          zIndex: 301,
          backgroundColor: '#1e1e1e',
          border: '1px solid #3c3c3c',
          boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
          display: 'flex',
          minHeight: 420,
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <aside
          style={{
            width: 190,
            flexShrink: 0,
            backgroundColor: '#252526',
            borderRight: '1px solid #333333',
            padding: '14px 0',
          }}
        >
          <div style={{ padding: '0 16px 12px', fontSize: 11, color: '#8a8a8a', textTransform: 'uppercase' }}>
            Settings
          </div>
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              style={{
                width: '100%',
                height: 30,
                padding: '0 16px',
                border: 'none',
                backgroundColor: activeSection === section.id ? '#37373d' : 'transparent',
                color: activeSection === section.id ? '#ffffff' : '#cccccc',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <span>{section.label}</span>
              {section.count > 0 && <span style={{ color: '#858585', fontSize: 11 }}>{section.count}</span>}
            </button>
          ))}
        </aside>

        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', backgroundColor: '#1e1e1e' }}>
          <header
            style={{
              height: 64,
              borderBottom: '1px solid #333333',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '0 20px',
              flexShrink: 0,
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder="Search settings"
              style={{
                flex: 1,
                height: 32,
                backgroundColor: '#3c3c3c',
                border: '1px solid #5a5a5a',
                color: '#f0f0f0',
                outline: 'none',
                padding: '0 10px',
                fontSize: 13,
              }}
            />
            <button
              onClick={toggleSettings}
              title="Close settings"
              style={{
                width: 28,
                height: 28,
                border: 'none',
                backgroundColor: 'transparent',
                color: '#cccccc',
                cursor: 'pointer',
                fontSize: 18,
              }}
            >
              x
            </button>
          </header>

          <div className="dark-scrollbar" style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
            <h1 style={{ fontSize: 20, fontWeight: 400, margin: '0 0 18px', color: '#cccccc' }}>
              {activeSection === 'appearance' ? 'Appearance' : 'General'}
            </h1>

            {activeSection === 'appearance' && showBranchSetting && (
              <SettingRow
                title="Git branch badges"
                description="Show the current branch beside tab default directories and pane directories."
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#cccccc', fontSize: 13 }}>
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
              <div style={{ color: '#858585', fontSize: 13 }}>
                No general settings yet.
              </div>
            )}

            {activeSection === 'appearance' && !showBranchSetting && (
              <div style={{ color: '#858585', fontSize: 13 }}>
                No settings match your search.
              </div>
            )}
          </div>
        </main>
      </div>
    </>
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
        borderBottom: '1px solid #333333',
        padding: '0 0 18px',
        marginBottom: 18,
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 1fr) minmax(160px, auto)',
        gap: 24,
        alignItems: 'center',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#cccccc', fontSize: 13, marginBottom: 5 }}>{title}</div>
        <div style={{ color: '#858585', fontSize: 12, lineHeight: 1.4 }}>{description}</div>
      </div>
      <div>{children}</div>
    </section>
  )
}
