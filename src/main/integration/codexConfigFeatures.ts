/**
 * codexConfigFeatures — pure, line-based TOML surgery on `~/.codex/config.toml` to ensure
 * the Codex hooks system is enabled (`[features] hooks = true`), for spec 047 phase 4.
 *
 * Codex reads hooks from `~/.codex/hooks.json` (same JSON shape as Claude settings.json,
 * handled by managedHooks.ts) but ALSO requires `[features] hooks = true` in
 * `~/.codex/config.toml` before it runs any hook at all. herdr's Rust `build_codex_config
 * _with_hooks` does the same; this is our idiomatic reimplementation (no vendoring).
 *
 * Operates on the raw file text so the idempotence / unrelated-key-preservation
 * invariants can be unit-tested without IO. A thin IO wrapper (managedHookController.ts)
 * reads/writes the file with a timestamped `.bak` and atomic replace.
 *
 * On uninstall we LEAVE `[features] hooks = true` in place (matches herdr; harmless once
 * the managed hook entry is gone from hooks.json) — so this module only ever *ensures*.
 */

const FEATURES_HEADER_RE = /^\s*\[features\]\s*$/
const TABLE_HEADER_RE = /^\s*\[[^\]]+\]\s*$/
const HOOKS_KEY_RE = /^(\s*hooks\s*=\s*)(.*)$/

/** True if the text currently has `[features]` with `hooks = true`. */
export function codexHooksFeatureEnabled(text: string): boolean {
  const lines = text.split(/\r?\n/)
  let inFeatures = false
  for (const line of lines) {
    if (TABLE_HEADER_RE.test(line)) {
      inFeatures = FEATURES_HEADER_RE.test(line)
      continue
    }
    if (!inFeatures) continue
    const m = line.match(HOOKS_KEY_RE)
    if (m) return m[2].trim() === 'true'
  }
  return false
}

/**
 * Ensure `[features] hooks = true` is present, preserving every unrelated line and the
 * original newline style. Returns text with the change applied. Idempotent: a no-op when
 * already enabled.
 *
 * - Existing `[features]` with `hooks` → set its value to `true`.
 * - Existing `[features]` without `hooks` → add `hooks = true` as the last key in the
 *   section (immediately before the next table header or EOF).
 * - No `[features]` section → append one.
 */
export function ensureCodexHooksFeatureEnabled(text: string): string {
  if (codexHooksFeatureEnabled(text)) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  let featuresIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (FEATURES_HEADER_RE.test(lines[i])) { featuresIdx = i; break }
  }

  if (featuresIdx === -1) {
    // No [features] section: append one. Preserve a trailing newline if the file had one.
    const hadTrailingNewline = text.length > 0 && /\r?\n$/.test(text)
    const section = hadTrailingNewline
      ? `[features]${eol}hooks = true${eol}`
      : `${eol}[features]${eol}hooks = true${eol}`
    return text + section
  }

  // Find the body of the [features] section: lines until the next table header or EOF.
  let bodyEnd = lines.length
  for (let i = featuresIdx + 1; i < lines.length; i++) {
    if (TABLE_HEADER_RE.test(lines[i])) { bodyEnd = i; break }
  }

  // If a `hooks` key exists in the body, set it to true (it is currently false/other).
  for (let i = featuresIdx + 1; i < bodyEnd; i++) {
    const m = lines[i].match(HOOKS_KEY_RE)
    if (m) { lines[i] = `${m[1]}true`; return lines.join(eol) }
  }

  // No `hooks` key: insert `hooks = true` as the last key of the section.
  lines.splice(bodyEnd, 0, 'hooks = true')
  return lines.join(eol)
}
