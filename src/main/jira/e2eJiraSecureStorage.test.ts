import { describe, expect, it } from 'vitest'
import { createE2EJiraSecureStorage } from './e2eJiraSecureStorage'

describe('E2E Jira secure storage', () => {
  const key = '10'.repeat(32)

  it('encrypts tokens with the supplied profile key and decrypts them after a new adapter is created', () => {
    const first = createE2EJiraSecureStorage(key)!
    const ciphertext = first.encryptString('synthetic-token')

    expect(ciphertext.toString('utf8')).not.toContain('synthetic-token')
    expect(createE2EJiraSecureStorage(key)!.decryptString(ciphertext)).toBe('synthetic-token')
    expect(() => createE2EJiraSecureStorage('20'.repeat(32))!.decryptString(ciphertext)).toThrow()
  })

  it('rejects invalid keys and tampered ciphertext', () => {
    expect(createE2EJiraSecureStorage('invalid')).toBeNull()
    const storage = createE2EJiraSecureStorage(key)!
    const ciphertext = storage.encryptString('synthetic-token')
    ciphertext[ciphertext.length - 1] ^= 1
    expect(() => storage.decryptString(ciphertext)).toThrow()
  })
})
