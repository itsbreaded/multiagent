import { useEffect, useRef, useState } from 'react'
import { useJiraStore } from '../../../store/jira'
import { border, ui } from '../../../styles/theme'
import type { JiraSettingsInput } from '../../../../../shared/jira'

const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: ui.color.input,
  border: border.default,
  borderRadius: ui.radius.xs,
  color: ui.color.text,
  padding: '6px 8px',
  fontSize: 12,
}

const secondaryButton: React.CSSProperties = {
  background: 'transparent',
  border: border.default,
  borderRadius: ui.radius.xs,
  color: ui.color.textMuted,
  padding: '5px 9px',
  fontSize: 11,
  cursor: 'pointer',
}

export function JiraSetting(): JSX.Element {
  const settings = useJiraStore((s) => s.settings)
  const getToken = useJiraStore((s) => s.getToken)
  const saveSettings = useJiraStore((s) => s.saveSettings)
  const testConnection = useJiraStore((s) => s.testConnection)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [email, setEmail] = useState(settings.email)
  const [token, setToken] = useState('')
  const [tokenDirty, setTokenDirty] = useState(false)
  const [tokenLoading, setTokenLoading] = useState(settings.hasToken)
  const [showToken, setShowToken] = useState(false)
  const [clearToken, setClearToken] = useState(false)
  const [patterns, setPatterns] = useState<string[]>(settings.patterns.length ? settings.patterns : [''])
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const draftDirty = useRef(false)
  const draftRef = useRef<JiraSettingsInput>({
    baseUrl: settings.baseUrl,
    email: settings.email,
    patterns,
  })

  draftRef.current = {
    baseUrl,
    email,
    patterns,
    ...(tokenDirty && token ? { apiToken: token } : {}),
    ...(clearToken || (settings.hasToken && tokenDirty && !token) ? { clearToken: true } : {}),
  }

  useEffect(() => {
    return () => {
      if (draftDirty.current) void saveSettings(draftRef.current)
    }
  }, [saveSettings])

  useEffect(() => {
    setBaseUrl(settings.baseUrl)
    setEmail(settings.email)
    setPatterns(settings.patterns.length ? settings.patterns : [''])
    setClearToken(false)
    setShowToken(false)
    draftDirty.current = false
  }, [settings.baseUrl, settings.email, settings.patterns, settings.hasToken])

  useEffect(() => {
    let cancelled = false
    setTokenDirty(false)
    setShowToken(false)
    if (!settings.hasToken) {
      setToken('')
      setTokenLoading(false)
      return () => { cancelled = true }
    }

    setTokenLoading(true)
    void getToken().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setToken(result.token)
      } else {
        setToken('')
        setError(result.error)
      }
      setTokenLoading(false)
    }).catch(() => {
      if (cancelled) return
      setToken('')
      setTokenLoading(false)
      setError('Saved Jira token could not be loaded securely.')
    })
    return () => { cancelled = true }
  }, [getToken, settings.hasToken])

  async function test(): Promise<void> {
    setTesting(true)
    setMessage(null)
    setError(null)
    const result = await testConnection({
      baseUrl,
      email,
      apiToken: token,
    })
    setTesting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setMessage(result.message)
  }

  function updatePattern(index: number, value: string): void {
    setPatterns((current) => current.map((pattern, i) => i === index ? value : pattern))
  }

  return (
    <>
      <div style={{ color: ui.color.textMuted, fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
        Match a leading ticket prefix such as <code>DZ-</code> to show read-only Jira status badges in project folders.
      </div>
      <label style={labelStyle}>Jira base URL</label>
      <input aria-label="Jira base URL" value={baseUrl} onChange={(e) => { draftDirty.current = true; setBaseUrl(e.target.value) }} style={fieldStyle} />

      <label style={labelStyle}>Atlassian account email</label>
      <input aria-label="Atlassian account email" type="email" value={email} onChange={(e) => { draftDirty.current = true; setEmail(e.target.value) }} style={fieldStyle} />

      <label style={labelStyle}>API token</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          aria-label="Jira API token"
          type={showToken ? 'text' : 'password'}
          value={token}
          disabled={tokenLoading}
          onChange={(e) => {
            const value = e.target.value
            draftDirty.current = true
            setToken(value)
            setTokenDirty(true)
            setClearToken(settings.hasToken && !value)
          }}
          placeholder={tokenLoading ? 'Loading saved token…' : clearToken ? 'Enter replacement token or save to clear' : 'Enter API token'}
          autoComplete="new-password"
          style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
        />
        {token && !clearToken && !tokenLoading && (
          <button
            type="button"
            aria-label={showToken ? 'Hide Jira API token' : 'Show Jira API token'}
            onClick={() => setShowToken((visible) => !visible)}
            style={secondaryButton}
          >
            {showToken ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {settings.hasToken && !clearToken && !tokenLoading && (
        <button
          type="button"
          onClick={() => {
            draftDirty.current = true
            setToken('')
            setTokenDirty(true)
            setClearToken(true)
            setShowToken(false)
          }}
          style={{ ...secondaryButton, marginTop: 6 }}
        >
          Clear saved token
        </button>
      )}

      <label style={{ ...labelStyle, marginTop: 14 }}>Issue-key prefixes</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {patterns.map((pattern, index) => (
          <div key={index} style={{ display: 'flex', gap: 6 }}>
            <input
              aria-label={`Jira issue-key prefix ${index + 1}`}
              value={pattern}
              onChange={(e) => { draftDirty.current = true; updatePattern(index, e.target.value) }}
              placeholder="DZ-"
              style={{ ...fieldStyle, flex: 1 }}
            />
            <button type="button" onClick={() => { draftDirty.current = true; setPatterns((current) => current.filter((_, i) => i !== index)) }} style={secondaryButton}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => { draftDirty.current = true; setPatterns((current) => [...current, '']) }} style={{ ...secondaryButton, marginTop: 8 }}>
        Add prefix
      </button>

      {error && <div role="alert" style={{ color: ui.color.danger, fontSize: 11, marginTop: 10 }}>{error}</div>}
      {message && <div role="status" style={{ color: ui.color.accent, fontSize: 11, marginTop: 10 }}>{message}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" onClick={() => { void test() }} disabled={testing || tokenLoading} style={{ ...secondaryButton, color: testing ? ui.color.textDim : ui.color.accent, border: border.accent }}>
          {testing ? 'Testing…' : 'Test Jira connection'}
        </button>
      </div>
    </>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  color: ui.color.textMuted,
  fontSize: 11,
  marginTop: 10,
  marginBottom: 4,
}
