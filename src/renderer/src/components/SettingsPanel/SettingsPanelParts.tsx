import React, { useEffect, useState } from 'react'
import { useUpdaterStore } from '../../store/updater'
import { useSettingsStore, type SettingsSection } from '../../store/settings'
import { DEFAULT_HOTKEYS, buildHotkeys, type HotkeyId, type HotkeyOverride } from '../../utils/hotkeys'
import { SectionLabel } from '../common/SectionLabel'
import { matchesSettingQuery } from './settingsSearch'
import { ContrastRatioSetting } from './settings/ContrastRatioSetting'
import { GitBranchBadgesSetting } from './settings/GitBranchBadgesSetting'
import { GpuAccelerationSetting } from './settings/GpuAccelerationSetting'
import { OptimizedRendererSetting } from './settings/OptimizedRendererSetting'
import { RescaleGlyphsSetting } from './settings/RescaleGlyphsSetting'
import { ScrollbackSetting } from './settings/ScrollbackSetting'
import { TabOverflowSetting } from './settings/TabOverflowSetting'

const MCP_KEYWORDS = ['mcp', 'model context', 'protocol', 'server', 'browser']
const PROVIDER_KEYWORDS = ['provider', 'agent', 'claude', 'codex', 'api', 'key', 'env', 'environment', 'variable']
const UPDATE_KEYWORDS = ['update', 'version', 'auto update', 'release', 'upgrade']

export function SearchResults({
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
          {showBranchSetting && <GitBranchBadgesSetting />}
          {showOverflowSetting && <TabOverflowSetting />}
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
          {showOptimizedRendererSetting && <OptimizedRendererSetting />}
          {showGpuAccelSetting && <GpuAccelerationSetting />}
          {showContrastSetting && <ContrastRatioSetting />}
          {showRescaleSetting && <RescaleGlyphsSetting />}
          {showScrollbackSetting && <ScrollbackSetting />}
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

export function HotkeyRow({
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

export function EmptyMessage({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ color: '#4a4b4e', fontSize: 12, padding: '14px' }}>{children}</div>
  )
}

export function UpdatesSection(): JSX.Element {
  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled)
  const setAutoUpdateEnabled = useSettingsStore((s) => s.setAutoUpdateEnabled)
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
            Update check unavailable in this build.
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
