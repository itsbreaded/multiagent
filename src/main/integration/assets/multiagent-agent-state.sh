#!/usr/bin/env bash
# MultiAgent agent lifecycle hook (spec 047 session linking + spec 032 status badges) --
# Unix port. The bash equivalent of multiagent-agent-state.ps1, installed as the hook
# command on Linux/macOS (Windows uses the .ps1).
#
# Usage: bash "<path>" <agentKind> [<event>]
#   <agentKind> = "claude" | "codex"
#   <event> = session_start | user_prompt_submit | pre_tool_use | post_tool_use |
#             stop | permission_request | stop_failure | idle_prompt |
#             bg_subagent_completed
#   An absent <event> (legacy 047 SessionStart install) is treated as session_start.
#
# Self-contained: bash + curl only (no Python/Node/jq). JSON parsing is sed-based and
# defensive -- a missing/wrong field means lost evidence, never a blocked agent.
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

# Turn identity: Codex carries turn_id; Claude carries prompt_id.
turn_id() {
  if [ "$agentKind" = "codex" ]; then
    printf '%s' "$(jsonstr turn_id)"
  else
    printf '%s' "$(jsonstr prompt_id)"
  fi
}

jsonbool() {
  printf '%s' "$raw" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p" | head -n1
}

claude_stop_terminal_state() {
  # Only an explicit boolean false means the foreground turn completed. Missing or
  # drifted stop_hook_active stays busy so Stop cannot fabricate idle.
  [ "$(jsonbool stop_hook_active)" = false ] && printf '%s' completed || printf '%s' busy
}

session_id() {
  jsonstr session_id
}

# Only an explicitly empty Claude list proves that there is no work in that category.
# Non-empty, malformed, or missing lists produce bounded incomplete evidence so a stale
# idle badge cannot be trusted. The awk scanner checks the key at object depth one and
# the array's first token; regexes over raw JSON would mistake nested/quoted examples for
# top-level empty arrays.
top_level_empty_array() {
  local key="$1"
  awk -v wanted="$key" '
    function ws(c) { return c ~ /[ \t\r\n]/ }
    function skip(i) { while (i <= n && ws(substr(s, i, 1))) i++; return i }
    {
      s = s $0
    }
    END {
      n = length(s); first = skip(1); last = n
      while (last > 0 && ws(substr(s, last, 1))) last--
      if (substr(s, first, 1) != "{" || substr(s, last, 1) != "}") exit
      depth = 0; brackets = 0; in_string = 0; escaped = 0; root_closed = 0; valid = 1
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (in_string) {
          if (escaped) { escaped = 0; continue }
          if (c == "\\") { escaped = 1; continue }
          if (c == "\"") { in_string = 0; continue }
          continue
        }
        if (root_closed && !ws(c)) { valid = 0; break }
        if (c == "\"") {
          start_depth = depth; value = ""; j = i + 1; escaped = 0
          while (j <= n) {
            d = substr(s, j, 1)
            if (escaped) { value = value d; escaped = 0; j++; continue }
            if (d == "\\") { escaped = 1; j++; continue }
            if (d == "\"") break
            value = value d; j++
          }
          if (j > n) { valid = 0; break }
          if (start_depth == 1 && value == wanted) {
            k = skip(j + 1)
            if (substr(s, k, 1) == ":") {
              k = skip(k + 1)
              if (substr(s, k, 1) == "[" && substr(s, skip(k + 1), 1) == "]") found = 1
            }
          }
          i = j
          continue
        }
        if (c == "{") {
          if (root_closed) { valid = 0; break }
          depth++
        } else if (c == "}") {
          depth--
          if (depth < 0) { valid = 0; break }
          if (depth == 0) root_closed = 1
        } else if (c == "[") {
          if (root_closed) { valid = 0; break }
          brackets++
        } else if (c == "]") {
          brackets--
          if (brackets < 0) { valid = 0; break }
        }
      }
      if (!valid || in_string || depth != 0 || brackets != 0 || !root_closed) exit
      if (found) print "yes"
    }
  ' <<< "$raw"
}

claude_evidence() {
  local terminalState="$1"
  local sid tid identity
  sid=$(session_id)
  tid=$(turn_id)
  identity=""
  [ -n "$sid" ] && identity="$identity,\"sessionId\":\"$(jsonesc "$sid")\""
  [ -n "$tid" ] && identity="$identity,\"turnId\":\"$(jsonesc "$tid")\""
  if [ "$(top_level_empty_array background_tasks)" = yes ] && [ "$(top_level_empty_array session_crons)" = yes ]; then
    printf '%s' "{\"provider\":\"claude\",\"completeness\":\"complete\",\"terminalState\":\"$terminalState\",\"activeCount\":0,\"scheduledCount\":0$identity}"
  else
    printf '%s' "{\"provider\":\"claude\",\"completeness\":\"incomplete\",\"terminalState\":\"$terminalState\",\"activeCount\":1,\"scheduledCount\":1$identity}"
  fi
}

post_event() {
  # $1 = event, $2 = detail, $3 = turnId, $4 = agentId, $5 = sessionId, $6 = evidence JSON
  local ev="$1" detail="$2" tid="$3" aid="$4" sid="$5" evidence="$6" body
  body="{\"ptyId\":\"$(jsonesc "$ptyId")\",\"agentKind\":\"$(jsonesc "$agentKind")\",\"event\":\"$(jsonesc "$ev")\""
  [ -n "$detail" ] && body="$body,\"detail\":\"$(jsonesc "$detail")\""
  [ -n "$tid" ] && body="$body,\"turnId\":\"$(jsonesc "$tid")\""
  [ -n "$aid" ] && body="$body,\"agentId\":\"$(jsonesc "$aid")\""
  [ -n "$sid" ] && body="$body,\"sessionId\":\"$(jsonesc "$sid")\""
  [ -n "$evidence" ] && body="$body,\"evidence\":$evidence"
  body="$body}"
  curl -s -m 2 -X POST -H 'Content-Type: application/json' -d "$body" \
    "http://127.0.0.1:$port/agent-event" >/dev/null 2>&1
}

post_session() {
  # $1 = sessionId, $2 = transcriptPath (may be empty -> null)
  local sid="$1" tp="$2" tp_json body
  if [ -z "$tp" ]; then
    tp_json='null'
  else
    local esc=${tp//\\/\\\\}; esc=${esc//\"/\\\"}
    tp_json="\"$esc\""
  fi
  body="{\"ptyId\":\"$(jsonesc "$ptyId")\",\"agentKind\":\"$(jsonesc "$agentKind")\",\"sessionId\":\"$(jsonesc "$sid")\",\"transcriptPath\":$tp_json}"
  curl -s -m 2 -X POST -H 'Content-Type: application/json' -d "$body" \
    "http://127.0.0.1:$port/agent-session" >/dev/null 2>&1
}

get_agent_id() {
  if [ "$event" = "bg_subagent_completed" ]; then
    jsonstr agent_id
  else
    jsonstr agentId
  fi
}

case "$event" in
  session_start)
    sid=$(session_id)
    post_event session_start "" "" "" "$sid" ""
    # Always seed the badge. Linking is skipped for app-launched Claude because its id is
    # already known by MultiAgent.
    if [ -z "$MULTIAGENT_SESSION_ID" ] && [ -n "$sid" ]; then
      post_session "$sid" "$(jsonstr transcript_path)"
    fi
    ;;
  user_prompt_submit)
    post_event user_prompt_submit "" "$(turn_id)" "" "$(session_id)" ""
    ;;
  pre_tool_use)
    post_event pre_tool_use "$(jsonstr tool_name)" "$(turn_id)" "" "$(session_id)" ""
    ;;
  post_tool_use)
    if printf '%s' "$raw" | grep -Eq '\"tool_name\"[[:space:]]*:[[:space:]]*\"(Agent|Task)\"' &&
       { printf '%s' "$raw" | grep -Eq '\"status\"[[:space:]]*:[[:space:]]*\"async_launched\"' ||
         printf '%s' "$raw" | grep -Eq '\"run_in_background\"[[:space:]]*:[[:space:]]*true'; }; then
      post_event bg_subagent_started "$(jsonstr tool_name)" "$(turn_id)" "$(get_agent_id)" "$(session_id)" ""
    else
      post_event post_tool_use "$(jsonstr tool_name)" "$(turn_id)" "" "$(session_id)" ""
    fi
    ;;
  bg_subagent_completed)
    evidence=""
    [ "$agentKind" = "claude" ] && evidence=$(claude_evidence completed)
    post_event bg_subagent_completed "" "$(turn_id)" "$(get_agent_id)" "$(session_id)" "$evidence"
    ;;
  stop)
    evidence=""
    terminalState=completed
    [ "$agentKind" = "claude" ] && terminalState=$(claude_stop_terminal_state)
    [ "$agentKind" = "claude" ] && evidence=$(claude_evidence "$terminalState")
    post_event stop "" "$(turn_id)" "" "$(session_id)" "$evidence"
    ;;
  idle_prompt)
    sid=$(session_id)
    if printf '%s' "$raw" | grep -Eq '\"notification_type\"[[:space:]]*:[[:space:]]*\"idle_prompt\"' && [ -n "$sid" ]; then
      post_event idle_prompt "" "$(turn_id)" "" "$sid" ""
    fi
    ;;
  permission_request)
    detail=$(jsonstr message)
    [ -n "$detail" ] || detail=$(jsonstr tool_name)
    post_event permission_request "$detail" "$(turn_id)" "" "$(session_id)" ""
    ;;
  stop_failure)
    detail=$(jsonstr error)
    [ -n "$detail" ] || detail=$(jsonstr error_details)
    [ -n "$detail" ] || detail=$(jsonstr error_type)
    [ -n "$detail" ] || detail=$(jsonstr message)
    [ "${#detail}" -le 256 ] || detail=${detail:0:256}
    post_event stop_failure "$detail" "$(turn_id)" "" "$(session_id)" ""
    ;;
  *)
    # Unknown event arg: no-op. Never blocks.
    ;;
esac
exit 0
