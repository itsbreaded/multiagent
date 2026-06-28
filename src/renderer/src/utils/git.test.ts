import { describe, it, expect } from 'vitest'
import { displayGitBranch } from './git'

describe('displayGitBranch', () => {
  it('returns null for null/undefined/empty/whitespace', () => {
    expect(displayGitBranch(null)).toBeNull()
    expect(displayGitBranch(undefined)).toBeNull()
    expect(displayGitBranch('')).toBeNull()
    expect(displayGitBranch('   ')).toBeNull()
  })

  it('returns null for a detached HEAD', () => {
    expect(displayGitBranch('HEAD')).toBeNull()
    expect(displayGitBranch('  HEAD ')).toBeNull()
  })

  it('returns the trimmed branch name', () => {
    expect(displayGitBranch('main')).toBe('main')
    expect(displayGitBranch('  feature/x  ')).toBe('feature/x')
  })
})
