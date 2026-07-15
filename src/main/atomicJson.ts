import * as fs from 'fs'

/**
 * Atomically write `value` to `filePath` as JSON.
 *
 * Writes to a temp file in the same directory (so the rename is a same-volume
 * atomic replace that works over an existing file on Windows), then renames it
 * over the target. A crash or interruption at any point leaves either the
 * previous complete file or the new complete file — never a truncated one.
 *
 * `space`, when given, is forwarded to `JSON.stringify(value, null, space)` so
 * callers that pretty-print (e.g. agent-provider settings) keep their format.
 *
 * This module imports only `fs` — never `electron` — so it stays unit-testable
 * under the node-env Vitest project.
 */
export function writeJsonAtomic(filePath: string, value: unknown, space?: number): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, space))
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    // Best-effort cleanup so a failed write (e.g. unserializable value, or a
    // rename blocked by an indexer) does not leave a `*.tmp.*` litter behind.
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {
      // ignore — the original error is what matters
    }
    throw err
  }
}

/**
 * Atomically write raw `text` to `filePath`. Same temp-file + rename discipline as
 * `writeJsonAtomic`, for non-JSON files (e.g. the Codex `~/.codex/config.toml` the
 * managed-hook feature touches). `.bak` handling stays with the caller.
 */
export function writeTextAtomic(filePath: string, text: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tmpPath, text)
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw err
  }
}
