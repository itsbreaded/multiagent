import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraClient } from './JiraClient'
import { JiraSettingsStore, type JiraSecureStorage } from './JiraSettingsStore'
import { createJiraIpcController, isPrimaryWindowSender } from './jiraIpc'

const dirs: string[] = []
const secureStorage: JiraSecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('Jira IPC controller', () => {
  it('recognizes only the primary window as a token reader', () => {
    expect(isPrimaryWindowSender(7, 7)).toBe(true)
    expect(isPrimaryWindowSender(8, 7)).toBe(false)
    expect(isPrimaryWindowSender(null, 7)).toBe(false)
    expect(isPrimaryWindowSender(7, null)).toBe(false)
  })

  it('opens a URL built from current settings and rejects renderer URLs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-jira-ipc-'))
    dirs.push(dir)
    const store = new JiraSettingsStore(path.join(dir, 'settings.json'), secureStorage)
    store.save({ baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: ['GLD-'], apiToken: 'token' })
    const openExternal = vi.fn()
    const controller = createJiraIpcController(store, new JiraClient({ fetch: vi.fn() }), openExternal)

    expect(controller.getToken()).toEqual({ ok: true, token: 'token' })
    expect(controller.openIssue('GLD-1955')).toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledWith('https://jira.example.test/browse/GLD-1955')
    expect(controller.openIssue('https://attacker.example/')).toEqual({ ok: false, error: 'Invalid Jira issue key.' })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('returns redacted settings and safe save failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-jira-ipc-'))
    dirs.push(dir)
    const store = new JiraSettingsStore(path.join(dir, 'settings.json'), {
      ...secureStorage,
      isEncryptionAvailable: () => false,
    })
    const controller = createJiraIpcController(store, new JiraClient({ fetch: vi.fn() }), vi.fn())
    expect(controller.getSettings()).not.toHaveProperty('token')
    expect(controller.saveSettings({ baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: [], apiToken: 'secret' })).toEqual({
      ok: false,
      error: 'Jira settings could not be saved securely.',
    })
    expect(JSON.stringify(controller.getSettings())).not.toContain('secret')
  })

  it('tests unsaved connection credentials without changing stored settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-jira-ipc-'))
    dirs.push(dir)
    const store = new JiraSettingsStore(path.join(dir, 'settings.json'), secureStorage)
    store.save({ baseUrl: 'https://jira.example.test', email: 'saved@example.com', patterns: ['GLD-'], apiToken: 'saved-token' })
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const controller = createJiraIpcController(store, new JiraClient({ fetch }), vi.fn())

    await expect(controller.testConnection({
      baseUrl: 'https://other.example.test',
      email: 'draft@example.com',
      apiToken: 'draft-token',
    })).resolves.toEqual({ ok: true, message: 'Jira connection succeeded.' })
    expect(store.getStoredSettings()).toMatchObject({ baseUrl: 'https://jira.example.test', email: 'saved@example.com', token: 'saved-token' })
    expect(fetch).toHaveBeenCalledWith('https://other.example.test/rest/api/3/myself', expect.anything())
  })
})
