import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import {
  encodeClaudeProjectDir,
  claudeProjectDirForCwd,
  claudeTranscriptPathForCwd,
} from './claudePaths'

// Claude Code's on-disk transcript layout: cwd is encoded into the projects-
// directory segment by replacing separators and colons with dashes. A regression
// here breaks cwd-repair (the encoded dir would no longer match where Claude
// actually writes), so the encoding rule is the thing to protect.

describe('encodeClaudeProjectDir', () => {
  it('replaces backslashes, forward slashes, and colons with dashes', () => {
    expect(encodeClaudeProjectDir('C:\\Users\\me\\proj')).toBe('C--Users-me-proj')
  })
  it('handles posix-style paths', () => {
    expect(encodeClaudeProjectDir('/home/user/proj')).toBe('-home-user-proj')
  })
  it('handles mixed separators', () => {
    expect(encodeClaudeProjectDir('C:/Users\\me')).toBe('C--Users-me')
  })
  it('leaves a path with no separators/colons untouched', () => {
    expect(encodeClaudeProjectDir('proj')).toBe('proj')
  })
})

describe('claudeProjectDirForCwd', () => {
  it('joins the encoded segment under ~/.claude/projects', () => {
    const expected = path.join(os.homedir(), '.claude', 'projects', 'C--Users-me-proj')
    expect(claudeProjectDirForCwd('C:\\Users\\me\\proj')).toBe(expected)
  })
})

describe('claudeTranscriptPathForCwd', () => {
  it('appends <sessionId>.jsonl inside the encoded project dir', () => {
    const dir = claudeProjectDirForCwd('C:\\proj')
    expect(claudeTranscriptPathForCwd('abc-123', 'C:\\proj')).toBe(path.join(dir, 'abc-123.jsonl'))
  })
})
