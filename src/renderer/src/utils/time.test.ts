import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatRelativeTime } from './time'

describe('formatRelativeTime', () => {
  beforeEach(() => {
    // Pin "now" so the relative math is deterministic.
    vi.setSystemTime(new Date('2026-06-28T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns empty for null/undefined', () => {
    expect(formatRelativeTime(null)).toBe('')
    expect(formatRelativeTime(undefined)).toBe('')
  })

  it('returns "just now" within the first minute', () => {
    expect(formatRelativeTime('2026-06-28T11:59:45Z')).toBe('just now')
  })

  it('formats minutes, hours, and days', () => {
    expect(formatRelativeTime('2026-06-28T11:55:00Z')).toBe('5m')
    expect(formatRelativeTime('2026-06-28T09:00:00Z')).toBe('3h')
    expect(formatRelativeTime('2026-06-25T09:00:00Z')).toBe('3d')
  })

  it('rolls over to months at 30+ days', () => {
    expect(formatRelativeTime('2026-05-28T09:00:00Z')).toBe('1mo')
    expect(formatRelativeTime('2025-12-28T09:00:00Z')).toBe('6mo')
  })
})
