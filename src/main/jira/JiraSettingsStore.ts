import * as fs from 'fs'
import * as path from 'path'
import { writeJsonAtomic } from '../atomicJson'
import {
  DEFAULT_JIRA_BASE_URL,
  normalizeJiraBaseUrl,
  normalizeJiraPatterns,
  type JiraSaveSettingsResult,
  type JiraSettings,
  type JiraSettingsInput,
  type JiraTokenResult,
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
}

interface PersistedJiraSettings {
  version: 1
  baseUrl: string
  email: string
  patterns: string[]
  encryptedToken?: string
}

const SAFE_SETTINGS_ERROR = 'Jira settings could not be saved securely.'

function defaultSettings(): JiraStoredSettings {
  return { baseUrl: DEFAULT_JIRA_BASE_URL, email: '', patterns: [], token: null }
}

export class JiraSettingsStore {
  private current: JiraStoredSettings = defaultSettings()
  private encryptedToken: string | undefined

  constructor(
    private readonly filePath: string,
    private readonly secureStorage: JiraSecureStorage,
  ) {
    this.reload()
  }

  reload(): JiraStoredSettings {
    const fallback = defaultSettings()
    this.encryptedToken = undefined
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedJiraSettings>
      const baseUrl = normalizeJiraBaseUrl(parsed.baseUrl) ?? fallback.baseUrl
      const email = typeof parsed.email === 'string' ? parsed.email : ''
      const patterns = normalizeJiraPatterns(Array.isArray(parsed.patterns) ? parsed.patterns : [])
      this.encryptedToken = typeof parsed.encryptedToken === 'string' && parsed.encryptedToken.length > 0
        ? parsed.encryptedToken
        : undefined
      let token: string | null = null
      if (this.encryptedToken && this.secureStorage.isEncryptionAvailable()) {
        try {
          token = this.secureStorage.decryptString(Buffer.from(this.encryptedToken, 'base64'))
        } catch {
          token = null
        }
      }
      this.current = { baseUrl, email, patterns, token }
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
    }
  }

  getStoredSettings(): JiraStoredSettings {
    return {
      baseUrl: this.current.baseUrl,
      email: this.current.email,
      patterns: [...this.current.patterns],
      token: this.current.token,
    }
  }

  getToken(): JiraTokenResult {
    if (!this.encryptedToken) return { ok: true, token: '' }
    if (typeof this.current.token !== 'string') {
      return { ok: false, error: 'Saved Jira token could not be decrypted securely.' }
    }
    return { ok: true, token: this.current.token }
  }

  save(input: JiraSettingsInput): JiraSaveSettingsResult {
    const baseUrl = normalizeJiraBaseUrl(input.baseUrl)
    const email = typeof input.email === 'string' ? input.email.trim() : ''
    if (!baseUrl || !email) return { ok: false, error: SAFE_SETTINGS_ERROR }

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

    const persisted: PersistedJiraSettings = {
      version: 1,
      baseUrl,
      email,
      patterns,
      ...(encryptedToken ? { encryptedToken } : {}),
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeJsonAtomic(this.filePath, persisted, 2)
    } catch {
      return { ok: false, error: SAFE_SETTINGS_ERROR }
    }

    this.current = { baseUrl, email, patterns, token }
    this.encryptedToken = encryptedToken
    return { ok: true, settings: this.getSettings() }
  }
}
