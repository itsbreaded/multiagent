import { describe, expect, it } from 'vitest'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireArray,
  requireCookies,
  requireNumber,
  requireString,
} from './toolArgs'

describe('requireString', () => {
  it('passes through a valid string', () => {
    expect(requireString({ url: 'https://example.com' }, 'url')).toBe('https://example.com')
  })

  it('accepts an empty string', () => {
    expect(requireString({ selector: '' }, 'selector')).toBe('')
  })

  it('throws when the key is missing', () => {
    expect(() => requireString({}, 'url')).toThrow(
      'Invalid arguments: "url" is required and must be a string (got undefined)'
    )
  })

  it('throws when args is undefined', () => {
    expect(() => requireString(undefined, 'url')).toThrow(
      'Invalid arguments: "url" is required and must be a string (got undefined)'
    )
  })

  it('throws on null', () => {
    expect(() => requireString({ url: null }, 'url')).toThrow(
      'Invalid arguments: "url" is required and must be a string (got null)'
    )
  })

  it('throws on a number value', () => {
    expect(() => requireString({ url: 5 }, 'url')).toThrow(
      'Invalid arguments: "url" is required and must be a string (got number)'
    )
  })

  it('uses the key in the message', () => {
    expect(() => requireString({}, 'selector')).toThrow(
      'Invalid arguments: "selector" is required and must be a string (got undefined)'
    )
  })
})

describe('requireNumber', () => {
  it('accepts zero', () => {
    expect(requireNumber({ x: 0 }, 'x')).toBe(0)
  })

  it('accepts negative numbers', () => {
    expect(requireNumber({ x: -5 }, 'x')).toBe(-5)
  })

  it('rejects NaN', () => {
    expect(() => requireNumber({ x: NaN }, 'x')).toThrow(
      'Invalid arguments: "x" must be a finite number (got number)'
    )
  })

  it('rejects Infinity', () => {
    expect(() => requireNumber({ x: Infinity }, 'x')).toThrow(
      'Invalid arguments: "x" must be a finite number (got number)'
    )
  })

  it('rejects numeric strings', () => {
    expect(() => requireNumber({ x: '300' }, 'x')).toThrow(
      'Invalid arguments: "x" must be a finite number (got string)'
    )
  })

  it('rejects missing keys', () => {
    expect(() => requireNumber({}, 'x')).toThrow(
      'Invalid arguments: "x" must be a finite number (got undefined)'
    )
  })
})

describe('requireArray', () => {
  it('accepts an array', () => {
    expect(requireArray({ cookies: [] }, 'cookies')).toEqual([])
  })

  it('rejects a non-array object', () => {
    expect(() => requireArray({ cookies: {} }, 'cookies')).toThrow(
      'Invalid arguments: "cookies" must be an array (got object)'
    )
  })

  it('rejects missing keys', () => {
    expect(() => requireArray({}, 'cookies')).toThrow(
      'Invalid arguments: "cookies" must be an array (got undefined)'
    )
  })
})

describe('optionalString', () => {
  it('returns undefined when absent', () => {
    expect(optionalString({}, 'selector')).toBeUndefined()
  })

  it('passes through a present string', () => {
    expect(optionalString({ selector: 'a.foo' }, 'selector')).toBe('a.foo')
  })

  it('throws on a present-but-mistyped value', () => {
    expect(() => optionalString({ selector: 5 }, 'selector')).toThrow(
      'Invalid arguments: "selector" must be a string (got number)'
    )
  })

  it('returns undefined for explicit null', () => {
    expect(optionalString({ selector: null }, 'selector')).toBeUndefined()
  })
})

describe('optionalNumber', () => {
  it('returns fallback when absent', () => {
    expect(optionalNumber({}, 'timeout_ms', 5000)).toBe(5000)
  })

  it('returns undefined when no fallback is given', () => {
    expect(optionalNumber({}, 'max_chars')).toBeUndefined()
  })

  it('passes through a present finite number', () => {
    expect(optionalNumber({ timeout_ms: 1000 }, 'timeout_ms', 5000)).toBe(1000)
  })

  it('passes through zero', () => {
    expect(optionalNumber({ timeout_ms: 0 }, 'timeout_ms', 5000)).toBe(0)
  })

  it('throws on a present-but-string value', () => {
    expect(() => optionalNumber({ timeout_ms: '5000' }, 'timeout_ms', 5000)).toThrow(
      'Invalid arguments: "timeout_ms" must be a finite number (got string)'
    )
  })

  it('throws on Infinity', () => {
    expect(() => optionalNumber({ timeout_ms: Infinity }, 'timeout_ms', 5000)).toThrow(
      'Invalid arguments: "timeout_ms" must be a finite number (got number)'
    )
  })
})

describe('optionalBoolean', () => {
  it('returns fallback when absent', () => {
    expect(optionalBoolean({}, 'exact', false)).toBe(false)
  })

  it('passes through a present boolean', () => {
    expect(optionalBoolean({ exact: true }, 'exact', false)).toBe(true)
  })

  it('throws on a present-but-mistyped value', () => {
    expect(() => optionalBoolean({ exact: 'yes' }, 'exact', false)).toThrow(
      'Invalid arguments: "exact" must be a boolean (got string)'
    )
  })
})

describe('optionalStringArray', () => {
  it('defaults to empty array when absent', () => {
    expect(optionalStringArray({}, 'modifiers')).toEqual([])
  })

  it('passes through a string array', () => {
    expect(optionalStringArray({ modifiers: ['shift', 'ctrl'] }, 'modifiers')).toEqual([
      'shift',
      'ctrl',
    ])
  })

  it('rejects a non-array value', () => {
    expect(() => optionalStringArray({ modifiers: 'shift' }, 'modifiers')).toThrow(
      'Invalid arguments: "modifiers" must be an array (got string)'
    )
  })

  it('rejects arrays containing non-strings', () => {
    expect(() => optionalStringArray({ modifiers: ['shift', 5] }, 'modifiers')).toThrow(
      'Invalid arguments: "modifiers[1]" must be a string (got number)'
    )
  })
})

describe('requireCookies', () => {
  it('happy path with snake->camel mapping', () => {
    const result = requireCookies(
      {
        cookies: [
          {
            url: 'https://example.com',
            name: 'session',
            value: 'abc',
            http_only: true,
            expiration_date: 1234567890,
            secure: false,
          },
        ],
      },
      'cookies'
    )
    expect(result).toEqual([
      {
        url: 'https://example.com',
        name: 'session',
        value: 'abc',
        secure: false,
        httpOnly: true,
        expirationDate: 1234567890,
      },
    ])
  })

  it('also accepts camelCase keys (preserves legacy pass-through)', () => {
    const result = requireCookies(
      {
        cookies: [
          {
            url: 'https://example.com',
            name: 'session',
            value: 'abc',
            httpOnly: true,
            expirationDate: 1234567890,
          },
        ],
      },
      'cookies'
    )
    expect(result).toEqual([
      {
        url: 'https://example.com',
        name: 'session',
        value: 'abc',
        httpOnly: true,
        expirationDate: 1234567890,
      },
    ])
  })

  it('reports an indexed error for a bad element', () => {
    expect(() =>
      requireCookies(
        {
          cookies: [
            { url: 'https://example.com', name: 'a', value: 'b' },
            { url: 'https://example.com', name: 'a', value: 5 },
          ],
        },
        'cookies'
      )
    ).toThrow(
      'Invalid arguments: "cookies[1].value" is required and must be a string (got number)'
    )
  })

  it('rejects a non-array cookies value', () => {
    expect(() => requireCookies({ cookies: {} }, 'cookies')).toThrow(
      'Invalid arguments: "cookies" must be an array (got object)'
    )
  })

  it('rejects a non-object element', () => {
    expect(() => requireCookies({ cookies: ['nope'] }, 'cookies')).toThrow(
      'Invalid arguments: "cookies[0]" must be an object (got string)'
    )
  })

  it('rejects a mistyped optional field', () => {
    expect(() =>
      requireCookies(
        { cookies: [{ url: 'u', name: 'n', value: 'v', secure: 'yes' }] },
        'cookies'
      )
    ).toThrow('Invalid arguments: "cookies[0].secure" must be a boolean (got string)')
  })

  it('allows omitting all optional fields', () => {
    expect(requireCookies({ cookies: [{ url: 'u', name: 'n', value: 'v' }] }, 'cookies')).toEqual([
      { url: 'u', name: 'n', value: 'v' },
    ])
  })
})
