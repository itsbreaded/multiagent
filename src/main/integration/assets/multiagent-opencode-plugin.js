// MultiAgent managed OpenCode plugin (spec 052).
//
// Loaded by OpenCode via a `plugin: ["<abs path>"]` entry in the per-pane
// OPENCODE_CONFIG_CONTENT inline JSON (process-scoped, no mutation of ~/.config/opencode/).
// Reports session-created + lifecycle events to the existing MultiAgent agent-session
// report server (the same one the Claude/Codex managed hooks POST to), so an OpenCode pane
// links its session id and drives the status badge.
//
// Bails unless MULTIAGENT_ENV==='1' + MULTIAGENT_PTY_ID + MULTIAGENT_HOOK_PORT are set, so
// it's a no-op for OpenCode launched outside MultiAgent (the env vars are pane-scoped).
// Every hook is wrapped in try/catch and the plugin never throws — a plugin must never
// break OpenCode's session start or turn.
//
// Verified against OpenCode's @opencode-ai/plugin / @opencode-ai/sdk type definitions:
// session/permission lifecycle (session.created, session.idle, session.status,
// session.error, permission.updated) are NOT individually-addressable hook keys — they are
// `Event` union members delivered only through the single generic `event` hook
// (`event: async ({ event }) => ...`, dispatched on `event.type`). Registering them as
// top-level keys (an earlier version of this plugin did) is silently ignored by OpenCode:
// the plugin loads without error but the hooks never fire. `tool.execute.before` /
// `tool.execute.after` ARE real top-level intercept hooks with their own signature
// (`(input: { tool, sessionID, callID }, output) => ...`) and are used directly, not via
// `event`. We deliberately do NOT implement `permission.ask` (the intercept hook that can
// decide allow/deny) — that would make this plugin part of the permission decision, and
// OpenCode's own `--auto` CLI flag + the user's `permission` config already own that
// decision; we only want to observe/report via the passive `permission.updated` event.

const PTY_ID = process.env.MULTIAGENT_PTY_ID
const HOOK_PORT = process.env.MULTIAGENT_HOOK_PORT
const ENABLED = process.env.MULTIAGENT_ENV === '1' && Boolean(PTY_ID) && Boolean(HOOK_PORT)

function post(path, body) {
  if (!ENABLED) return
  try {
    const port = HOOK_PORT
    const url = 'http://127.0.0.1:' + port + path
    const payload = JSON.stringify(body)
    // Use fetch (Bun and modern Node have it). 2s timeout via AbortController.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: ctrl.signal,
    }).then((r) => { clearTimeout(timer); void r }, (e) => { clearTimeout(timer); void e })
  } catch (e) { void e }
}

function reportSession(sessionId, transcriptPath) {
  post('/agent-session', {
    ptyId: PTY_ID,
    agentKind: 'opencode',
    sessionId: sessionId,
    transcriptPath: transcriptPath ?? null,
  })
}

function reportEvent(event, detail, turnId) {
  post('/agent-event', {
    ptyId: PTY_ID,
    agentKind: 'opencode',
    event: event,
    detail: detail,
    turnId: turnId,
  })
}

export const MultiAgentPlugin = async function () {
  if (!ENABLED) return {}

  return {
    // Generic passive-event hook — the ONLY delivery path for session/permission
    // lifecycle events (see file header). `event.type` discriminates; `event.properties`
    // shape is per-type (verified against @opencode-ai/sdk's Event union).
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case 'session.created': {
            const info = event.properties?.info
            if (info?.id) reportSession(String(info.id), null)
            reportEvent('session_start', undefined, info?.id ? String(info.id) : undefined)
            break
          }
          case 'session.idle': {
            reportEvent('stop', undefined, event.properties?.sessionID)
            break
          }
          case 'session.status': {
            // properties.status is a discriminated union: {type:'idle'|'busy'|'retry',...}.
            // Only a busy status means a turn is actively running.
            if (event.properties?.status?.type === 'busy') {
              reportEvent('user_prompt_submit', undefined, event.properties?.sessionID)
            }
            break
          }
          case 'session.error': {
            const detail = event.properties?.error?.message ?? 'session error'
            reportEvent('stop_failure', String(detail), event.properties?.sessionID)
            break
          }
          case 'permission.updated': {
            const perm = event.properties
            reportEvent('permission_request', perm?.title ? String(perm.title) : undefined, perm?.sessionID)
            break
          }
          default:
            break
        }
      } catch (e) { void e }
    },
    'tool.execute.before': async (input) => {
      try {
        reportEvent('pre_tool_use', input?.tool ? String(input.tool) : undefined, input?.sessionID)
      } catch (e) { void e }
    },
    'tool.execute.after': async (input) => {
      try {
        reportEvent('post_tool_use', input?.tool ? String(input.tool) : undefined, input?.sessionID)
      } catch (e) { void e }
    },
  }
}
