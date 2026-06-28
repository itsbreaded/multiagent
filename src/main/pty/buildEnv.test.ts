import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildEnv } from './buildEnv'

// These two invariants are encoded as explicit assertions because they are the
// single highest-value regression guards in the repo (specs 012/013 + the
// Claude renderer-flag constraint in CLAUDE.md). If either regresses, a future
// change silently breaks the no-scroll output path / Claude fullscreen input.

const SCRUBBED_FLAGS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'CLAUDECODE',
  'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
  'CLAUDE_CODE_DISABLE_MOUSE',
  'CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL',
  'CLAUDE_CODE_NO_FLICKER',
]

const stash: Record<string, string | undefined> = {}
const sentinel = '/test/runner/path:/usr/local/bin'

describe('buildEnv', () => {
  beforeEach(() => {
    // Preserve the real env so the test can mutate it freely.
    for (const key of [...SCRUBBED_FLAGS, 'PATH', 'ANTHROPIC_API_KEY']) {
      stash[key] = process.env[key]
    }
    // Use a distinctive PATH we can assert equality against. The equality form
    // is the strong, non-vacuous check: a "does not contain npm/nodejs/local-bin"
    // check passes trivially when those dirs aren't on PATH; equality actually
    // catches a reintroduced prepend/reorder.
    process.env.PATH = sentinel
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(stash)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  describe('PATH passthrough (spec 012/013 root cause)', () => {
    it('passes PATH through UNMODIFIED', () => {
      const env = buildEnv()
      expect(env.PATH).toBe(sentinel)
      expect(env.PATH).toBe(process.env.PATH)
    })

    it('does not prepend npm / nodejs / local-bin to PATH', () => {
      const env = buildEnv()
      expect(env.PATH).toBe(sentinel)
      // If a prepend were reintroduced, PATH would no longer start with the sentinel.
      expect(env.PATH?.startsWith(sentinel)).toBe(true)
    })
  })

  describe('Claude renderer-flag scrubbing', () => {
    it('removes every inherited Claude/Electron flag', () => {
      for (const flag of SCRUBBED_FLAGS) process.env[flag] = '1'
      const env = buildEnv()
      for (const flag of SCRUBBED_FLAGS) {
        expect(env[flag]).toBeUndefined()
      }
    })
  })

  describe('terminal profile', () => {
    it('sets TERM / COLORTERM / TERM_PROGRAM to terminal-like values', () => {
      const env = buildEnv()
      expect(env.TERM).toBe('xterm-256color')
      expect(env.COLORTERM).toBe('truecolor')
      expect(env.TERM_PROGRAM).toBe('vscode')
    })
  })

  describe('extra vars', () => {
    it('applies extra vars on top of the inherited env', () => {
      const env = buildEnv({ MY_TOOL_VAR: 'yes' })
      expect(env.MY_TOOL_VAR).toBe('yes')
    })

    it('removes an empty-string ANTHROPIC_API_KEY (alternative-provider routing)', () => {
      process.env.ANTHROPIC_API_KEY = 'native-key'
      expect(buildEnv().ANTHROPIC_API_KEY).toBe('native-key')
      process.env.ANTHROPIC_API_KEY = ''
      expect(buildEnv().ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('keeps a non-empty ANTHROPIC_API_KEY supplied via extra vars', () => {
      const env = buildEnv({ ANTHROPIC_API_KEY: 'provider-token' })
      expect(env.ANTHROPIC_API_KEY).toBe('provider-token')
    })
  })
})
