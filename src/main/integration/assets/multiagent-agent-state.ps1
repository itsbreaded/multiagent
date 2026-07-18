# MultiAgent agent lifecycle hook (spec 047 session linking + spec 032 status badges).
#
# Installed (default-on, reversible from the Settings -> Terminal toggle) as multiple hook
# entries in BOTH ~/.claude/settings.json and ~/.codex/hooks.json. Each entry's command is:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<path>" <agentKind> [<event>]
# where <agentKind> is "claude" or "codex" and <event> is one of:
#   session_start | user_prompt_submit | pre_tool_use | post_tool_use |
#   stop | permission_request | stop_failure
# An absent <event> (legacy 047 SessionStart install) is treated as session_start for
# back-compat -- it still seeds the badge AND posts the linking report.
#
# Reports lifecycle events to POST /agent-event (status badges). For session_start only,
# AND only when MULTIAGENT_SESSION_ID is unset, it ALSO posts the 047 linking report to
# /agent-session (app-launched Claude already knows its id, so the linking report is
# skipped for it, but the badge seed is NOT -- app-launched Claude badges too).
#
# Codex note: the interactive TUI defers SessionStart until the first user message creates
# the rollout (the earliest moment a session_id exists), so a Codex pane links + badges on
# its first message -- not at cold launch. Claude links + badges at launch.
#
# Never blocks the agent: every failure path exits 0 silently. Field reading is defensive
# (a missing/wrong JSON field => a lost detail/turnId, never a thrown error).

$ErrorActionPreference = 'SilentlyContinue'

# No-op for any agent session launched outside MultiAgent.
if ($env:MULTIAGENT_ENV -ne '1') { exit 0 }
$ptyId = $env:MULTIAGENT_PTY_ID
$port = $env:MULTIAGENT_HOOK_PORT
if (-not $ptyId -or -not $port) { exit 0 }

# Agent kind is passed as the first positional arg by the hook command. Fall back to
# 'claude' only if somehow absent (older installs); the report server still validates.
$agentKind = $args[0]
if (-not $agentKind) { $agentKind = 'claude' }

# Event name is the second positional arg. Absent => legacy SessionStart install.
$event = $args[1]
if (-not $event) { $event = 'session_start' }

try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw) { $payload = $raw | ConvertFrom-Json } else { $payload = $null }
} catch {
  $payload = $null
}

function Post-Event {
  param([string]$EventName, [string]$Detail, [string]$TurnId)
  $body = [ordered]@{ ptyId = $ptyId; agentKind = $agentKind; event = $EventName }
  if ($Detail) { $body['detail'] = $Detail }
  if ($TurnId) { $body['turnId'] = $TurnId }
  try {
    $json = $body | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/agent-event" -f $port) -Method POST -Body $json -ContentType 'application/json' -TimeoutSec 2 | Out-Null
  } catch { }
}

function Post-Session {
  param([string]$SessionId, [string]$TranscriptPath)
  try {
    $body = [ordered]@{ ptyId = $ptyId; agentKind = $agentKind; sessionId = $SessionId; transcriptPath = $TranscriptPath } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/agent-session" -f $port) -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 2 | Out-Null
  } catch { }
}

# Turn identity: Claude carries prompt_id (UUID, v2.1.196+); Codex carries turn_id. Read
# defensively -- absent on older Claude / some events; the reducer tolerates undefined.
function Get-TurnId {
  if ($payload) {
    if ($agentKind -eq 'codex') { return $payload.turn_id }
    return $payload.prompt_id
  }
  return $null
}

switch ($event) {
  'session_start' {
    $sid = $payload.session_id
    # Always seed the badge (working). The session-id linking report is skipped for
    # app-launched Claude (MULTIAGENT_SESSION_ID set) -- it already has its id.
    Post-Event -EventName 'session_start' -TurnId $sid
    if (-not $env:MULTIAGENT_SESSION_ID -and $sid) {
      Post-Session -SessionId $sid -TranscriptPath $payload.transcript_path
    }
  }
  'user_prompt_submit' {
    Post-Event -EventName 'user_prompt_submit' -TurnId (Get-TurnId)
  }
  'pre_tool_use' {
    Post-Event -EventName 'pre_tool_use' -Detail $payload.tool_name -TurnId (Get-TurnId)
  }
  'post_tool_use' {
    Post-Event -EventName 'post_tool_use' -Detail $payload.tool_name -TurnId (Get-TurnId)
  }
  'stop' {
    Post-Event -EventName 'stop' -TurnId (Get-TurnId)
  }
  'permission_request' {
    # Claude Notification(permission_prompt) carries `message`; Codex PermissionRequest
    # carries `tool_name`. Prefer the notification message, fall back to the tool name.
    $detail = $payload.message
    if (-not $detail) { $detail = $payload.tool_name }
    Post-Event -EventName 'permission_request' -Detail $detail -TurnId (Get-TurnId)
  }
  'stop_failure' {
    # Claude only. The payload may carry an error type/message; send whatever is present.
    $detail = $payload.error_type
    if (-not $detail) { $detail = $payload.message }
    Post-Event -EventName 'stop_failure' -Detail $detail -TurnId (Get-TurnId)
  }
  default {
    # Unknown event arg: no-op. Never blocks.
  }
}
exit 0