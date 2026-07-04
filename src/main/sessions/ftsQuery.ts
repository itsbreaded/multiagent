/**
 * Pure helpers for `SessionIndex.search()` — extracted (spec 036, item 7) so
 * the FTS5 query escaping and the LIKE-fallback tokenization can be unit-tested
 * under plain Node without loading `better-sqlite3` (Electron-ABI only).
 *
 * Summary search is **strictly literal**: raw user input is tokenized on
 * whitespace and each token is wrapped as a double-quoted FTS5 string literal
 * (with internal quotes doubled), joined with implicit AND. FTS5 operators
 * (`OR`, `NEAR`, column filters like `C:`, `*` prefixes, parens) lose their
 * meta-meaning inside a quoted string, so user-typed Windows paths and stray
 * punctuation no longer throw `SqliteError` from the MATCH expression.
 *
 * Doubling `"` inside a double-quoted FTS5 string is the documented FTS5 escape.
 */

/** Split raw user input into literal search tokens (whitespace-separated). */
export function splitFtsTokens(query: string): string[] {
  return query.split(/\s+/).filter(Boolean)
}

/**
 * Convert raw user input into a safe FTS5 MATCH expression: each whitespace-
 * separated token wrapped as a double-quoted FTS5 string literal with internal
 * quotes doubled, joined with implicit AND. Returns `null` when no tokens
 * remain (caller should fall back to "return all rows").
 */
export function toFtsMatchExpression(query: string): string | null {
  const tokens = splitFtsTokens(query)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

/**
 * Escape a single token for a SQL `LIKE ? ESCAPE '\'` bound value: wrap in
 * `%…%` and escape the LIKE metacharacters `%`, `_`, and the escape char `\`.
 */
export function toLikeSubstringPattern(token: string): string {
  const escaped = token.replace(/[\\%_]/g, (m) => `\\${m}`)
  return `%${escaped}%`
}
