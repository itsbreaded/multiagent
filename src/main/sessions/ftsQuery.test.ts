import { describe, expect, it } from 'vitest'
import {
  toFtsMatchExpression,
  splitFtsTokens,
  toLikeSubstringPattern,
} from './ftsQuery'

// Pure unit tests over the FTS5 query builder (spec 036, item 7). These are the
// primary regression net for "summary search silently breaks for queries users
// actually type" (Windows paths, unbalanced quotes, dangling FTS operators) —
// they run under plain Node and never touch better-sqlite3.

describe('toFtsMatchExpression', () => {
  it('wraps a single token as a quoted FTS5 string literal', () => {
    expect(toFtsMatchExpression('foo')).toBe('"foo"')
  })

  it('preserves implicit-AND multi-term semantics', () => {
    expect(toFtsMatchExpression('foo bar')).toBe('"foo" "bar"')
  })

  it('neutralizes the FTS5 column-filter colon in a Windows path', () => {
    // `C:\Code\multiagent` is the case that threw SqliteError before — the colon
    // is FTS5 column-filter syntax and `sessions_fts` has no column named `C`.
    expect(toFtsMatchExpression('C:\\Code\\multiagent')).toBe('"C:\\Code\\multiagent"')
  })

  it('doubles internal quotes per FTS5 quoted-string escape rules', () => {
    expect(toFtsMatchExpression('say "hello"')).toBe('"say" """hello"""')
  })

  it('renders FTS keywords as literal terms', () => {
    expect(toFtsMatchExpression('foo AND')).toBe('"foo" "AND"')
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(toFtsMatchExpression('')).toBeNull()
    expect(toFtsMatchExpression('   ')).toBeNull()
    expect(toFtsMatchExpression('\t\n')).toBeNull()
  })

  it('does not throw on the adversarial query set', () => {
    // Each of these used to throw SqliteError under raw MATCH; each must now
    // produce some quoted output without throwing.
    const adversarial = ['"unbalanced', '-foo', 'foo(*', 'NEAR(', 'a:b:c', 'foo)', '(foo)', 'foo OR', 'foo*']
    for (const q of adversarial) {
      const out = toFtsMatchExpression(q)
      expect(typeof out).toBe('string')
      expect(out!.length).toBeGreaterThan(0)
    }
  })
})

describe('splitFtsTokens', () => {
  it('splits on whitespace and drops empties', () => {
    expect(splitFtsTokens('  foo   bar\n')).toEqual(['foo', 'bar'])
  })
  it('returns an empty array for whitespace-only input', () => {
    expect(splitFtsTokens('   ')).toEqual([])
  })
})

describe('toLikeSubstringPattern', () => {
  it('wraps the token in % wildcards', () => {
    expect(toLikeSubstringPattern('foo')).toBe('%foo%')
  })
  it('escapes LIKE metacharacters %, _, and the escape char \\', () => {
    expect(toLikeSubstringPattern('50%_off\\x')).toBe('%50\\%\\_off\\\\x%')
  })
  it('leaves a Windows path colon unescaped (colon has no LIKE meta-meaning)', () => {
    expect(toLikeSubstringPattern('C:\\Code')).toBe('%C:\\\\Code%')
  })
})
