// Cwd-repair path mapping — the prefix-aware, segment-boundary rewrite used to
// repair stored layouts/sessions when a project directory moves or is copied.
//
// This is the app-wide semantics (string-based, platform-agnostic): it handles
// `\`-style, `/`-style, and mixed `[\\/]+` paths plus drive prefixes (C:)
// regardless of host OS. It is the correct semantics for stored paths that may
// have been written on a different OS than the one reading them.
//
// The former host-bound main-process behavior is preserved as a golden master
// in src/main/ipc/cwdRepairLegacy.test.ts. Main and renderer now share this
// implementation so persisted paths are repaired consistently.

import type { CwdRepairMapping } from './types'

export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.includes('\\')
}

export function repairSeparator(value: string): '\\' | '/' {
  return isWindowsPath(value) ? '\\' : '/'
}

export function normalizeRepairPath(value: string): string {
  const windows = isWindowsPath(value)
  const sep = windows ? '\\' : '/'
  const normalized = value.replace(/[\\/]+/g, sep)
  const prefix = windows && /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 2) : normalized.startsWith(sep) ? sep : ''
  const rest = prefix ? normalized.slice(prefix.length) : normalized
  const parts: string[] = []
  for (const part of rest.split(sep)) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop()
    } else if (part !== '..' || !prefix) {
      parts.push(part)
    }
  }
  const joined = parts.join(sep)
  if (prefix === sep) return `${sep}${joined}`
  return joined ? `${prefix}${prefix && prefix !== sep ? sep : ''}${joined}` : prefix || '.'
}

export function comparableRepairPath(value: string): string {
  return isWindowsPath(value) ? value.toLowerCase() : value
}

export function joinRepairPath(root: string, suffix: string): string {
  const sep = repairSeparator(root)
  let cleanSuffix = suffix.replace(/[\\/]+/g, sep)
  while (cleanSuffix.startsWith(sep)) cleanSuffix = cleanSuffix.slice(1)
  if (!cleanSuffix) return root
  return root.endsWith(sep) ? `${root}${cleanSuffix}` : `${root}${sep}${cleanSuffix}`
}

/**
 * Rewrite `value` if it is the old cwd or nested under it, mapping onto newCwd.
 * A segment boundary is enforced: the old root only matches the whole path or a
 * child path — never a sibling that merely shares a prefix (e.g. C:\\proj must
 * not match C:\\project-other).
 */
export function replaceCwdPrefix(value: string, mapping: CwdRepairMapping): string {
  const oldRoot = normalizeRepairPath(mapping.oldCwd)
  const newRoot = normalizeRepairPath(mapping.newCwd)
  const candidate = normalizeRepairPath(value)
  const oldKey = comparableRepairPath(oldRoot)
  const candidateKey = comparableRepairPath(candidate)
  if (candidateKey === oldKey) return newRoot

  const sep = repairSeparator(oldRoot)
  const oldPrefix = oldKey.endsWith(sep) ? oldKey : `${oldKey}${sep}`
  if (!candidateKey.startsWith(oldPrefix)) return value
  const suffix = candidate.slice(oldRoot.length)
  return joinRepairPath(newRoot, suffix)
}
