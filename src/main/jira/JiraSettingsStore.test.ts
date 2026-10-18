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
      mentionsEnabled: false,
      mentionsPollingEnabled: false,
      mentionsPollingMinutes: 15,
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
      mentionsEnabled: false,
      mentionsPollingEnabled: false,
      mentionsPollingMinutes: 15,
    })
  })

  it('validates mention polling and preserves the private identity binding across preference saves', () => {
    const store = new JiraSettingsStore(makePath(), makeSecureStorage())
    expect(store.save({
      baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: [], apiToken: 'token',
      mentionsEnabled: true, mentionsPollingEnabled: true, mentionsPollingMinutes: 15.5,
    })).toMatchObject({ ok: false, error: expect.stringContaining('whole number') })
    store.save({
      baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: [], apiToken: 'token',
      mentionsEnabled: true, mentionsPollingEnabled: true, mentionsPollingMinutes: 15,
    })
    const key = store.getCredentialRecordKey()!
    expect(store.saveVerifiedIdentityBinding(key, {
      contextId: 'context-1', siteUrl: 'https://jira.example.test', accountId: 'account-1',
      verifiedAt: 1234, credentialRecordKey: key,
    })).toBe(true)
    expect(store.getSettings()).not.toHaveProperty('mentionsVerifiedIdentity')

    store.save({
      baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: ['APP-'],
      mentionsEnabled: true, mentionsPollingEnabled: false, mentionsPollingMinutes: 30,
    })
    expect(store.getVerifiedIdentityBinding()).toMatchObject({ contextId: 'context-1', accountId: 'account-1' })
    expect(store.getSettings()).toMatchObject({ mentionsEnabled: true, mentionsPollingEnabled: false, mentionsPollingMinutes: 30 })
  })

  it('invalidates the binding when Jira credentials change or are removed', () => {
    const store = new JiraSettingsStore(makePath(), makeSecureStorage())
    store.save({ baseUrl: 'https://jira.example.test', email: 'user@example.com', patterns: [], apiToken: 'token' })
    const key = store.getCredentialRecordKey()!
    store.saveVerifiedIdentityBinding(key, {
      contextId: 'context-1', siteUrl: 'https://jira.example.test', accountId: 'account-1',
      verifiedAt: 1234, credentialRecordKey: key,
    })
    store.save({ baseUrl: 'https://other.example.test', email: 'user@example.com', patterns: [] })
    expect(store.getVerifiedIdentityBinding()).toBeNull()
    const nextKey = store.getCredentialRecordKey()!
    store.saveVerifiedIdentityBinding(nextKey, {
      contextId: 'context-2', siteUrl: 'https://other.example.test', accountId: 'account-1',
      verifiedAt: 2345, credentialRecordKey: nextKey,
    })
    store.save({ baseUrl: 'https://other.example.test', email: 'user@example.com', patterns: [], clearToken: true })
    expect(store.getVerifiedIdentityBinding()).toBeNull()
    expect(store.getCredentialRecordKey()).toBeNull()
  })
})
