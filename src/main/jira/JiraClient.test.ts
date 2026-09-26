import { describe, expect, it, vi } from 'vitest'
import { JiraClient } from './JiraClient'
import type { JiraStoredSettings } from './JiraSettingsStore'

const settings: JiraStoredSettings = {
  baseUrl: 'https://jira.example.com',
  email: 'user@example.com',
  patterns: ['GLD-'],
  token: 'secret-token',
}

function response(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('JiraClient', () => {
  it('performs a read-only status GET with Basic auth and redirect protection', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, {
      fields: { status: { name: 'Main Development', statusCategory: { name: 'In Progress' } } },
    }))
    const result = await new JiraClient({ fetch, timeoutMs: 1000 }).fetchStatus(settings, 'GLD-1955')
    expect(result).toEqual({
      ok: true,
      issueKey: 'GLD-1955',
      issueUrl: 'https://jira.example.com/browse/GLD-1955',
      statusName: 'Main Development',
      statusCategory: 'In Progress',
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/3/issue/GLD-1955?fields=status',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }),
    )
    const init = fetch.mock.calls[0][1] as RequestInit
    expect(init.headers).toMatchObject({ Accept: 'application/json' })
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
  })

  it('tests the configured connection with a read-only account request', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { accountId: 'account-id' }))
    const result = await new JiraClient({ fetch, timeoutMs: 1000 }).testConnection(settings)
    expect(result).toEqual({ ok: true, message: 'Jira connection succeeded.' })
    expect(fetch).toHaveBeenCalledWith(
      'https://jira.example.com/rest/api/3/myself',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }),
    )
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Accept: 'application/json' })
  })

  it.each([
    [401, 'authentication was rejected'],
    [403, 'access is not permitted'],
    [429, 'rate limited'],
  ] as const)('reports safe connection failures for HTTP %s', async (status, message) => {
    const fetch = vi.fn().mockResolvedValue(response(status, { errorMessages: ['secret-token'] }))
    const result = await new JiraClient({ fetch }).testConnection(settings)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'not_found'],
    [429, 'rate_limited'],
  ] as const)('classifies HTTP %s without exposing response data', async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(response(status, { errorMessages: ['secret-token'] }))
    const result = await new JiraClient({ fetch }).fetchStatus(settings, 'GLD-1955')
    expect(result).toMatchObject({ ok: false, code, issueKey: 'GLD-1955' })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('fails closed for malformed successful payloads', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { fields: {} }))
    await expect(new JiraClient({ fetch }).fetchStatus(settings, 'GLD-1955')).resolves.toMatchObject({
      ok: false,
      code: 'invalid_response',
    })
  })

  it('rejects missing credentials and invalid issue keys before network access', async () => {
    const fetch = vi.fn()
    const noToken = await new JiraClient({ fetch }).fetchStatus({ ...settings, token: null }, 'GLD-1955')
    const badKey = await new JiraClient({ fetch }).fetchStatus(settings, 'javascript:alert(1)')
    expect(noToken).toMatchObject({ ok: false, code: 'invalid_config' })
    expect(badKey).toMatchObject({ ok: false, code: 'invalid_config' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
