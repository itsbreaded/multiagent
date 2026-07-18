/**
 * agentStatus -- pure lifecycle-event -> badge-state reducer (spec 032).
 *
 * Mirrors the discipline of paneTree.ts / cwdRepair.ts: no Electron deps, no IO, fully
 * deterministic. The renderer runs this per pane on each `pane:agent-event` (and on the
 * synthetic promote/demote from the agent-process sweeper). `now` (Date.now()) is injected
 * so tests are deterministic via vi.setSystemTime.
 *
 * The state machine is sourced entirely from agent-self-reported lifecycle hooks -- never
 * from screen/OSC scraping. When no hook events have arrived, the caller passes
 * prev === undefined and the pane renders `unknown` (the honest fallback).
 */

import type { AgentStatusState, AgentStatusInput } from './types'

/**
 * Reduce a lifecycle event into the next per-pane status state.
 *
 * @param prev  the pane's current status (undefined on cold start / after demote).
 * @param input the event the hook script (or the synthetic sweeper) reported.
 * @param now   Date.now() at the call site (injected for testability).
 * @returns     the next status state, or undefined to clear the badge (demote).
 */
export function eventToState(
  prev: AgentStatusState | undefined,
  input: AgentStatusInput,
  now: number,
): AgentStatusState | undefined {
  switch (input.event) {
    case 'demote':
      // The agent process exited (sweeper). Clear the badge entirely -- this is the
      // missed-Stop fallback: even if a Stop hook was dropped, demotion clears it.
      return undefined

    case 'promote':
      // A CLI-launched agent was detected. Seed working immediately; the first real hook
      // event refines it. No turnId/detail yet (the hook has not reported).
      return { status: 'working', event: 'promote', updatedAt: now }

    case 'session_start':
      // A session is ready and waiting for input (cold launch, resume, clear, compact) -- NOT
      // a turn in progress. Seed idle ONLY on cold start (prev undefined) so an app-
      // launched pane badges immediately instead of unknown. If state already exists,
      // preserve it: session_start must not flip a live working turn to idle (e.g. Codex
      // fires SessionStart on the first user message, which can arrive after
      // UserPromptSubmit; an in-pane resume fork can fire mid-turn).
      return prev ?? { status: 'idle', event: 'session_start', updatedAt: now }

    case 'user_prompt_submit':
      // The authoritative 'a turn is in progress' signal: the user actually submitted a
      // prompt. Seeds/refreshes working with the turn id so later out-of-order tool
      // events can be guarded.
      return { status: 'working', turnId: input.turnId, event: input.event, updatedAt: now }

    case 'pre_tool_use':
    case 'post_tool_use': {
      // Turn-id guard: once a turn ended (idle), drop late tool events from THAT turn.
      // A tool event from a *different* turn id means a new turn started (we missed its
      // UserPromptSubmit, or the tool fired first) -> promote to working. If the turn id
      // is absent (older Claude with no prompt_id) we cannot distinguish, so we keep the
      // honest idle rather than flapping -- a stuck idle is benign, a false working is not.
      if (prev?.status === 'idle') {
        if (input.turnId === undefined || input.turnId === prev.turnId) {
          return prev
        }
      }
      return {
        status: 'working',
        detail: input.detail,
        turnId: input.turnId ?? prev?.turnId,
        event: input.event,
        updatedAt: now,
      }
    }

    case 'stop':
      // Turn ended, awaiting input. Clear the per-tool detail.
      return { status: 'idle', turnId: input.turnId ?? prev?.turnId, event: 'stop', updatedAt: now }

    case 'stop_failure':
      // Claude only (Codex has no StopFailure). High-signal: always apply.
      return {
        status: 'error',
        detail: input.detail ?? 'error',
        turnId: input.turnId ?? prev?.turnId,
        event: 'stop_failure',
        updatedAt: now,
      }

    case 'permission_request':
      // Permission prompt -- the headline signal. High-signal: always apply. Inherit the
      // turn id when the hook payload omits it (e.g. Claude Notification message-only).
      return {
        status: 'waiting',
        detail: input.detail,
        turnId: input.turnId ?? prev?.turnId,
        event: 'permission_request',
        updatedAt: now,
      }

    default:
      // Unknown event (not in the allow-list). Never throws; keep the prior state so a
      // stray/forward-incompatible event cannot blank a live badge.
      return prev
  }
}