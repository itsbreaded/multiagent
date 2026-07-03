/**
 * Pure parsing helpers for Claude transcript JSONL records.
 *
 * Extracted from `TranscriptScanner.ts` so the record classification
 * (real-user-message detection, content extraction, truncation, project-name
 * derivation) can be tested without touching disk or streaming files. These are
 * the rules that determine firstMessage / lastMessage / messageCount in the
 * session index — a regression here silently corrupts session metadata.
 */

export interface JsonlRecord {
  type?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  timestamp?: string
  isMeta?: boolean
  message?: {
    role?: string
    content?: string | Array<{ type: string; text?: string }>
  }
}

export function parseJsonLine<T>(line: string): T | null {
  try { return JSON.parse(line) as T } catch { return null }
}

/** Parse a single JSONL line; returns null for malformed JSON. */
export function parseRecord(line: string): JsonlRecord | null {
  return parseJsonLine<JsonlRecord>(line)
}

/** Extract the human-readable text from a record's message content (string or text blocks). */
export function extractText(record: JsonlRecord): string | null {
  if (!record.message) return null
  const content = record.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textItem = content.find((c) => c.type === 'text')
    return textItem?.text ?? null
  }
  return null
}

/**
 * A record counts as a "real" user message only if it is a non-meta user turn
 * with extractable text that is not a `<command`/`<local-command` invocation.
 * These exclusions keep synthesized command records out of messageCount and the
 * first/last message summaries.
 */
export function isRealUserMessage(record: JsonlRecord): boolean {
  if (record.type !== 'user') return false
  if (record.isMeta === true) return false
  const text = extractText(record)
  if (!text) return false
  if (text.startsWith('<command') || text.startsWith('<local-command')) return false
  return true
}

/** Truncate to `maxLen` characters (no ellipsis — matches the scanner's behavior). */
export function truncate(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) : text
}

/**
 * Derive a project display name from a cwd: the last two path segments when
 * available, else the last segment, else the raw cwd. Separators are normalized
 * before splitting so backslash and forward-slash paths behave identically.
 */
export function deriveProjectName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[parts.length - 1] ?? cwd
}
