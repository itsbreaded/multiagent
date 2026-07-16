import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { ui, overlayStyles } from '../../styles/theme'
import type {
  AgentProviderSettings,
  ClaudeProviderConfig,
  ClaudeBuiltinPreset,
  ClaudePresetId,
  CodexProviderConfig,
  CodexBuiltinPreset,
  CodexPresetId,
  CodexWireApi,
  CustomProviderId,
  EnvVarEntry,
} from '../../../../shared/types'
import { isCustomId } from '../../../../shared/types'

// Built-in preset pickers + labels. `custom` is no longer a built-in — non-default
// providers live as named chips in claudeCustomProviders / codexCustomProviders.
const CLAUDE_BUILTIN_LIST: ClaudeBuiltinPreset[] = ['native', 'deepseek', 'alibaba', 'ollama', 'zai']
const CLAUDE_BUILTIN_LABELS: Record<ClaudeBuiltinPreset, string> = {
  native: 'Native', deepseek: 'DeepSeek', alibaba: 'Alibaba', ollama: 'Ollama', zai: 'z.ai',
}
const CODEX_BUILTIN_LIST: CodexBuiltinPreset[] = ['native', 'alibaba-token', 'alibaba-payg']
const CODEX_BUILTIN_LABELS: Record<CodexBuiltinPreset, string> = {
  native: 'Native', 'alibaba-token': 'Alibaba Token', 'alibaba-payg': 'Alibaba PAYG',
}

// Known built-in defaults. Custom providers (custom:<id>) get an empty body and
// are fully user-configured, so they have no entry here.
//
// SAFETY INVARIANT (spec 049): these maps must NEVER include credential keys —
// not `authToken` (Claude) nor `apiKey` (Codex). The reset feature spreads a
// preset's defaults over the active draft, so any credential key present here
// would silently wipe the user's secret on "Reset to defaults". Guarded by
// providerPresetDefaults.test.ts.
export const CLAUDE_PRESET_DEFAULTS: Record<ClaudeBuiltinPreset, Partial<ClaudeProviderConfig>> = {
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
  // Local Ollama client proxying to the cloud; token-less (logged in upstream).
  // authToken intentionally absent here — newClaudeConfig seeds it as '' and the
  // reset spread must not overwrite a user's token (see SAFETY INVARIANT above).
  ollama: {
    baseUrl: 'http://localhost:11434', model: 'glm-5.2:cloud',
    opusModel: '', sonnetModel: '', haikuModel: '', subagentModel: '', effortLevel: '',
  },
  // z.ai Anthropic Messages endpoint; user fills the auth token (Bearer).
  // authToken intentionally absent — preserved across reset (see SAFETY INVARIANT).
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.2[1m]',
    opusModel: '', sonnetModel: '', haikuModel: '', subagentModel: '', effortLevel: '',
  },
}

export const CODEX_PRESET_DEFAULTS: Record<CodexBuiltinPreset, Partial<CodexProviderConfig>> = {
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
}

function newClaudeConfig(preset: ClaudePresetId, enabled: boolean): ClaudeProviderConfig {
  const builtinDefaults = isCustomId(preset) ? {} : CLAUDE_PRESET_DEFAULTS[preset]
  return {
    enabled,
    preset,
    baseUrl: '',
    authToken: '',
    model: '',
    opusModel: '',
    sonnetModel: '',
    haikuModel: '',
    subagentModel: '',
    effortLevel: '',
    extraEnvVars: [],
    ...builtinDefaults,
  }
}

function newCodexConfig(preset: CodexPresetId, enabled: boolean): CodexProviderConfig {
  const builtinDefaults = isCustomId(preset) ? {} : CODEX_PRESET_DEFAULTS[preset]
  return {
    enabled,
    preset,
    providerName: '',
    model: '',
    baseUrl: '',
    envKey: '',
    apiKey: '',
    wireApi: 'responses',
    extraEnvVars: [],
    ...builtinDefaults,
  }
}

// True when every field a preset ships a default for already equals that default.
// Driven by the defaults map keys, so it stays correct as presets add fields.
// Guards against a missing defaults entry (e.g. a stale legacy preset value that
// has not yet been sanitized) — returns false rather than throwing, since a preset
// with no known defaults has nothing to reset.
export function draftMatchesDefaults<T extends object>(draft: T, defaults: Partial<T> | undefined): boolean {
  if (!defaults) return false
  return (Object.keys(defaults) as (keyof T)[]).every((k) => draft[k] === defaults[k])
}

// Type guard: the active preset is a real built-in (a key in the defaults map).
// Needed because a stale unsanitized value (e.g. the legacy `"custom"` slot) is
// neither a built-in nor a `custom:<id>` and must not index the defaults map.
function isClaudeBuiltin(preset: ClaudePresetId): preset is ClaudeBuiltinPreset {
  return Object.prototype.hasOwnProperty.call(CLAUDE_PRESET_DEFAULTS, preset)
}
function isCodexBuiltin(preset: CodexPresetId): preset is CodexBuiltinPreset {
  return Object.prototype.hasOwnProperty.call(CODEX_PRESET_DEFAULTS, preset)
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

// Shared overlay modal (the #1a1b1e overlay pattern from theme.ts, not a native confirm()).
function ConfirmOverlay({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  message: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div style={{ ...overlayStyles.backdrop, zIndex: ui.z.overlay }} onClick={onCancel}>
      <div style={{ ...overlayStyles.panel, width: 340, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div style={overlayStyles.header}>
          <span style={overlayStyles.headerTitle}>{title}</span>
        </div>
        <div style={{ padding: '14px 16px', fontSize: 12, color: ui.color.text, lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 16px 14px' }}>
          <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
          <button
            onClick={onConfirm}
            style={{ ...primaryBtn, background: '#3a1a1a', borderColor: ui.color.danger, color: ui.color.danger }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

interface CustomEntryView { id: CustomProviderId; name: string }

// Provider picker: built-in preset chips + named custom-provider chips (rename +
// delete) + an inline "+ Add custom" control. Switching never touches another
// provider's saved draft — the parent owns that routing.
function ProviderPicker<B extends string>({
  builtins,
  builtinLabels,
  customs,
  activeId,
  disabled,
  onSelectBuiltin,
  onSelectCustom,
  onAddCustom,
  onRenameCustom,
  onDeleteCustom,
}: {
  builtins: readonly B[]
  builtinLabels: Record<B, string>
  customs: CustomEntryView[]
  activeId: string
  disabled?: boolean
  onSelectBuiltin: (p: B) => void
  onSelectCustom: (id: CustomProviderId) => void
  onAddCustom: (name: string) => void
  onRenameCustom: (id: CustomProviderId, name: string) => void
  onDeleteCustom: (id: CustomProviderView) => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CustomEntryView | null>(null)

  function commitAdd(): void {
    const name = addName.trim()
    if (!name) { setAdding(false); return }
    onAddCustom(name)
    setAdding(false)
    setAddName('')
  }
  function cancelAdd(): void {
    setAdding(false)
    setAddName('')
  }

  function startRename(c: CustomEntryView): void {
    setRenamingId(c.id)
    setRenameValue(c.name)
  }
  function commitRename(): void {
    if (!renamingId) return
    const name = renameValue.trim()
    if (name) onRenameCustom(renamingId as CustomProviderId, name)
    setRenamingId(null)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {builtins.map((p) => {
          const active = activeId === p
          return (
            <button
              key={p}
              disabled={disabled}
              onClick={() => onSelectBuiltin(p)}
              style={{
                padding: '3px 9px', fontSize: 11, cursor: disabled ? 'default' : 'pointer',
                background: active ? '#1a3a1a' : 'none',
                border: `1px solid ${active ? '#4ade80' : '#3a3b3e'}`,
                borderRadius: 4, color: active ? '#4ade80' : '#6b7280',
                fontWeight: active ? 500 : 400,
              }}
            >
              {builtinLabels[p]}
            </button>
          )
        })}

        {customs.length > 0 && <span style={{ width: 1, alignSelf: 'stretch', background: '#2a2b2e', margin: '2px 2px' }} />}
        {customs.map((c) => {
          const active = c.id === activeId
          const renaming = renamingId === c.id
          return (
            <span
              key={c.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 1,
                padding: '1px 3px 1px 8px',
                background: active ? '#1a3a1a' : 'none',
                border: `1px solid ${active ? '#4ade80' : '#3a3b3e'}`,
                borderRadius: 4,
              }}
            >
              {renaming ? (
                <input
                  autoFocus value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                    if (e.key === 'Escape') setRenamingId(null)
                    e.stopPropagation()
                  }}
                  onBlur={commitRename}
                  style={{ ...monoInput, width: 100, padding: '1px 4px', fontSize: 11 }}
                />
              ) : (
                <button
                  onClick={() => onSelectCustom(c.id)}
                  disabled={disabled}
                  title={c.name}
                  style={{ background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', color: active ? '#4ade80' : '#9aa0a6', fontSize: 11, padding: '2px 0', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {c.name}
                </button>
              )}
              <button onClick={() => startRename(c)} disabled={disabled || renaming} title="Rename" style={iconBtn}>✎</button>
              <button onClick={() => setPendingDelete(c)} disabled={disabled} title="Delete" style={{ ...iconBtn, color: '#6b3030' }}>✕</button>
            </span>
          )
        })}
      </div>

      <div style={{ marginTop: 5 }}>
        {adding ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              autoFocus value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
                if (e.key === 'Escape') cancelAdd()
                e.stopPropagation()
              }}
              placeholder="provider name"
              style={{ ...monoInput, width: 130, padding: '2px 6px', fontSize: 11 }}
            />
            <button onClick={commitAdd} disabled={!addName.trim()} style={primaryBtn}>Add</button>
            <button onClick={cancelAdd} style={secondaryBtn}>Cancel</button>
          </span>
        ) : (
          <button onClick={() => { setAdding(true); setAddName('') }} disabled={disabled} style={{ ...secondaryBtn, fontSize: 10 }}>+ Add custom</button>
        )}
      </div>

      {pendingDelete && (
        <ConfirmOverlay
          title="Delete custom provider"
          message={<>Delete <strong style={{ color: ui.color.textStrong }}>{pendingDelete.name}</strong>? This discards that provider's saved credentials and cannot be undone.</>}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => { onDeleteCustom(pendingDelete); setPendingDelete(null) }}
        />
      )}
    </div>
  )
}

// A small handle passed to onDeleteCustom so the parent can branch on active-vs-inactive.
type CustomProviderView = CustomEntryView

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

  // --- Claude slot routing ---
  // Write the active draft back to whichever slot is active: a built-in preset
  // map entry, or the matching custom-providers array entry.
  function flushClaude(draft: ClaudeProviderConfig = claudeDraft): void {
    const current = useSettingsStore.getState().agentProviders
    if (isCustomId(draft.preset)) {
      const customs = (current.claudeCustomProviders ?? []).map((c) =>
        c.id === draft.preset ? { ...c, config: draft } : c
      )
      setAgentProviders({ ...current, claude: draft, claudeCustomProviders: customs })
    } else {
      setAgentProviders({
        ...current,
        claude: draft,
        claudePresets: { ...current.claudePresets, [draft.preset]: draft },
      })
    }
  }

  // Reset the active built-in preset's routing fields (baseUrl + model + tier
  // overrides + effort) to CLAUDE_PRESET_DEFAULTS. The spread puts defaults over
  // the draft, so authToken / extraEnvVars / enabled / preset survive. No-op for
  // custom providers (no shipped defaults). Persists into the preset's saved slot
  // via flushClaude so the reset survives a switch-away-and-back.
  function resetClaudeDefaults(): void {
    if (!isClaudeBuiltin(claudeDraft.preset)) return
    const reset = { ...claudeDraft, ...CLAUDE_PRESET_DEFAULTS[claudeDraft.preset] }
    setClaudeDraft(reset)
    flushClaude(reset)
  }

  // Save the outgoing provider's draft, then load the incoming provider's saved
  // draft (or a freshly seeded one). `enabled` carries across as the per-kind
  // runtime toggle; everything else is per-provider.
  function activateClaude(incomingId: ClaudePresetId): void {
    if (claudeDraft.preset === incomingId) return
    const current = useSettingsStore.getState().agentProviders
    const afterSave = saveClaudeOutgoing(current, claudeDraft)
    const incoming = loadClaudeDraft(afterSave, incomingId, claudeDraft.enabled)
    setClaudeDraft(incoming)
    commitClaudeActive(afterSave, incoming)
  }

  function addClaudeCustom(name: string): void {
    const id = `custom:${crypto.randomUUID()}` as CustomProviderId
    const current = useSettingsStore.getState().agentProviders
    const afterSave = saveClaudeOutgoing(current, claudeDraft)
    const config = newClaudeConfig(id, claudeDraft.enabled)
    const entry = { id, name, config }
    const incoming = { ...config, enabled: claudeDraft.enabled }
    setClaudeDraft(incoming)
    setAgentProviders({
      ...afterSave,
      claude: incoming,
      claudeCustomProviders: [...(afterSave.claudeCustomProviders ?? []), entry],
    })
  }

  function renameClaudeCustom(id: CustomProviderId, name: string): void {
    const current = useSettingsStore.getState().agentProviders
    setAgentProviders({
      ...current,
      claudeCustomProviders: (current.claudeCustomProviders ?? []).map((c) => c.id === id ? { ...c, name } : c),
    })
  }

  function deleteClaudeCustom(view: CustomProviderView): void {
    const current = useSettingsStore.getState().agentProviders
    const customs = (current.claudeCustomProviders ?? []).filter((c) => c.id !== view.id)
    if (current.claude.preset === view.id) {
      // Deleting the active provider → fall back to native (disabled).
      const native = newClaudeConfig('native', false)
      setClaudeDraft(native)
      setAgentProviders({
        ...current,
        claude: native,
        claudeCustomProviders: customs,
        claudePresets: { ...current.claudePresets, native },
      })
    } else {
      setAgentProviders({ ...current, claudeCustomProviders: customs })
    }
  }

  // --- Codex slot routing (mirrors Claude) ---
  function flushCodex(draft: CodexProviderConfig = codexDraft): void {
    const current = useSettingsStore.getState().agentProviders
    if (isCustomId(draft.preset)) {
      const customs = (current.codexCustomProviders ?? []).map((c) =>
        c.id === draft.preset ? { ...c, config: draft } : c
      )
      setAgentProviders({ ...current, codex: draft, codexCustomProviders: customs })
    } else {
      setAgentProviders({
        ...current,
        codex: draft,
        codexPresets: { ...current.codexPresets, [draft.preset]: draft },
      })
    }
  }

  // Reset the active built-in preset's routing fields (providerName + model +
  // baseUrl + envKey + wireApi) to CODEX_PRESET_DEFAULTS. The spread puts defaults
  // over the draft, so apiKey / extraEnvVars / enabled / preset survive. envKey is
  // the env-var *name* (routing), not the secret (apiKey, preserved). No-op for
  // custom providers. Persists into the preset's saved slot via flushCodex.
  function resetCodexDefaults(): void {
    if (!isCodexBuiltin(codexDraft.preset)) return
    const reset = { ...codexDraft, ...CODEX_PRESET_DEFAULTS[codexDraft.preset] }
    setCodexDraft(reset)
    flushCodex(reset)
  }

  function activateCodex(incomingId: CodexPresetId): void {
    if (codexDraft.preset === incomingId) return
    const current = useSettingsStore.getState().agentProviders
    const afterSave = saveCodexOutgoing(current, codexDraft)
    const incoming = loadCodexDraft(afterSave, incomingId, codexDraft.enabled)
    setCodexDraft(incoming)
    commitCodexActive(afterSave, incoming)
  }

  function addCodexCustom(name: string): void {
    const id = `custom:${crypto.randomUUID()}` as CustomProviderId
    const current = useSettingsStore.getState().agentProviders
    const afterSave = saveCodexOutgoing(current, codexDraft)
    const config = newCodexConfig(id, codexDraft.enabled)
    const entry = { id, name, config }
    const incoming = { ...config, enabled: codexDraft.enabled }
    setCodexDraft(incoming)
    setAgentProviders({
      ...afterSave,
      codex: incoming,
      codexCustomProviders: [...(afterSave.codexCustomProviders ?? []), entry],
    })
  }

  function renameCodexCustom(id: CustomProviderId, name: string): void {
    const current = useSettingsStore.getState().agentProviders
    setAgentProviders({
      ...current,
      codexCustomProviders: (current.codexCustomProviders ?? []).map((c) => c.id === id ? { ...c, name } : c),
    })
  }

  function deleteCodexCustom(view: CustomProviderView): void {
    const current = useSettingsStore.getState().agentProviders
    const customs = (current.codexCustomProviders ?? []).filter((c) => c.id !== view.id)
    if (current.codex.preset === view.id) {
      const native = newCodexConfig('native', false)
      setCodexDraft(native)
      setAgentProviders({
        ...current,
        codex: native,
        codexCustomProviders: customs,
        codexPresets: { ...current.codexPresets, native },
      })
    } else {
      setAgentProviders({ ...current, codexCustomProviders: customs })
    }
  }

  const claudeDisabled = !claudeDraft.enabled
  const codexDisabled = !codexDraft.enabled
  // Reset is available only for real built-ins that render routing fields. Native
  // ships no visible fields; custom providers have no shipped defaults; a stale
  // unsanitized preset value is neither and is ignored until hydration fixes it.
  const claudeActiveDefaults = isClaudeBuiltin(claudeDraft.preset) ? CLAUDE_PRESET_DEFAULTS[claudeDraft.preset] : undefined
  const codexActiveDefaults = isCodexBuiltin(codexDraft.preset) ? CODEX_PRESET_DEFAULTS[codexDraft.preset] : undefined
  const claudeResetVisible = !!claudeActiveDefaults && claudeDraft.preset !== 'native'
  const codexResetVisible = !!codexActiveDefaults && codexDraft.preset !== 'native'
  const claudeAtDefaults = claudeResetVisible && draftMatchesDefaults(claudeDraft, claudeActiveDefaults)
  const codexAtDefaults = codexResetVisible && draftMatchesDefaults(codexDraft, codexActiveDefaults)
  const claudeCustoms: CustomEntryView[] = (agentProviders.claudeCustomProviders ?? []).map((c) => ({ id: c.id, name: c.name }))
  const codexCustoms: CustomEntryView[] = (agentProviders.codexCustomProviders ?? []).map((c) => ({ id: c.id, name: c.name }))

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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ProviderPicker<ClaudeBuiltinPreset>
                builtins={CLAUDE_BUILTIN_LIST}
                builtinLabels={CLAUDE_BUILTIN_LABELS}
                customs={claudeCustoms}
                activeId={claudeDraft.preset}
                disabled={claudeDisabled}
                onSelectBuiltin={(p) => activateClaude(p)}
                onSelectCustom={(id) => activateClaude(id)}
                onAddCustom={addClaudeCustom}
                onRenameCustom={renameClaudeCustom}
                onDeleteCustom={deleteClaudeCustom}
              />
              {claudeResetVisible && (
                <button
                  onClick={resetClaudeDefaults}
                  disabled={claudeAtDefaults}
                  title="Restore this preset's base URL and model defaults (keeps auth token)"
                  style={{
                    ...secondaryBtn,
                    fontSize: 10,
                    alignSelf: 'flex-start',
                    opacity: claudeAtDefaults ? 0.4 : 1,
                    cursor: claudeAtDefaults ? 'default' : 'pointer',
                  }}
                >
                  Reset to defaults
                </button>
              )}
            </div>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ProviderPicker<CodexBuiltinPreset>
                builtins={CODEX_BUILTIN_LIST}
                builtinLabels={CODEX_BUILTIN_LABELS}
                customs={codexCustoms}
                activeId={codexDraft.preset}
                disabled={codexDisabled}
                onSelectBuiltin={(p) => activateCodex(p)}
                onSelectCustom={(id) => activateCodex(id)}
                onAddCustom={addCodexCustom}
                onRenameCustom={renameCodexCustom}
                onDeleteCustom={deleteCodexCustom}
              />
              {codexResetVisible && (
                <button
                  onClick={resetCodexDefaults}
                  disabled={codexAtDefaults}
                  title="Restore this preset's base URL and model defaults (keeps API key)"
                  style={{
                    ...secondaryBtn,
                    fontSize: 10,
                    alignSelf: 'flex-start',
                    opacity: codexAtDefaults ? 0.4 : 1,
                    cursor: codexAtDefaults ? 'default' : 'pointer',
                  }}
                >
                  Reset to defaults
                </button>
              )}
            </div>
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
              {/* envKey + wireApi only matter for custom providers (z.ai / Ollama
                  via OpenAI). Widening to the alibaba built-ins is a spec-017
                  loose end, out of scope here. */}
              {isCustomId(codexDraft.preset) && (
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

// --- Claude slot helpers (operate on store snapshots, no React state) ---
function saveClaudeOutgoing(settings: AgentProviderSettings, draft: ClaudeProviderConfig): AgentProviderSettings {
  if (isCustomId(draft.preset)) {
    return {
      ...settings,
      claudeCustomProviders: (settings.claudeCustomProviders ?? []).map((c) =>
        c.id === draft.preset ? { ...c, config: draft } : c
      ),
    }
  }
  return { ...settings, claudePresets: { ...settings.claudePresets, [draft.preset]: draft } }
}

function loadClaudeDraft(settings: AgentProviderSettings, incomingId: ClaudePresetId, enabled: boolean): ClaudeProviderConfig {
  if (isCustomId(incomingId)) {
    const entry = (settings.claudeCustomProviders ?? []).find((c) => c.id === incomingId)
    if (entry) return { ...entry.config, enabled, preset: incomingId }
    // Dangling reference — sanitizer should have prevented this; seed fresh.
    return newClaudeConfig(incomingId, enabled)
  }
  const saved = settings.claudePresets?.[incomingId]
  return saved ? { ...saved, enabled, preset: incomingId } : newClaudeConfig(incomingId, enabled)
}

function commitClaudeActive(settings: AgentProviderSettings, incoming: ClaudeProviderConfig): void {
  // Push the incoming draft to the store as the active config AND persist it into
  // its own slot so a subsequent switch-away saves the right thing.
  const store = useSettingsStore.getState()
  if (isCustomId(incoming.preset)) {
    store.setAgentProviders({
      ...settings,
      claude: incoming,
      claudeCustomProviders: (settings.claudeCustomProviders ?? []).map((c) =>
        c.id === incoming.preset ? { ...c, config: incoming } : c
      ),
    })
  } else {
    store.setAgentProviders({
      ...settings,
      claude: incoming,
      claudePresets: { ...settings.claudePresets, [incoming.preset]: incoming },
    })
  }
}

// --- Codex slot helpers (mirror Claude) ---
function saveCodexOutgoing(settings: AgentProviderSettings, draft: CodexProviderConfig): AgentProviderSettings {
  if (isCustomId(draft.preset)) {
    return {
      ...settings,
      codexCustomProviders: (settings.codexCustomProviders ?? []).map((c) =>
        c.id === draft.preset ? { ...c, config: draft } : c
      ),
    }
  }
  return { ...settings, codexPresets: { ...settings.codexPresets, [draft.preset]: draft } }
}

function loadCodexDraft(settings: AgentProviderSettings, incomingId: CodexPresetId, enabled: boolean): CodexProviderConfig {
  if (isCustomId(incomingId)) {
    const entry = (settings.codexCustomProviders ?? []).find((c) => c.id === incomingId)
    if (entry) return { ...entry.config, enabled, preset: incomingId }
    return newCodexConfig(incomingId, enabled)
  }
  const saved = settings.codexPresets?.[incomingId]
  return saved ? { ...saved, enabled, preset: incomingId } : newCodexConfig(incomingId, enabled)
}

function commitCodexActive(settings: AgentProviderSettings, incoming: CodexProviderConfig): void {
  const store = useSettingsStore.getState()
  if (isCustomId(incoming.preset)) {
    store.setAgentProviders({
      ...settings,
      codex: incoming,
      codexCustomProviders: (settings.codexCustomProviders ?? []).map((c) =>
        c.id === incoming.preset ? { ...c, config: incoming } : c
      ),
    })
  } else {
    store.setAgentProviders({
      ...settings,
      codex: incoming,
      codexPresets: { ...settings.codexPresets, [incoming.preset]: incoming },
    })
  }
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
