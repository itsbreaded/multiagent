/**
 * Pure parsers for the shell-integration CWD reporting escape sequences emitted
 * by `shellIntegration.ps1` (OSC 633;P;Cwd=...) and the conventional OSC 7
 * `file://` sequence used as a compatibility fallback.
 *
 * Extracted from `handlers.ts` so the parsing — including the `\xNN` value
 * unescaping and the win32 backslash/path-prefix normalization — can be tested
 * without importing Electron. These run inline against raw PTY output chunks,
 * so they must stay allocation-light and tolerate partial/missing sequences.
 */

/**
 * Parse an OSC 7 CWD escape sequence from PTY output.
 * Format: ESC ] 7 ; file://[host]/path BEL  (or ST terminator)
 *
 * On win32 the `/C:/...` host-style prefix is stripped and forward slashes are
 * converted to backslashes so the result is a native Windows path. Pin
 * `process.platform` in tests that assert this branch — it is host-dependent.
 */
export function parseOsc7(data: string): string | null {
  const match = data.match(/\x1b\]7;file:\/\/[^\x07\x1b/]*(\/?[^\x07\x1b]*)(?:\x07|\x1b\\)/)
  if (!match || !match[1]) return null
  let cwd = match[1]
  try {
    cwd = decodeURIComponent(cwd)
  } catch {
    /* use raw value */
  }
  if (process.platform === 'win32') {
    if (/^\/[A-Za-z]:/.test(cwd)) cwd = cwd.slice(1) // /C:/... → C:/...
    cwd = cwd.replace(/\//g, '\\')
  }
  return cwd || null
}

/**
 * Parse the VS Code-style OSC 633 `P;Cwd=<value>` prompt property. The value is
 * escaped by `__MultiAgent-Escape-Value` as `\xNN` byte sequences, which are
 * unescaped here. Returns null for any non-matching chunk.
 */
export function parseShellIntegrationCwd(data: string): string | null {
  const match = data.match(/\x1b\]633;P;Cwd=([^\x07\x1b]*)(?:\x07|\x1b\\)/)
  if (!match || !match[1]) return null
  return unescapeShellIntegrationValue(match[1])
}

/**
 * Unescape the `\xNN` byte sequences emitted by the shell-integration prompt
 * helper. Each escape expands to the single character of that code point.
 */
export function unescapeShellIntegrationValue(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => {
    return String.fromCharCode(Number.parseInt(hex, 16))
  })
}
