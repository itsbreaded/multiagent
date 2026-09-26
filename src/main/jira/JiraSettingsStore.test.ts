import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { JiraSettingsStore, type JiraSecureStorage } from './JiraSettingsStore'

const tempDirs: string[] = []

function makeSecureStorage(available = true): JiraSecureStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => {
      const decoded = value.toString()
      if (!decoded.startsWith('encrypted:')) throw new Error('bad ciphertext')
      return decoded.slice('encrypted:'.length)
    },
  }
}

function makePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-jira-'))
  tempDirs.push(dir)
  return path.join(dir, 'jira-settings.json')
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('JiraSettingsStore', () => {
  it('starts with an empty site and persists only encrypted token material', () => {
    const filePath = makePath()
    const store = new JiraSettingsStore(filePath, makeSecureStorage())
    expect(store.getSettings()).toEqual({
      baseUrl: '',
      email: '',
      patterns: [],
      hasToken: false,
    })

    const result = store.save({
      baseUrl: 'https://jira.example.com/',
      email: 'chris@example.com',
      patterns: [' DZ- ', 'dz-'],
      apiToken: 'secret-token',
    })
    expect(result.ok).toBe(true)
    const persisted = fs.readFileSync(filePath, 'utf8')
    expect(persisted).not.toContain('secret-token')
    expect(store.getSettings()).toMatchObject({ email: 'chris@example.com', patterns: ['DZ-'], hasToken: true })
  })

  it('reloads and decrypts token material for the settings view only', () => {
    const filePath = makePath()
    const first = new JiraSettingsStore(filePath, makeSecureStorage())
    first.save({ baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: ['GLD-'], apiToken: 'secret' })
    const second = new JiraSettingsStore(filePath, makeSecureStorage())
    expect(second.getSettings().hasToken).toBe(true)
    expect(second.getStoredSettings().token).toBe('secret')
    expect(second.getToken()).toEqual({ ok: true, token: 'secret' })
    expect((second.getSettings() as unknown as { token?: string }).token).toBeUndefined()
  })

  it('fails closed when secure storage is unavailable for a new token', () => {
    const store = new JiraSettingsStore(makePath(), makeSecureStorage(false))
    const result = store.save({ baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: [], apiToken: 'secret' })
    expect(result).toEqual({ ok: false, error: 'Jira settings could not be saved securely.' })
  })

  it('uses safe defaults for corrupt settings', () => {
    const filePath = makePath()
    fs.writeFileSync(filePath, '{not-json')
    const store = new JiraSettingsStore(filePath, makeSecureStorage())
    expect(store.getSettings()).toEqual({
      baseUrl: '',
      email: '',
      patterns: [],
      hasToken: false,
    })
  })
})
