import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  parseOsc7,
  parseShellIntegrationCwd,
  unescapeShellIntegrationValue,
  unterminatedOscTail,
} from './shellIntegration'

// Shell-integration CWD reporting — OSC 633;P;Cwd= (primary, emitted by
// shellIntegration.ps1) and OSC 7 file:// (compatibility fallback). These
// parsers feed pty:cwd which drives the agent cwd / pane labels, so a regression
// here corrupts CWD tracking. The OSC 7 win32 branch keys off process.platform,
// so it is pinned explicitly and both branches are covered.

const ST = String.fromCharCode(0x1b) + '\\' // string terminator (ESC \)
const BEL = '\x07'

describe('unescapeShellIntegrationValue', () => {
  it('expands \\xNN escapes to their code point', () => {
    expect(unescapeShellIntegrationValue('C:\\x5cproj')).toBe('C:\\proj')
    expect(unescapeShellIntegrationValue('a\\x20b')).toBe('a b')
  })
  it('is case-insensitive on the hex digits', () => {
    expect(unescapeShellIntegrationValue('\\x5C')).toBe('\\')
    expect(unescapeShellIntegrationValue('\\x5c')).toBe('\\')
  })
  it('leaves a value with no escapes untouched', () => {
    expect(unescapeShellIntegrationValue('/home/user')).toBe('/home/user')
  })
})

describe('unterminatedOscTail', () => {
  it('keeps a split OSC sequence and drops completed sequences', () => {
    expect(unterminatedOscTail('text\x1b]633;P;Cwd=C:\\pro')).toBe('\x1b]633;P;Cwd=C:\\pro')
    expect(unterminatedOscTail('text\x1b]633;D\x07prompt')).toBe('')
  })

  it('keeps a trailing ESC that may begin an OSC in the next chunk', () => {
    expect(unterminatedOscTail('text\x1b')).toBe('\x1b')
  })
})

describe('parseShellIntegrationCwd (OSC 633;P;Cwd=)', () => {
  it('extracts an unescaped cwd, BEL terminated', () => {
    expect(parseShellIntegrationCwd(`\x1b]633;P;Cwd=/home/user/proj${BEL}`)).toBe(
      '/home/user/proj'
    )
  })
  it('extracts an ST-terminated sequence', () => {
    expect(parseShellIntegrationCwd(`\x1b]633;P;Cwd=/home/user/proj${ST}`)).toBe(
      '/home/user/proj'
    )
  })
  it('unescapes \\xNN byte sequences in the value', () => {
    // C:\proj encoded as C:\x5cproj
    expect(parseShellIntegrationCwd(`\x1b]633;P;Cwd=C:\\x5cproj${BEL}`)).toBe('C:\\proj')
  })
  it('finds the sequence when embedded in other output', () => {
    const chunk = `some text\r\n\x1b]633;P;Cwd=/work/app${BEL}\r\nprompt> `
    expect(parseShellIntegrationCwd(chunk)).toBe('/work/app')
  })
  it('returns null for non-matching data', () => {
    expect(parseShellIntegrationCwd('no sequence here')).toBeNull()
    expect(parseShellIntegrationCwd('\x1b]633;A' + BEL)).toBeNull()
  })
})

describe('parseOsc7 (OSC 7 file://)', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  describe('posix host', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
    })

    it('extracts the path, BEL terminated', () => {
      expect(parseOsc7(`\x1b]7;file://localhost/home/user/proj${BEL}`)).toBe('/home/user/proj')
    })
    it('extracts an ST-terminated sequence', () => {
      expect(parseOsc7(`\x1b]7;file://localhost/home/user/proj${ST}`)).toBe('/home/user/proj')
    })
    it('returns null for non-matching data', () => {
      expect(parseOsc7('no sequence')).toBeNull()
    })
  })

  describe('win32 host', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
    })

    it('strips the leading slash before the drive letter and converts to backslashes', () => {
      // file:///C:/proj/app → C:\proj\app
      expect(parseOsc7(`\x1b]7;file:///C:/proj/app${BEL}`)).toBe('C:\\proj\\app')
    })
    it('keeps a posix-looking path posix-style only off win32 (covered above)', () => {
      // sanity: under win32 a drive-less path still gets backslashes
      expect(parseOsc7(`\x1b]7;file://host/home/user${BEL}`)).toBe('\\home\\user')
    })
  })
})
