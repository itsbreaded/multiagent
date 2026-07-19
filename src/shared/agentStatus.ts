/**
 * agentStatus -- pure lifecycle-event -> badge-state reducer (spec 032).
 *
 * Mirrors the discipline of paneTree.ts / cwdRepair.ts: no Electron deps, no IO, fully
 * deterministic. The renderer runs this per pane on each `pane:agent-event` (and on the
 * synthetic promote/demote from the agent-process sweeper). `now` (Date.now()) is injected
 * so tests are deterministic via vi.setSystemTime.
 *
 * The state machine is sourced primarily from agent-self-reported lifecycle hooks --
 * the authoritative path. ONE scoped, opt-in exception exists (spec 050): the
 * `terminal_error` event fed by the `agentStatusScraping` terminal-output observer,
 * which exists only because some fatal errors (notably Codex provider-compat failures)
 * print to the terminal and emit no hook at all. Default OFF; never on unless the user
 * opts in. When no events have arrived, the caller passes prev === undefined and the
 * pane renders `unknown` (the honest fallback).
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
  // spec 050: a latched terminal_error is sticky. Any straggler hook event from the dead
  // turn (a late tool, a stop, a permission echo, a re-promote) must NOT flap the badge
  // back to working/idle/waiting -- the only legitimate clears are a fresh turn
  // (user_prompt_submit), a fresh session (session_start), or process exit (demote).
  // `stop_failure` is its own high-signal error path and stays put regardless.
  const latched = prev?.event === 'terminal_error'

  switch (input.event) {
    case 'demote':
      // The agent process exited (sweeper). Clear the badge entirely -- this is the
      // missed-Stop fallback: even if a Stop hook was dropped, demotion clears it.
      // (Also the legitimate clear of a latched terminal_error -- the dead process is gone.)
      return undefined

    case 'promote':
      // A CLI-launched agent was detected. Seed working immediately; the first real hook
      // event refines it. No turnId/detail yet (the hook has not reported).
      if (latched) return prev   // dead turn: do not resurrect working
      return { status: 'working', event: 'promote', updatedAt: now }

    case 'session_start':
      // A session is ready and waiting for input (cold launch, resume, clear, compact) -- NOT
      // a turn in progress. Seed idle ONLY on cold start (prev undefined) so an app-
      // launched pane badges immediately instead of unknown. If state already exists,
      // preserve it: session_start must not flip a live working turn to idle (e.g. Codex
      // fires SessionStart on the first user message, which can arrive after
      // UserPromptSubmit; an in-pane resume fork can fire mid-turn).
      //
      // spec 050 exception: when the badge is latched on terminal_error, a session_start
      // (resume/clear/compact) is the legitimate re-arm -- the prior error is from a dead
      // turn and the new session is a fresh start. Without this the dot would stay red
      // across restarts, which is exactly the "silent recovery we can't verify" the spec
      // forbids. Falls through to the existing preserve-prev behavior when NOT latched.
      if (latched) return { status: 'idle', event: 'session_start', updatedAt: now }
      return prev ?? { status: 'idle', event: 'session_start', updatedAt: now }

    case 'user_prompt_submit':
      // The authoritative 'a turn is in progress' signal: the user actually submitted a
      // prompt. Seeds/refreshes working with the turn id so later out-of-order tool
      // events can be guarded. (Also the primary clear of a latched terminal_error --
      // the user retried.)
      return { status: 'working', turnId: input.turnId, event: input.event, updatedAt: now }

    case 'pre_tool_use':
    case 'post_tool_use': {
      // spec 050: the latch check goes at the TOP of the case so a late tool event from
      // the dead turn short-circuits BEFORE the existing turn-id guard runs. Without this
      // a stray post_tool_use would resurrect `working` on a pane whose turn is dead.
      if (latched) return prev
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
      if (latched) return prev   // dead turn: do not flap to idle from a late Stop
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
      if (latched) return prev   // dead turn: do not flap to waiting from a stale prompt
      return {
        status: 'waiting',
        detail: input.detail,
        turnId: input.turnId ?? prev?.turnId,
        event: 'permission_request',
        updatedAt: now,
      }

    case 'terminal_error':
      // spec 050: the ONLY event fed by the opt-in terminal-output observer (the
      // `agentStatusScraping` setting). Latches the badge red until the next
      // user_prompt_submit / session_start / demote -- see the `latched` guard at the
      // top of each preserving case. Carries no turn id (the detector has no turn
      // context), so it inherits the prior turn id to keep the tooltip coherent.
      return {
        status: 'error',
        detail: input.detail ?? 'terminal error',
        turnId: prev?.turnId,
        event: 'terminal_error',
        updatedAt: now,
      }

    default:
      // Unknown event (not in the allow-list). Never throws; keep the prior state so a
      // stray/forward-incompatible event cannot blank a live badge.
      return prev
  }
}