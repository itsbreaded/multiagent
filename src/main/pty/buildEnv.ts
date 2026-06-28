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
  extraVars?: Record<string, string>,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>

  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']
  delete env['CLAUDECODE']
  delete env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']
  delete env['CLAUDE_CODE_DISABLE_MOUSE']
  delete env['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL']
  delete env['CLAUDE_CODE_NO_FLICKER']

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

  if (extraVars) Object.assign(env, extraVars)

  // Remove empty-string API key: agentEnv sets it to '' when routing to an
  // alternative provider so the native key does not shadow the provider token.
  if (env['ANTHROPIC_API_KEY'] === '') delete env['ANTHROPIC_API_KEY']

  return env
}
