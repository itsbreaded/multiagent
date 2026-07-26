// spec 052: install the managed OpenCode plugin to <userData>/opencode-plugin/plugins/.
//
// OpenCode has no per-process plugin-directory override (only project `.opencode/plugins/`
// and global `~/.config/opencode/plugins/` are scanned — verified against the live docs;
// `OPENCODE_CONFIG_DIR` is not a real OpenCode env var). Instead, SessionSpawner.agentEnv
// injects the installed plugin's absolute file path into the `plugin` array of the same
// process-scoped `OPENCODE_CONFIG_CONTENT` inline JSON used for provider/MCP overrides, so
// it loads without touching ~/.config/opencode/. No managed-hook install into user config,
// no feature flag, no toggle — the plugin loads unconditionally for any OpenCode pane
// MultiAgent spawns (it bails unless MULTIAGENT_ENV is set, so an OpenCode launched outside
// MultiAgent is unaffected even if the file exists).
//
// Idempotent: the bundled asset is only re-copied when its content changes (same pattern as
// ManagedHookController.refreshInstalledScript).

import * as fs from 'fs'
import * as path from 'path'

const PLUGIN_BASENAME = 'multiagent-opencode-plugin.js'

/** Resolve the bundled plugin path: beside out/main, then a couple of dev fallbacks. */
export function resolveOpencodePluginSourcePath(): string {
  const candidates = [
    path.join(__dirname, PLUGIN_BASENAME),
    path.join(__dirname, '..', PLUGIN_BASENAME),
    path.join(process.cwd(), 'src', 'main', 'integration', 'assets', PLUGIN_BASENAME),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* try next */ }
  }
  return candidates[0]
}

/**
 * Copy the bundled plugin into <userData>/opencode-plugin/plugins/multiagent-opencode-plugin.js
 * if the content differs (or the file is missing). Returns the installed plugin's absolute
 * file path (to inject into the `plugin` array of `OPENCODE_CONFIG_CONTENT`), or null if the
 * bundled asset couldn't be read. Safe to call on every startup.
 */
export function installOpencodePlugin(userDataDir: string): string | null {
  const configDir = path.join(userDataDir, 'opencode-plugin')
  const pluginsDir = path.join(configDir, 'plugins')
  const dest = path.join(pluginsDir, PLUGIN_BASENAME)
  try {
    const sourceText = fs.readFileSync(resolveOpencodePluginSourcePath(), 'utf8')
    let existing: string | null = null
    try { existing = fs.readFileSync(dest, 'utf8') } catch { /* not installed yet */ }
    if (existing !== sourceText) {
      fs.mkdirSync(pluginsDir, { recursive: true })
      fs.writeFileSync(dest, sourceText)
    }
    return dest
  } catch (err) {
    // If the bundled asset can't be read (e.g. missing in a dev tree), the plugin simply
    // won't load — OpenCode session linking fails closed (pane promotes but stays unlinked),
    // same failure mode as an untrusted Codex hook.
    console.warn('[MultiAgent] opencode plugin install failed:', err)
    return null
  }
}