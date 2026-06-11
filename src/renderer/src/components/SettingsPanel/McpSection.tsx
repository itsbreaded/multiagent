import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { McpServerEntry, McpServerType, McpSettings, McpStatus } from '../../../../shared/types'
import { useSettingsStore } from '../../store/settings'

function generateId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
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

type TestState = 'idle' | 'testing' | 'ok' | 'unreachable' | 'error'
type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'done'; tools: string[] }
  | { status: 'error'; message: string }
type PreviewTab = 'claude' | 'codex'

export function McpSection(): JSX.Element {
  const mcpSettings = useSettingsStore((s) => s.mcpSettings)
  const setMcpSettings = useSettingsStore((s) => s.setMcpSettings)

  const [status, setStatus] = useState<McpStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<Omit<McpServerEntry, 'id'>>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [previewTab, setPreviewTab] = useState<PreviewTab>('claude')
  const [saved, setSaved] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [testStates, setTestStates] = useState<Record<string, TestState>>({})
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({})

  // Track whether we have ever successfully loaded status so that subsequent
  // refreshes update silently without tearing out the current display.
  const hasLoadedOnce = useRef(false)

  const fetchStatus = useCallback(() => {
    setStatusError(false)
    if (!hasLoadedOnce.current) setStatusLoading(true)
    window.ipc.invoke('mcp:get-status').then((s) => {
      hasLoadedOnce.current = true
      setStatus(s as McpStatus)
      setStatusLoading(false)
    }).catch(() => {
      setStatusError(true)
      setStatusLoading(false)
    })
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
    setShowImport(false)
  }

  function openEdit(entry: McpServerEntry): void {
    setFormData({ ...entry })
    setFormError(null)
    setEditingId(entry.id)
    setShowAddForm(true)
    setShowImport(false)
  }

  function cancelForm(): void {
    setShowAddForm(false)
    setEditingId(null)
    setFormError(null)
  }

  function validateForm(data: Omit<McpServerEntry, 'id'>, editId: string | null): string | null {
    if (!data.name.trim()) return 'Server name is required.'
    if (!/^[a-zA-Z0-9_-]+$/.test(data.name.trim())) return 'Name must contain only letters, numbers, hyphens, and underscores.'
    if (data.name.trim() === 'multiagent-browser') return '"multiagent-browser" is reserved for the built-in server.'
    if (data.type !== 'stdio' && !data.url?.trim()) return 'URL is required for HTTP/SSE servers.'
    if (data.type === 'stdio' && !data.command?.trim()) return 'Command is required for stdio servers.'
    const isDuplicate = mcpSettings.customServers.some(
      (s) => s.name.trim() === data.name.trim() && s.id !== editId
    )
    if (isDuplicate) return `A server named "${data.name.trim()}" already exists.`
    return null
  }

  function submitForm(): void {
    const err = validateForm(formData, editingId)
    if (err) { setFormError(err); return }

    const entry: McpServerEntry = {
      id: editingId ?? generateId(),
      name: formData.name.trim(),
      enabled: formData.enabled,
      type: formData.type,
      ...(formData.type !== 'stdio' ? { url: formData.url?.trim() } : {
        command: formData.command?.trim(),
        args: (formData.args ?? []).filter(Boolean),
        ...(formData.env && Object.keys(formData.env).length ? { env: formData.env } : {}),
      }),
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
    setTestStates((prev) => { const n = { ...prev }; delete n[id]; return n })
    setProbeStates((prev) => { const n = { ...prev }; delete n[id]; return n })
  }

  function toggleServer(id: string, enabled: boolean): void {
    save({
      ...mcpSettings,
      customServers: mcpSettings.customServers.map((s) => (s.id === id ? { ...s, enabled } : s)),
    })
  }

  async function testServer(entry: McpServerEntry): Promise<void> {
    if (entry.type === 'stdio') return
    setTestStates((p) => ({ ...p, [entry.id]: 'testing' }))
    const result = await testConnection(entry.url ?? '', entry.type)
    setTestStates((p) => ({ ...p, [entry.id]: result }))
    setTimeout(() => setTestStates((p) => ({ ...p, [entry.id]: 'idle' })), 4000)
  }

  async function probeServer(entry: McpServerEntry): Promise<void> {
    if (entry.type !== 'stdio') return
    setProbeStates((p) => ({ ...p, [entry.id]: { status: 'probing' } }))
    try {
      const result = await window.ipc.invoke('mcp:probe-stdio', entry.command ?? '', entry.args ?? [], entry.env) as { tools: string[] }
      setProbeStates((p) => ({ ...p, [entry.id]: { status: 'done', tools: result.tools } }))
    } catch (err) {
      setProbeStates((p) => ({ ...p, [entry.id]: { status: 'error', message: (err as Error).message } }))
    }
  }

  function handleImport(servers: McpServerEntry[]): void {
    const existingNames = new Set(mcpSettings.customServers.map((s) => s.name))
    const fresh = servers.filter((s) => !existingNames.has(s.name))
    save({ ...mcpSettings, customServers: [...mcpSettings.customServers, ...fresh] })
    setShowImport(false)
  }

  const claudeJson = buildClaudePreviewJson(mcpSettings, status?.port ?? null)
  const codexArgs = buildCodexArgsPreview(mcpSettings, status?.port ?? null)

  return (
    <div>
      <SectionLabel>Model Context Protocol (MCP)</SectionLabel>
      <p style={{ color: '#6b7280', fontSize: 11, padding: '0 14px 10px', lineHeight: 1.5, margin: 0 }}>
        MCP servers are injected into each new Claude and Codex session at launch.
        Changes apply to sessions started after saving — existing sessions are not affected.
      </p>

      {saved && (
        <div style={{
          margin: '0 0 8px',
          padding: '5px 12px',
          background: '#0f2a15',
          border: '1px solid #1a4a25',
          borderRadius: 5,
          color: '#4ade80',
          fontSize: 12,
        }}>
          Saved — new sessions will use the updated config.
        </div>
      )}

      {/* Built-in Browser MCP Server */}
      <SubLabel>Built-in server</SubLabel>
      <ServerCard>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <StatusDot running={!statusLoading && !statusError && (status?.running ?? false)} />
              <span style={{ color: '#d4d4d4', fontSize: 13, fontWeight: 500 }}>multiagent-browser</span>
              <TypeBadge type="http" />
              <span style={{ color: '#4a4b4e', fontSize: 10, background: '#1e1f22', border: '1px solid #2a2b2e', borderRadius: 3, padding: '1px 5px' }}>built-in</span>
            </div>
            <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>
              {statusLoading ? (
                <span style={{ color: '#4a4b4e' }}>Loading…</span>
              ) : statusError ? (
                <span style={{ color: '#f87171' }}>Failed to fetch status</span>
              ) : status?.running ? (
                <>
                  Port{' '}
                  <code style={{ color: '#a0a4a8', background: '#1e1f22', padding: '0 4px', borderRadius: 3 }}>
                    {status.port}
                  </code>
                  {' · '}
                  <span>{status.tools.length} tools</span>
                </>
              ) : 'Not running'}
            </div>
            {!statusLoading && !statusError && status?.running && mcpSettings.builtinBrowserEnabled && (
              <ToolsCollapse tools={status.tools} />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 2 }}>
            <button
              onClick={fetchStatus}
              title="Refresh status"
              style={{ background: 'none', border: '1px solid #2a2b2e', borderRadius: 4, color: '#4a4b4e', fontSize: 11, cursor: 'pointer', padding: '2px 7px' }}
            >
              ↻
            </button>
            <Toggle
              checked={mcpSettings.builtinBrowserEnabled}
              onChange={toggleBuiltin}
              label={mcpSettings.builtinBrowserEnabled ? 'Enabled' : 'Disabled'}
            />
          </div>
        </div>
      </ServerCard>

      {/* Custom Servers */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px 4px' }}>
          <SubLabel inline>Custom servers</SubLabel>
          {!showAddForm && !showImport && (
            <div style={{ display: 'flex', gap: 6 }}>
              <ActionButton onClick={() => { setShowImport(true); setShowAddForm(false) }}>
                Import JSON
              </ActionButton>
              <ActionButton onClick={openAdd} accent>
                + Add server
              </ActionButton>
            </div>
          )}
        </div>

        {mcpSettings.customServers.length === 0 && !showAddForm && !showImport && (
          <div style={{ color: '#4a4b4e', fontSize: 12, padding: '8px 14px' }}>
            No custom servers configured.
          </div>
        )}

        {mcpSettings.customServers.map((entry) => {
          const probe = probeStates[entry.id] ?? { status: 'idle' }
          return editingId === entry.id && showAddForm ? null : (
            <ServerCard key={entry.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ color: '#d4d4d4', fontSize: 13, fontWeight: 500 }}>{entry.name}</span>
                    <TypeBadge type={entry.type} />
                    {!entry.enabled && <DisabledBadge />}
                  </div>
                  <div style={{ color: '#6b7280', fontSize: 11, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.type === 'stdio' ? entry.command : entry.url}
                  </div>
                  {/* Probe results for stdio */}
                  {entry.type === 'stdio' && probe.status === 'probing' && (
                    <div style={{ color: '#4a4b4e', fontSize: 11, marginTop: 4 }}>Probing — spawning server…</div>
                  )}
                  {entry.type === 'stdio' && probe.status === 'done' && (
                    <ToolsCollapse tools={probe.tools} emptyLabel="Server responded but listed no tools" />
                  )}
                  {entry.type === 'stdio' && probe.status === 'error' && (
                    <div style={{ color: '#f87171', fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
                      {probe.message}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {entry.type === 'stdio' ? (
                    <ProbeButton state={probe.status} onClick={() => probeServer(entry)} />
                  ) : (
                    <TestButton state={testStates[entry.id] ?? 'idle'} onClick={() => testServer(entry)} />
                  )}
                  <Toggle checked={entry.enabled} onChange={(v) => toggleServer(entry.id, v)} />
                  <IconButton onClick={() => openEdit(entry)} title="Edit">✎</IconButton>
                  <IconButton onClick={() => deleteServer(entry.id)} title="Delete" danger>×</IconButton>
                </div>
              </div>
            </ServerCard>
          )
        })}

        {showImport && (
          <ServerCard>
            <ImportForm onImport={handleImport} onCancel={() => setShowImport(false)} />
          </ServerCard>
        )}

        {showAddForm && !showImport && (
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

      {/* Config Preview */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={() => setShowJson((v) => !v)}
          style={{ background: 'none', border: 'none', color: '#4a4b4e', fontSize: 11, cursor: 'pointer', padding: '0 14px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span>{showJson ? '▾' : '▸'}</span>
          <span>Generated config preview</span>
        </button>
        {showJson && (
          <div>
            <div style={{ display: 'flex', borderBottom: '1px solid #2a2b2e', marginBottom: 0 }}>
              {(['claude', 'codex'] as PreviewTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setPreviewTab(tab)}
                  style={{
                    background: 'none',
                    border: 'none',
                    borderBottom: previewTab === tab ? '2px solid #4ade80' : '2px solid transparent',
                    color: previewTab === tab ? '#d4d4d4' : '#4a4b4e',
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: '5px 14px',
                    marginBottom: -1,
                  }}
                >
                  {tab === 'claude' ? 'Claude (claude-mcp.json)' : 'Codex (-c args)'}
                </button>
              ))}
            </div>
            <pre style={{
              margin: 0,
              padding: 12,
              background: '#0e0f11',
              border: '1px solid #2a2b2e',
              borderTop: 'none',
              borderRadius: '0 0 6px 6px',
              color: '#a0a4a8',
              fontSize: 11,
              fontFamily: 'monospace',
              overflow: 'auto',
              maxHeight: 220,
              lineHeight: 1.5,
              whiteSpace: 'pre',
            }}>
              {previewTab === 'claude' ? claudeJson : codexArgs}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Import Form ────────────────────────────────────────────────────────────

function ImportForm({ onImport, onCancel }: { onImport: (servers: McpServerEntry[]) => void; onCancel: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<McpServerEntry[]>([])

  function parse(raw: string): void {
    setError(null)
    setPreview([])
    if (!raw.trim()) return
    const result = parseImportJson(raw)
    if (typeof result === 'string') { setError(result); return }
    setPreview(result)
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#d4d4d4', marginBottom: 6 }}>
        Import from JSON
      </div>
      <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 8, lineHeight: 1.4 }}>
        Paste a standard <code style={{ color: '#a0a4a8' }}>mcpServers</code> config object. Servers with
        duplicate names will be skipped.
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => { setText(e.target.value); parse(e.target.value) }}
        placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "type": "http",\n      "url": "http://localhost:3000/mcp"\n    }\n  }\n}'}
        rows={7}
        style={{
          width: '100%',
          background: '#0e0f11',
          border: `1px solid ${error ? '#5a2020' : '#2a2b2e'}`,
          borderRadius: 4,
          color: '#d4d4d4',
          fontSize: 11,
          fontFamily: 'monospace',
          padding: '6px 8px',
          resize: 'vertical',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {error && <div style={{ color: '#f87171', fontSize: 11, marginTop: 4 }}>{error}</div>}
      {preview.length > 0 && (
        <div style={{ color: '#4ade80', fontSize: 11, marginTop: 4 }}>
          {preview.length} server{preview.length > 1 ? 's' : ''} found: {preview.map((s) => s.name).join(', ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          onClick={() => preview.length > 0 && onImport(preview)}
          disabled={preview.length === 0}
          style={{
            background: preview.length > 0 ? '#1a3a1a' : '#141517',
            border: `1px solid ${preview.length > 0 ? '#2a5a2a' : '#2a2b2e'}`,
            borderRadius: 4,
            color: preview.length > 0 ? '#4ade80' : '#4a4b4e',
            fontSize: 12,
            cursor: preview.length > 0 ? 'pointer' : 'default',
            padding: '5px 14px',
          }}
        >
          Import {preview.length > 0 ? `(${preview.length})` : ''}
        </button>
        <button
          onClick={onCancel}
          style={{ background: 'none', border: '1px solid #3a3b3e', borderRadius: 4, color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: '5px 14px' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Server Form ─────────────────────────────────────────────────────────────

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
  const [testState, setTestState] = useState<TestState>('idle')
  const [formProbe, setFormProbe] = useState<ProbeState>({ status: 'idle' })

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
    const env: Record<string, string> = {}
    for (const line of val.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) { setEnvError('Format: KEY=value (one per line)'); return }
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1)
    }
    update({ env })
  }

  async function handleTest(): Promise<void> {
    if (data.type === 'stdio' || !data.url?.trim()) return
    setTestState('testing')
    const result = await testConnection(data.url.trim(), data.type)
    setTestState(result)
    setTimeout(() => setTestState('idle'), 4000)
  }

  async function handleProbe(): Promise<void> {
    if (data.type !== 'stdio' || !data.command?.trim()) return
    setFormProbe({ status: 'probing' })
    try {
      const result = await window.ipc.invoke('mcp:probe-stdio', data.command.trim(), data.args ?? [], data.env) as { tools: string[] }
      setFormProbe({ status: 'done', tools: result.tools })
    } catch (err) {
      setFormProbe({ status: 'error', message: (err as Error).message })
    }
  }

  // Reset args/env text when type changes away from stdio
  const prevType = useRef(data.type)
  useEffect(() => {
    if (prevType.current !== data.type) {
      prevType.current = data.type
    }
  }, [data.type])

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
        <FieldHint>Key in the mcpServers config — letters, numbers, hyphens, underscores</FieldHint>
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
        <FieldHint>
          {data.type === 'http' ? 'Streamable HTTP transport (MCP 2025-03-26+)' :
           data.type === 'sse' ? 'Server-Sent Events transport — connect to /sse endpoint' :
           'Local subprocess over stdin/stdout'}
        </FieldHint>
      </FormRow>

      {data.type !== 'stdio' ? (
        <FormRow label="URL">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <FormInput
                value={data.url ?? ''}
                placeholder={data.type === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
                onChange={(v) => update({ url: v })}
                monospace
              />
            </div>
            <TestButton state={testState} onClick={handleTest} />
          </div>
          <FieldHint>
            {data.type === 'sse'
              ? 'Full URL to the SSE endpoint — Claude uses GET, expects text/event-stream'
              : 'Full URL to the MCP endpoint — Claude uses POST per streamable HTTP spec'}
          </FieldHint>
        </FormRow>
      ) : (
        <>
          <FormRow label="Command">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <FormInput value={data.command ?? ''} placeholder="npx" onChange={(v) => update({ command: v })} monospace />
              </div>
              <ProbeButton state={formProbe.status} onClick={handleProbe} />
            </div>
            <FieldHint>Probe spawns the server, runs MCP handshake, and lists tools — may take up to 30s for npx packages</FieldHint>
          </FormRow>
          <FormRow label="Args">
            <FormInput
              value={argsText}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              onChange={handleArgsChange}
              monospace
            />
            <FieldHint>Space-separated arguments</FieldHint>
          </FormRow>
          <FormRow label="Env vars">
            <textarea
              value={envText}
              onChange={(e) => handleEnvChange(e.target.value)}
              placeholder={'KEY=value\nANOTHER_KEY=value'}
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
          <FieldHint style={{ marginTop: -4, marginBottom: 8 }}>
            Codex injection of stdio env vars uses per-key TOML overrides — complex env may require native config instead.
          </FieldHint>
          {formProbe.status === 'done' && (
            <ToolsCollapse tools={formProbe.tools} emptyLabel="Server responded but listed no tools" />
          )}
          {formProbe.status === 'error' && (
            <div style={{ color: '#f87171', fontSize: 11, marginBottom: 6, lineHeight: 1.4 }}>{formProbe.message}</div>
          )}
        </>
      )}

      <FormRow label="Enabled">
        <Toggle checked={data.enabled} onChange={(v) => update({ enabled: v })} label={data.enabled ? 'Yes' : 'No'} />
      </FormRow>

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button
          onClick={onSubmit}
          style={{ background: '#1a3a1a', border: '1px solid #2a5a2a', borderRadius: 4, color: '#4ade80', fontSize: 12, cursor: 'pointer', padding: '5px 14px' }}
        >
          {isEdit ? 'Save changes' : 'Add server'}
        </button>
        <button
          onClick={onCancel}
          style={{ background: 'none', border: '1px solid #3a3b3e', borderRadius: 4, color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: '5px 14px' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolsCollapse({ tools, emptyLabel }: { tools: string[]; emptyLabel?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  if (tools.length === 0) {
    return <div style={{ color: '#4a4b4e', fontSize: 11, marginTop: 4 }}>{emptyLabel ?? 'No tools'}</div>
  }
  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'none', border: 'none', color: '#4a4b4e', fontSize: 10, cursor: 'pointer', padding: 0 }}
      >
        {open ? '▾' : '▸'} {tools.length} tool{tools.length !== 1 ? 's' : ''}
      </button>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {tools.map((t) => (
            <span key={t} style={{ fontSize: 10, fontFamily: 'monospace', color: '#6b7280', background: '#1e1f22', border: '1px solid #2a2b2e', borderRadius: 3, padding: '1px 5px' }}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ProbeButton({ state, onClick }: { state: ProbeState['status']; onClick: () => void }): JSX.Element {
  const busy = state === 'probing'
  const label = busy ? '…' : state === 'done' ? '✓ Probed' : state === 'error' ? '✗ Error' : 'Probe'
  const color = state === 'done' ? '#4ade80' : state === 'error' ? '#f87171' : '#6b7280'
  const title = state === 'done'
    ? 'Tools fetched — click to re-probe'
    : state === 'error'
    ? 'Probe failed — click to retry'
    : 'Spawn server and list available tools (may take up to 30s for npx packages)'
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      style={{
        background: 'none',
        border: '1px solid #2a2b2e',
        borderRadius: 4,
        color,
        fontSize: 11,
        cursor: busy ? 'default' : 'pointer',
        padding: '2px 8px',
        minWidth: 52,
        fontFamily: 'monospace',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}

function TestButton({ state, onClick }: { state: TestState; onClick: () => void }): JSX.Element {
  const label = state === 'testing' ? '…' : state === 'ok' ? '✓' : state === 'unreachable' ? '✗' : state === 'error' ? '!' : 'Test'
  const color = state === 'ok' ? '#4ade80' : state === 'unreachable' ? '#f87171' : state === 'error' ? '#facc15' : '#6b7280'
  return (
    <button
      onClick={onClick}
      disabled={state === 'testing'}
      title={state === 'ok' ? 'Reachable' : state === 'unreachable' ? 'Unreachable' : state === 'error' ? 'Server responded with error (but is running)' : 'Test connection'}
      style={{
        background: 'none',
        border: '1px solid #2a2b2e',
        borderRadius: 4,
        color,
        fontSize: 11,
        cursor: state === 'testing' ? 'default' : 'pointer',
        padding: '2px 8px',
        minWidth: 42,
        fontFamily: 'monospace',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}

function StatusDot({ running }: { running: boolean }): JSX.Element {
  return (
    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: running ? '#4ade80' : '#4a4b4e', flexShrink: 0 }} />
  )
}

function TypeBadge({ type }: { type: McpServerType | 'http' }): JSX.Element {
  const colors: Record<string, { bg: string; border: string; text: string }> = {
    http:  { bg: '#0d1f2d', border: '#1a3a5a', text: '#60a0d0' },
    sse:   { bg: '#1f1a0d', border: '#5a3a1a', text: '#d09060' },
    stdio: { bg: '#1a0d1f', border: '#3a1a5a', text: '#a060d0' },
  }
  const c = colors[type] ?? colors.http
  return (
    <span style={{ fontSize: 10, fontFamily: 'monospace', background: c.bg, border: `1px solid ${c.border}`, borderRadius: 3, color: c.text, padding: '1px 5px' }}>
      {type}
    </span>
  )
}

function DisabledBadge(): JSX.Element {
  return (
    <span style={{ color: '#4a4b4e', fontSize: 10, background: '#1e1f22', border: '1px solid #2a2b2e', borderRadius: 3, padding: '1px 5px' }}>
      disabled
    </span>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
      <div
        onClick={() => onChange(!checked)}
        style={{ width: 30, height: 16, borderRadius: 8, background: checked ? '#4ade80' : '#2a2b2e', position: 'relative', cursor: 'pointer', transition: 'background 0.15s', flexShrink: 0 }}
      >
        <div style={{ position: 'absolute', top: 2, left: checked ? 16 : 2, width: 12, height: 12, borderRadius: '50%', background: checked ? '#0a1f0a' : '#4a4b4e', transition: 'left 0.15s' }} />
      </div>
      {label && <span style={{ color: checked ? '#d4d4d4' : '#6b7280', fontSize: 12 }}>{label}</span>}
    </label>
  )
}

function IconButton({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title?: string; danger?: boolean }): JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'none',
        border: '1px solid',
        borderColor: hovered ? (danger ? '#5a2020' : '#4a4b4e') : '#2a2b2e',
        borderRadius: 4,
        color: hovered ? (danger ? '#f87171' : '#d4d4d4') : '#4a4b4e',
        fontSize: 13,
        cursor: 'pointer',
        padding: '1px 6px',
        lineHeight: 1.2,
        transition: 'color 0.1s, border-color 0.1s',
      }}
    >
      {children}
    </button>
  )
}

function ActionButton({ children, onClick, accent }: { children: React.ReactNode; onClick: () => void; accent?: boolean }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none',
        border: `1px solid ${accent ? '#2a5a2a' : '#3a3b3e'}`,
        borderRadius: 4,
        color: accent ? '#4ade80' : '#6b7280',
        fontSize: 11,
        cursor: 'pointer',
        padding: '2px 8px',
      }}
    >
      {children}
    </button>
  )
}

function ServerCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: '10px 12px', marginBottom: 4, border: '1px solid #2a2b2e', borderRadius: 6, background: '#141517' }}>
      {children}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: '6px 14px 3px', fontSize: 10, fontWeight: 600, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </div>
  )
}

function SubLabel({ children, inline }: { children: React.ReactNode; inline?: boolean }): JSX.Element {
  const el = (
    <div style={{ fontSize: 10, fontWeight: 600, color: '#4a4b4e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </div>
  )
  if (inline) return el
  return <div style={{ padding: '0 14px 4px' }}>{el}</div>
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}

function FormInput({ value, placeholder, onChange, monospace }: { value: string; placeholder?: string; onChange: (v: string) => void; monospace?: boolean }): JSX.Element {
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

function FieldHint({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): JSX.Element {
  return <div style={{ color: '#4a4b4e', fontSize: 10, marginTop: 2, lineHeight: 1.4, ...style }}>{children}</div>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function testConnection(url: string, type: McpServerType): Promise<TestState> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    let res: Response
    if (type === 'sse') {
      // GET to the SSE endpoint — just check that the server responds
      res = await fetch(url, { method: 'GET', signal: controller.signal })
    } else {
      // POST a minimal JSONRPC initialize to the HTTP endpoint
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'multiagent', version: '1' } } }),
      })
    }
    clearTimeout(timer)
    // Any response (even 4xx/5xx) means the server is running; 2xx is ideal
    return res.status < 500 ? 'ok' : 'error'
  } catch {
    return 'unreachable'
  }
}

function parseImportJson(text: string): McpServerEntry[] | string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const rawServers: Record<string, unknown> =
      (parsed.mcpServers as Record<string, unknown> | undefined) ?? parsed
    const entries: McpServerEntry[] = []
    for (const [name, config] of Object.entries(rawServers)) {
      if (!name || name === 'multiagent-browser') continue
      const c = (config ?? {}) as Record<string, unknown>
      const explicit = c.type as McpServerType | undefined
      const type: McpServerType = explicit ?? (c.command ? 'stdio' : 'http')
      entries.push({
        id: generateId(),
        name,
        enabled: true,
        type,
        ...(type !== 'stdio' ? { url: (c.url as string | undefined) ?? '' } : {
          command: (c.command as string | undefined) ?? '',
          args: (c.args as string[] | undefined) ?? [],
          env: (c.env as Record<string, string> | undefined) ?? {},
        }),
      })
    }
    if (entries.length === 0) return 'No server entries found in this config.'
    return entries
  } catch (e) {
    return `JSON parse error: ${(e as Error).message}`
  }
}

function buildClaudePreviewJson(settings: McpSettings, port: number | null): string {
  const mcpServers: Record<string, unknown> = {}

  if (settings.builtinBrowserEnabled) {
    mcpServers['multiagent-browser'] = { type: 'http', url: `http://127.0.0.1:${port ?? '<port>'}/mcp` }
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

function buildCodexArgsPreview(settings: McpSettings, port: number | null): string {
  const lines: string[] = ['# Injected via -c flags when spawning Codex', '']

  if (settings.builtinBrowserEnabled && port !== null) {
    const url = `http://127.0.0.1:${port}/mcp`
    lines.push(`-c 'mcp_servers.multiagent-browser.url="${url}"'`)
    lines.push(`-c 'mcp_servers.multiagent-browser.enabled=true'`)
  } else if (settings.builtinBrowserEnabled) {
    lines.push(`-c 'mcp_servers.multiagent-browser.url="http://127.0.0.1:<port>/mcp"'`)
    lines.push(`-c 'mcp_servers.multiagent-browser.enabled=true'`)
  }

  for (const server of settings.customServers) {
    if (!server.enabled || !server.name.trim()) continue
    const key = server.name.trim()
    lines.push('')
    if (server.type === 'stdio') {
      if (server.command) {
        lines.push(`-c 'mcp_servers.${key}.command=${JSON.stringify(server.command)}'`)
        if (server.args?.length) lines.push(`-c 'mcp_servers.${key}.args=${JSON.stringify(server.args)}'`)
        if (server.env) {
          for (const [k, v] of Object.entries(server.env)) {
            lines.push(`-c 'mcp_servers.${key}.env.${k}=${JSON.stringify(v)}'`)
          }
        }
        lines.push(`-c 'mcp_servers.${key}.enabled=true'`)
      }
    } else {
      if (server.url) {
        lines.push(`-c 'mcp_servers.${key}.url=${JSON.stringify(server.url)}'`)
        lines.push(`-c 'mcp_servers.${key}.enabled=true'`)
      }
    }
  }

  if (lines.length === 2) lines.push('# (no MCP servers enabled)')
  return lines.join('\n')
}
