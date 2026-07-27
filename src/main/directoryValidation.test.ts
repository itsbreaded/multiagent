import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { cleanDirectoryInput, validateDirectoryInput } from './directoryValidation'

const directory = { isDirectory: () => true }
const file = { isDirectory: () => false }

describe('cleanDirectoryInput', () => {
  it('trims whitespace and one matching pair of surrounding quotes', () => {
    expect(cleanDirectoryInput('  "C:\\Code\\multiagent"  ')).toBe('C:\\Code\\multiagent')
    expect(cleanDirectoryInput("  '/workspace/app'  ")).toBe('/workspace/app')
  })

  it('preserves unmatched quotes', () => {
    expect(cleanDirectoryInput('"C:\\Code\\multiagent')).toBe('"C:\\Code\\multiagent')
  })
})

describe('validateDirectoryInput', () => {
  const deps = (stat: (directory: string) => { isDirectory(): boolean }) => ({
    isAbsolute: (value: string) => value.startsWith('C:\\'),
    resolve: (value: string) => `resolved:${value}`,
    stat,
  })

  it('returns a cleaned, resolved directory', () => {
    expect(validateDirectoryInput('  "C:\\Code\\multiagent"  ', deps(() => directory))).toEqual({
      ok: true,
      directory: 'resolved:C:\\Code\\multiagent',
    })
  })

  it.each([
    ['empty input', '   ', 'Enter a directory path'],
    ['empty quoted input', ' "" ', 'Enter a directory path'],
    ['relative input', 'project', 'Enter an absolute directory path'],
  ])('rejects %s', (_label, input, error) => {
    expect(validateDirectoryInput(input, deps(() => directory))).toEqual({ ok: false, error })
  })

  it('rejects a file path', () => {
    expect(validateDirectoryInput('C:\\Code\\file.txt', deps(() => file))).toEqual({
      ok: false,
      error: 'The selected path is not a directory',
    })
  })

  it('distinguishes a missing directory from an unreadable one', () => {
    expect(validateDirectoryInput('C:\\missing', deps(() => { throw { code: 'ENOENT' } }))).toEqual({
      ok: false,
      error: 'The selected directory does not exist',
    })
    expect(validateDirectoryInput('C:\\denied', deps(() => { throw { code: 'EACCES' } }))).toEqual({
      ok: false,
      error: 'The selected directory could not be read',
    })
  })

  it('inspects real filesystem paths with the privileged defaults', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-directory-validation-'))
    const filePath = path.join(root, 'file.txt')
    fs.writeFileSync(filePath, '')
    try {
      expect(validateDirectoryInput(`  "${root}"  `)).toEqual({ ok: true, directory: path.resolve(root) })
      expect(validateDirectoryInput(filePath)).toEqual({ ok: false, error: 'The selected path is not a directory' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
