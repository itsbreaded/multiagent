import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import type {
  AgentProviderSettings,
  ClaudeProviderConfig,
  ClaudeProviderPreset,
  CodexProviderConfig,
  CodexProviderPreset,
  CodexWireApi,
  EnvVarEntry,
} from '../../../../shared/types'

// Known preset defaults
const CLAUDE_PRESET_DEFAULTS: Record<ClaudeProviderPreset, Partial<ClaudeProviderConfig>> = {
  native:   { baseUrl: '', model: '', opusModel: '', sonnetModel: '', haikuModel: '', subagentModel: '', effortLevel: '' },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-pro', opusModel: 'deepseek-v4-pro', sonnetModel: 'deepseek-v4-pro',
    haikuModel: 'deepseek-v4-flash', subagentModel: 'deepseek-v4-flash', effortLevel: 'max',
  },
  alibaba: {
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    model: 'qwen3.5-plus', opusModel: '', sonnetModel: '', haikuModel: '', subagentModel: '', effortLevel: '',
  },
  custom: {},
}

const CODEX_PRESET_DEFAULTS: Record<CodexProviderPreset, Partial<CodexProviderConfig>> = {
  native:         { providerName: '', model: '', baseUrl: '', envKey: '', wireApi: 'responses' },
  'alibaba-token': {
    providerName: 'alibaba_token', model: 'qwen3.6-plus',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    envKey: 'OPENAI_API_KEY', wireApi: 'responses',
  },
  'alibaba-payg': {
    providerName: 'alibaba_payg', model: 'qwen3.6-plus',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'OPENAI_API_KEY', wireApi: 'responses',
  },
  custom: {},
}


// Compact key-value editor extracted from the old EnvVarsSection
function EnvVarEditor({
  entries,
  onChange,
}: {
  entries: EnvVarEntry[]
  onChange: (entries: EnvVarEntry[]) => void
}): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKey, setEditKey] = useState('')
  const [editValue, setEditValue] = useState('')
  const [showValues, setShowValues] = useState<Set<string>>(new Set())

  function startAdd(): void {
    const id = crypto.randomUUID()
    onChange([...entries, { id, key: '', value: '', enabled: true }])
    setEditingId(id)
    setEditKey('')
    setEditValue('')
  }

  function commitEdit(): void {
    if (!editingId) return
    const key = editKey.trim()
    if (!key) {
      onChange(entries.filter((e) => e.id !== editingId))
    } else {
      onChange(entries.map((e) => e.id === editingId ? { ...e, key, value: editValue } : e))
    }
    setEditingId(null)
  }

  function cancelEdit(): void {
    if (!editingId) return
    const entry = entries.find((e) => e.id === editingId)
    if (entry && !entry.key) onChange(entries.filter((e) => e.id !== editingId))
    setEditingId(null)
  }

  return (
    <div>
      {entries.map((entry) => {
        const isEditing = editingId === entry.id
        const revealed = showValues.has(entry.id)
        const looksSecret = /key|token|secret|pass|auth/i.test(entry.key)
        return (
          <div
            key={entry.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 8px', marginBottom: 2,
              background: isEditing ? '#141e14' : '#0e0f11',
              border: `1px solid ${isEditing ? '#2a4a2a' : '#2a2b2e'}`,
              borderRadius: 4,
            }}
          >
            <input
              type="checkbox"
              checked={entry.enabled}
              onChange={() => onChange(entries.map((e) => e.id === entry.id ? { ...e, enabled: !e.enabled } : e))}
              style={{ flexShrink: 0, cursor: 'pointer', accentColor: '#4ade80' }}
            />
            {isEditing ? (
              <>
                <input
                  autoFocus value={editKey} onChange={(e) => setEditKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit() } if (e.key === 'Escape') cancelEdit(); e.stopPropagation() }}
                  placeholder="KEY"
                  style={{ ...monoInput, width: 140, flexShrink: 0 }}
                />
                <span style={{ color: '#4a4b4e', fontSize: 11, flexShrink: 0 }}>=</span>
                <input
                  value={editValue} onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit() } if (e.key === 'Escape') cancelEdit(); e.stopPropagation() }}
                  placeholder="value"
                  style={{ ...monoInput, flex: 1, minWidth: 0 }}
                />
                <button onClick={commitEdit} style={primaryBtn}>Save</button>
                <button onClick={cancelEdit} style={secondaryBtn}>Cancel</button>
              </>
            ) : (
              <>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: entry.enabled ? '#a0c4e8' : '#4a4b4e', width: 140, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.key || <span style={{ color: '#4a4b4e', fontStyle: 'italic' }}>unnamed</span>}
                </span>
                <span style={{ color: '#4a4b4e', fontSize: 11, flexShrink: 0 }}>=</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: entry.enabled ? '#c9cdd1' : '#4a4b4e', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {looksSecret && !revealed ? '•'.repeat(Math.min(entry.value.length, 16)) : (entry.value || <span style={{ color: '#4a4b4e', fontStyle: 'italic' }}>empty</span>)}
                </span>
                {looksSecret && (
                  <button onClick={() => setShowValues((prev) => { const next = new Set(prev); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next })} style={iconBtn}>
                    {revealed ? '🙈' : '👁'}
                  </button>
                )}
                <button onClick={() => { setEditingId(entry.id); setEditKey(entry.key); setEditValue(entry.value) }} style={iconBtn}>✎</button>
                <button onClick={() => { if (editingId === entry.id) setEditingId(null); onChange(entries.filter((e) => e.id !== entry.id)) }} style={{ ...iconBtn, color: '#6b3030' }}>✕</button>
              </>
            )}
          </div>
        )
      })}
      <button onClick={startAdd} style={{ ...secondaryBtn, marginTop: 4, fontSize: 10 }}>+ Add var</button>
    </div>
  )
}

function CollapsibleSection({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#6b7280', fontSize: 11, padding: '0 0 4px',
        }}
      >
        <span style={{ fontSize: 9, transform: expanded ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
        {label}
      </button>
      {expanded && <div style={{ paddingLeft: 4 }}>{children}</div>}
    </div>
  )
}

function ProviderCard({
  title,
  disabled,
  children,
}: {
  title: string
  disabled: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div style={{
      border: '1px solid #2a2b2e', borderRadius: 6, marginBottom: 12,
      background: '#141517', overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #2a2b2e',
        background: '#1a1b1e',
        color: disabled ? '#4a4b4e' : '#d4d4d4', fontSize: 12, fontWeight: 600,
      }}>
        {title}
      </div>
      <div style={{ padding: '10px 12px', opacity: disabled ? 0.6 : 1 }}>
        {children}
      </div>
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, gap: 8 }}>
      <span style={{ fontSize: 11, color: '#6b7280', width: 110, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function TextInput({ value, onChange, onBlur, placeholder, masked }: { value: string; onChange: (v: string) => void; onBlur?: () => void; placeholder?: string; masked?: boolean }): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <input
        type={masked && !revealed ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        style={{ ...monoInput, flex: 1, minWidth: 0, fontSize: 11 }}
      />
      {masked && (
        <button onClick={() => setRevealed((r) => !r)} style={iconBtn} title={revealed ? 'Hide' : 'Reveal'}>
          {revealed ? '🙈' : '👁'}
        </button>
      )}
    </div>
  )
}

function PresetButtons<T extends string>({
  presets,
  labels,
  value,
  onChange,
  disabled,
}: {
  presets: T[]
  labels: Record<T, string>
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {presets.map((p) => {
        const active = value === p
        return (
          <button
            key={p}
            disabled={disabled}
            onClick={() => onChange(p)}
            style={{
              padding: '3px 9px', fontSize: 11, cursor: disabled ? 'default' : 'pointer',
              background: active ? '#1a3a1a' : 'none',
              border: `1px solid ${active ? '#4ade80' : '#3a3b3e'}`,
              borderRadius: 4, color: active ? '#4ade80' : '#6b7280',
              fontWeight: active ? 500 : 400,
            }}
          >
            {labels[p]}
          </button>
        )
      })}
    </div>
  )
}

export function AgentProvidersSection(): JSX.Element {
  const agentProviders = useSettingsStore((s) => s.agentProviders)
  const setAgentProviders = useSettingsStore((s) => s.setAgentProviders)
  const hydrateAgentProviders = useSettingsStore((s) => s.hydrateAgentProviders)

  useEffect(() => {
    window.ipc.invoke('settings:get-agent-providers').then((settings) => {
      hydrateAgentProviders(settings as AgentProviderSettings)
    }).catch(() => {})
  }, [hydrateAgentProviders])

  // Local draft state so text fields don't trigger IPC on every keystroke
  const [claudeDraft, setClaudeDraft] = useState<ClaudeProviderConfig>(() => agentProviders.claude)
  const [codexDraft, setCodexDraft] = useState<CodexProviderConfig>(() => agentProviders.codex)

  // Sync draft when store changes (e.g. on hydration)
  useEffect(() => { setClaudeDraft(agentProviders.claude) }, [agentProviders.claude])
  useEffect(() => { setCodexDraft(agentProviders.codex) }, [agentProviders.codex])

  const [claudeTierExpanded, setClaudeTierExpanded] = useState(false)
  const [claudeEnvExpanded, setClaudeEnvExpanded] = useState(false)
  const [codexEnvExpanded, setCodexEnvExpanded] = useState(false)

  // Flush draft to store (triggers IPC save + localStorage)
  function flushClaude(draft: ClaudeProviderConfig = claudeDraft): void {
    setAgentProviders({ ...agentProviders, claude: draft })
  }
  function flushCodex(draft: CodexProviderConfig = codexDraft): void {
    setAgentProviders({ ...agentProviders, codex: draft })
  }

  // Apply a preset (fills known fields, saves immediately)
  function applyClaudePreset(preset: ClaudeProviderPreset): void {
    const defaults = CLAUDE_PRESET_DEFAULTS[preset]
    const next: ClaudeProviderConfig = { ...claudeDraft, preset, ...defaults }
    setClaudeDraft(next)
    setAgentProviders({ ...agentProviders, claude: next })
  }
  function applyCodexPreset(preset: CodexProviderPreset): void {
    const defaults = CODEX_PRESET_DEFAULTS[preset]
    const next: CodexProviderConfig = { ...codexDraft, preset, ...defaults }
    setCodexDraft(next)
    setAgentProviders({ ...agentProviders, codex: next })
  }

  const claudeDisabled = !claudeDraft.enabled
  const codexDisabled = !codexDraft.enabled

  return (
    <div>
      <div style={{ padding: '6px 14px 10px', fontSize: 10, fontWeight: 600, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Agent Providers
      </div>
      <div style={{ padding: '0 2px' }}>

        {/* Claude Code card */}
        <ProviderCard title="Claude Code" disabled={claudeDisabled}>
          <FieldRow label="">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#c9cdd1', fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={claudeDraft.enabled}
                onChange={(e) => {
                  const next = { ...claudeDraft, enabled: e.target.checked }
                  setClaudeDraft(next)
                  flushClaude(next)
                }}
                style={{ accentColor: '#4ade80' }}
              />
              Enabled
            </label>
          </FieldRow>

          <FieldRow label="Preset">
            <PresetButtons<ClaudeProviderPreset>
              presets={['native', 'deepseek', 'alibaba', 'custom']}
              labels={{ native: 'Native', deepseek: 'DeepSeek', alibaba: 'Alibaba', custom: 'Custom' }}
              value={claudeDraft.preset}
              onChange={applyClaudePreset}
              disabled={claudeDisabled}
            />
          </FieldRow>

          {claudeDraft.preset !== 'native' && (
            <>
              <FieldRow label="Base URL">
                <TextInput
                  value={claudeDraft.baseUrl}
                  onChange={(v) => setClaudeDraft((d) => ({ ...d, baseUrl: v }))}
                  onBlur={() => flushClaude()}
                  placeholder="https://api.example.com/anthropic"
                />
              </FieldRow>
              <FieldRow label="Auth token">
                <TextInput
                  value={claudeDraft.authToken}
                  onChange={(v) => setClaudeDraft((d) => ({ ...d, authToken: v }))}
                  onBlur={() => flushClaude()}
                  placeholder="sk-..."
                  masked
                />
              </FieldRow>
              <FieldRow label="Model">
                <TextInput
                  value={claudeDraft.model}
                  onChange={(v) => setClaudeDraft((d) => ({ ...d, model: v }))}
                  onBlur={() => flushClaude()}
                  placeholder="model-id"
                />
              </FieldRow>

              <CollapsibleSection label="Model tier overrides" expanded={claudeTierExpanded} onToggle={() => setClaudeTierExpanded((v) => !v)}>
                {(['opusModel', 'sonnetModel', 'haikuModel', 'subagentModel', 'effortLevel'] as const).map((field) => {
                  const labels: Record<typeof field, string> = {
                    opusModel: 'Opus model', sonnetModel: 'Sonnet model', haikuModel: 'Haiku model',
                    subagentModel: 'Subagent model', effortLevel: 'Effort level',
                  }
                  return (
                    <FieldRow key={field} label={labels[field]}>
                      <TextInput
                        value={claudeDraft[field]}
                        onChange={(v) => setClaudeDraft((d) => ({ ...d, [field]: v }))}
                        onBlur={() => flushClaude()}
                      />
                    </FieldRow>
                  )
                })}
              </CollapsibleSection>
            </>
          )}

          <CollapsibleSection label="Extra env vars" expanded={claudeEnvExpanded} onToggle={() => setClaudeEnvExpanded((v) => !v)}>
            <EnvVarEditor
              entries={claudeDraft.extraEnvVars}
              onChange={(extraEnvVars) => {
                const next = { ...claudeDraft, extraEnvVars }
                setClaudeDraft(next)
                flushClaude(next)
              }}
            />
          </CollapsibleSection>
        </ProviderCard>

        {/* Codex card */}
        <ProviderCard title="Codex" disabled={codexDisabled}>
          <FieldRow label="">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#c9cdd1', fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={codexDraft.enabled}
                onChange={(e) => {
                  const next = { ...codexDraft, enabled: e.target.checked }
                  setCodexDraft(next)
                  flushCodex(next)
                }}
                style={{ accentColor: '#4ade80' }}
              />
              Enabled
            </label>
          </FieldRow>

          <FieldRow label="Preset">
            <PresetButtons<CodexProviderPreset>
              presets={['native', 'alibaba-token', 'alibaba-payg', 'custom']}
              labels={{ native: 'Native', 'alibaba-token': 'Alibaba Token', 'alibaba-payg': 'Alibaba PAYG', custom: 'Custom' }}
              value={codexDraft.preset}
              onChange={applyCodexPreset}
              disabled={codexDisabled}
            />
          </FieldRow>

          {codexDraft.preset !== 'native' && (
            <>
              <FieldRow label="Provider name">
                <TextInput
                  value={codexDraft.providerName}
                  onChange={(v) => setCodexDraft((d) => ({ ...d, providerName: v }))}
                  onBlur={() => flushCodex()}
                  placeholder="my_provider"
                />
              </FieldRow>
              <FieldRow label="Model">
                <TextInput
                  value={codexDraft.model}
                  onChange={(v) => setCodexDraft((d) => ({ ...d, model: v }))}
                  onBlur={() => flushCodex()}
                  placeholder="model-id"
                />
              </FieldRow>
              <FieldRow label="Base URL">
                <TextInput
                  value={codexDraft.baseUrl}
                  onChange={(v) => setCodexDraft((d) => ({ ...d, baseUrl: v }))}
                  onBlur={() => flushCodex()}
                  placeholder="https://api.example.com/v1"
                />
              </FieldRow>
              <FieldRow label="API key">
                <TextInput
                  value={codexDraft.apiKey}
                  onChange={(v) => setCodexDraft((d) => ({ ...d, apiKey: v }))}
                  onBlur={() => flushCodex()}
                  placeholder="sk-..."
                  masked
                />
              </FieldRow>
              {codexDraft.preset === 'custom' && (
                <>
                  <FieldRow label="Env key">
                    <TextInput
                      value={codexDraft.envKey}
                      onChange={(v) => setCodexDraft((d) => ({ ...d, envKey: v }))}
                      onBlur={() => flushCodex()}
                      placeholder="OPENAI_API_KEY"
                    />
                  </FieldRow>
                  <FieldRow label="Wire API">
                    <PresetButtons<CodexWireApi>
                      presets={['responses', 'chat']}
                      labels={{ responses: 'responses', chat: 'chat (deprecated)' }}
                      value={codexDraft.wireApi}
                      onChange={(v) => {
                        const next = { ...codexDraft, wireApi: v }
                        setCodexDraft(next)
                        flushCodex(next)
                      }}
                      disabled={codexDisabled}
                    />
                  </FieldRow>
                </>
              )}
            </>
          )}

          <CollapsibleSection label="Extra env vars" expanded={codexEnvExpanded} onToggle={() => setCodexEnvExpanded((v) => !v)}>
            <EnvVarEditor
              entries={codexDraft.extraEnvVars}
              onChange={(extraEnvVars) => {
                const next = { ...codexDraft, extraEnvVars }
                setCodexDraft(next)
                flushCodex(next)
              }}
            />
          </CollapsibleSection>
        </ProviderCard>

      </div>
      <div style={{ padding: '0 14px 6px', fontSize: 10, color: '#4a4b4e', lineHeight: 1.4 }}>
        Provider settings take effect in new agent panes. Existing running panes are not affected.
      </div>
    </div>
  )
}

// Shared style constants
const monoInput: React.CSSProperties = {
  background: '#0e0f11',
  border: '1px solid #3a3b3e',
  borderRadius: 4,
  color: '#d4d4d4',
  fontSize: 12,
  fontFamily: 'monospace',
  padding: '4px 6px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const secondaryBtn: React.CSSProperties = {
  background: 'none',
  border: '1px solid #3a3b3e',
  borderRadius: 4,
  color: '#6b7280',
  fontSize: 11,
  cursor: 'pointer',
  padding: '3px 8px',
  flexShrink: 0,
}

const primaryBtn: React.CSSProperties = {
  background: '#1a3a1a',
  border: '1px solid #4ade80',
  borderRadius: 4,
  color: '#4ade80',
  fontSize: 11,
  cursor: 'pointer',
  padding: '3px 8px',
  flexShrink: 0,
}

const iconBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#4a4b4e',
  fontSize: 13,
  cursor: 'pointer',
  padding: '0 3px',
  flexShrink: 0,
  lineHeight: 1,
}
