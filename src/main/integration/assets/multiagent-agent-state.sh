#!/usr/bin/env bash
# MultiAgent CLI session-linking hook (spec 047 phase 3 / phase 4) — Unix port.
#
# The bash equivalent of multiagent-agent-state.ps1, installed as the SessionStart hook
# command on Linux/macOS (Windows uses the .ps1). Reports the agent session id + transcript
# path back to the MultiAgent main process over a localhost loopback endpoint, so a
# launched (or CLI-launched, promoted) pane links the running session (including across an
# in-pane resume/fork) and resumes it on restart. Self-contained: uses only bash + curl,
# both present on every macOS and desktop Linux — no Python/Node/jq prerequisite.
#
# Usage: bash "<path>" <agentKind>   (agentKind is "claude" or "codex")
#
# Codex note: the interactive TUI defers SessionStart until the first user message creates
# the rollout (the earliest a session_id exists), so a Codex pane links on its first
# message — not at cold launch. Claude links at launch.
#
# Never blocks the agent's session start: every failure path exits 0 silently.

# App-launched Claude panes already carry their --session-id (known at spawn); a redundant
# report adds nothing, so bail. (App-launched Codex does NOT set this.)
[ -n "$MULTIAGENT_SESSION_ID" ] && exit 0

# No-op for any agent session launched outside MultiAgent.
[ "$MULTIAGENT_ENV" = "1" ] || exit 0
ptyId="$MULTIAGENT_PTY_ID"
port="$MULTIAGENT_HOOK_PORT"
[ -n "$ptyId" ] || exit 0
[ -n "$port" ] || exit 0

# Agent kind is passed as the first positional arg by the hook command; fall back to claude.
agentKind="${1:-claude}"

# Read the agent's SessionStart payload from stdin. JSON parsing is done with sed (no jq
# dependency). We only need `session_id` (a UUID — no special chars) for linking; main's
# `session:detected` forwards only ptyId/agentKind/sessionId, so transcriptPath is best-effort.
raw=$(cat)
[ -n "$raw" ] || exit 0
sid=$(printf '%s' "$raw" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
[ -n "$sid" ] || exit 0
tpath=$(printf '%s' "$raw" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)

# Build the JSON body. ptyId/agentKind/sid are safe (UUIDs + fixed strings). JSON-escape
# backslashes and double quotes in transcriptPath (rare on Unix, but be safe); empty → null.
if [ -z "$tpath" ]; then
  tp_json='null'
else
  esc=${tpath//\\/\\\\}
  esc=${esc//\"/\\\"}
  tp_json="\"$esc\""
fi
body="{\"ptyId\":\"$ptyId\",\"agentKind\":\"$agentKind\",\"sessionId\":\"$sid\",\"transcriptPath\":$tp_json}"

# POST to the report server. -s silent, -m 2 max-time (matches the .ps1 TimeoutSec). Any
# failure is swallowed — a report must never interrupt the agent's session start.
curl -s -m 2 -X POST -H 'Content-Type: application/json' -d "$body" \
  "http://127.0.0.1:$port/agent-session" >/dev/null 2>&1
exit 0