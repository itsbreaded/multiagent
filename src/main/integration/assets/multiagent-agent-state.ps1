# MultiAgent CLI session-linking hook (spec 047 phase 3 / phase 4).
#
# Installed (default-on, reversible) as a SessionStart hook in BOTH
# ~/.claude/settings.json and ~/.codex/hooks.json. Reports the agent session id +
# transcript path back to the MultiAgent main process over a localhost loopback endpoint,
# so a launched (or CLI-launched, promoted) pane can link the running session — including
# across an in-pane resume/fork — and resumes it on restart. Self-contained: no
# Python/Node/CLI prerequisite (the app is a per-user Windows installer). Bails silently
# unless MultiAgent injected its env vars, so it is a no-op for any agent session launched
# outside the app.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<path>" <agentKind>
# where <agentKind> is "claude" or "codex". The kind is echoed back in the report body so
# the report server can emit a correctly-typed `session:detected`.
#
# Codex note: the interactive TUI defers SessionStart until the first user message creates
# the rollout (that is the earliest moment a session_id exists), so a Codex pane links on
# its first message — not at cold launch. Claude links at launch.
#
# Never blocks the agent's session start: every failure path exits 0 silently.

$ErrorActionPreference = 'SilentlyContinue'

# App-launched Claude panes already carry their --session-id (known at spawn). The renderer
# gets it immediately; a redundant hook report adds nothing, so bail. (App-launched Codex
# does NOT set this — it relies on the hook for its id under phase 4.)
if ($env:MULTIAGENT_SESSION_ID) { exit 0 }

if ($env:MULTIAGENT_ENV -ne '1') { exit 0 }
$ptyId = $env:MULTIAGENT_PTY_ID
$port = $env:MULTIAGENT_HOOK_PORT
if (-not $ptyId -or -not $port) { exit 0 }

# Agent kind is passed as the first positional arg by the hook command. Fall back to
# 'claude' only if somehow absent (older installs); the report server still validates.
$agentKind = $args[0]
if (-not $agentKind) { $agentKind = 'claude' }

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { exit 0 }
  $payload = $raw | ConvertFrom-Json
  $sessionId = $payload.session_id
  $transcriptPath = $payload.transcript_path
  if (-not $sessionId) { exit 0 }
  $body = @{ ptyId = $ptyId; agentKind = $agentKind; sessionId = $sessionId; transcriptPath = $transcriptPath } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/agent-session" -f $port) -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 2 | Out-Null
} catch {
  # A report failure must never interrupt the agent's session start.
}
exit 0