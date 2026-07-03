import React, { useEffect, useRef, useState } from 'react'
import { useUpdaterStore } from '../../store/updater'
import { usePanesStore } from '../../store/panes'
import {
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  MIN_CONTRAST_RATIO,
  MAX_CONTRAST_RATIO,
  normalizeTerminalScrollbackLines,
  normalizeContrastRatio,
  useSettingsStore,
  type SettingsSection,
  type GpuAccelerationPref,
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
import { GitBranchBadgesSetting, GpuAccelerationSetting, OptimizedRendererSetting, TabOverflowSetting } from './settings/controls'
import { AgentProvidersSection } from './AgentProvidersSection'
import { TerminalBindingsSection } from './TerminalBindingsSection'

const MCP_KEYWORDS      = ['mcp', 'model context', 'protocol', 'server', 'browser']
const PROVIDER_KEYWORDS = ['provider', 'agent', 'claude', 'codex', 'api', 'key', 'env', 'environment', 'variable']
const UPDATE_KEYWORDS   = ['update', 'version', 'auto update', 'release', 'upgrade']

// Terminal-only shortcuts shown read-only for visibility

const HOTKEY_ORDER: HotkeyId[] = [
  'newTab', 'closeTab', 'splitVertical', 'splitHorizontal',
  'closePane', 'zoomPane', 'toggleSidebar', 'commandPalette', 'sessionBrowser',
]

export function SettingsPanel(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)
  const setShowGitBranchBadges = useSettingsStore((s) => s.setShowGitBranchBadges)
  const tabOverflowMode = useSettingsStore((s) => s.tabOverflowMode)
  const setTabOverflowMode = useSettingsStore((s) => s.setTabOverflowMode)
  const optimizedTerminalRenderer = useSettingsStore((s) => s.optimizedTerminalRenderer)
  const setOptimizedTerminalRenderer = useSettingsStore((s) => s.setOptimizedTerminalRenderer)
  const terminalGpuAcceleration = useSettingsStore((s) => s.terminalGpuAcceleration)
  const setTerminalGpuAcceleration = useSettingsStore((s) => s.setTerminalGpuAcceleration)
  const terminalMinimumContrastRatio = useSettingsStore((s) => s.terminalMinimumContrastRatio)
  const setTerminalMinimumContrastRatio = useSettingsStore((s) => s.setTerminalMinimumContrastRatio)
  const terminalRescaleOverlappingGlyphs = useSettingsStore((s) => s.terminalRescaleOverlappingGlyphs)
  const setTerminalRescaleOverlappingGlyphs = useSettingsStore((s) => s.setTerminalRescaleOverlappingGlyphs)
  const terminalScrollbackLines = useSettingsStore((s) => s.terminalScrollbackLines)
  const setTerminalScrollbackLines = useSettingsStore((s) => s.setTerminalScrollbackLines)
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
  const [scrollbackDraft, setScrollbackDraft] = useState(String(terminalScrollbackLines))
  const [contrastDraft, setContrastDraft] = useState(String(terminalMinimumContrastRatio))
  const mouseDownOnOverlay = useRef(false)

  // Lazily read diagnostics only when Terminal section is active to avoid any probe
  // being triggered before the section opens.
  const [caps, setCaps] = useState<ReturnType<typeof getCapabilities> | null>(null)
  useEffect(() => {
    if (activeSection === 'terminal' && !caps) {
      setCaps(getCapabilities())
    }
  }, [activeSection, caps])

  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled)
  const setAutoUpdateEnabled = useSettingsStore((s) => s.setAutoUpdateEnabled)
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

  useEffect(() => {
    setScrollbackDraft(String(terminalScrollbackLines))
  }, [terminalScrollbackLines])

  useEffect(() => {
    setContrastDraft(String(terminalMinimumContrastRatio))
  }, [terminalMinimumContrastRatio])

  function commitScrollbackDraft(): void {
    const normalized = normalizeTerminalScrollbackLines(scrollbackDraft.replaceAll(',', ''))
    setTerminalScrollbackLines(normalized)
    setScrollbackDraft(String(normalized))
  }

  function commitContrastDraft(): void {
    const normalized = normalizeContrastRatio(contrastDraft)
    setTerminalMinimumContrastRatio(normalized)
    setContrastDraft(String(normalized))
  }

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
                    {showContrastSetting && (
                      <SettingRow
                        title="Minimum contrast ratio"
                        description={`1 = no color adjustment (preserves exact agent colors). Range ${MIN_CONTRAST_RATIO}–${MAX_CONTRAST_RATIO}. Applies immediately.`}
                      >
                        <input
                          type="text"
                          inputMode="numeric"
                          value={contrastDraft}
                          onChange={(e) => setContrastDraft(e.target.value)}
                          onBlur={commitContrastDraft}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitContrastDraft(); e.currentTarget.blur() }
                          }}
                          style={{
                            width: 60,
                            backgroundColor: '#0e0f11',
                            border: '1px solid #3a3b3e',
                            borderRadius: 4,
                            color: '#d4d4d4',
                            fontSize: 12,
                            padding: '5px 7px',
                            textAlign: 'right',
                          }}
                        />
                      </SettingRow>
                    )}
                    {showRescaleSetting && (
                      <SettingRow
                        title="Rescale overlapping glyphs"
                        description="Shrink wide or ambiguous-width characters so they don't bleed into adjacent cells. WebGL renderer only — no effect on DOM renderer."
                      >
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c9cdd1', fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={terminalRescaleOverlappingGlyphs}
                            onChange={(e) => setTerminalRescaleOverlappingGlyphs(e.target.checked)}
                          />
                          Enabled
                        </label>
                      </SettingRow>
                    )}
                    {showScrollbackSetting && (
                      <SettingRow
                        title="Scrollback lines"
                        description="Maximum retained terminal history. Applies immediately; lowering this can trim existing scrollback."
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                          <input
                            type="text"
                            inputMode="numeric"
                            min={MIN_TERMINAL_SCROLLBACK_LINES}
                            max={MAX_TERMINAL_SCROLLBACK_LINES}
                            value={scrollbackDraft}
                            onChange={(e) => setScrollbackDraft(e.target.value)}
                            onBlur={commitScrollbackDraft}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitScrollbackDraft()
                                e.currentTarget.blur()
                              }
                            }}
                            style={{
                              width: 120,
                              backgroundColor: '#0e0f11',
                              border: '1px solid #3a3b3e',
                              borderRadius: 4,
                              color: '#d4d4d4',
                              fontSize: 12,
                              padding: '5px 7px',
                              textAlign: 'right',
                            }}
                          />
                          <div style={{ display: 'flex', gap: 6 }}>
                            {[50_000, 100_000, DEFAULT_TERMINAL_SCROLLBACK_LINES].map((value) => (
                              <button
                                key={value}
                                onClick={() => {
                                  setTerminalScrollbackLines(value)
                                  setScrollbackDraft(String(value))
                                }}
                                style={{
                                  background: terminalScrollbackLines === value ? ui.color.control : 'none',
                                  border: `1px solid ${terminalScrollbackLines === value ? ui.color.accent : ui.color.border}`,
                                  borderRadius: 4,
                                  color: terminalScrollbackLines === value ? ui.color.text : ui.color.textMuted,
                                  fontSize: 11,
                                  cursor: 'pointer',
                                  padding: '2px 6px',
                                }}
                              >
                                {formatLineCount(value)}
                              </button>
                            ))}
                          </div>
                        </div>
                      </SettingRow>
                    )}
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
                  <UpdatesSection
                    autoUpdateEnabled={autoUpdateEnabled}
                    setAutoUpdateEnabled={setAutoUpdateEnabled}
                  />
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
                showGitBranchBadges={showGitBranchBadges}
                setShowGitBranchBadges={setShowGitBranchBadges}
                tabOverflowMode={tabOverflowMode}
                setTabOverflowMode={setTabOverflowMode}
                optimizedTerminalRenderer={optimizedTerminalRenderer}
                setOptimizedTerminalRenderer={setOptimizedTerminalRenderer}
                terminalGpuAcceleration={terminalGpuAcceleration}
                setTerminalGpuAcceleration={setTerminalGpuAcceleration}
                terminalMinimumContrastRatio={terminalMinimumContrastRatio}
                contrastDraft={contrastDraft}
                setContrastDraft={setContrastDraft}
                commitContrastDraft={commitContrastDraft}
                terminalRescaleOverlappingGlyphs={terminalRescaleOverlappingGlyphs}
                setTerminalRescaleOverlappingGlyphs={setTerminalRescaleOverlappingGlyphs}
                terminalScrollbackLines={terminalScrollbackLines}
                scrollbackDraft={scrollbackDraft}
                setScrollbackDraft={setScrollbackDraft}
                commitScrollbackDraft={commitScrollbackDraft}
                setTerminalScrollbackLines={setTerminalScrollbackLines}
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

function SearchResults({
  normalizedQuery,
  showBranchSetting,
  showOverflowSetting,
  showOptimizedRendererSetting,
  showGpuAccelSetting,
  showContrastSetting,
  showRescaleSetting,
  showScrollbackSetting,
  anyTerminalSetting,
  visibleHotkeys,
  effectiveHotkeys,
  hotkeyOverrides,
  recording,
  conflictLabel,
  terminalClashLabelForHotkey,
  showGitBranchBadges,
  setShowGitBranchBadges,
  tabOverflowMode,
  setTabOverflowMode,
  optimizedTerminalRenderer,
  setOptimizedTerminalRenderer,
  terminalGpuAcceleration,
  setTerminalGpuAcceleration,
  terminalMinimumContrastRatio: _terminalMinimumContrastRatio,
  contrastDraft,
  setContrastDraft,
  commitContrastDraft,
  terminalRescaleOverlappingGlyphs,
  setTerminalRescaleOverlappingGlyphs,
  terminalScrollbackLines,
  scrollbackDraft,
  setScrollbackDraft,
  commitScrollbackDraft,
  setTerminalScrollbackLines,
  onStartRecording,
  onResetHotkey,
  onNavigate,
}: {
  normalizedQuery: string
  showBranchSetting: boolean
  showOverflowSetting: boolean
  showOptimizedRendererSetting: boolean
  showGpuAccelSetting: boolean
  showContrastSetting: boolean
  showRescaleSetting: boolean
  showScrollbackSetting: boolean
  anyTerminalSetting: boolean
  visibleHotkeys: HotkeyId[]
  effectiveHotkeys: ReturnType<typeof buildHotkeys>
  hotkeyOverrides: Record<string, HotkeyOverride>
  recording: HotkeyId | null
  conflictLabel: string | null
  terminalClashLabelForHotkey: (id: HotkeyId) => string | null
  showGitBranchBadges: boolean
  setShowGitBranchBadges: (v: boolean) => void
  tabOverflowMode: 'scroll' | 'wrap'
  setTabOverflowMode: (v: 'scroll' | 'wrap') => void
  optimizedTerminalRenderer: boolean
  setOptimizedTerminalRenderer: (v: boolean) => void
  terminalGpuAcceleration: GpuAccelerationPref
  setTerminalGpuAcceleration: (v: GpuAccelerationPref) => void
  terminalMinimumContrastRatio: number
  contrastDraft: string
  setContrastDraft: (v: string) => void
  commitContrastDraft: () => void
  terminalRescaleOverlappingGlyphs: boolean
  setTerminalRescaleOverlappingGlyphs: (v: boolean) => void
  terminalScrollbackLines: number
  scrollbackDraft: string
  setScrollbackDraft: (v: string) => void
  commitScrollbackDraft: () => void
  setTerminalScrollbackLines: (v: number) => void
  onStartRecording: (id: HotkeyId) => void
  onResetHotkey: (id: HotkeyId) => void
  onNavigate: (section: SettingsSection) => void
}): JSX.Element {
  const hasAppearance = showBranchSetting || showOverflowSetting
  const hasHotkeys    = visibleHotkeys.length > 0
  const hasMcp        = matchesSettingQuery(normalizedQuery, MCP_KEYWORDS.join(' '))
  const hasProviders  = matchesSettingQuery(normalizedQuery, PROVIDER_KEYWORDS.join(' '))
  const hasUpdates    = matchesSettingQuery(normalizedQuery, UPDATE_KEYWORDS.join(' '))
  const hasAnything   = hasAppearance || hasHotkeys || anyTerminalSetting || hasMcp || hasProviders || hasUpdates

  if (!hasAnything) return <EmptyMessage>No settings match your search.</EmptyMessage>

  return (
    <>
      {hasAppearance && (
        <>
          <SectionLabel>Appearance</SectionLabel>
          {showBranchSetting && (
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
          {showOverflowSetting && (
            <SettingRow
              title="Tab overflow"
              description="Scroll keeps tabs in a single row; Wrap grows to additional rows."
            >
              <div style={{ display: 'flex', gap: 6 }}>
                {(['scroll', 'wrap'] as const).map((mode) => {
                  const isActive = tabOverflowMode === mode
                  return (
                    <button
                      key={mode}
                      onClick={() => setTabOverflowMode(mode)}
                      style={{
                        padding: '4px 12px',
                        background: isActive ? ui.color.control : 'none',
                        border: `1px solid ${isActive ? ui.color.accent : ui.color.border}`,
                        borderRadius: ui.radius.sm,
                        color: isActive ? ui.color.text : ui.color.textMuted,
                        fontSize: 12,
                        cursor: 'pointer',
                        fontWeight: isActive ? 500 : 400,
                      }}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  )
                })}
              </div>
            </SettingRow>
          )}
        </>
      )}
      {hasHotkeys && (
        <>
          <SectionLabel>Keyboard Shortcuts</SectionLabel>
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
          {visibleHotkeys.map((id) => {
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
                onStartRecording={() => onStartRecording(id)}
                onReset={() => onResetHotkey(id)}
              />
            )
          })}
        </>
      )}
      {anyTerminalSetting && (
        <>
          <SectionLabel>Terminal</SectionLabel>
          {showOptimizedRendererSetting && (
            <SettingRow
              title="Optimized renderer"
              description="Use the environment-aware backend registry. Disable to revert to legacy unconditional WebGL behavior. Applies to new panes."
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c9cdd1', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={optimizedTerminalRenderer}
                  onChange={(e) => setOptimizedTerminalRenderer(e.target.checked)}
                />
                Enabled
              </label>
            </SettingRow>
          )}
          {showGpuAccelSetting && (
            <SettingRow
              title="GPU acceleration"
              description="auto avoids software-rendered WebGL (the CPU spike trap). on always attempts WebGL. off always uses the DOM renderer. Applies to new panes."
            >
              <div style={{ display: 'flex', gap: 6 }}>
                {(['auto', 'on', 'off'] as GpuAccelerationPref[]).map((mode) => {
                  const isActive = terminalGpuAcceleration === mode
                  return (
                    <button
                      key={mode}
                      onClick={() => setTerminalGpuAcceleration(mode)}
                      style={{
                        padding: '4px 12px',
                        background: isActive ? ui.color.control : 'none',
                        border: `1px solid ${isActive ? ui.color.accent : ui.color.border}`,
                        borderRadius: ui.radius.sm,
                        color: isActive ? ui.color.text : ui.color.textMuted,
                        fontSize: 12,
                        cursor: 'pointer',
                        fontWeight: isActive ? 500 : 400,
                      }}
                    >
                      {mode}
                    </button>
                  )
                })}
              </div>
            </SettingRow>
          )}
          {showContrastSetting && (
            <SettingRow
              title="Minimum contrast ratio"
              description={`1 = no color adjustment (preserves exact agent colors). Range ${MIN_CONTRAST_RATIO}–${MAX_CONTRAST_RATIO}. Applies immediately.`}
            >
              <input
                type="text"
                inputMode="numeric"
                value={contrastDraft}
                onChange={(e) => setContrastDraft(e.target.value)}
                onBlur={commitContrastDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitContrastDraft(); e.currentTarget.blur() }
                }}
                style={{
                  width: 60,
                  backgroundColor: '#0e0f11',
                  border: '1px solid #3a3b3e',
                  borderRadius: 4,
                  color: '#d4d4d4',
                  fontSize: 12,
                  padding: '5px 7px',
                  textAlign: 'right',
                }}
              />
            </SettingRow>
          )}
          {showRescaleSetting && (
            <SettingRow
              title="Rescale overlapping glyphs"
              description="Shrink wide or ambiguous-width characters so they don't bleed into adjacent cells. WebGL renderer only — no effect on DOM renderer."
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c9cdd1', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={terminalRescaleOverlappingGlyphs}
                  onChange={(e) => setTerminalRescaleOverlappingGlyphs(e.target.checked)}
                />
                Enabled
              </label>
            </SettingRow>
          )}
          {showScrollbackSetting && (
            <SettingRow
              title="Scrollback lines"
              description="Maximum retained terminal history. Applies immediately; lowering this can trim existing scrollback."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                <input
                  type="text"
                  inputMode="numeric"
                  min={MIN_TERMINAL_SCROLLBACK_LINES}
                  max={MAX_TERMINAL_SCROLLBACK_LINES}
                  value={scrollbackDraft}
                  onChange={(e) => setScrollbackDraft(e.target.value)}
                  onBlur={commitScrollbackDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitScrollbackDraft()
                      e.currentTarget.blur()
                    }
                  }}
                  style={{
                    width: 120,
                    backgroundColor: '#0e0f11',
                    border: '1px solid #3a3b3e',
                    borderRadius: 4,
                    color: '#d4d4d4',
                    fontSize: 12,
                    padding: '5px 7px',
                    textAlign: 'right',
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  {[50_000, 100_000, DEFAULT_TERMINAL_SCROLLBACK_LINES].map((value) => (
                    <button
                      key={value}
                      onClick={() => {
                        setTerminalScrollbackLines(value)
                        setScrollbackDraft(String(value))
                      }}
                      style={{
                        background: terminalScrollbackLines === value ? ui.color.control : 'none',
                        border: `1px solid ${terminalScrollbackLines === value ? ui.color.accent : ui.color.border}`,
                        borderRadius: 4,
                        color: terminalScrollbackLines === value ? ui.color.text : ui.color.textMuted,
                        fontSize: 11,
                        cursor: 'pointer',
                        padding: '2px 6px',
                      }}
                    >
                      {formatLineCount(value)}
                    </button>
                  ))}
                </div>
              </div>
            </SettingRow>
          )}
        </>
      )}
      {hasMcp && (
        <SettingNavCard
          title="MCP Servers"
          description="Configure the built-in browser server and custom MCP servers."
          onNavigate={() => onNavigate('mcp')}
        />
      )}
      {hasProviders && (
        <SettingNavCard
          title="Agent Providers"
          description="Set API keys and model overrides for Claude and Codex."
          onNavigate={() => onNavigate('providers')}
        />
      )}
      {hasUpdates && (
        <SettingNavCard
          title="Updates"
          description="Check for updates, view version info, and configure auto-update behavior."
          onNavigate={() => onNavigate('updates')}
        />
      )}
    </>
  )
}

function SettingNavCard({ title, description, onNavigate }: {
  title: string
  description: string
  onNavigate: () => void
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
      <div>
        <button
          onClick={onNavigate}
          style={{
            padding: '4px 12px',
            background: 'none',
            border: '1px solid #3a3b3e',
            borderRadius: 4,
            color: '#6b7280',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Go to →
        </button>
      </div>
    </section>
  )
}

function formatLineCount(value: number): string {
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`
  return value.toLocaleString()
}

function HotkeyRow({
  label,
  display,
  isCustomized,
  isRecording,
  terminalClashLabel,
  onStartRecording,
  onReset,
}: {
  label: string
  display: string
  isCustomized: boolean
  isRecording: boolean
  terminalClashLabel?: string | null
  onStartRecording: () => void
  onReset: () => void
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '7px 12px',
        marginBottom: 2,
        border: `1px solid ${isRecording ? '#2a4a2a' : '#2a2b2e'}`,
        borderRadius: 5,
        backgroundColor: isRecording ? '#141e14' : '#141517',
        gap: 12,
      }}
    >
      <span style={{ color: '#c9cdd1', fontSize: 12, flex: 1 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {terminalClashLabel && (
          <span style={{
            display: 'inline-block',
            background: '#2a2410',
            border: '1px solid #5a4810',
            borderRadius: 4,
            color: '#fbbf24',
            fontSize: 10,
            padding: '2px 6px',
            maxWidth: 220,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }} title={`Shares key with terminal binding "${terminalClashLabel}"`}>
            Shares key with {terminalClashLabel}
          </span>
        )}
        <button
          onClick={onStartRecording}
          title="Click to rebind"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          <KeyBadge active={isRecording}>
            {isRecording ? 'Press keys…' : display}
          </KeyBadge>
        </button>
        {isCustomized && (
          <button
            onClick={onReset}
            title="Reset to default"
            style={{
              background: 'none',
              border: 'none',
              color: '#4a4b4e',
              fontSize: 13,
              cursor: 'pointer',
              padding: '0 2px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}

function KeyBadge({ children, active, muted }: { children: React.ReactNode; active?: boolean; muted?: boolean }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        background: active ? '#1a3a1a' : '#1e1f22',
        border: `1px solid ${active ? '#4ade80' : muted ? '#222326' : '#3a3b3e'}`,
        borderRadius: 4,
        color: active ? '#4ade80' : muted ? '#4a4b4e' : '#a0a4a8',
        fontSize: 11,
        fontFamily: 'monospace',
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function EmptyMessage({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ color: '#4a4b4e', fontSize: 12, padding: '14px' }}>{children}</div>
  )
}

function UpdatesSection({
  autoUpdateEnabled,
  setAutoUpdateEnabled,
}: {
  autoUpdateEnabled: boolean
  setAutoUpdateEnabled: (v: boolean) => void
}): JSX.Element {
  const [version, setVersion] = useState<string>('')
  const [checking, setChecking] = useState(false)
  const [updaterEnabled, setUpdaterEnabled] = useState<boolean | null>(null)
  const updaterStatus = useUpdaterStore((s) => s.status)

  useEffect(() => {
    window.ipc.invoke('updater:get-version').then((v) => {
      if (typeof v === 'string') setVersion(v)
    }).catch(() => {})
    window.ipc.invoke('updater:is-enabled').then((enabled) => {
      setUpdaterEnabled(!!enabled)
    }).catch(() => { setUpdaterEnabled(false) })
  }, [])

  function checkNow(): void {
    if (!updaterEnabled) return
    setChecking(true)
    window.ipc.invoke('updater:check').catch(() => {}).finally(() => {
      setChecking(false)
    })
  }

  function statusLabel(): string {
    if (!updaterEnabled) return ''
    if (checking) return 'Checking…'
    if (!updaterStatus) return ''
    if (updaterStatus.state === 'up-to-date') return 'Up to date'
    if (updaterStatus.state === 'available') return `Update available: v${updaterStatus.version}`
    if (updaterStatus.state === 'preparing') return 'Preparing update…'
    if (updaterStatus.state === 'downloading') return `Downloading… ${updaterStatus.percent}%`
    if (updaterStatus.state === 'ready') return `Ready to install: v${updaterStatus.version}`
    if (updaterStatus.state === 'error') return 'Update check failed'
    return ''
  }

  const label = statusLabel()
  const isAvailable =
    updaterStatus?.state === 'available' ||
    updaterStatus?.state === 'ready' ||
    updaterStatus?.state === 'preparing' ||
    updaterStatus?.state === 'downloading'
  const buttonDisabled = checking || !updaterEnabled

  // Inline actions mirror the banner so the user can complete an update without
  // leaving Settings. Download is only meaningful when auto-update is off (when
  // it is on, the download starts automatically the moment a version is found).
  const showDownload =
    updaterEnabled && updaterStatus?.state === 'available' && !autoUpdateEnabled
  const showRestart = updaterEnabled && updaterStatus?.state === 'ready'
  const showActionRow = showDownload || showRestart

  return (
    <>
      <SectionLabel>Updates</SectionLabel>
      <div style={{
        padding: '10px 12px',
        marginBottom: 4,
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        backgroundColor: '#141517',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: '#d4d4d4', fontSize: 13 }}>Current version</div>
            <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>
              {version ? `v${version}` : '—'}
              {label && (
                <span style={{ marginLeft: 10, color: isAvailable ? '#4ade80' : '#6b7280' }}>
                  {label}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={checkNow}
            disabled={buttonDisabled}
            title={!updaterEnabled ? 'Only available in installed builds' : undefined}
            style={{
              padding: '4px 12px',
              background: 'none',
              border: '1px solid #3a3b3e',
              borderRadius: 4,
              color: buttonDisabled ? '#4a4b4e' : '#6b7280',
              fontSize: 12,
              cursor: buttonDisabled ? 'default' : 'pointer',
            }}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
        {updaterEnabled === false && (
          <div style={{ color: '#4a4b4e', fontSize: 11 }}>
            Update token not set — rebuild with GH_UPDATE_TOKEN configured to enable updates.
          </div>
        )}
        {showActionRow && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {showDownload && (
              <button
                onClick={() => window.ipc.send('updater:download')}
                style={updateActionStyle}
              >
                Download
              </button>
            )}
            {showRestart && (
              <button
                onClick={() => window.ipc.send('updater:install')}
                style={updateActionStyle}
              >
                Restart to install
              </button>
            )}
          </div>
        )}
      </div>
      <SettingRow
        title="Auto-update"
        description="Automatically download updates in the background. When disabled, you will be notified and can download manually."
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c9cdd1', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={autoUpdateEnabled}
            onChange={(e) => setAutoUpdateEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </SettingRow>
    </>
  )
}

const updateActionStyle: React.CSSProperties = {
  padding: '4px 12px',
  backgroundColor: 'transparent',
  border: '1px solid #4ade80',
  borderRadius: 4,
  color: '#4ade80',
  fontSize: 12,
  cursor: 'pointer',
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
