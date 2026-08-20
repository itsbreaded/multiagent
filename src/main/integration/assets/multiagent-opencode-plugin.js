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

function reportEvent(event, detail, sessionID) {
  const rootID = rootFor(sessionID)
  if (!rootID) return
  post('/agent-event', {
    ptyId: PTY_ID,
    agentKind: 'opencode',
    event: event,
    detail: detail,
    turnId: turnFor(rootID, false),
    sessionId: rootID,
  })
}

const MAX_SESSIONS = 256
const sessionInfo = new Map()
const sessionStatus = new Map()
const sessionTurns = new Map()
const unresolvedSessions = new Set()
let rootSessionID

function rememberSession(info) {
  if (!info || typeof info.id !== 'string' || !info.id) return
  sessionInfo.set(info.id, { parentID: typeof info.parentID === 'string' ? info.parentID : undefined })
  unresolvedSessions.delete(info.id)
  if (!info.parentID && !rootSessionID) rootSessionID = info.id
  while (sessionInfo.size > MAX_SESSIONS) {
    const first = sessionInfo.keys().next().value
    if (first === rootSessionID && sessionInfo.size > 1) {
      const second = sessionInfo.keys()
      second.next()
      const victim = second.next().value
      if (victim) sessionInfo.delete(victim)
    } else if (first) {
      sessionInfo.delete(first)
    } else break
  }
}

function rootFor(sessionID) {
  if (typeof sessionID !== 'string' || !sessionID) return undefined
  let current = sessionID
  const seen = new Set()
  while (!seen.has(current)) {
    seen.add(current)
    const info = sessionInfo.get(current)
    if (!info) return undefined
    if (!info.parentID) return current
    current = info.parentID
  }
  return undefined
}

function turnFor(rootID, create) {
  const existing = sessionTurns.get(rootID)
  if (existing || !create) return existing
  const next = rootID + ':turn:1'
  sessionTurns.set(rootID, next)
  return next
}

function reportEventWithEvidence(event, detail, rootID, turnID, evidence) {
  if (!rootID) return
  const body = { ptyId: PTY_ID, agentKind: 'opencode', event, detail, turnId: turnID, sessionId: rootID }
  if (evidence) body.evidence = evidence
  post('/agent-event', body)
}

function snapshot(rootID, terminalState) {
  const allActiveIDs = []
  for (const [id, state] of sessionStatus) {
    if (state !== 'busy' && state !== 'retry') continue
    if (rootFor(id) === rootID) allActiveIDs.push(id)
  }
  const activeCount = Math.min(allActiveIDs.length, 64)
  const activeIDs = allActiveIDs.filter((id) => typeof id === 'string' && id.length <= 256).slice(0, 64)
  return {
    provider: 'opencode',
    completeness: 'incomplete',
    terminalState,
    activeCount,
    scheduledCount: 0,
    ...(activeCount > 0 && activeIDs.length === activeCount ? { activeIds: activeIDs } : {}),
    sessionId: rootID,
    turnId: turnFor(rootID, false),
  }
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
            rememberSession(info)
            if (info?.id && !info.parentID) {
              rootSessionID = String(info.id)
              reportSession(rootSessionID, null)
              reportEventWithEvidence('session_start', undefined, rootSessionID, undefined)
            }
            break
          }
          case 'session.updated': {
            const info = event.properties?.info
            rememberSession(info)
            break
          }
          case 'session.status': {
            const sessionID = event.properties?.sessionID
            const type = event.properties?.status?.type
            if (!sessionID || typeof type !== 'string') break
            sessionStatus.set(sessionID, type)
            const rootID = rootFor(sessionID)
            if (!rootID) {
              unresolvedSessions.add(sessionID)
              while (unresolvedSessions.size > MAX_SESSIONS) unresolvedSessions.delete(unresolvedSessions.values().next().value)
              break
            }
            unresolvedSessions.delete(sessionID)
            if (type === 'busy') {
              const turnID = turnFor(rootID, true)
              reportEventWithEvidence('user_prompt_submit', undefined, rootID, turnID)
              reportEventWithEvidence('work_snapshot', undefined, rootID, turnID, snapshot(rootID, 'busy'))
            } else if (type === 'retry') {
              const turnID = turnFor(rootID, true)
              reportEventWithEvidence('user_prompt_submit', undefined, rootID, turnID)
              reportEventWithEvidence('work_snapshot', event.properties.status.message, rootID, turnID, snapshot(rootID, 'retry'))
            } else if (type === 'idle') {
              reportEventWithEvidence('work_snapshot', undefined, rootID, turnFor(rootID, false), snapshot(rootID, 'idle'))
            }
            break
          }
          case 'session.error': {
            const detail = event.properties?.error?.message ?? 'session error'
            const rootID = rootFor(event.properties?.sessionID)
            reportEventWithEvidence('stop_failure', String(detail), rootID, turnFor(rootID, false))
            break
          }
          case 'permission.updated': {
            const perm = event.properties
            const rootID = rootFor(perm?.sessionID)
            reportEventWithEvidence('permission_request', perm?.title ? String(perm.title) : undefined, rootID, turnFor(rootID, false))
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
