import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { JiraSecureStorage } from './JiraSettingsStore'

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Uses an ephemeral key supplied only by Playwright's isolated E2E profile.
 * This keeps cross-platform integration tests independent of OS keychain setup;
 * normal app launches always use Electron safeStorage.
 */
export function createE2EJiraSecureStorage(keyHex: string): JiraSecureStorage | null {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) return null
  const key = Buffer.from(keyHex, 'hex')

  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext])
    },
    decryptString(value) {
      if (value.length < 1 + IV_BYTES + TAG_BYTES || value[0] !== VERSION) {
        throw new Error('Invalid E2E Jira token envelope')
      }
      const iv = value.subarray(1, 1 + IV_BYTES)
      const tag = value.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
      const ciphertext = value.subarray(1 + IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    },
  }
}
