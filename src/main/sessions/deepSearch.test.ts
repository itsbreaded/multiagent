import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  buildMatcher,
  truncate,
  snippetAround,
  extractClaudeText,
  extractCodexText,
  scoreResult,
  SNIPPET_MAX_LEN,
  DEFAULT_LIMIT,
  DEFAULT_MATCHES_PER_SESSION,
  CLAUDE_SESSION_ID_RE,
  type FileResult,
} from './deepSearch'
import type { Session, SessionSearchMatch } from '../../shared/types'

// Deep-search pure helpers (spec 011): matcher modes, snippet windowing,
// role/recency ranking, and the result caps. Ranking reads Date.now(), so the
// recency test pins the clock and supplies a fixed lastActivity.

const match = (role: SessionSearchMatch['role']): SessionSearchMatch => ({
  transcriptPath: 'f',
  lineNumber: 1,
  timestamp: null,
  role,
  snippet: 's',
})

describe('caps + session-id regex', () => {
  it('exposes the documented caps', () => {
    expect(DEFAULT_LIMIT).toBe(50)
    expect(DEFAULT_MATCHES_PER_SESSION).toBe(5)
    expect(SNIPPET_MAX_LEN).toBe(500)
  })
  it('accepts a UUID-shaped Claude session filename', () => {
    expect(CLAUDE_SESSION_ID_RE.test('11111111-2222-3333-4444-555555555555')).toBe(true)
  })
  it('rejects a non-UUID Claude filename', () => {
    expect(CLAUDE_SESSION_ID_RE.test('rollout-abc')).toBe(false)
  })
})

describe('buildMatcher', () => {
  it('matches case-insensitively by default (literal)', () => {
    const m = buildMatcher('Error', false, false)
    expect(m('something failed: error here')).toBe(true)
    expect(m('all good')).toBe(false)
  })
  it('respects caseSensitive for literal matching', () => {
    const m = buildMatcher('Error', true, false)
    expect(m('An Error ocurred')).toBe(true)
    expect(m('an error ocurred')).toBe(false)
  })
  it('treats the query as a regex when regex=true', () => {
    const m = buildMatcher('foo.*bar', false, true)
    expect(m('foo then bar')).toBe(true)
    expect(m('nope')).toBe(false)
  })
  it('throws on an invalid regex', () => {
    expect(() => buildMatcher('(', false, true)).toThrow()
  })
})

describe('truncate (deep-search style)', () => {
  it('appends an ellipsis when truncated', () => {
    expect(truncate('0123456789', 5)).toBe('01234…')
  })
  it('leaves short text untouched', () => {
    expect(truncate('short', 500)).toBe('short')
  })
})

describe('snippetAround', () => {
  it('returns null when the query is absent', () => {
    expect(snippetAround('hello world', 'missing', false)).toBeNull()
  })
  it('windows around the first match with ellipses on both sides', () => {
    const text = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200)
    const snip = snippetAround(text, 'needle', false)
    expect(snip).not.toBeNull()
    expect(snip!.startsWith('…')).toBe(true)
    expect(snip!.endsWith('…')).toBe(true)
    expect(snip!.toLowerCase()).toContain('needle')
  })
  it('omits the leading ellipsis when the match is near the start', () => {
    const snip = snippetAround('NEEDLE rest', 'needle', false)
    expect(snip!.startsWith('…')).toBe(false)
  })
})

describe('extractClaudeText', () => {
  it('reads a string user message', () => {
    expect(extractClaudeText({ message: { role: 'user', content: 'hi' } })).toEqual({
      text: 'hi',
      role: 'user',
    })
  })
  it('joins text blocks for an assistant turn', () => {
    const r = extractClaudeText({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      },
    })
    expect(r.text).toBe('line1\nline2')
    expect(r.role).toBe('assistant')
  })
  it('falls back to a compact tool-block preview', () => {
    const toolBlock = { type: 'tool_use', name: 'bash' } as { type: string; text?: string }
    const r = extractClaudeText({
      message: { role: 'assistant', content: [toolBlock] },
    })
    expect(r.role).toBe('tool')
    expect(r.text).toContain('tool_use')
  })
  it('returns unknown role with no text when there is no message', () => {
    expect(extractClaudeText({})).toEqual({ text: null, role: 'unknown' })
  })
})

describe('extractCodexText', () => {
  it('reads a user_message event', () => {
    expect(
      extractCodexText({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } })
    ).toEqual({ text: 'hello', role: 'user' })
  })
  it('reads output_text from a response_item', () => {
    const r = extractCodexText({
      type: 'response_item',
      payload: { content: [{ type: 'output_text', text: 'answer' }] },
    })
    expect(r).toEqual({ text: 'answer', role: 'assistant' })
  })
  it('returns unknown when the record has no payload', () => {
    expect(extractCodexText({})).toEqual({ text: null, role: 'unknown' })
  })
})

describe('scoreResult', () => {
  beforeEach(() => {
    // Pin the clock so recency math is deterministic.
    vi.setSystemTime(new Date('2026-06-28T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const fileResult = (matches: SessionSearchMatch[]): FileResult => ({
    agentKind: 'claude',
    sessionId: 's1',
    filePath: 'f',
    matches,
  })

  it('scores match count, capped at 10 matches', () => {
    const a = scoreResult(fileResult([match('user')]), new Map())
    const b = scoreResult(fileResult(Array.from({ length: 15 }, () => match('user'))), new Map())
    // 1 match → 10 + 5 role; 15 matches capped at 10 → 100 + 75 role
    expect(a).toBe(15)
    expect(b).toBe(175)
  })

  it('weights user/assistant above tool/system', () => {
    const high = scoreResult(fileResult([match('user'), match('assistant')]), new Map())
    const low = scoreResult(fileResult([match('tool'), match('system')]), new Map())
    expect(high).toBeGreaterThan(low)
  })

  it('adds a recency bonus that decays over ~30 days', () => {
    const recent = new Map<string, Session>([
      ['claude:s1', { lastActivity: '2026-06-27T00:00:00Z' } as Session],
    ])
    const stale = new Map<string, Session>([
      ['claude:s1', { lastActivity: '2026-05-01T00:00:00Z' } as Session],
    ])
    const base = scoreResult(fileResult([match('user')]), new Map())
    expect(scoreResult(fileResult([match('user')]), recent)).toBeGreaterThan(base)
    // 58 days old → recency bonus floored to 0, equals base
    expect(scoreResult(fileResult([match('user')]), stale)).toBe(base)
  })
})
