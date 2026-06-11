import React, { useCallback, useEffect, useState } from 'react'
import type { McpServerEntry, McpServerType, McpSettings, McpStatus } from '../../../../shared/types'
import { useSettingsStore } from '../../store/settings'

function generateId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

const EMPTY_FORM: Omit<McpServerEntry, 'id'> = {
  name: '',
  enabled: true,
  type: 'http',
  url: '',
  command: '',
  args: [],
  env: {},
}

export function McpSection(): JSX.Element {
  const mcpSettings = useSettingsStore((s) => s.mcpSettings)
  const setMcpSettings = useSettingsStore((s) => s.setMcpSettings)

  const [status, setStatus] = useState<McpStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<Omit<McpServerEntry, 'id'>>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [saved, setSaved] = useState(false)

  const fetchStatus = useCallback(() => {
    setStatusError(false)
    window.ipc.invoke('mcp:get-status').then((s) => {
      setStatus(s as McpStatus)
    }).catch(() => setStatusError(true))
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  function save(next: McpSettings): void {
    setMcpSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function toggleBuiltin(enabled: boolean): void {
    save({ ...mcpSettings, builtinBrowserEnabled: enabled })
  }

  function openAdd(): void {
    setFormData(EMPTY_FORM)
    setFormError(null)
    setEditingId(null)
    setShowAddForm(true)
  }

  function openEdit(entry: McpServerEntry): void {
    setFormData({ ...entry })
    setFormError(null)
    setEditingId(entry.id)
    setShowAddForm(true)
  }

  function cancelForm(): void {
    setShowAddForm(false)
    setEditingId(null)
    setFormError(null)
  }

  function validateForm(): string | null {
    if (!formData.name.trim()) return 'Server name is required.'
    if (!/^[a-zA-Z0-9_-]+$/.test(formData.name.trim())) return 'Name must contain only letters, numbers, hyphens, and underscores.'
    if (formData.name.trim() === 'multiagent-browser') return '"multiagent-browser" is reserved for the built-in server.'
    if (formData.type !== 'stdio' && !formData.url?.trim()) return 'URL is required for HTTP/SSE servers.'
    if (formData.type === 'stdio' && !formData.command?.trim()) return 'Command is required for stdio servers.'
    const isDuplicate = mcpSettings.customServers.some(
      (s) => s.name.trim() === formData.name.trim() && s.id !== editingId
    )
    if (isDuplicate) return `A server named "${formData.name.trim()}" already exists.`
    return null
  }

  function submitForm(): void {
    const err = validateForm()
    if (err) { setFormError(err); return }

    const entry: McpServerEntry = {
      id: editingId ?? generateId(),
      name: formData.name.trim(),
      enabled: formData.enabled,
      type: formData.type,
      ...(formData.type !== 'stdio' ? { url: formData.url?.trim() } : {}),
      ...(formData.type === 'stdio' ? {
        command: formData.command?.trim(),
        args: (formData.args ?? []).filter(Boolean),
        ...(formData.env && Object.keys(formData.env).length ? { env: formData.env } : {}),
      } : {}),
    }

    const customServers = editingId
      ? mcpSettings.customServers.map((s) => (s.id === editingId ? entry : s))
      : [...mcpSettings.customServers, entry]

    save({ ...mcpSettings, customServers })
    setShowAddForm(false)
    setEditingId(null)
  }

  function deleteServer(id: string): void {
    save({ ...mcpSettings, customServers: mcpSettings.customServers.filter((s) => s.id !== id) })
  }

  function toggleServer(id: string, enabled: boolean): void {
    save({
      ...mcpSettings,
      customServers: mcpSettings.customServers.map((s) => (s.id === id ? { ...s, enabled } : s)),
    })
  }

  const generatedJson = buildPreviewJson(mcpSettings, status?.port ?? null)

  return (
    <div>
      <SectionLabel>Model Context Protocol (MCP)</SectionLabel>
      <p style={{ color: '#6b7280', fontSize: 11, padding: '0 14px 12px', lineHeight: 1.5, margin: 0 }}>
        Configure MCP servers that are injected into new Claude and Codex sessions.
        Changes apply to sessions started after saving.
      </p>

      {saved && (
        <div style={{
          margin: '0 0 8px',
          padding: '6px 12px',
          background: '#0f2a15',
          border: '1px solid #1a4a25',
          borderRadius: 5,
          color: '#4ade80',
          fontSize: 12,
        }}>
          Settings saved — new sessions will use the updated config.
        </div>
      )}

      {/* Built-in Browser MCP Server */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ padding: '0 14px 4px', fontSize: 10, fontWeight: 600, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Built-in Server
        </div>
        <ServerCard>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <StatusDot running={status?.running ?? false} />
                <span style={{ color: '#d4d4d4', fontSize: 13, fontWeight: 500 }}>multiagent-browser</span>
                <span style={{ color: '#4a4b4e', fontSize: 10, fontFamily: 'monospace', background: '#1e1f22', border: '1px solid #2a2b2e', borderRadius: 3, padding: '1px 5px' }}>
                  http
                </span>
              </div>
              {status ? (
                <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>
                  {status.running ? (
                    <>
                      Listening on port <code style={{ color: '#a0a4a8', background: '#1e1f22', padding: '0 4px', borderRadius: 3 }}>{status.port}</code>
                      {' · '}
                      <span style={{ color: '#4a4b4e' }}>{status.tools.length} tools available</span>
                    </>
                  ) : 'Not running'}
                </div>
              ) : statusError ? (
                <div style={{ color: '#f87171', fontSize: 11 }}>Failed to fetch status</div>
              ) : (
                <div style={{ color: '#4a4b4e', fontSize: 11 }}>Loading...</div>
              )}
              {status?.running && mcpSettings.builtinBrowserEnabled && (
                <ToolsCollapse tools={status.tools} />
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {statusError && (
                <button
                  onClick={fetchStatus}
                  style={{ background: 'none', border: '1px solid #3a3b3e', borderRadius: 4, color: '#6b7280', fontSize: 11, cursor: 'pointer', padding: '2px 8px' }}
                >
                  Retry
                </button>
              )}
              <Toggle
                checked={mcpSettings.builtinBrowserEnabled}
                onChange={toggleBuiltin}
                label={mcpSettings.builtinBrowserEnabled ? 'Enabled' : 'Disabled'}
              />
            </div>
          </div>
        </ServerCard>
      </div>

      {/* Custom Servers */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px 4px' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Custom Servers
          </div>
          {!showAddForm && (
            <button
              onClick={openAdd}
              style={{
                background: 'none',
                border: '1px solid #3a3b3e',
                borderRadius: 4,
                color: '#4ade80',
                fontSize: 11,
                cursor: 'pointer',
                padding: '2px 8px',
              }}
            >
              + Add server
            </button>
          )}
        </div>

        {mcpSettings.customServers.length === 0 && !showAddForm && (
          <div style={{ color: '#4a4b4e', fontSize: 12, padding: '10px 14px' }}>
            No custom servers configured.
          </div>
        )}

        {mcpSettings.customServers.map((entry) => (
          editingId === entry.id && showAddForm ? null : (
            <ServerCard key={entry.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ color: '#d4d4d4', fontSize: 13, fontWeight: 500 }}>{entry.name}</span>
                    <TypeBadge type={entry.type} />
                    {!entry.enabled && (
                      <span style={{ color: '#4a4b4e', fontSize: 10, background: '#1e1f22', border: '1px solid #2a2b2e', borderRadius: 3, padding: '1px 5px' }}>
                        disabled
                      </span>
                    )}
                  </div>
                  <div style={{ color: '#6b7280', fontSize: 11, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.type === 'stdio' ? entry.command : entry.url}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <Toggle checked={entry.enabled} onChange={(v) => toggleServer(entry.id, v)} />
                  <ActionButton onClick={() => openEdit(entry)} title="Edit">✎</ActionButton>
                  <ActionButton onClick={() => deleteServer(entry.id)} title="Delete" danger>×</ActionButton>
                </div>
              </div>
            </ServerCard>
          )
        ))}

        {showAddForm && (
          <ServerCard>
            <ServerForm
              data={formData}
              error={formError}
              isEdit={editingId !== null}
              onChange={setFormData}
              onSubmit={submitForm}
              onCancel={cancelForm}
            />
          </ServerCard>
        )}
      </div>

      {/* JSON Preview */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={() => setShowJson((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            color: '#4a4b4e',
            fontSize: 11,
            cursor: 'pointer',
            padding: '0 14px 6px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span>{showJson ? '▾' : '▸'}</span>
          <span>Generated config (claude-mcp.json)</span>
        </button>
        {showJson && (
          <pre style={{
            margin: '0 0 8px',
            padding: 12,
            background: '#0e0f11',
            border: '1px solid #2a2b2e',
            borderRadius: 6,
            color: '#a0a4a8',
            fontSize: 11,
            fontFamily: 'monospace',
            overflow: 'auto',
            maxHeight: 220,
            lineHeight: 1.5,
            whiteSpace: 'pre',
          }}>
            {generatedJson}
          </pre>
        )}
      </div>
    </div>
  )
}

function ServerForm({
  data,
  error,
  isEdit,
  onChange,
  onSubmit,
  onCancel,
}: {
  data: Omit<McpServerEntry, 'id'>
  error: string | null
  isEdit: boolean
  onChange: (d: Omit<McpServerEntry, 'id'>) => void
  onSubmit: () => void
  onCancel: () => void
}): JSX.Element {
  const [argsText, setArgsText] = useState((data.args ?? []).join(' '))
  const [envText, setEnvText] = useState(
    data.env && Object.keys(data.env).length
      ? Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n')
      : ''
  )
  const [envError, setEnvError] = useState<string | null>(null)

  function update(patch: Partial<Omit<McpServerEntry, 'id'>>): void {
    onChange({ ...data, ...patch })
  }

  function handleArgsChange(val: string): void {
    setArgsText(val)
    update({ args: val.split(' ').map((s) => s.trim()).filter(Boolean) })
  }

  function handleEnvChange(val: string): void {
    setEnvText(val)
    setEnvError(null)
    if (!val.trim()) { update({ env: {} }); return }
    try {
      const env: Record<string, string> = {}
      for (const line of val.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx < 1) { setEnvError('Format: KEY=value (one per line)'); return }
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1)
      }
      update({ env })
    } catch {
      setEnvError('Invalid env format')
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#d4d4d4', marginBottom: 10 }}>
        {isEdit ? 'Edit server' : 'Add MCP server'}
      </div>

      {error && (
        <div style={{ color: '#f87171', fontSize: 11, background: '#2a1a1a', border: '1px solid #5a2020', borderRadius: 4, padding: '5px 8px', marginBottom: 8 }}>
          {error}
        </div>
      )}

      <FormRow label="Name">
        <FormInput
          value={data.name}
          placeholder="my-server"
          onChange={(v) => update({ name: v })}
          monospace
        />
        <div style={{ color: '#4a4b4e', fontSize: 10, marginTop: 2 }}>Used as the key in mcpServers config</div>
      </FormRow>

      <FormRow label="Type">
        <div style={{ display: 'flex', gap: 6 }}>
          {(['http', 'sse', 'stdio'] as McpServerType[]).map((t) => (
            <button
              key={t}
              onClick={() => update({ type: t })}
              style={{
                background: data.type === t ? '#1a3a1a' : '#1e1f22',
                border: `1px solid ${data.type === t ? '#4ade80' : '#3a3b3e'}`,
                borderRadius: 4,
                color: data.type === t ? '#4ade80' : '#6b7280',
                fontSize: 11,
                cursor: 'pointer',
                padding: '3px 10px',
                fontFamily: 'monospace',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </FormRow>

      {data.type !== 'stdio' ? (
        <FormRow label="URL">
          <FormInput
            value={data.url ?? ''}
            placeholder="http://localhost:3000/mcp"
            onChange={(v) => update({ url: v })}
            monospace
          />
        </FormRow>
      ) : (
        <>
          <FormRow label="Command">
            <FormInput
              value={data.command ?? ''}
              placeholder="npx"
              onChange={(v) => update({ command: v })}
              monospace
            />
          </FormRow>
          <FormRow label="Args">
            <FormInput
              value={argsText}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              onChange={handleArgsChange}
              monospace
            />
            <div style={{ color: '#4a4b4e', fontSize: 10, marginTop: 2 }}>Space-separated arguments</div>
          </FormRow>
          <FormRow label="Env">
            <textarea
              value={envText}
              onChange={(e) => handleEnvChange(e.target.value)}
              placeholder={'KEY=value\nANOTHER=value'}
              rows={3}
              style={{
                width: '100%',
                background: '#0e0f11',
                border: `1px solid ${envError ? '#5a2020' : '#2a2b2e'}`,
                borderRadius: 4,
                color: '#d4d4d4',
                fontSize: 11,
                fontFamily: 'monospace',
                padding: '4px 8px',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {envError && <div style={{ color: '#f87171', fontSize: 10, marginTop: 2 }}>{envError}</div>}
          </FormRow>
        </>
      )}

      <FormRow label="Enabled">
        <Toggle checked={data.enabled} onChange={(v) => update({ enabled: v })} label={data.enabled ? 'Yes' : 'No'} />
      </FormRow>

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button
          onClick={onSubmit}
          style={{
            background: '#1a3a1a',
            border: '1px solid #2a5a2a',
            borderRadius: 4,
            color: '#4ade80',
            fontSize: 12,
            cursor: 'pointer',
            padding: '5px 14px',
          }}
        >
          {isEdit ? 'Save changes' : 'Add server'}
        </button>
        <button
          onClick={onCancel}
          style={{
            background: 'none',
            border: '1px solid #3a3b3e',
            borderRadius: 4,
            color: '#6b7280',
            fontSize: 12,
            cursor: 'pointer',
            padding: '5px 14px',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ToolsCollapse({ tools }: { tools: string[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'none', border: 'none', color: '#4a4b4e', fontSize: 10, cursor: 'pointer', padding: 0 }}
      >
        {open ? '▾' : '▸'} {tools.length} tools
      </button>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {tools.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 10,
                fontFamily: 'monospace',
                color: '#6b7280',
                background: '#1e1f22',
                border: '1px solid #2a2b2e',
                borderRadius: 3,
                padding: '1px 5px',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusDot({ running }: { running: boolean }): JSX.Element {
  return (
    <span style={{
      display: 'inline-block',
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: running ? '#4ade80' : '#4a4b4e',
      flexShrink: 0,
    }} />
  )
}

function TypeBadge({ type }: { type: McpServerType }): JSX.Element {
  return (
    <span style={{
      color: '#4a4b4e',
      fontSize: 10,
      fontFamily: 'monospace',
      background: '#1e1f22',
      border: '1px solid #2a2b2e',
      borderRadius: 3,
      padding: '1px 5px',
    }}>
      {type}
    </span>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 30,
          height: 16,
          borderRadius: 8,
          background: checked ? '#4ade80' : '#2a2b2e',
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 0.15s',
          flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: checked ? '#0a1f0a' : '#4a4b4e',
          transition: 'left 0.15s',
        }} />
      </div>
      {label && <span style={{ color: checked ? '#d4d4d4' : '#6b7280', fontSize: 12 }}>{label}</span>}
    </label>
  )
}

function ActionButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
  danger?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'none',
        border: '1px solid #2a2b2e',
        borderRadius: 4,
        color: danger ? '#4a4b4e' : '#4a4b4e',
        fontSize: 13,
        cursor: 'pointer',
        padding: '1px 6px',
        lineHeight: 1.2,
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = danger ? '#f87171' : '#d4d4d4'
        ;(e.currentTarget as HTMLButtonElement).style.borderColor = danger ? '#5a2020' : '#4a4b4e'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = '#4a4b4e'
        ;(e.currentTarget as HTMLButtonElement).style.borderColor = '#2a2b2e'
      }}
    >
      {children}
    </button>
  )
}

function ServerCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{
      padding: '10px 12px',
      marginBottom: 4,
      border: '1px solid #2a2b2e',
      borderRadius: 6,
      background: '#141517',
    }}>
      {children}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{
      padding: '6px 14px 3px',
      fontSize: 10,
      fontWeight: 600,
      color: '#4a4b4e',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
    }}>
      {children}
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}

function FormInput({
  value,
  placeholder,
  onChange,
  monospace,
}: {
  value: string
  placeholder?: string
  onChange: (v: string) => void
  monospace?: boolean
}): JSX.Element {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        background: '#0e0f11',
        border: '1px solid #2a2b2e',
        borderRadius: 4,
        color: '#d4d4d4',
        fontSize: 12,
        fontFamily: monospace ? 'monospace' : 'inherit',
        padding: '4px 8px',
        outline: 'none',
        boxSizing: 'border-box',
      }}
    />
  )
}

function buildPreviewJson(settings: McpSettings, port: number | null): string {
  const mcpServers: Record<string, unknown> = {}

  if (settings.builtinBrowserEnabled) {
    mcpServers['multiagent-browser'] = {
      type: 'http',
      url: `http://127.0.0.1:${port ?? '<port>'}/mcp`,
    }
  }

  for (const server of settings.customServers) {
    if (!server.enabled || !server.name.trim()) continue
    if (server.type === 'stdio') {
      mcpServers[server.name] = {
        type: 'stdio',
        command: server.command ?? '',
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
      }
    } else {
      mcpServers[server.name] = { type: server.type, url: server.url ?? '' }
    }
  }

  return JSON.stringify({ mcpServers }, null, 2)
}
