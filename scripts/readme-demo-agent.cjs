const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

// Used only by capture-readme-screenshots.mjs. The app still creates a real
// agent pane; this process selects the matching installed CLI while keeping
// the temporary capture profile free of user credentials and session data.
// The app's E2E hook replaces (rather than appends to) its normal command.
// Claude is identifiable by its app-generated session id; OpenCode receives
// its process-scoped inline config; the remaining launch is Codex.
if (process.env.MULTIAGENT_SESSION_ID) {
  spawn('claude', [], { stdio: 'inherit', env: process.env })
    .on('exit', (code) => process.exit(code ?? 0))
} else {
  const binary = process.env.OPENCODE_CONFIG_CONTENT ? 'opencode' : 'codex'
  const npmBin = (process.env.PATH || '').split(';').find((directory) =>
    existsSync(join(directory, `${binary}.cmd`)),
  )
  if (!npmBin) throw new Error(`Could not locate the installed ${binary} CLI`)
  const command = binary === 'codex'
    ? [process.execPath, [
      join(npmBin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      '--no-alt-screen',
      '-c', 'tui.animations=false',
      '-c', 'tui.terminal_title=[]',
    ]]
    : [join(npmBin, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), ['--auto']]
  const env = { ...process.env }
  // USERPROFILE is already the isolated capture home. Let Codex derive its
  // default there instead of emitting its safeguard warning about CODEX_HOME.
  delete env.CODEX_HOME
  spawn(command[0], command[1], {
    stdio: 'inherit',
    env,
  })
    .on('exit', (code) => process.exit(code ?? 0))
}
