import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from '../atomicJson'
import {
  DEFAULT_JIRA_BASE_URL,
  normalizeJiraBaseUrl,
  normalizeJiraPatterns,
  type JiraSaveSettingsResult,
  type JiraSettings,
  type JiraSettingsInput,
  type JiraTokenResult,
  type JiraVerifiedIdentityBinding,
} from '../../shared/jira'

export interface JiraSecureStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface JiraStoredSettings {
  baseUrl: string
  email: string
  patterns: string[]
  token: string | null
  mentionsEnabled: boolean
  mentionsPollingEnabled: boolean
  mentionsPollingMinutes: number
}

interface PersistedJiraSettings {
  version: 2
  baseUrl: string
  email: string
  patterns: string[]
  mentionsEnabled?: boolean
  mentionsPollingEnabled?: boolean
  mentionsPollingMinutes?: number
  encryptedToken?: string
  mentionsVerifiedIdentity?: JiraVerifiedIdentityBinding
}

const SAFE_SETTINGS_ERROR = 'Jira settings could not be saved securely.'

function defaultSettings(): JiraStoredSettings {
  return {
    baseUrl: DEFAULT_JIRA_BASE_URL,
    email: '',
    patterns: [],
    token: null,
    mentionsEnabled: false,
    mentionsPollingEnabled: false,
    mentionsPollingMinutes: 15,
  }
}

function isPollingInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 240
}

function parseBinding(value: unknown): JiraVerifiedIdentityBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const binding = value as Partial<JiraVerifiedIdentityBinding>
  const siteUrl = normalizeJiraBaseUrl(binding.siteUrl)
  if (typeof binding.contextId !== 'string' || !binding.contextId
    || !siteUrl || typeof binding.accountId !== 'string' || !binding.accountId
    || typeof binding.verifiedAt !== 'number' || !Number.isFinite(binding.verifiedAt)
    || typeof binding.credentialRecordKey !== 'string' || !/^[a-f0-9]{64}$/i.test(binding.credentialRecordKey)) return undefined
  return {
    contextId: binding.contextId,
    siteUrl,
    accountId: binding.accountId,
    verifiedAt: binding.verifiedAt,
    credentialRecordKey: binding.credentialRecordKey,
  }
}

export class JiraSettingsStore {
  private current: JiraStoredSettings = defaultSettings()
  private encryptedToken: string | undefined
  private verifiedIdentityBinding: JiraVerifiedIdentityBinding | undefined

  constructor(
    private readonly filePath: string,
    private readonly secureStorage: JiraSecureStorage,
  ) {
    this.reload()
  }

  reload(): JiraStoredSettings {
    const fallback = defaultSettings()
    this.encryptedToken = undefined
    this.verifiedIdentityBinding = undefined
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedJiraSettings>
      const baseUrl = normalizeJiraBaseUrl(parsed.baseUrl) ?? fallback.baseUrl
      const email = typeof parsed.email === 'string' ? parsed.email : ''
      const patterns = normalizeJiraPatterns(Array.isArray(parsed.patterns) ? parsed.patterns : [])
      const mentionsEnabled = typeof parsed.mentionsEnabled === 'boolean' ? parsed.mentionsEnabled : false
      const mentionsPollingEnabled = typeof parsed.mentionsPollingEnabled === 'boolean' ? parsed.mentionsPollingEnabled : false
      const mentionsPollingMinutes = isPollingInterval(parsed.mentionsPollingMinutes) ? parsed.mentionsPollingMinutes : 15
      this.encryptedToken = typeof parsed.encryptedToken === 'string' && parsed.encryptedToken.length > 0
        ? parsed.encryptedToken
        : undefined
      this.verifiedIdentityBinding = parseBinding(parsed.mentionsVerifiedIdentity)
      let token: string | null = null
      if (this.encryptedToken && this.secureStorage.isEncryptionAvailable()) {
        try {
          token = this.secureStorage.decryptString(Buffer.from(this.encryptedToken, 'base64'))
        } catch {
          token = null
        }
      }
      this.current = { baseUrl, email, patterns, token, mentionsEnabled, mentionsPollingEnabled, mentionsPollingMinutes }
    } catch {
      this.current = fallback
    }
    return this.current
  }

  getSettings(): JiraSettings {
    return {
      baseUrl: this.current.baseUrl,
      email: this.current.email,
      patterns: [...this.current.patterns],
      hasToken: Boolean(this.encryptedToken),
      mentionsEnabled: this.current.mentionsEnabled,
      mentionsPollingEnabled: this.current.mentionsPollingEnabled,
      mentionsPollingMinutes: this.current.mentionsPollingMinutes,
    }
  }

  getStoredSettings(): JiraStoredSettings {
    return {
      baseUrl: this.current.baseUrl,
      email: this.current.email,
      patterns: [...this.current.patterns],
      token: this.current.token,
      mentionsEnabled: this.current.mentionsEnabled,
      mentionsPollingEnabled: this.current.mentionsPollingEnabled,
      mentionsPollingMinutes: this.current.mentionsPollingMinutes,
    }
  }

  getToken(): JiraTokenResult {
    if (!this.encryptedToken) return { ok: true, token: '' }
    if (typeof this.current.token !== 'string') {
      return { ok: false, error: 'Saved Jira token could not be decrypted securely.' }
    }
    return { ok: true, token: this.current.token }
  }

  getCredentialRecordKey(): string | null {
    if (!this.encryptedToken || !this.current.email || !this.current.baseUrl) return null
    return this.credentialRecordKey(this.current.baseUrl, this.current.email, this.encryptedToken)
  }

  getVerifiedIdentityBinding(): JiraVerifiedIdentityBinding | null {
    const binding = this.verifiedIdentityBinding
    if (!binding) return null
    return { ...binding }
  }

  saveVerifiedIdentityBinding(expectedCredentialRecordKey: string, binding: JiraVerifiedIdentityBinding): boolean {
    const currentKey = this.getCredentialRecordKey()
    const siteUrl = normalizeJiraBaseUrl(binding.siteUrl)
    if (!currentKey || currentKey !== expectedCredentialRecordKey || binding.credentialRecordKey !== currentKey
      || !siteUrl || siteUrl !== this.current.baseUrl || typeof binding.accountId !== 'string' || !binding.accountId
      || !Number.isFinite(binding.verifiedAt)) return false
    const nextBinding: JiraVerifiedIdentityBinding = { ...binding, siteUrl }
    try {
      this.persist(this.current, this.encryptedToken, nextBinding)
    } catch {
      return false
    }
    this.verifiedIdentityBinding = nextBinding
    return true
  }

  save(input: JiraSettingsInput): JiraSaveSettingsResult {
    const baseUrl = normalizeJiraBaseUrl(input.baseUrl)
    const email = typeof input.email === 'string' ? input.email.trim() : ''
    if (!baseUrl || !email) return { ok: false, error: SAFE_SETTINGS_ERROR }
    const mentionsPollingMinutes = input.mentionsPollingMinutes === undefined
      ? this.current.mentionsPollingMinutes
      : input.mentionsPollingMinutes
    if (!isPollingInterval(mentionsPollingMinutes)) {
      return { ok: false, error: 'Background refresh interval must be a whole number from 5 to 240 minutes.' }
    }

    const patterns = normalizeJiraPatterns(input.patterns)
    let encryptedToken = this.encryptedToken
    let token = this.current.token

    if (input.clearToken) {
      encryptedToken = undefined
      token = null
    } else if (input.apiToken !== undefined) {
      if (!input.apiToken) {
        encryptedToken = undefined
        token = null
      } else {
        if (!this.secureStorage.isEncryptionAvailable()) return { ok: false, error: SAFE_SETTINGS_ERROR }
        try {
          encryptedToken = this.secureStorage.encryptString(input.apiToken).toString('base64')
          token = input.apiToken
        } catch {
          return { ok: false, error: SAFE_SETTINGS_ERROR }
        }
      }
    }

    const credentialChanged = baseUrl !== this.current.baseUrl || email !== this.current.email || encryptedToken !== this.encryptedToken
    const nextCurrent: JiraStoredSettings = {
      baseUrl,
      email,
      patterns,
      token,
      mentionsEnabled: typeof input.mentionsEnabled === 'boolean' ? input.mentionsEnabled : this.current.mentionsEnabled,
      mentionsPollingEnabled: typeof input.mentionsPollingEnabled === 'boolean' ? input.mentionsPollingEnabled : this.current.mentionsPollingEnabled,
      mentionsPollingMinutes,
    }
    const nextBinding = credentialChanged ? undefined : this.verifiedIdentityBinding
    try {
      this.persist(nextCurrent, encryptedToken, nextBinding)
    } catch {
      return { ok: false, error: SAFE_SETTINGS_ERROR }
    }

    this.current = nextCurrent
    this.encryptedToken = encryptedToken
    this.verifiedIdentityBinding = nextBinding
    return { ok: true, settings: this.getSettings() }
  }

  private credentialRecordKey(baseUrl: string, email: string, encryptedToken: string): string {
    return createHash('sha256').update(JSON.stringify([baseUrl, email, encryptedToken]), 'utf8').digest('hex')
  }

  private persist(
    current: JiraStoredSettings,
    encryptedToken: string | undefined,
    binding: JiraVerifiedIdentityBinding | undefined,
  ): void {
    const persisted: PersistedJiraSettings = {
      version: 2,
      baseUrl: current.baseUrl,
      email: current.email,
      patterns: current.patterns,
      mentionsEnabled: current.mentionsEnabled,
      mentionsPollingEnabled: current.mentionsPollingEnabled,
      mentionsPollingMinutes: current.mentionsPollingMinutes,
      ...(encryptedToken ? { encryptedToken } : {}),
      ...(binding ? { mentionsVerifiedIdentity: binding } : {}),
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    writeJsonAtomic(this.filePath, persisted, 2)
  }
}
