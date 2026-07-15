/**
 * buildEnv — the env-var profile for a terminal/agent PTY.
 *
 * Extracted verbatim from PtyManager.ts so it can be unit-tested in isolation
 * (PtyManager.ts imports child_process/node-pty at module load). This is a pure
 * function over process.env — no Electron or native coupling.
 *
 * Two CLAUDE.md invariants live here and are protected by buildEnv.test.ts:
 *   1. PATH is passed through UNMODIFIED (the spec 012/013 root cause — a PATH
 *      prepend reordered git's startup into ConPTY's no-scroll flush race and
 *      dropped short output like "Already up to date.").
 *   2. Inherited Claude renderer flags are scrubbed so app-spawned Claude
 *      sessions don't lose input after /tui fullscreen.
 */
export function buildEnv(
  extraVars?: Record<string, string | undefined>,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>

  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']
  delete env['CLAUDECODE']
  delete env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']
  delete env['CLAUDE_CODE_DISABLE_MOUSE']
  delete env['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL']
  delete env['CLAUDE_CODE_NO_FLICKER']
  // MultiAgent pane-identity vars (spec 047 phase 3 / phase 4) are set per-pane via
  // extraVars when the session-linking feature is on. Scrub inherited copies so a nested
  // MultiAgent (launched from inside one of our panes) never reuses the outer pane's id or
  // session id (the latter would make an app-Claude hook bail on the wrong id).
  delete env['MULTIAGENT_PTY_ID']
  delete env['MULTIAGENT_ENV']
  delete env['MULTIAGENT_HOOK_PORT']
  delete env['MULTIAGENT_SESSION_ID']

  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'

  // Claude Code keys its embedded-terminal rendering path on TERM_PROGRAM=vscode,
  // and the shell integration script gates on it too, so both profiles set it.
  env['TERM_PROGRAM'] = 'vscode'

  // Agent-specific CLI environment belongs in SessionSpawner.agentEnv(), where
  // the concrete agent kind is known. Keep this profile terminal-like; VS Code
  // and Warp do not set Claude-only renderer flags for a normal PTY session.

  // NOTE: we deliberately do NOT rewrite PATH. An earlier version prepended
  // %APPDATA%\npm, %ProgramFiles%\nodejs, and ~/.local/bin to PATH for agents.
  // Those dirs are already on the inherited PATH (agents launch and shells run
  // fine without the prepend), so it only *reordered* PATH — which shifted git's
  // startup timing into ConPTY's no-scroll flush race and dropped short output
  // like `git pull -> Already up to date.`. This was the real root cause of the
  // whole "no-scroll drop" investigation (see spec 013); do not reintroduce it.

  // Undefined values explicitly remove inherited variables. Agent provider
  // profiles use this to prevent disabled credentials from reaching the PTY.
  for (const [key, value] of Object.entries(extraVars ?? {})) {
    // Windows treats environment names case-insensitively. Remove every casing
    // before deleting or assigning so `Anthropic_Api_Key` cannot bypass a scrub
    // (and assignments cannot create ambiguous duplicate names).
    const matchingKeys = process.platform === 'win32'
      ? Object.keys(env).filter((existing) => existing.toLowerCase() === key.toLowerCase())
      : [key]
    for (const matchingKey of matchingKeys) delete env[matchingKey]
    if (value !== undefined) env[key] = value
  }

  return env
}
