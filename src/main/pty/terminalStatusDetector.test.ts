import { describe, it, expect } from 'vitest'
import { Detector, createDetector, TERMINAL_STATUS_PATTERNS } from './terminalStatusDetector'

// Spec 050 phase 1: the pure fatal-terminal-error detector. The 048 lesson is
// the framing for every test here -- canonical signatures only, rolling fresh-
// output buffer only, no scrollback, no broad keywords.

describe('Detector -- Codex fatal API error (the headline case)', () => {
  // A real captured Codex 404 against a z.ai/GLM endpoint that lacks /responses.
  // Multi-chunk: Codex streams the line in pieces; the detector must still fire
  // exactly once with a sensible detail.
  const FATAL_LINE =
    'error: unexpected status 404 Not Found: Unknown error, url: https://api.z.ai/api/coding/paas/v4/responses\n'

  it('matches a single-chunk fatal line and emits terminal_error once', () => {
    const d = createDetector('codex')
    const first = d.feed(FATAL_LINE)
    expect(first).not.toBeNull()
    expect(first?.event).toBe('terminal_error')
    expect(first?.detail).toContain('404')
  })

  it('matches when Codex colorizes the line with SGR escapes (incl. inside the span)', () => {
    // Real Codex prints fatal errors in red. The escape can land INSIDE the signature
    // span (here, around the status code), which would break a literal regex. Stripping
    // ANSI in feed() must reduce this to the plain fatal line before matching.
    const colored =
      '\x1b[31m■ unexpected status \x1b[1m404\x1b[22m Not Found\x1b[0m: Unknown error, url: https://api.z.ai/api/coding/paas/v4/responses\n'
    const d = createDetector('codex')
    const r = d.feed(colored)
    expect(r).not.toBeNull()
    expect(r?.event).toBe('terminal_error')
    expect(r?.detail).toContain('404')
  })

  it('does not re-emit when only benign content follows the fatal line', () => {
    // The reducer's latch is the badge-level dedup; the detector's contract is
    // only that an OLD line still in the rolling buffer is never re-reported on
    // later feeds. Trailing benign bytes must not pick up the prior signature.
    const d = createDetector('codex')
    expect(d.feed(FATAL_LINE)).not.toBeNull()
    expect(d.feed('returning to prompt\n')).toBeNull()
    expect(d.feed('user: what happened?\n')).toBeNull()
  })

  it('matches when the fatal line spans many small writes', () => {
    const d = createDetector('codex')
    let result: { event: 'terminal_error'; detail: string } | null = null
    for (let i = 0; i < FATAL_LINE.length; i += 7) {
      const chunk = FATAL_LINE.slice(i, i + 7)
      const r = d.feed(chunk)
      if (r) {
        expect(result).toBeNull() // exactly one match across the whole stream
        result = r
      }
    }
    expect(result).not.toBeNull()
    expect(result?.detail).toContain('404')
  })

  it('matches when the signature itself is split across the chunk boundary', () => {
    const d = createDetector('codex')
    expect(d.feed('error: unexpected stat')).toBeNull()
    const hit = d.feed(`us 404 Not Found: Unknown error, url: https://api.z.ai/x\n`)
    expect(hit?.event).toBe('terminal_error')
    expect(hit?.detail).toContain('404')
  })

  it('matches the API-failed-after-N-retries signature and surfaces N in the detail', () => {
    const d = createDetector('codex')
    const hit = d.feed('API failed after 3 retries — upstream returned 5xx\n')
    expect(hit?.event).toBe('terminal_error')
    expect(hit?.detail).toBe('API failed after 3 retries')
  })
})

describe('Detector -- no false positives on benign Codex output (the 048 lesson)', () => {
  // These are the shapes that sank 048: ordinary chat, diffs, prompts that
  // *discuss* detection rules. None of them must fire.
  const cases: Array<[string, string]> = [
    ['ordinary chat', 'how do I fix the login bug in the auth module?\n'],
    ['code review prompt', 'can you run a /review on my current changes?\n'],
    ['quoted rule prose', 'we match on "unexpected status" only when followed by url:\n'],
    ['plain Error: keyword', 'Error: cannot find module ./foo\n'],
    ['panic keyword in tool output', 'goroutine panic: fatal error: out of memory\n'],
    ['unrelated status mention', 'exit status 1 from the build step\n'],
    ['api discussion', 'the API returns 404 for unknown users\n'],
    ['diff hunk', '-    if status == 404 { return errUnexpected }\n'],
    ['curl output', 'HTTP/1.1 404 Not Found\ncontent-length: 0\n'],
  ]

  for (const [label, bytes] of cases) {
    it(`does not fire on ${label}`, () => {
      const d = createDetector('codex')
      expect(d.feed(bytes)).toBeNull()
    })
  }

  it('does not fire across a long benign stream that mentions the keywords loosely', () => {
    const d = createDetector('codex', { maxBufferBytes: 512 })
    const benign =
      'running tests...\n' +
      'unexpected status from the server was retried successfully\n' +
      'API responded after 2 retries (recoverable)\n' +
      'all good, exiting cleanly\n'
    expect(d.feed(benign)).toBeNull()
  })
})

describe('Detector -- rolling buffer + cursor discipline', () => {
  it('trims the buffer to the cap without losing the in-flight line', () => {
    // maxBufferBytes=64 means the buffer trims aggressively; feed benign padding
    // then the fatal line -- the trim must not drop the signature's line.
    const d = createDetector('codex', { maxBufferBytes: 64 })
    const padding = 'line of harmless output\n'.repeat(20)
    expect(d.feed(padding)).toBeNull()
    const hit = d.feed('unexpected status 500 x, url: https://example.com\n')
    expect(hit?.event).toBe('terminal_error')
  })

  it('reset() clears state so a fresh stream starts clean', () => {
    const d = createDetector('codex')
    expect(d.feed('unexpected status 503 x, url: https://x\n')).not.toBeNull()
    d.reset()
    // After reset the same signature is matchable again (new pane, new stream).
    expect(d.feed('unexpected status 502 x, url: https://y\n')).not.toBeNull()
  })
})

describe('Detector registry -- per-agentKind pluggability', () => {
  it('Claude has no patterns today (hooks own its error path via StopFailure)', () => {
    expect(TERMINAL_STATUS_PATTERNS.claude).toEqual([])
  })

  it('Codex has the two canonical fatal signatures', () => {
    expect(TERMINAL_STATUS_PATTERNS.codex.length).toBe(2)
  })

  it('A claude detector never fires (Codex-only at launch)', () => {
    const d = createDetector('claude')
    expect(d.feed('unexpected status 404 x, url: https://x\n')).toBeNull()
    expect(d.feed('API failed after 3 retries\n')).toBeNull()
  })

  it('Patterns are stateless (no g/y flag) so exec is reproducible', () => {
    for (const entry of TERMINAL_STATUS_PATTERNS.codex) {
      expect(entry.regex.global).toBe(false)
      expect(entry.regex.sticky).toBe(false)
    }
  })

  it('An empty pattern list is a no-op detector (plumbing stays agent-agnostic)', () => {
    const d = new Detector([])
    expect(d.feed('anything at all\n')).toBeNull()
  })
})
