import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import type { EnvVarEntry } from '../../../../shared/types'

// Parse a block of env var assignments in common formats:
//   KEY=value
//   KEY="value"
//   $env:KEY="value"   (PowerShell)
//   export KEY=value   (bash)
function parseEnvBlock(text: string): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Strip leading $env: or export
    const stripped = line.replace(/^\$env:/i, '').replace(/^export\s+/i, '')
    const eqIdx = stripped.indexOf('=')
    if (eqIdx < 1) continue
    const key = stripped.slice(0, eqIdx).trim()
    let value = stripped.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) results.push({ key, value })
  }
  return results
}

export function EnvVarsSection(): JSX.Element {
  const envVarOverrides = useSettingsStore((s) => s.envVarOverrides)
  const setEnvVarOverrides = useSettingsStore((s) => s.setEnvVarOverrides)
  const hydrateEnvVarOverrides = useSettingsStore((s) => s.hydrateEnvVarOverrides)

  // Hydrate from main on first open so disk state and localStorage stay in sync
  useEffect(() => {
    window.ipc.invoke('settings:get-env-vars').then((entries) => {
      hydrateEnvVarOverrides(entries as EnvVarEntry[])
    }).catch(() => {})
  }, [hydrateEnvVarOverrides])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKey, setEditKey] = useState('')
  const [editValue, setEditValue] = useState('')
  const [showValues, setShowValues] = useState<Set<string>>(new Set())
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importError, setImportError] = useState('')

  function startEdit(entry: EnvVarEntry): void {
    setEditingId(entry.id)
    setEditKey(entry.key)
    setEditValue(entry.value)
  }

  function startAdd(): void {
    const id = crypto.randomUUID()
    const newEntry: EnvVarEntry = { id, key: '', value: '', enabled: true }
    setEnvVarOverrides([...envVarOverrides, newEntry])
    setEditingId(id)
    setEditKey('')
    setEditValue('')
  }

  function commitEdit(): void {
    if (!editingId) return
    const key = editKey.trim()
    if (!key) {
      // Empty key = discard new entry
      setEnvVarOverrides(envVarOverrides.filter((e) => e.id !== editingId))
    } else {
      setEnvVarOverrides(envVarOverrides.map((e) =>
        e.id === editingId ? { ...e, key, value: editValue } : e
      ))
    }
    setEditingId(null)
  }

  function cancelEdit(): void {
    if (!editingId) return
    // If the entry has an empty key (was just added), remove it
    const entry = envVarOverrides.find((e) => e.id === editingId)
    if (entry && !entry.key) {
      setEnvVarOverrides(envVarOverrides.filter((e) => e.id !== editingId))
    }
    setEditingId(null)
  }

  function toggleEnabled(id: string): void {
    setEnvVarOverrides(envVarOverrides.map((e) =>
      e.id === id ? { ...e, enabled: !e.enabled } : e
    ))
  }

  function deleteEntry(id: string): void {
    if (editingId === id) setEditingId(null)
    setEnvVarOverrides(envVarOverrides.filter((e) => e.id !== id))
  }

  function toggleShowValue(id: string): void {
    setShowValues((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function commitImport(): void {
    const parsed = parseEnvBlock(importText)
    if (parsed.length === 0) {
      setImportError('No valid KEY=VALUE pairs found.')
      return
    }
    const newEntries: EnvVarEntry[] = parsed.map(({ key, value }) => ({
      id: crypto.randomUUID(),
      key,
      value,
      enabled: true,
    }))
    // Merge: update existing keys, append new ones
    const merged = [...envVarOverrides]
    for (const entry of newEntries) {
      const existing = merged.findIndex((e) => e.key === entry.key)
      if (existing >= 0) {
        merged[existing] = { ...merged[existing], value: entry.value, enabled: true }
      } else {
        merged.push(entry)
      }
    }
    setEnvVarOverrides(merged)
    setImportText('')
    setImportError('')
    setShowImport(false)
  }

  const activeCount = envVarOverrides.filter((e) => e.enabled && e.key.trim()).length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 6px', marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Environment Variables
          </span>
          {activeCount > 0 && (
            <span style={{ marginLeft: 8, fontSize: 10, color: '#4ade80' }}>{activeCount} active</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => { setShowImport(!showImport); setImportError('') }}
            style={secondaryBtn}
          >
            Import
          </button>
          <button onClick={startAdd} style={secondaryBtn}>
            + Add
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 6, padding: '0 14px', fontSize: 11, color: '#5a6272', lineHeight: 1.5 }}>
        Injected into every new shell and agent pane at spawn time. Use this to configure alternative API providers
        (e.g. DeepSeek via <code style={{ color: '#a0c4e8', fontFamily: 'monospace' }}>ANTHROPIC_BASE_URL</code>)
        or any other environment-level settings.
      </div>

      {showImport && (
        <div style={{ margin: '0 0 8px', padding: '10px 12px', background: '#141517', border: '1px solid #2a2b2e', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
            Paste a block of assignments — supports <code style={{ color: '#a0c4e8', fontFamily: 'monospace' }}>KEY=value</code>,{' '}
            <code style={{ color: '#a0c4e8', fontFamily: 'monospace' }}>{`$env:KEY="value"`}</code>, or{' '}
            <code style={{ color: '#a0c4e8', fontFamily: 'monospace' }}>export KEY=value</code> formats.
            Existing keys will be updated.
          </div>
          <textarea
            value={importText}
            onChange={(e) => { setImportText(e.target.value); setImportError('') }}
            placeholder={`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nANTHROPIC_AUTH_TOKEN=sk-...`}
            rows={5}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: '#0e0f11',
              border: '1px solid #3a3b3e',
              borderRadius: 4,
              color: '#d4d4d4',
              fontSize: 11,
              fontFamily: 'monospace',
              padding: '6px 8px',
              resize: 'vertical',
            }}
          />
          {importError && (
            <div style={{ color: '#f87171', fontSize: 11, marginTop: 4 }}>{importError}</div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowImport(false); setImportText(''); setImportError('') }} style={secondaryBtn}>
              Cancel
            </button>
            <button onClick={commitImport} style={primaryBtn}>
              Import
            </button>
          </div>
        </div>
      )}

      {envVarOverrides.length === 0 && !showImport && (
        <div style={{ padding: '12px 14px', color: '#4a4b4e', fontSize: 12 }}>
          No environment variables configured. Add one or use Import to paste a block.
        </div>
      )}

      {envVarOverrides.map((entry) => {
        const isEditing = editingId === entry.id
        const revealed = showValues.has(entry.id)
        const looksSecret = /key|token|secret|pass|auth/i.test(entry.key)

        return (
          <div
            key={entry.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              marginBottom: 3,
              background: isEditing ? '#141e14' : '#141517',
              border: `1px solid ${isEditing ? '#2a4a2a' : '#2a2b2e'}`,
              borderRadius: 5,
            }}
          >
            {/* Enable toggle */}
            <input
              type="checkbox"
              checked={entry.enabled}
              onChange={() => toggleEnabled(entry.id)}
              title={entry.enabled ? 'Disable' : 'Enable'}
              style={{ flexShrink: 0, cursor: 'pointer', accentColor: '#4ade80' }}
            />

            {isEditing ? (
              <>
                <input
                  autoFocus
                  value={editKey}
                  onChange={(e) => setEditKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                    if (e.key === 'Escape') cancelEdit()
                    e.stopPropagation()
                  }}
                  placeholder="KEY"
                  style={{ ...monoInput, width: 180, flexShrink: 0 }}
                />
                <span style={{ color: '#4a4b4e', fontSize: 12, flexShrink: 0 }}>=</span>
                <input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                    if (e.key === 'Escape') cancelEdit()
                    e.stopPropagation()
                  }}
                  placeholder="value"
                  style={{ ...monoInput, flex: 1, minWidth: 0 }}
                />
                <button onClick={commitEdit} style={primaryBtn} title="Save">Save</button>
                <button onClick={cancelEdit} style={secondaryBtn} title="Cancel">Cancel</button>
              </>
            ) : (
              <>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: entry.enabled ? '#a0c4e8' : '#4a4b4e',
                    width: 180,
                    flexShrink: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.key || <span style={{ color: '#4a4b4e', fontStyle: 'italic' }}>unnamed</span>}
                </span>
                <span style={{ color: '#4a4b4e', fontSize: 12, flexShrink: 0 }}>=</span>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: entry.enabled ? '#c9cdd1' : '#4a4b4e',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                  }}
                  title={looksSecret && !revealed ? 'Click eye icon to reveal' : entry.value}
                >
                  {looksSecret && !revealed
                    ? '•'.repeat(Math.min(entry.value.length, 20))
                    : (entry.value || <span style={{ color: '#4a4b4e', fontStyle: 'italic' }}>empty</span>)
                  }
                </span>
                {looksSecret && (
                  <button
                    onClick={() => toggleShowValue(entry.id)}
                    title={revealed ? 'Hide' : 'Reveal'}
                    style={iconBtn}
                  >
                    {revealed ? '🙈' : '👁'}
                  </button>
                )}
                <button onClick={() => startEdit(entry)} title="Edit" style={iconBtn}>✎</button>
                <button onClick={() => deleteEntry(entry.id)} title="Delete" style={{ ...iconBtn, color: '#6b3030' }}>✕</button>
              </>
            )}
          </div>
        )
      })}

      {envVarOverrides.length > 0 && (
        <div style={{ padding: '6px 14px 2px', fontSize: 10, color: '#4a4b4e', lineHeight: 1.4 }}>
          Changes take effect in new panes. Existing running panes are not affected.
        </div>
      )}
    </div>
  )
}

const monoInput: React.CSSProperties = {
  background: '#0e0f11',
  border: '1px solid #3a3b3e',
  borderRadius: 4,
  color: '#d4d4d4',
  fontSize: 12,
  fontFamily: 'monospace',
  padding: '4px 6px',
  outline: 'none',
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
