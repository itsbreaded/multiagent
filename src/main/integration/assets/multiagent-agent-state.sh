#!/usr/bin/env bash
# MultiAgent agent lifecycle hook (spec 047 session linking + spec 032 status badges) --
# Unix port. The bash equivalent of multiagent-agent-state.ps1, installed as the hook
# command on Linux/macOS (Windows uses the .ps1).
#
# Usage: bash "<path>" <agentKind> [<event>]
#   <agentKind> = "claude" | "codex"
#   <event>     = session_start | user_prompt_submit | pre_tool_use | post_tool_use |
#                 stop | permission_request | stop_failure
# An absent <event> (legacy 047 SessionStart install) is treated as session_start.
#
# Reports lifecycle events to POST /agent-event (status badges) and, for session_start
# only when MULTIAGENT_SESSION_ID is unset, the 047 linking report to /agent-session.
# Codex defers SessionStart until the first user message; Claude links + badges at launch.
#
# Self-contained: bash + curl only (no Python/Node/jq). JSON parsing is sed-based and
# defensive -- a missing/wrong field means a lost detail/turnId, never a blocked agent.
# Never blocks the agent: every path exits 0 silently.

# No-op for any agent session launched outside MultiAgent.
[ "$MULTIAGENT_ENV" = "1" ] || exit 0
ptyId="$MULTIAGENT_PTY_ID"
port="$MULTIAGENT_HOOK_PORT"
[ -n "$ptyId" ] || exit 0
[ -n "$port" ] || exit 0

agentKind="${1:-claude}"
event="${2:-session_start}"

# Read the agent's hook payload from stdin (best-effort; may be empty for some events).
raw=$(cat)

# sed-based extraction of a top-level JSON string field: prints the value or empty.
jsonstr() {
  printf '%s' "$raw" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}

# JSON-escape backslashes and double quotes in a value (for detail/message text).
jsonesc() {
  local v="$1"
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  printf '%s' "$v"
}

# Turn identity: Codex carries turn_id; Claude carries prompt_id. Absent on older Claude.
turn_id() {
  if [ "$agentKind" = "codex" ]; then printf '%s' "$(jsonstr turn_id)"
  else printf '%s' "$(jsonstr prompt_id)"; fi
}

post_event() {
  # $1 = event name, $2 = detail (may be empty), $3 = turnId (may be empty)
  local ev="$1" detail="$2" tid="$3" body
  body="{\"ptyId\":\"$ptyId\",\"agentKind\":\"$agentKind\",\"event\":\"$ev\""
  [ -n "$detail" ] && body="$body,\"detail\":\"$(jsonesc "$detail")\""
  [ -n "$tid" ] && body="$body,\"turnId\":\"$tid\""
  body="$body}"
  curl -s -m 2 -X POST -H 'Content-Type: application/json' -d "$body" \
    "http://127.0.0.1:$port/agent-event" >/dev/null 2>&1
}

post_session() {
  # $1 = sessionId, $2 = transcriptPath (may be empty -> null)
  local sid="$1" tp="$2" tp_json body
  if [ -z "$tp" ]; then tp_json='null'
  else
    local esc=${tp//\\/\\\\}; esc=${esc//\"/\\\"}
    tp_json="\"$esc\""
  fi
  body="{\"ptyId\":\"$ptyId\",\"agentKind\":\"$agentKind\",\"sessionId\":\"$sid\",\"transcriptPath\":$tp_json}"
  curl -s -m 2 -X POST -H 'Content-Type: application/json' -d "$body" \
    "http://127.0.0.1:$port/agent-session" >/dev/null 2>&1
}

case "$event" in
  session_start)
    sid=$(jsonstr session_id)
    # Always seed the badge. The linking report is skipped for app-launched Claude
    # (MULTIAGENT_SESSION_ID set) -- it already has its id.
    post_event session_start "" "$sid"
    if [ -z "$MULTIAGENT_SESSION_ID" ] && [ -n "$sid" ]; then
      post_session "$sid" "$(jsonstr transcript_path)"
    fi
    ;;
  user_prompt_submit)
    post_event user_prompt_submit "" "$(turn_id)"
    ;;
  pre_tool_use)
    post_event pre_tool_use "$(jsonstr tool_name)" "$(turn_id)"
    ;;
  post_tool_use)
    post_event post_tool_use "$(jsonstr tool_name)" "$(turn_id)"
    ;;
  stop)
    post_event stop "" "$(turn_id)"
    ;;
  permission_request)
    # Claude Notification(permission_prompt) carries `message`; Codex PermissionRequest
    # carries `tool_name`. Prefer the message, fall back to the tool name.
    detail=$(jsonstr message)
    [ -n "$detail" ] || detail=$(jsonstr tool_name)
    post_event permission_request "$detail" "$(turn_id)"
    ;;
  stop_failure)
    # Claude only. Send whatever error text is present.
    detail=$(jsonstr error_type)
    [ -n "$detail" ] || detail=$(jsonstr message)
    post_event stop_failure "$detail" "$(turn_id)"
    ;;
  *)
    # Unknown event arg: no-op. Never blocks.
    ;;
esac
exit 0