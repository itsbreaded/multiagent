import { describe, it, expect } from 'vitest'
import {
  parseRecord,
  extractText,
  isRealUserMessage,
  truncate,
  deriveProjectName,
  type JsonlRecord,
} from './transcriptParse'

// Characterization tests for the Claude transcript record classifiers. These
// determine firstMessage / lastMessage / messageCount in the session index, so
// the command/meta exclusions and content-shape handling are exactly where a
// regression would silently inflate or drop session metadata.

const rec = (over: Partial<JsonlRecord>): JsonlRecord => over

describe('parseRecord', () => {
  it('parses valid JSON', () => {
    expect(parseRecord('{"type":"user"}')).toEqual({ type: 'user' })
  })
  it('returns null for malformed JSON', () => {
    expect(parseRecord('{not json')).toBeNull()
    expect(parseRecord('')).toBeNull()
  })
})

describe('extractText', () => {
  it('returns the content when it is a plain string', () => {
    expect(extractText(rec({ message: { content: 'hello' } }))).toBe('hello')
  })
  it('extracts the first text block from an array content', () => {
    const r = rec({ message: { content: [{ type: 'text', text: 'hi there' }] } })
    expect(extractText(r)).toBe('hi there')
  })
  it('picks the text item out of a mixed content array', () => {
    // Non-text blocks carry extra fields (name, id, …); only `type`/`text` are read.
    const toolBlock = { type: 'tool_use', name: 'foo' } as { type: string; text?: string }
    const r = rec({
      message: {
        content: [toolBlock, { type: 'text', text: 'after tool' }],
      },
    })
    expect(extractText(r)).toBe('after tool')
  })
  it('returns null when no message or no text block is present', () => {
    expect(extractText(rec({}))).toBeNull()
    expect(extractText(rec({ message: { content: [{ type: 'tool_use' }] } }))).toBeNull()
    expect(extractText(rec({ message: { content: [] } }))).toBeNull()
  })

  it('ignores non-text blocks when looking for text', () => {
    // Non-text blocks (tool_use etc.) carry extra fields; only the type is read.
    const block = { type: 'tool_use', name: 'bash' } as { type: string; text?: string }
    expect(extractText(rec({ message: { content: [block] } }))).toBeNull()
  })
})

describe('isRealUserMessage', () => {
  it('accepts a plain user turn with string content', () => {
    expect(isRealUserMessage(rec({ type: 'user', message: { content: 'fix the bug' } }))).toBe(true)
  })
  it('rejects assistant / non-user types', () => {
    expect(isRealUserMessage(rec({ type: 'assistant', message: { content: 'ok' } }))).toBe(false)
  })
  it('rejects meta user records', () => {
    expect(
      isRealUserMessage(rec({ type: 'user', isMeta: true, message: { content: 'x' } }))
    ).toBe(false)
  })
  it('rejects synthetic <command> and <local-command> invocations', () => {
    expect(
      isRealUserMessage(rec({ type: 'user', message: { content: '<command>clear</command>' } }))
    ).toBe(false)
    expect(
      isRealUserMessage(rec({ type: 'user', message: { content: '<local-command>ls</local-command>' } }))
    ).toBe(false)
  })
  it('rejects records with no extractable text', () => {
    expect(isRealUserMessage(rec({ type: 'user' }))).toBe(false)
  })
})

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('short', 200)).toBe('short')
  })
  it('slices text longer than maxLen with no ellipsis', () => {
    expect(truncate('0123456789', 5)).toBe('01234')
  })
  it('respects a custom maxLen', () => {
    expect(truncate('abcdefgh', 3)).toBe('abc')
  })
})

describe('deriveProjectName', () => {
  it('returns the last two segments for a deep posix path', () => {
    expect(deriveProjectName('/home/user/code/multiagent')).toBe('code/multiagent')
  })
  it('normalizes backslash separators the same as forward slashes', () => {
    expect(deriveProjectName('C:\\Users\\me\\multiagent')).toBe('me/multiagent')
  })
  it('returns the single segment for a shallow path', () => {
    expect(deriveProjectName('/multiagent')).toBe('multiagent')
  })
  it('falls back to the raw cwd when empty', () => {
    expect(deriveProjectName('')).toBe('')
  })
})
