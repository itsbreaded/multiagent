import { describe, it, expect } from 'vitest'
import { codexHooksFeatureEnabled, ensureCodexHooksFeatureEnabled } from './codexConfigFeatures'

// Spec 047 phase 4: pure TOML surgery that ensures [features] hooks = true in
// ~/.codex/config.toml. Invariants under test: idempotent, preserves unrelated keys, sets
// an existing hooks value to true, and creates the section when absent.

describe('codexConfigFeatures', () => {
  describe('codexHooksFeatureEnabled', () => {
    it('is false for empty text', () => {
      expect(codexHooksFeatureEnabled('')).toBe(false)
    })

    it('is true when [features] hooks = true is present', () => {
      expect(codexHooksFeatureEnabled('[features]\nhooks = true\n')).toBe(true)
    })

    it('is false when hooks is false', () => {
      expect(codexHooksFeatureEnabled('[features]\nhooks = false\n')).toBe(false)
    })

    it('ignores a hooks key that belongs to a different table', () => {
      const text = '[other]\nhooks = true\n[features]\nmodel = "gpt"\n'
      expect(codexHooksFeatureEnabled(text)).toBe(false)
    })

    it('ignores a [features.something] subsection header', () => {
      const text = '[features.something]\nhooks = true\n'
      expect(codexHooksFeatureEnabled(text)).toBe(false)
    })
  })

  describe('ensureCodexHooksFeatureEnabled', () => {
    it('creates a [features] section when none exists', () => {
      const out = ensureCodexHooksFeatureEnabled('')
      expect(codexHooksFeatureEnabled(out)).toBe(true)
      expect(out).toContain('[features]')
      expect(out).toContain('hooks = true')
    })

    it('appends a section after unrelated content without a trailing newline', () => {
      const out = ensureCodexHooksFeatureEnabled('model = "gpt-5"')
      expect(codexHooksFeatureEnabled(out)).toBe(true)
      expect(out).toContain('model = "gpt-5"')
    })

    it('sets an existing hooks value to true', () => {
      const out = ensureCodexHooksFeatureEnabled('[features]\nhooks = false\n')
      expect(codexHooksFeatureEnabled(out)).toBe(true)
      expect(out).toContain('hooks = true')
      expect(out).not.toContain('hooks = false')
    })

    it('adds hooks to an existing [features] section with other keys', () => {
      const text = '[features]\nstream = true\n'
      const out = ensureCodexHooksFeatureEnabled(text)
      expect(codexHooksFeatureEnabled(out)).toBe(true)
      expect(out).toContain('stream = true')
      expect(out).toContain('hooks = true')
    })

    it('inserts hooks before the next table header, not at EOF', () => {
      const text = '[features]\nstream = true\n\n[mcp_servers.foo]\nurl = "x"\n'
      const out = ensureCodexHooksFeatureEnabled(text)
      const featuresBlock = out.slice(0, out.indexOf('[mcp_servers'))
      expect(featuresBlock).toContain('hooks = true')
      expect(out).toContain('[mcp_servers.foo]')
    })

    it('is idempotent', () => {
      const once = ensureCodexHooksFeatureEnabled('[features]\nstream = true\n')
      const twice = ensureCodexHooksFeatureEnabled(once)
      expect(twice).toBe(once)
    })

    it('preserves CRLF newlines', () => {
      const out = ensureCodexHooksFeatureEnabled('[features]\r\nstream = true\r\n')
      expect(out.includes('\r\n')).toBe(true)
      expect(codexHooksFeatureEnabled(out)).toBe(true)
    })

    it('preserves unrelated keys when enabling', () => {
      const text = 'model = "gpt-5"\n\n[features]\nstream = true\n\n[mcp_servers.x]\nurl = "y"\n'
      const out = ensureCodexHooksFeatureEnabled(text)
      expect(out).toContain('model = "gpt-5"')
      expect(out).toContain('stream = true')
      expect(out).toContain('[mcp_servers.x]')
      expect(out).toContain('url = "y"')
      expect(codexHooksFeatureEnabled(out)).toBe(true)
    })
  })
})
