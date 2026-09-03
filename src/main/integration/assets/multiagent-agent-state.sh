#!/usr/bin/env bash
# MultiAgent agent lifecycle hook (spec 047 session linking + spec 032 status badges) --
# Unix port. The bash equivalent of multiagent-agent-state.ps1, installed as the hook
# command on Linux/macOS (Windows uses the .ps1).
#
# Usage: bash "<path>" <agentKind> [<event>]
#   <agentKind> = "claude" | "codex"
#   <event> = session_start | user_prompt_submit | pre_tool_use | post_tool_use |
#             stop | permission_request | stop_failure | idle_prompt |
#             bg_subagent_completed | bg_agent_completed
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
  # BSD sed (macOS) does not support GNU BRE alternation (\|). POSIX ERE is
  # supported by both BSD and GNU sed.
  printf '%s' "$raw" | sed -E -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*(true|false).*/\1/p" | head -n1
}

claude_stop_terminal_state() {
  # Only an explicit boolean false means the foreground turn completed. Missing or
  # drifted stop_hook_active stays busy so Stop cannot fabricate idle.
  [ "$(jsonbool stop_hook_active)" = false ] && printf '%s' completed || printf '%s' busy
}

session_id() {
  jsonstr session_id
}

# Only explicitly present Claude lists contribute known work counts. Missing or
# malformed lists produce incomplete evidence, which remains suspension-protective,
# but they do not fabricate active work and block a matching idle_prompt forever.
# The awk scanner checks the key at object depth one and each array item's own
# top-level status; regexes over raw JSON would mistake nested/quoted examples
# for top-level arrays or task fields.
top_level_array_state() {
  local key="$1"
  awk -v wanted="$key" '
    function ws(c) { return c ~ /[ \t\r\n]/ }
    function skip(i) { while (i <= n && ws(substr(s, i, 1))) i++; return i }
    function terminal(v) {
      return v == "completed" || v == "failed" || v == "killed" ||
        v == "stopped" || v == "canceled" || v == "cancelled" ||
        v == "done" || v == "success" || v == "idle"
    }
    {
      s = s $0
    }
    END {
      n = length(s); first = skip(1); last = n
      while (last > 0 && ws(substr(s, last, 1))) last--
      if (substr(s, first, 1) != "{" || substr(s, last, 1) != "}") exit
      depth = 0; brackets = 0; in_string = 0; escaped = 0; root_closed = 0; valid = 1
      target = 0; target_level = 0; target_closed = 0; item_root = 0
      item_status = ""; item_status_seen = 0; active = 0
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
              if (substr(s, k, 1) == "[") {
                if (target) { valid = 0; break }
                target = 1
                target_level = brackets + 1
              }
            }
          }
          # Only a background task item status field can release its
          # active-work protection. Missing/unknown status remains active.
          if (target && !target_closed && wanted == "background_tasks" && item_root > 0 &&
              start_depth == item_root && value == "status") {
            k = skip(j + 1)
            if (substr(s, k, 1) == ":") {
              k = skip(k + 1)
              if (substr(s, k, 1) == "\"") {
                l = k + 1; status_escaped = 0
                while (l <= n) {
                  d = substr(s, l, 1)
                  if (status_escaped) { status_escaped = 0; l++; continue }
                  if (d == "\\") { status_escaped = 1; l++; continue }
                  if (d == "\"") break
                  l++
                }
                if (l > n) { valid = 0; break }
                item_status = substr(s, k + 1, l - k - 1)
                item_status_seen = 1
              } else {
                l = k
                while (l <= n && substr(s, l, 1) !~ /[ \t\r\n,}\]]/) l++
                item_status = substr(s, k, l - k)
                item_status_seen = 1
              }
            }
          }
          i = j
          continue
        }
        if (target && !target_closed) {
          if (c == "]" && brackets == target_level) {
            target_closed = 1
          } else if (brackets == target_level && item_root == 0 && !ws(c) && c != ",") {
            if (c == "{") {
              item_root = depth + 1
              item_status = ""
              item_status_seen = 0
            } else {
              # Preserve the old fail-safe behavior for malformed array items.
              active = 1
            }
          }
          if (item_root > 0 && c == "}" && depth == item_root) {
            if (wanted != "background_tasks" || !item_status_seen || !terminal(item_status)) active = 1
            item_root = 0
          }
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
      if (target) print active ? "nonempty" : "empty"
    }
  ' <<< "$raw" || true
}

claude_evidence() {
  local terminalState="$1"
  local sid tid identity
  sid=$(session_id)
  tid=$(turn_id)
  identity=""
  [ -n "$sid" ] && identity="$identity,\"sessionId\":\"$(jsonesc "$sid")\""
  [ -n "$tid" ] && identity="$identity,\"turnId\":\"$(jsonesc "$tid")\""
  local activeState scheduledState completeness activeCount scheduledCount
  activeState=$(top_level_array_state background_tasks)
  scheduledState=$(top_level_array_state session_crons)
  completeness=incomplete
  activeCount=0
  scheduledCount=0
  [ "$activeState" = nonempty ] && activeCount=1
  [ "$scheduledState" = nonempty ] && scheduledCount=1
  if [ "$activeState" = empty ] && [ "$scheduledState" = empty ]; then completeness=complete; fi
  printf '%s' "{\"provider\":\"claude\",\"completeness\":\"$completeness\",\"terminalState\":\"$terminalState\",\"activeCount\":$activeCount,\"scheduledCount\":$scheduledCount$identity}"
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
  bg_agent_completed)
    if printf '%s' "$raw" | grep -Eq '"notification_type"[[:space:]]*:[[:space:]]*"agent_completed"'; then
      post_event bg_agent_completed "" "" "" "$(session_id)" ""
    fi
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
