import React, { useEffect, useRef, useState } from 'react'
import { usePanesStore } from '../../store/panes'
import {
  useSettingsStore,
  type SettingsSection,
} from '../../store/settings'
import { getCapabilities } from '../../terminal/rendering/capabilities'
import { overlayStyles, ui } from '../../styles/theme'
import {
  DEFAULT_HOTKEYS,
  buildHotkeys,
  hotkeyKey,
  type HotkeyId,
  type HotkeyOverride,
} from '../../utils/hotkeys'
import { McpSection } from './McpSection'
import { SectionLabel } from '../common/SectionLabel'
import { matchesSettingQuery } from './settingsSearch'
import { EmptyMessage, SearchResults } from './SearchResults'
import { HotkeyRow } from './HotkeyRow'
import { UpdatesSection } from './UpdatesSection'
import { ContrastRatioSetting } from './settings/ContrastRatioSetting'
import { CliSessionLinkingSetting } from './settings/CliSessionLinkingSetting'
import { AgentStatusScrapingSetting } from './settings/AgentStatusScrapingSetting'
import { GitBranchBadgesSetting } from './settings/GitBranchBadgesSetting'
import { GpuAccelerationSetting } from './settings/GpuAccelerationSetting'
import { OptimizedRendererSetting } from './settings/OptimizedRendererSetting'
import { RescaleGlyphsSetting } from './settings/RescaleGlyphsSetting'
import { ScrollbackSetting } from './settings/ScrollbackSetting'
import { TabOverflowSetting } from './settings/TabOverflowSetting'
import { AgentProvidersSection } from './AgentProvidersSection'
import { TerminalBindingsSection } from './TerminalBindingsSection'

// Terminal-only shortcuts shown read-only for visibility

const HOTKEY_ORDER: HotkeyId[] = [
  'newTab', 'closeTab', 'splitVertical', 'splitHorizontal',
  'closePane', 'zoomPane', 'toggleSidebar', 'commandPalette', 'sessionBrowser',
]

export function SettingsPanel(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const hotkeyOverrides = useSettingsStore((s) => s.hotkeyOverrides)
  const setHotkeyOverride = useSettingsStore((s) => s.setHotkeyOverride)
  const resetHotkeyOverride = useSettingsStore((s) => s.resetHotkeyOverride)
  const resetAllHotkeyOverrides = useSettingsStore((s) => s.resetAllHotkeyOverrides)

  const [activeSection, setActiveSection] = useState<SettingsSection>(
    // Read settingsInitialSection synchronously on mount so deep-linking from the
    // command palette (openSettings('hotkeys')) lands on the right section immediately.
    () => usePanesStore.getState().settingsInitialSection ?? 'appearance'
  )
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<HotkeyId | null>(null)
  const [conflictLabel, setConflictLabel] = useState<string | null>(null)
  // Non-blocking yellow warning: a recorded app hotkey shares its key with a
  // terminal key binding. Distinct from the red `conflictLabel` refusal.
  const [hotkeyTerminalWarning, setHotkeyTerminalWarning] = useState<string | null>(null)
  const terminalKeyBindings = useSettingsStore((s) => s.terminalKeyBindings)
  const mouseDownOnOverlay = useRef(false)

  // Lazily read diagnostics only when Terminal section is active to avoid any probe
  // being triggered before the section opens.
  const [caps, setCaps] = useState<ReturnType<typeof getCapabilities> | null>(null)
  useEffect(() => {
    if (activeSection === 'terminal' && !caps) {
      setCaps(getCapabilities())
    }
  }, [activeSection, caps])

  const customizedCount = Object.keys(hotkeyOverrides).length
  const sections = [
    { id: 'appearance' as const,   label: 'Appearance' },
    { id: 'hotkeys' as const,      label: 'Hotkeys' },
    { id: 'terminal' as const,     label: 'Terminal' },
    { id: 'mcp' as const,          label: 'MCP' },
    { id: 'providers' as const,    label: 'Providers' },
    { id: 'updates' as const,      label: 'Updates' },
  ]

  // Listen for key recording
  useEffect(() => {
    const recordingId = recording
    if (!recordingId) return

    function onKeyDown(e: KeyboardEvent): void {
      if (!recordingId) return  // narrows type inside this closure
      // Escape cancels recording — swallow it (capture phase) so it does NOT also
      // bubble to App.tsx's global Escape handler and close the settings overlay.
      // This listener only exists while recording is active, so normal
      // Escape-to-close still works once recording ends.
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setRecording(null)
          setConflictLabel(null)
          setHotkeyTerminalWarning(null)
        }
        return
      }
      // Skip bare modifier presses
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return

      e.preventDefault()
      e.stopPropagation()

      const newBinding: HotkeyOverride = { code: e.code, shift: e.shiftKey }
      const newKey = hotkeyKey(newBinding)

      // Conflict check against current effective hotkeys
      const hotkeys = buildHotkeys(hotkeyOverrides)
      const conflict = (Object.entries(hotkeys) as [HotkeyId, (typeof hotkeys)[HotkeyId]][])
        .find(([id, h]) => id !== recordingId && hotkeyKey(h) === newKey)
      if (conflict) {
        setConflictLabel(DEFAULT_HOTKEYS[conflict[0]].label)
        return
      }

      // Bidirectional clash: app hotkey shares code+shift with a terminal binding
      // held with Ctrl/Meta. Non-blocking — warn but still commit.
      const tbClash = terminalKeyBindings.find((b) =>
        (b.trigger.ctrl || b.trigger.meta) &&
        b.trigger.code === newBinding.code &&
        b.trigger.shift === newBinding.shift
      )
      if (tbClash) {
        setHotkeyTerminalWarning(`Shares key with terminal binding "${tbClash.label}". Terminal wins while a pane is focused.`)
      }

      // If same as default, clear any override instead of storing a no-op
      const def = DEFAULT_HOTKEYS[recordingId]
      if (def.code === newBinding.code && def.shift === newBinding.shift) {
        resetHotkeyOverride(recordingId)
      } else {
        setHotkeyOverride(recordingId, newBinding)
      }
      setRecording(null)
      setConflictLabel(null)
    }

    // Capture phase so we intercept before global app handler
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, hotkeyOverrides, terminalKeyBindings, setHotkeyOverride, resetHotkeyOverride])

  // Clear conflict message after a short delay
  useEffect(() => {
    if (!conflictLabel) return
    const t = setTimeout(() => setConflictLabel(null), 2000)
    return () => clearTimeout(t)
  }, [conflictLabel])

  // Clear the terminal-binding clash warning after a short delay
  useEffect(() => {
    if (!hotkeyTerminalWarning) return
    const t = setTimeout(() => setHotkeyTerminalWarning(null), 4000)
    return () => clearTimeout(t)
  }, [hotkeyTerminalWarning])


  const normalizedQuery = query.trim().toLowerCase()
  const isSearching = normalizedQuery !== ''
  const showBranchSetting = matchesSettingQuery(normalizedQuery, 'git branch badges tabs panes')
  const showOverflowSetting = matchesSettingQuery(normalizedQuery, 'tab overflow scroll wrap rows')
  const showOptimizedRendererSetting = matchesSettingQuery(normalizedQuery, 'optimized terminal renderer feature flag webgl dom')
  const showGpuAccelSetting = matchesSettingQuery(normalizedQuery, 'gpu acceleration webgl renderer auto on off')
  const showContrastSetting = matchesSettingQuery(normalizedQuery, 'minimum contrast ratio color accuracy')
  const showRescaleSetting = matchesSettingQuery(normalizedQuery, 'rescale overlapping glyphs wide ambiguous')
  const showScrollbackSetting = matchesSettingQuery(normalizedQuery, 'terminal scrollback lines history memory buffer maximum')
  const anyTerminalSetting = showOptimizedRendererSetting || showGpuAccelSetting || showContrastSetting || showRescaleSetting || showScrollbackSetting

  const effectiveHotkeys = buildHotkeys(hotkeyOverrides)
  const visibleHotkeys = HOTKEY_ORDER.filter((id) =>
    matchesSettingQuery(normalizedQuery, DEFAULT_HOTKEYS[id].label)
  )
  function terminalClashLabelForHotkey(id: HotkeyId): string | null {
    const h = effectiveHotkeys[id]
    const clash = terminalKeyBindings.find((b) =>
      (b.trigger.ctrl || b.trigger.meta) &&
      b.trigger.code === h.code &&
      b.trigger.shift === h.shift
    )
    return clash?.label ?? null
  }

  return (
    <div
      style={{
        ...overlayStyles.backdrop,
        zIndex: ui.z.overlay,
      }}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget }}
      onClick={() => { if (mouseDownOnOverlay.current) { setRecording(null); setConflictLabel(null); closeOverlays() } }}
    >
      <div
        role="dialog"
        aria-label="Settings"
        style={{
          width: '85vw',
          maxWidth: 960,
          height: '75vh',
          ...overlayStyles.panel,
          display: 'flex',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar nav — INVARIANT: never filter this list by query.
            All sections must stay visible while a search is active so users can
            switch sections without clearing the query first. Only the content
            pane (below) filters by query. */}
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
            const active = activeSection === section.id && !isSearching
            return (
              <button
                key={section.id}
                onClick={() => {
                  if (isSearching) setQuery('')
                  setActiveSection(section.id)
                  setRecording(null)
                  setConflictLabel(null)
                }}
                style={{
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
                {section.label}
              </button>
            )
          })}
        </aside>

        {/* Main content */}
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
              onChange={(e) => { setRecording(null); setQuery(e.target.value) }}
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
            {!isSearching ? (
              <>
                {/* Appearance section */}
                {activeSection === 'appearance' && (
                  <>
                    <SectionLabel>Appearance</SectionLabel>
                    {showBranchSetting && <GitBranchBadgesSetting />}
                    {showOverflowSetting && <TabOverflowSetting />}
                    {!showBranchSetting && !showOverflowSetting && (
                      <EmptyMessage>No settings match your search.</EmptyMessage>
                    )}
                  </>
                )}

                {/* Hotkeys section */}
                {activeSection === 'hotkeys' && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <SectionLabel>Keyboard Shortcuts</SectionLabel>
                      {customizedCount > 0 && (
                        <button
                          onClick={resetAllHotkeyOverrides}
                          style={{
                            background: 'none',
                            border: '1px solid #3a3b3e',
                            borderRadius: 4,
                            color: '#6b7280',
                            fontSize: 11,
                            cursor: 'pointer',
                            padding: '2px 8px',
                            marginRight: 12,
                            marginBottom: 3,
                          }}
                        >
                          Reset all
                        </button>
                      )}
                    </div>

                    {conflictLabel && (
                      <div style={{
                        background: '#2a1a1a',
                        border: '1px solid #5a2020',
                        borderRadius: 5,
                        color: '#f87171',
                        fontSize: 12,
                        padding: '6px 10px',
                        marginBottom: 8,
                      }}>
                        Already assigned to <strong>{conflictLabel}</strong>
                      </div>
                    )}

                    {hotkeyTerminalWarning && (
                      <div style={{
                        background: '#2a2410',
                        border: '1px solid #5a4810',
                        borderRadius: 5,
                        color: '#fbbf24',
                        fontSize: 12,
                        padding: '6px 10px',
                        marginBottom: 8,
                      }}>
                        {hotkeyTerminalWarning}
                      </div>
                    )}

                    {recording && (
                      <div style={{
                        background: '#1a2a1a',
                        border: '1px solid #205a20',
                        borderRadius: 5,
                        color: '#4ade80',
                        fontSize: 12,
                        padding: '6px 10px',
                        marginBottom: 8,
                      }}>
                        Press a Ctrl+key combination — Escape to cancel
                      </div>
                    )}

                    {visibleHotkeys.length > 0 ? (
                      visibleHotkeys.map((id) => {
                        const effective = effectiveHotkeys[id]
                        const isCustomized = !!hotkeyOverrides[id]
                        const isRecording = recording === id
                        return (
                          <HotkeyRow
                            key={id}
                            label={DEFAULT_HOTKEYS[id].label}
                            display={effective.display}
                            isCustomized={isCustomized}
                            isRecording={isRecording}
                            terminalClashLabel={terminalClashLabelForHotkey(id)}
                            onStartRecording={() => { setRecording(id); setConflictLabel(null) }}
                            onReset={() => { resetHotkeyOverride(id); if (recording === id) setRecording(null) }}
                          />
                        )
                      })
                    ) : (
                      <EmptyMessage>No hotkeys match your search.</EmptyMessage>
                    )}

                    {!normalizedQuery && (
                      <div style={{ margin: '16px 0 4px', borderTop: '1px solid #2a2b2e', paddingTop: 12 }}>
                        <TerminalBindingsSection />
                      </div>
                    )}
                  </>
                )}

                {/* Terminal section */}
                {activeSection === 'terminal' && (
                  <>
                    <SectionLabel>Renderer</SectionLabel>
                    {showOptimizedRendererSetting && <OptimizedRendererSetting />}
                    {showGpuAccelSetting && <GpuAccelerationSetting />}

                    {/* Diagnostics readout — only in section mode, never in search results */}
                    {caps && (
                      <div style={{
                        margin: '4px 0 8px',
                        padding: '8px 12px',
                        background: '#0e0f11',
                        border: '1px solid #222326',
                        borderRadius: 5,
                        fontSize: 11,
                        color: '#6b7280',
                        lineHeight: 1.6,
                      }}>
                        <div><span style={{ color: '#4a4b4e', marginRight: 8 }}>GPU renderer</span>{caps.gpuRenderer ?? '(unavailable)'}</div>
                        <div>
                          <span style={{ color: '#4a4b4e', marginRight: 8 }}>Software rendering</span>
                          <span style={{ color: caps.softwareRendering ? '#fbbf24' : '#4ade80' }}>
                            {caps.softwareRendering ? 'yes — auto resolves to DOM' : 'no'}
                          </span>
                        </div>
                        <div><span style={{ color: '#4a4b4e', marginRight: 8 }}>WebGL2</span>{caps.webgl ? 'available' : 'unavailable'}</div>
                      </div>
                    )}

                    <div style={{ marginTop: 8 }}><SectionLabel>Display</SectionLabel></div>
                    {showContrastSetting && <ContrastRatioSetting />}
                    {showRescaleSetting && <RescaleGlyphsSetting />}
                    {showScrollbackSetting && <ScrollbackSetting />}

                    <div style={{ marginTop: 8 }}><SectionLabel>Session detection</SectionLabel></div>
                    <CliSessionLinkingSetting />
                    <AgentStatusScrapingSetting />
                    {!anyTerminalSetting && (
                      <EmptyMessage>No terminal settings match your search.</EmptyMessage>
                    )}
                  </>
                )}

                {/* MCP section */}
                {activeSection === 'mcp' && <McpSection />}

                {/* Providers section */}
                {activeSection === 'providers' && <AgentProvidersSection />}

                {/* Updates section */}
                {activeSection === 'updates' && (
                  <UpdatesSection />
                )}
              </>
            ) : (
              <SearchResults
                normalizedQuery={normalizedQuery}
                showBranchSetting={showBranchSetting}
                showOverflowSetting={showOverflowSetting}
                showOptimizedRendererSetting={showOptimizedRendererSetting}
                showGpuAccelSetting={showGpuAccelSetting}
                showContrastSetting={showContrastSetting}
                showRescaleSetting={showRescaleSetting}
                showScrollbackSetting={showScrollbackSetting}
                anyTerminalSetting={anyTerminalSetting}
                visibleHotkeys={visibleHotkeys}
                effectiveHotkeys={effectiveHotkeys}
                hotkeyOverrides={hotkeyOverrides}
                recording={recording}
                conflictLabel={conflictLabel}
                terminalClashLabelForHotkey={terminalClashLabelForHotkey}
                onStartRecording={(id) => { setRecording(id); setConflictLabel(null) }}
                onResetHotkey={(id) => { resetHotkeyOverride(id); if (recording === id) setRecording(null) }}
                onNavigate={(section) => { setQuery(''); setActiveSection(section) }}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
