import { describe, expect, it } from 'vitest'
import { win32 } from 'path'
import { replaceCwdPrefix } from '../../shared/cwdRepair'
import { legacyReplaceCwdPrefix } from './cwdRepairLegacy'

describe('legacy main-process cwd repair golden master', () => {
  const windowsMapping = { oldCwd: 'C:\\old', newCwd: 'D:\\new' }

  it('rewrites Windows exact and child paths case-insensitively on a Win32 host', () => {
    expect(legacyReplaceCwdPrefix('C:\\OLD', windowsMapping, 'win32')).toBe('D:\\new')
    expect(legacyReplaceCwdPrefix('C:/old/sub', windowsMapping, 'win32')).toBe('D:\\new\\sub')
  })

  it('enforces a segment boundary on a Win32 host', () => {
    expect(legacyReplaceCwdPrefix('C:\\old-extra', windowsMapping, 'win32')).toBe('C:\\old-extra')
  })

  it('converts POSIX stored paths to host-resolved Windows paths on a Win32 host', () => {
    const mapping = { oldCwd: '/home/old', newCwd: '/home/new' }
    expect(legacyReplaceCwdPrefix('/home/old/proj', mapping, 'win32')).toBe(win32.resolve('/home/new/proj'))
    expect(replaceCwdPrefix('/home/old/proj', mapping)).toBe('/home/new/proj')
  })

  it('does not recognize backslashes as separators on a POSIX host', () => {
    expect(legacyReplaceCwdPrefix('C:\\old\\sub', windowsMapping, 'posix')).toBe('C:\\old\\sub')
    expect(replaceCwdPrefix('C:\\old\\sub', windowsMapping)).toBe('D:\\new\\sub')
  })

  it('rewrites native POSIX paths on a POSIX host', () => {
    const mapping = { oldCwd: '/home/old', newCwd: '/home/new' }
    expect(legacyReplaceCwdPrefix('/home/old/proj', mapping, 'posix')).toBe('/home/new/proj')
  })
})
