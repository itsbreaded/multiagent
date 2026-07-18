import { describe, it, expect } from 'vitest'
import { eventToState } from './agentStatus'
import type { AgentStatusState, AgentLifecycleEvent } from './types'

// Spec 032: the pure reducer that maps agent lifecycle hook events to badge state.
// Every truth-table row + the turn-id guard + cold-start seeding is covered. `now` is
// injected so the assertions are deterministic (no vi.setSystemTime needed).

const NOW = 1_700_000_000_000

function ev(event: AgentLifecycleEvent, detail?: string, turnId?: string) {
  return eventToState(undefined, { event, detail, turnId }, NOW)
}

describe('eventToState -- truth table', () => {
  it('demote clears the badge (returns undefined)', () => {
    const prev: AgentStatusState = { status: 'working', event: 'pre_tool_use', updatedAt: NOW - 5 }
    expect(eventToState(prev, { event: 'demote' }, NOW)).toBeUndefined()
  })

  it('promote seeds working with no turnId/detail', () => {
    expect(eventToState(undefined, { event: 'promote' }, NOW)).toEqual({
      status: 'working',
      event: 'promote',
      updatedAt: NOW,
    })
  })

  it('session_start seeds idle on cold start (a session ready, waiting for input)', () => {
    expect(ev('session_start', undefined, 'turn-1')).toEqual({
      status: 'idle',
      event: 'session_start',
      updatedAt: NOW,
    })
  })

  it('session_start preserves an existing state (never flips a live turn to idle)', () => {
    const working: AgentStatusState = { status: 'working', turnId: 'turn-1', event: 'user_prompt_submit', updatedAt: NOW - 5 }
    expect(eventToState(working, { event: 'session_start' }, NOW)).toBe(working)
    const idle: AgentStatusState = { status: 'idle', turnId: 'turn-1', event: 'stop', updatedAt: NOW - 5 }
    expect(eventToState(idle, { event: 'session_start' }, NOW)).toBe(idle)
  })

  it('session_start seeds idle without a turn id (Codex defers, or older Claude)', () => {
    expect(ev('session_start')).toEqual({
      status: 'idle',
      event: 'session_start',
      updatedAt: NOW,
    })
  })

  it('user_prompt_submit seeds a fresh working turn', () => {
    expect(ev('user_prompt_submit', undefined, 'turn-2')).toEqual({
      status: 'working',
      turnId: 'turn-2',
      event: 'user_prompt_submit',
      updatedAt: NOW,
    })
  })

  it('pre_tool_use sets working with the tool name as detail', () => {
    const prev: AgentStatusState = { status: 'working', turnId: 'turn-1', event: 'user_prompt_submit', updatedAt: NOW - 5 }
    expect(eventToState(prev, { event: 'pre_tool_use', detail: 'Bash', turnId: 'turn-1' }, NOW)).toEqual({
      status: 'working',
      detail: 'Bash',
      turnId: 'turn-1',
      event: 'pre_tool_use',
      updatedAt: NOW,
    })
  })

  it('post_tool_use keeps working while a tool runs', () => {
    const prev: AgentStatusState = { status: 'working', detail: 'Bash', turnId: 'turn-1', event: 'pre_tool_use', updatedAt: NOW - 5 }
    expect(eventToState(prev, { event: 'post_tool_use', detail: 'Read', turnId: 'turn-1' }, NOW)).toEqual({
      status: 'working',
      detail: 'Read',
      turnId: 'turn-1',
      event: 'post_tool_use',
      updatedAt: NOW,
    })
  })

  it('stop ends the turn to idle and clears the per-tool detail', () => {
    const prev: AgentStatusState = { status: 'working', detail: 'Bash', turnId: 'turn-1', event: 'pre_tool_use', updatedAt: NOW - 5 }
    expect(eventToState(prev, { event: 'stop', turnId: 'turn-1' }, NOW)).toEqual({
      status: 'idle',
      turnId: 'turn-1',
      event: 'stop',
      updatedAt: NOW,
    })
  })

  it('stop_failure sets error (Claude only) with detail falling back to "error"', () => {
    expect(ev('stop_failure', undefined, 'turn-1')).toEqual({
      status: 'error',
      detail: 'error',
      turnId: 'turn-1',
      event: 'stop_failure',
      updatedAt: NOW,
    })
    const prev: AgentStatusState = { status: 'working', turnId: 'turn-1', event: 'pre_tool_use', updatedAt: NOW - 5 }
    expect(eventToState(prev, { event: 'stop_failure', detail: 'api_error', turnId: 'turn-1' }, NOW)).toEqual({
      status: 'error',
      detail: 'api_error',
      turnId: 'turn-1',
      event: 'stop_failure',
      updatedAt: NOW,
    })
  })

  it('permission_request sets waiting and inherits the prior turn id when omitted', () => {
    const prev: AgentStatusState = { status: 'working', turnId: 'turn-1', event: 'pre_tool_use', updatedAt: NOW - 5 }
    expect(eventToState(prev, { event: 'permission_request', detail: 'Allow Bash?' }, NOW)).toEqual({
      status: 'waiting',
      detail: 'Allow Bash?',
      turnId: 'turn-1',
      event: 'permission_request',
      updatedAt: NOW,
    })
  })

  it('permission_request seeds from cold start without a prior turn id', () => {
    expect(ev('permission_request', 'Allow Bash?', 'turn-1')).toEqual({
      status: 'waiting',
      detail: 'Allow Bash?',
      turnId: 'turn-1',
      event: 'permission_request',
      updatedAt: NOW,
    })
  })
})

describe('eventToState -- turn-id guard (out-of-order late tool event after stop)', () => {
  const idle: AgentStatusState = { status: 'idle', turnId: 'turn-1', event: 'stop', updatedAt: NOW - 10 }

  it('drops a late tool event from the SAME turn id (keeps idle)', () => {
    expect(eventToState(idle, { event: 'post_tool_use', detail: 'Bash', turnId: 'turn-1' }, NOW)).toBe(idle)
    expect(eventToState(idle, { event: 'pre_tool_use', detail: 'Bash', turnId: 'turn-1' }, NOW)).toBe(idle)
  })

  it('drops a late tool event with NO turn id (older Claude; cannot disambiguate)', () => {
    expect(eventToState(idle, { event: 'post_tool_use', detail: 'Bash' }, NOW)).toBe(idle)
  })

  it('promotes to working when a tool event carries a DIFFERENT turn id (new turn)', () => {
    expect(eventToState(idle, { event: 'pre_tool_use', detail: 'Bash', turnId: 'turn-2' }, NOW)).toEqual({
      status: 'working',
      detail: 'Bash',
      turnId: 'turn-2',
      event: 'pre_tool_use',
      updatedAt: NOW,
    })
  })

  it('a new user_prompt_submit always wins over idle (fresh turn id)', () => {
    expect(eventToState(idle, { event: 'user_prompt_submit', turnId: 'turn-2' }, NOW)).toEqual({
      status: 'working',
      turnId: 'turn-2',
      event: 'user_prompt_submit',
      updatedAt: NOW,
    })
  })

  it('permission_request and stop_failure always apply even when idle (high-signal)', () => {
    const waiting = eventToState(idle, { event: 'permission_request', detail: 'Allow?' }, NOW)
    expect(waiting?.status).toBe('waiting')
    expect(waiting?.turnId).toBe('turn-1')
    const errored = eventToState(idle, { event: 'stop_failure', detail: 'boom' }, NOW)
    expect(errored?.status).toBe('error')
  })
})

describe('eventToState -- Codex first-message ordering (SessionStart fires on first message)', () => {
  // Codex defers SessionStart until the first user message creates the rollout, so it can
  // arrive alongside (or just after) UserPromptSubmit. session_start must not flip a live
  // working turn to idle in either ordering.
  it('UserPromptSubmit then SessionStart: stays working (SessionStart preserves state)', () => {
    const working = eventToState(undefined, { event: 'user_prompt_submit', turnId: 'codex-turn-1' }, NOW)
    expect(working?.status).toBe('working')
    const after = eventToState(working, { event: 'session_start', turnId: 'codex-turn-1' }, NOW + 1)
    expect(after).toBe(working) // unchanged -- not flipped to idle
  })

  it('SessionStart then UserPromptSubmit: seeds idle then promotes to working', () => {
    const seeded = eventToState(undefined, { event: 'session_start', turnId: 'codex-turn-1' }, NOW)
    expect(seeded?.status).toBe('idle')
    const after = eventToState(seeded, { event: 'user_prompt_submit', turnId: 'codex-turn-1' }, NOW + 1)
    expect(after?.status).toBe('working')
    expect(after?.turnId).toBe('codex-turn-1')
  })
})
describe('eventToState -- cold start and forward-compat', () => {
  it('any non-demote event seeds state from prev === undefined', () => {
    expect(ev('pre_tool_use', 'Bash', 'turn-1')?.status).toBe('working')
    expect(ev('stop', undefined, 'turn-1')?.status).toBe('idle')
    expect(ev('post_tool_use', 'Read')?.status).toBe('working')
  })

  it('an unknown event keeps the prior state and never throws', () => {
    const prev: AgentStatusState = { status: 'working', turnId: 'turn-1', event: 'pre_tool_use', updatedAt: NOW - 5 }
    // Cast: simulate a forward-incompatible event not in the allow-list.
    expect(eventToState(prev, { event: 'subagent_start' as AgentLifecycleEvent }, NOW)).toBe(prev)
    expect(eventToState(undefined, { event: 'subagent_start' as AgentLifecycleEvent }, NOW)).toBeUndefined()
  })
})