# MultiAgent agent lifecycle hook (spec 047 session linking + spec 032 status badges).
#
# Installed (default-on, reversible from the Settings -> Terminal toggle) as multiple hook
# entries in BOTH ~/.claude/settings.json and ~/.codex/hooks.json. Each entry's command is:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<path>" <agentKind> [<event>]
# where <agentKind> is "claude" or "codex" and <event> is one of:
#   session_start | user_prompt_submit | pre_tool_use | post_tool_use |
#   stop | permission_request | stop_failure | idle_prompt | bg_subagent_completed
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
  if ($raw) { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } else { $payload = $null }
} catch {
  $payload = $null
}

function Post-Event {
  param([string]$EventName, [string]$Detail, [string]$TurnId, [string]$AgentId, [string]$SessionId, [object]$Evidence)
  $body = [ordered]@{ ptyId = $ptyId; agentKind = $agentKind; event = $EventName }
  if ($Detail) { $body['detail'] = $Detail }
  if ($TurnId) { $body['turnId'] = $TurnId }
  if ($AgentId) { $body['agentId'] = $AgentId }
  if ($SessionId) { $body['sessionId'] = $SessionId }
  if ($null -ne $Evidence) { $body['evidence'] = $Evidence }
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

function Get-ClaudeStopTerminalState {
  # Stop can be invoked while a stop hook is continuing the turn. Only an explicit
  # boolean false means the foreground turn completed; missing or drifted fields stay
  # busy so the reducer cannot fabricate idle from an ambiguous Stop payload.
  if (-not $payload) { return 'busy' }
  $property = $payload.PSObject.Properties['stop_hook_active']
  if ($null -eq $property -or $property.Value -isnot [bool]) { return 'busy' }
  if ($property.Value) { return 'busy' }
  return 'completed'
}

function Get-SessionId {
  if ($payload) { return $payload.session_id }
  return $null
}

function Test-ClaudeBackgroundTaskActive {
  param([object]$Item)
  $statusProperty = $Item.PSObject.Properties['status']
  # Older Claude payloads did not include status. Keep those rows active so a
  # schema downgrade cannot make a live task look idle. Only an explicit
  # terminal status releases the protection.
  if ($null -eq $statusProperty -or $statusProperty.Value -isnot [string]) { return $true }
  $status = $statusProperty.Value.Trim().ToLowerInvariant()
  return @('completed', 'failed', 'killed', 'stopped', 'canceled', 'cancelled', 'done', 'success', 'idle') -notcontains $status
}

function New-ClaudeSnapshot {
  param([string]$TerminalState)
  if (-not $payload) { return [pscustomobject]@{ provider = 'claude'; completeness = 'incomplete'; terminalState = $TerminalState; activeCount = 0; scheduledCount = 0 } }
  $complete = $true
  $active = @()
  $scheduled = @()
  foreach ($name in @('background_tasks', 'session_crons')) {
    $property = $payload.PSObject.Properties[$name]
    if ($null -eq $property -or $null -eq $property.Value) { $complete = $false; continue }
    $value = @($property.Value)
    if ($value.Count -gt 64) { $complete = $false; continue }
    foreach ($item in $value) {
      if ($null -eq $item -or $item -is [string] -or $item -is [ValueType]) { $complete = $false; continue }
      if ($name -eq 'background_tasks') {
        if (Test-ClaudeBackgroundTaskActive $item) { $active += $item }
      } else { $scheduled += $item }
    }
  }
  $result = [ordered]@{
    provider = 'claude'
    completeness = $(if ($complete) { 'complete' } else { 'incomplete' })
    terminalState = $TerminalState
    # Incomplete coverage is still suspension-protective, but a missing or
    # malformed category is not proof that work exists. Preserve only the
    # positively observed items so idle_prompt can recover the visible
    # foreground badge when no known work remains.
    activeCount = $active.Count
    scheduledCount = $scheduled.Count
  }
  $snapshotSessionId = Get-SessionId
  $snapshotTurnId = Get-TurnId
  if ($snapshotSessionId) { $result['sessionId'] = $snapshotSessionId }
  if ($snapshotTurnId) { $result['turnId'] = $snapshotTurnId }
  if ($complete) {
    $activeIds = @($active | ForEach-Object { if ($_.id) { $_.id } else { $_.task_id } } | Where-Object { $_ -is [string] -and $_.Length -le 256 })
    $scheduledIds = @($scheduled | ForEach-Object { $_.id } | Where-Object { $_ -is [string] -and $_.Length -le 256 })
    if ($activeIds.Count -eq $active.Count -and $activeIds.Count -gt 0) { $result['activeIds'] = $activeIds }
    if ($scheduledIds.Count -eq $scheduled.Count -and $scheduledIds.Count -gt 0) { $result['scheduledIds'] = $scheduledIds }
  }
  return [pscustomobject]$result
}

function Get-AgentId {
  if (-not $payload) { return $null }
  if ($event -eq 'bg_subagent_completed') { return $payload.agent_id }
  if ($payload.tool_response) { return $payload.tool_response.agentId }
  return $null
}

switch ($event) {
  'session_start' {
    $sid = $payload.session_id
    # Always seed the badge (working). The session-id linking report is skipped for
    # app-launched Claude (MULTIAGENT_SESSION_ID set) -- it already has its id.
    Post-Event -EventName 'session_start' -SessionId $sid
    if (-not $env:MULTIAGENT_SESSION_ID -and $sid) {
      Post-Session -SessionId $sid -TranscriptPath $payload.transcript_path
    }
  }
  'user_prompt_submit' {
    Post-Event -EventName 'user_prompt_submit' -TurnId (Get-TurnId) -SessionId (Get-SessionId)
  }
  'pre_tool_use' {
    Post-Event -EventName 'pre_tool_use' -Detail $payload.tool_name -TurnId (Get-TurnId) -SessionId (Get-SessionId)
  }
  'post_tool_use' {
    $isAgentTool = $payload.tool_name -eq 'Agent' -or $payload.tool_name -eq 'Task'
    $isBackground = $false
    if ($isAgentTool) {
      $isBackground = $payload.tool_response.status -eq 'async_launched' -or $payload.tool_input.run_in_background -eq $true
    }
    if ($isBackground) {
      $detail = $payload.tool_name
      if (-not $detail) { $detail = 'background subagent' }
      Post-Event -EventName 'bg_subagent_started' -Detail $detail -TurnId (Get-TurnId) -AgentId (Get-AgentId) -SessionId (Get-SessionId)
    } else {
      Post-Event -EventName 'post_tool_use' -Detail $payload.tool_name -TurnId (Get-TurnId) -SessionId (Get-SessionId)
    }
  }
  'bg_subagent_completed' {
    $evidence = if ($agentKind -eq 'claude') { New-ClaudeSnapshot -TerminalState 'completed' } else { $null }
    Post-Event -EventName 'bg_subagent_completed' -TurnId (Get-TurnId) -AgentId (Get-AgentId) -SessionId (Get-SessionId) -Evidence $evidence
  }
  'stop' {
    $terminalState = if ($agentKind -eq 'claude') { Get-ClaudeStopTerminalState } else { 'completed' }
    $evidence = if ($agentKind -eq 'claude') { New-ClaudeSnapshot -TerminalState $terminalState } else { $null }
    Post-Event -EventName 'stop' -TurnId (Get-TurnId) -SessionId (Get-SessionId) -Evidence $evidence
  }
  'idle_prompt' {
    $sid = Get-SessionId
    if ($payload.notification_type -eq 'idle_prompt' -and $sid) {
      Post-Event -EventName 'idle_prompt' -TurnId (Get-TurnId) -SessionId $sid
    }
  }
  'permission_request' {
    # Claude Notification(permission_prompt) carries `message`; Codex PermissionRequest
    # carries `tool_name`. Prefer the notification message, fall back to the tool name.
    $detail = $payload.message
    if (-not $detail) { $detail = $payload.tool_name }
    Post-Event -EventName 'permission_request' -Detail $detail -TurnId (Get-TurnId) -SessionId (Get-SessionId)
  }
  'stop_failure' {
    # Claude only. Prefer the current hook fields, with legacy fields as a compatibility
    # fallback. Keep the report bounded even when the provider supplies verbose details.
    $detail = $payload.error
    if (-not $detail) { $detail = $payload.error_details }
    if (-not $detail) { $detail = $payload.error_type }
    if (-not $detail) { $detail = $payload.message }
    if ($detail -isnot [string]) { $detail = $null }
    if ($detail -and $detail.Length -gt 256) { $detail = $detail.Substring(0, 256) }
    Post-Event -EventName 'stop_failure' -Detail $detail -TurnId (Get-TurnId) -SessionId (Get-SessionId)
  }
  default {
    # Unknown event arg: no-op. Never blocks.
  }
}
exit 0
