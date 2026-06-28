import { describe, it, expect } from 'vitest'
import {
  replaceCwdPrefix,
  isWindowsPath,
  repairSeparator,
  normalizeRepairPath,
} from './cwdRepair'

// Characterization tests for the renderer-side cwd-repair mapping — the
// platform-agnostic, segment-boundary rewrite. These are exactly the branches
// where a regression hides: backslash vs forward-slash vs mixed, drive prefix,
// and segment-boundary enforcement (a prefix must not match a longer sibling).

describe('isWindowsPath / repairSeparator', () => {
  it('detects drive-prefixed and backslash paths', () => {
    expect(isWindowsPath('C:\\proj')).toBe(true)
    expect(isWindowsPath('D:/mixed\\path')).toBe(true)
  })
  it('treats pure posix paths as non-windows', () => {
    expect(isWindowsPath('/home/user')).toBe(false)
  })
  it('picks the separator from the path style', () => {
    expect(repairSeparator('C:\\proj')).toBe('\\')
    expect(repairSeparator('/home/user')).toBe('/')
  })
})

describe('normalizeRepairPath', () => {
  it('normalizes mixed separators to the detected style', () => {
    expect(normalizeRepairPath('C:/a/b\\c')).toBe('C:\\a\\b\\c')
  })
  it('leaves a pure posix path posix', () => {
    expect(normalizeRepairPath('/a/b/c')).toBe('/a/b/c')
  })
  it('treats a posix path containing a backslash as windows (any backslash ⇒ windows)', () => {
    expect(normalizeRepairPath('/a/b\\c')).toBe('\\a\\b\\c')
  })
  it('collapses redundant separators and resolves . / ..', () => {
    expect(normalizeRepairPath('C:\\a\\.\\b')).toBe('C:\\a\\b')
    expect(normalizeRepairPath('C:\\a\\b\\..\\c')).toBe('C:\\a\\c')
  })
})

describe('replaceCwdPrefix — backslash (Windows) paths', () => {
  const mapping = { oldCwd: 'C:\\old', newCwd: 'C:\\new' }

  it('rewrites an exact match onto the new root', () => {
    expect(replaceCwdPrefix('C:\\old', mapping)).toBe('C:\\new')
  })
  it('rewrites a child path, preserving the suffix', () => {
    expect(replaceCwdPrefix('C:\\old\\sub\\deep', mapping)).toBe('C:\\new\\sub\\deep')
  })
  it('returns unrelated paths unchanged', () => {
    expect(replaceCwdPrefix('C:\\other', mapping)).toBe('C:\\other')
  })
  it('enforces a segment boundary (no partial-segment prefix match)', () => {
    // "old-extra" is a different segment than "old"; must NOT be rewritten.
    expect(replaceCwdPrefix('C:\\old-extra', mapping)).toBe('C:\\old-extra')
  })
  it('normalizes forward-slash input onto the backslash root', () => {
    expect(replaceCwdPrefix('C:/old/sub', mapping)).toBe('C:\\new\\sub')
  })
})

describe('replaceCwdPrefix — forward-slash (posix) paths', () => {
  const mapping = { oldCwd: '/home/old', newCwd: '/home/new' }

  it('rewrites an exact match', () => {
    expect(replaceCwdPrefix('/home/old', mapping)).toBe('/home/new')
  })
  it('rewrites a child path', () => {
    expect(replaceCwdPrefix('/home/old/proj', mapping)).toBe('/home/new/proj')
  })
  it('enforces a segment boundary', () => {
    expect(replaceCwdPrefix('/home/oldish', mapping)).toBe('/home/oldish')
  })
})

describe('replaceCwdPrefix — mixed separators in the mapping', () => {
  it('normalizes the newCwd to the path style implied by the candidate', () => {
    const mapping = { oldCwd: 'C:\\old', newCwd: 'C:/new' }
    // newCwd 'C:/new' is a drive-prefixed path → normalized to backslashes,
    // and the suffix is re-joined in the same style.
    expect(replaceCwdPrefix('C:\\old\\sub', mapping)).toBe('C:\\new\\sub')
  })
})

describe('replaceCwdPrefix — drive-prefix edge case', () => {
  it('treats different drive letters as unrelated', () => {
    const mapping = { oldCwd: 'C:\\old', newCwd: 'C:\\new' }
    expect(replaceCwdPrefix('D:\\old', mapping)).toBe('D:\\old')
  })
})
