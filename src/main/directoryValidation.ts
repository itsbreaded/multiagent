import * as fs from 'fs'
import * as path from 'path'

export type DirectoryValidationResult =
  | { ok: true; directory: string }
  | { ok: false; error: string }

type DirectoryValidationDeps = {
  isAbsolute: (directory: string) => boolean
  resolve: (directory: string) => string
  stat: (directory: string) => { isDirectory(): boolean }
}

const defaultDeps: DirectoryValidationDeps = {
  isAbsolute: path.isAbsolute,
  resolve: path.resolve,
  stat: fs.statSync,
}

export function cleanDirectoryInput(input: unknown): string {
  if (typeof input !== 'string') return ''
  let cleaned = input.trim()
  if (
    cleaned.length >= 2 &&
    ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  return cleaned
}

export function validateDirectoryInput(
  input: unknown,
  deps: DirectoryValidationDeps = defaultDeps,
): DirectoryValidationResult {
  const cleaned = cleanDirectoryInput(input)
  if (!cleaned) return { ok: false, error: 'Enter a directory path' }
  if (!deps.isAbsolute(cleaned)) return { ok: false, error: 'Enter an absolute directory path' }

  try {
    if (!deps.stat(cleaned).isDirectory()) {
      return { ok: false, error: 'The selected path is not a directory' }
    }
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, error: 'The selected directory does not exist' }
    }
    return { ok: false, error: 'The selected directory could not be read' }
  }

  return { ok: true, directory: deps.resolve(cleaned) }
}
