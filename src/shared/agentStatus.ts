/** Pure lifecycle/evidence reducer. Main forwards; renderer state owns status. */

import type { AgentStatusState, AgentStatusInput, AgentWorkSnapshot } from './types'
import { hasAgentEvidenceIdentityMismatch, MAX_AGENT_TRACKED_IDENTITIES } from './agentStatusEvidence'

type RecoveryProvenance = NonNullable<AgentStatusState['recoveryProvenance']>

const TERMINAL_EVENTS = new Set<AgentStatusInput['event']>([
  'stop', 'stop_failure', 'permission_request', 'turn_interrupted', 'work_snapshot',
  'idle_prompt', 'bg_subagent_completed',
])
const IDENTITY_REQUIRED_TERMINAL_EVENTS = new Set<AgentStatusInput['event']>([
  'stop', 'turn_interrupted', 'work_snapshot', 'bg_subagent_completed',
])
const FOREGROUND_TURN_EVENTS = new Set<AgentStatusInput['event']>([
  'pre_tool_use', 'post_tool_use', 'permission_request', 'stop_failure', 'terminal_error',
])

function clearWork(state: AgentStatusState): AgentStatusState {
  const next = { ...state }
  delete next.activeBackgroundSubagents
  delete next.activeBackgroundSubagentIds
  delete next.activeWorkCount
  delete next.scheduledWorkCount
  delete next.activeWorkIds
  delete next.scheduledWorkIds
  delete next.workSnapshot
  return next
}

function clearRecovery(state: AgentStatusState): AgentStatusState {
  const next = { ...state }
  delete next.pendingInterrupt
  delete next.recoveryGeneration
  delete next.recoveryProvenance
  return next
}

function copyWorkTracking(target: AgentStatusState, source: AgentStatusState | undefined): void {
  if (!source) return
  if (source.activeWorkCount !== undefined) target.activeWorkCount = source.activeWorkCount
  if (source.scheduledWorkCount !== undefined) target.scheduledWorkCount = source.scheduledWorkCount
  if (source.activeWorkIds) target.activeWorkIds = [...source.activeWorkIds]
  if (source.scheduledWorkIds) target.scheduledWorkIds = [...source.scheduledWorkIds]
  if (source.workSnapshot) target.workSnapshot = source.workSnapshot
  if (source.completedBackgroundSubagentIds) {
    target.completedBackgroundSubagentIds = [...source.completedBackgroundSubagentIds]
  }
}

function copyProtection(target: AgentStatusState, source: AgentStatusState | undefined): void {
  if (!source) return
  if (source.suspensionBlocked) target.suspensionBlocked = true
  if (source.completedBackgroundSubagentIds) {
    target.completedBackgroundSubagentIds = [...source.completedBackgroundSubagentIds]
  }
}

function rememberCompletedBackgroundId(state: AgentStatusState, agentId: string | undefined): AgentStatusState {
  if (!agentId) return state
  const existing = state.completedBackgroundSubagentIds ?? []
  if (existing.includes(agentId)) return state
  const next = { ...state }
  next.completedBackgroundSubagentIds = [...existing, agentId].slice(-MAX_AGENT_TRACKED_IDENTITIES)
  return next
}

function withBackgroundTracking(state: AgentStatusState, count: number, ids: readonly string[]): AgentStatusState {
  const next = { ...state }
  delete next.activeBackgroundSubagents
  delete next.activeBackgroundSubagentIds
  if (count > 0) next.activeBackgroundSubagents = count
  if (ids.length > 0) next.activeBackgroundSubagentIds = [...ids]
  if (count > 0) {
    delete next.pendingInterrupt
    delete next.recoveryGeneration
  }
  return next
}

function activeWork(state: AgentStatusState | undefined): boolean {
  return Boolean(
    (state?.activeBackgroundSubagents ?? 0) > 0 ||
    (state?.activeWorkCount ?? 0) > 0 ||
    (state?.scheduledWorkCount ?? 0) > 0 ||
    (state?.workSnapshot?.activeCount ?? 0) > 0 ||
    (state?.workSnapshot?.scheduledCount ?? 0) > 0,
  )
}

function identityFromInput(input: AgentStatusInput): { sessionId?: string; turnId?: string } {
  return { sessionId: input.sessionId ?? input.evidence?.sessionId, turnId: input.turnId ?? input.evidence?.turnId }
}

function isStaleSession(prev: AgentStatusState | undefined, input: AgentStatusInput): boolean {
  if (!prev?.sessionId) return false
  const incoming = identityFromInput(input).sessionId
  return incoming !== undefined && incoming !== prev.sessionId
}

function terminalIdentityMissing(prev: AgentStatusState, input: AgentStatusInput): boolean {
  const incoming = identityFromInput(input)
  return !prev.sessionId || !prev.turnId || !incoming.sessionId || !incoming.turnId ||
    prev.sessionId !== incoming.sessionId || prev.turnId !== incoming.turnId
}

function idlePromptCanRecover(prev: AgentStatusState, input: AgentStatusInput): boolean {
  const incoming = identityFromInput(input)
  if (input.agentKind && input.agentKind !== 'claude') return false
  return Boolean(
    prev.status === 'working' && prev.sessionId && prev.turnId &&
    incoming.sessionId === prev.sessionId && incoming.turnId === prev.turnId && !activeWork(prev) &&
    !hasCurrentBusyWorkSnapshot(prev) &&
    prev.event !== 'terminal_error',
  )
}

function staleForegroundTurn(prev: AgentStatusState | undefined, input: AgentStatusInput): boolean {
  // A different turn id while the pane is working is an old in-flight hook from a
  // previous turn. When the pane is idle, a different id is instead the first signal
  // of a new turn (there is no UserPromptSubmit ordering guarantee across providers).
  if (input.agentKind && input.agentKind !== 'claude') return false
  if (!prev || !FOREGROUND_TURN_EVENTS.has(input.event) || !prev.turnId || prev.status === 'idle') return false
  const incomingTurn = identityFromInput(input).turnId
  return incomingTurn !== undefined && incomingTurn !== prev.turnId
}

function hasCompleteEmptyWorkSnapshot(state: AgentStatusState): boolean {
  const snapshot = state.workSnapshot
  return snapshot?.completeness === 'complete' &&
    snapshot.activeCount === 0 && snapshot.scheduledCount === 0 &&
    Boolean(state.sessionId && state.turnId && snapshot.sessionId === state.sessionId && snapshot.turnId === state.turnId)
}

function hasCurrentBusyWorkSnapshot(state: AgentStatusState): boolean {
  const snapshot = state.workSnapshot
  return (snapshot?.terminalState === 'busy' || snapshot?.terminalState === 'retry') &&
    Boolean(state.sessionId && state.turnId && snapshot.sessionId === state.sessionId && snapshot.turnId === state.turnId)
}

function isCrossTurnBackgroundEvent(prev: AgentStatusState, input: AgentStatusInput): boolean {
  if (input.event !== 'bg_subagent_started' && input.event !== 'bg_subagent_completed') return false
  const incoming = identityFromInput(input)
  return Boolean(prev.sessionId && prev.turnId && incoming.sessionId === prev.sessionId &&
    incoming.turnId && incoming.turnId !== prev.turnId)
}

function backgroundSessionMatches(prev: AgentStatusState, input: AgentStatusInput): boolean {
  const incomingSession = identityFromInput(input).sessionId
  return Boolean(incomingSession && (!prev.sessionId || incomingSession === prev.sessionId))
}

function withSnapshot(state: AgentStatusState, snapshot: AgentWorkSnapshot, provenance: RecoveryProvenance, now: number): AgentStatusState {
  const next = clearWork(state)
  next.activeWorkCount = snapshot.activeCount
  next.scheduledWorkCount = snapshot.scheduledCount
  if (snapshot.activeIds?.length) next.activeWorkIds = [...snapshot.activeIds]
  if (snapshot.scheduledIds?.length) next.scheduledWorkIds = [...snapshot.scheduledIds]
  if (snapshot.provider === 'claude' && snapshot.activeCount > 0) {
    next.activeBackgroundSubagents = snapshot.activeCount
    if (snapshot.activeIds?.length) next.activeBackgroundSubagentIds = [...snapshot.activeIds]
  }
  next.workSnapshot = snapshot
  next.recoveryProvenance = provenance
  next.updatedAt = now
  return next
}

function reconcileSnapshot(prev: AgentStatusState, input: AgentStatusInput, now: number, provenance: RecoveryProvenance): AgentStatusState {
  const snapshot = input.evidence
  if (!snapshot) return prev
  if (snapshot.completeness !== 'complete') {
    // Incomplete active evidence is still protective. Incomplete zero evidence cannot
    // erase an earlier work record because the provider did not prove coverage. It
    // also cannot leave an already-idle pane suspension-eligible: unknown coverage
    // remains suspension-blocked until a complete snapshot arrives. A current,
    // completed Stop may nevertheless clear the visible foreground badge when no
    // work is positively observed; this is the same split as idle_prompt recovery.
    const protective = snapshot.activeCount > 0 || snapshot.scheduledCount > 0
      ? withSnapshot(prev, snapshot, provenance, now)
      : { ...prev, workSnapshot: snapshot, recoveryProvenance: provenance, updatedAt: now }
    protective.sessionId = prev.sessionId ?? snapshot.sessionId ?? input.sessionId
    protective.turnId = prev.turnId ?? snapshot.turnId ?? input.turnId
    protective.event = input.event
    copyProtection(protective, prev)
    delete protective.pendingInterrupt
    delete protective.recoveryGeneration
    const preserveTerminalState = prev.status === 'waiting' || prev.status === 'error' || prev.event === 'terminal_error'
    const completedStopWithoutKnownWork = input.event === 'stop' && snapshot.terminalState === 'completed' &&
      snapshot.activeCount === 0 && snapshot.scheduledCount === 0
    if (completedStopWithoutKnownWork && !preserveTerminalState) {
      protective.status = 'idle'
      protective.suspensionBlocked = true
      delete protective.detail
    } else if (!preserveTerminalState) {
      protective.status = 'working'
      protective.detail = 'background work'
    }
    return protective
  }
  const next = withSnapshot(prev, snapshot, provenance, now)
  next.sessionId = prev.sessionId ?? snapshot.sessionId ?? input.sessionId
  next.turnId = prev.turnId ?? snapshot.turnId ?? input.turnId
  next.event = input.event
  if (snapshot.activeCount > 0 || snapshot.scheduledCount > 0) {
    delete next.pendingInterrupt
    delete next.recoveryGeneration
    if (prev.status !== 'waiting' && prev.status !== 'error' && prev.event !== 'terminal_error') {
      next.status = 'working'
      next.detail = 'background work'
    }
    return next
  }
  if (prev.status === 'waiting' || prev.status === 'error' || prev.event === 'terminal_error') return next
  if (snapshot.terminalState === 'busy' || snapshot.terminalState === 'retry') {
    next.status = 'working'
    next.detail = input.detail ?? snapshot.terminalState
    return next
  }
  if (snapshot.terminalState === 'failed') {
    next.status = 'error'
    next.detail = input.detail ?? 'error'
    return next
  }
  next.status = 'idle'
  delete next.detail
  delete next.suspensionBlocked
  return next
}

/** Reduce one validated lifecycle/evidence event. */
export function eventToState(prev: AgentStatusState | undefined, input: AgentStatusInput, now: number): AgentStatusState | undefined {
  // Never downgrade a conflicting envelope to a bare lifecycle event.
  if (hasAgentEvidenceIdentityMismatch(input)) return prev

  const latched = prev?.event === 'terminal_error'
  const activeCount = prev?.activeBackgroundSubagents ?? 0
  const activeIds = prev?.activeBackgroundSubagentIds ?? []

  if (isStaleSession(prev, input) && input.event !== 'session_start' && input.event !== 'user_prompt_submit') return prev
  if (TERMINAL_EVENTS.has(input.event) && !prev) return prev
  if (prev && IDENTITY_REQUIRED_TERMINAL_EVENTS.has(input.event) && input.event !== 'bg_subagent_completed' && terminalIdentityMissing(prev, input)) return prev
  if (staleForegroundTurn(prev, input)) return prev
  if (prev && (input.event === 'bg_subagent_started' || input.event === 'bg_subagent_completed') &&
    !backgroundSessionMatches(prev, input)) return prev
  if (prev && input.event === 'idle_prompt' && !idlePromptCanRecover(prev, input)) return prev

  switch (input.event) {
    case 'demote': return undefined
    case 'promote':
      if (latched) return prev
      return { status: 'working', event: 'promote', updatedAt: now }

    case 'session_start': {
      const reportedSessionId = input.sessionId ?? input.evidence?.sessionId
      const sessionId = reportedSessionId ?? prev?.sessionId
      const changed = Boolean(prev?.sessionId && sessionId && prev.sessionId !== sessionId)
      if (changed || !prev) return { status: 'idle', ...(sessionId ? { sessionId } : {}), event: 'session_start', updatedAt: now }
      if (latched) return { status: 'idle', ...(sessionId ? { sessionId } : {}), event: 'session_start', updatedAt: now }
      if (!reportedSessionId && !prev.pendingInterrupt && !prev.recoveryGeneration && !prev.recoveryProvenance &&
        !prev.suspensionBlocked && !prev.completedBackgroundSubagentIds) return prev
      const next = clearRecovery(prev)
      delete next.suspensionBlocked
      delete next.completedBackgroundSubagentIds
      next.sessionId = sessionId
      if (activeWork(next)) next.status = 'working'
      next.event = prev.event ?? 'session_start'
      return next
    }

    case 'user_prompt_submit': {
      const sessionId = input.sessionId ?? input.evidence?.sessionId ?? prev?.sessionId
      const next = clearRecovery({
        status: 'working', ...(sessionId ? { sessionId } : {}),
        turnId: input.turnId ?? input.evidence?.turnId, event: input.event, updatedAt: now,
      })
      const sameSession = !prev?.sessionId || !sessionId || prev.sessionId === sessionId
      if (sameSession) copyWorkTracking(next, prev)
      return withBackgroundTracking(next, sameSession ? activeCount : 0, sameSession ? activeIds : [])
    }

    case 'interrupt_requested': {
      if (!prev?.sessionId || !prev.turnId) return prev
      const sessionId = input.sessionId ?? prev.sessionId
      const turnId = input.turnId ?? prev.turnId
      if (sessionId !== prev.sessionId || turnId !== prev.turnId) return prev
      const generation = input.recoveryGeneration ?? ((prev.recoveryGeneration ?? 0) + 1)
      return { ...prev, recoveryGeneration: generation, pendingInterrupt: { sessionId, turnId, generation }, updatedAt: now }
    }

    case 'idle_prompt': {
      const next = clearWork(prev as AgentStatusState)
      next.status = 'idle'
      next.event = input.event
      next.recoveryProvenance = 'idle_prompt_recovery'
      delete next.detail
      delete next.pendingInterrupt
      next.updatedAt = now
      if (!hasCompleteEmptyWorkSnapshot(prev as AgentStatusState)) next.suspensionBlocked = true
      else delete next.suspensionBlocked
      return next
    }

    case 'work_snapshot':
      return reconcileSnapshot(prev as AgentStatusState, input, now, 'stale_work_reconciliation')
    case 'turn_interrupted':
      return reconcileSnapshot(prev as AgentStatusState, input, now, 'interrupt_recovery')

    case 'pre_tool_use':
    case 'post_tool_use': {
      if (latched) return prev
      if (prev?.status === 'idle' && (input.turnId === undefined || input.turnId === prev.turnId)) return prev
      return withBackgroundTracking({
        status: 'working', ...(input.sessionId ?? input.evidence?.sessionId ?? prev?.sessionId
          ? { sessionId: input.sessionId ?? input.evidence?.sessionId ?? prev?.sessionId } : {}),
        detail: input.detail, turnId: input.turnId ?? prev?.turnId, event: input.event, updatedAt: now,
        ...(prev ? { activeWorkCount: prev.activeWorkCount, scheduledWorkCount: prev.scheduledWorkCount,
          activeWorkIds: prev.activeWorkIds, scheduledWorkIds: prev.scheduledWorkIds, workSnapshot: prev.workSnapshot,
          suspensionBlocked: prev.suspensionBlocked, completedBackgroundSubagentIds: prev.completedBackgroundSubagentIds } : {}),
      }, activeCount, activeIds)
    }

    case 'stop':
      if (latched) return prev
      if (input.evidence) return reconcileSnapshot(prev as AgentStatusState, input, now, 'ordinary_completion')
      // Codex's managed Stop hook has no provider work snapshot. Its lifecycle
      // completion is still authoritative for the normal turn, while Claude and
      // OpenCode must retain the evidence-required fail-closed behavior.
      if (input.agentKind === 'codex') {
        const next = { ...prev, status: 'idle' as const, event: 'stop' as const, updatedAt: now }
        delete next.detail
        return next
      }
      return prev

    case 'stop_failure':
      return withBackgroundTracking({
        status: 'error', sessionId: prev?.sessionId ?? input.sessionId, detail: input.detail ?? 'error',
        turnId: input.turnId ?? prev?.turnId, event: 'stop_failure', updatedAt: now,
        ...(prev ? { activeWorkCount: prev.activeWorkCount, scheduledWorkCount: prev.scheduledWorkCount,
          activeWorkIds: prev.activeWorkIds, scheduledWorkIds: prev.scheduledWorkIds, workSnapshot: prev.workSnapshot,
          suspensionBlocked: prev.suspensionBlocked, completedBackgroundSubagentIds: prev.completedBackgroundSubagentIds } : {}),
      }, activeCount, activeIds)

    case 'permission_request':
      if (latched) return prev
      return withBackgroundTracking({
        status: 'waiting', sessionId: prev?.sessionId ?? input.sessionId, detail: input.detail,
        turnId: input.turnId ?? prev?.turnId, event: 'permission_request', updatedAt: now,
        ...(prev ? { activeWorkCount: prev.activeWorkCount, scheduledWorkCount: prev.scheduledWorkCount,
          activeWorkIds: prev.activeWorkIds, scheduledWorkIds: prev.scheduledWorkIds, workSnapshot: prev.workSnapshot,
          suspensionBlocked: prev.suspensionBlocked, completedBackgroundSubagentIds: prev.completedBackgroundSubagentIds } : {}),
      }, activeCount, activeIds)

    case 'terminal_error':
      return withBackgroundTracking({
        status: 'error', sessionId: prev?.sessionId ?? input.sessionId, detail: input.detail ?? 'terminal error',
        turnId: prev?.turnId, event: 'terminal_error', updatedAt: now,
        ...(prev ? { activeWorkCount: prev.activeWorkCount, scheduledWorkCount: prev.scheduledWorkCount,
          activeWorkIds: prev.activeWorkIds, scheduledWorkIds: prev.scheduledWorkIds, workSnapshot: prev.workSnapshot,
          suspensionBlocked: prev.suspensionBlocked, completedBackgroundSubagentIds: prev.completedBackgroundSubagentIds } : {}),
      }, activeCount, activeIds)

    case 'bg_subagent_started': {
      const agentId = input.agentId?.trim() || undefined
      if (agentId && prev?.completedBackgroundSubagentIds?.includes(agentId)) return prev
      if (agentId && activeIds.includes(agentId)) return prev
      const nextCount = Math.max(0, activeCount) + 1
      const nextIds = agentId ? [...activeIds, agentId] : activeIds
      if (prev && (latched || prev.status === 'waiting' || prev.status === 'error')) return withBackgroundTracking({ ...prev, updatedAt: now }, nextCount, nextIds)
      const preserveForeground = Boolean(prev && isCrossTurnBackgroundEvent(prev, input) && prev.status !== 'idle')
      return withBackgroundTracking({
        status: preserveForeground ? prev!.status : 'working',
        sessionId: prev?.sessionId ?? input.sessionId,
        detail: preserveForeground ? prev?.detail : input.detail ?? 'background subagent',
        turnId: preserveForeground ? prev!.turnId : input.turnId ?? prev?.turnId,
        event: preserveForeground ? prev!.event : input.event,
        ...(prev ? { suspensionBlocked: prev.suspensionBlocked, completedBackgroundSubagentIds: prev.completedBackgroundSubagentIds } : {}),
        updatedAt: now,
      }, nextCount, nextIds)
    }

    case 'bg_subagent_completed': {
      // Claude's SubagentStop payload can carry the provider's complete task/cron
      // snapshot. Prefer that authoritative reconciliation over the legacy
      // single-identity counter; one child completion must not hide siblings or
      // scheduled work.
      if (input.evidence) {
        const current = prev as AgentStatusState
        const crossTurn = isCrossTurnBackgroundEvent(current, input)
        const reconciled = reconcileSnapshot(current, input, now, 'ordinary_completion')
        const agentId = input.agentId?.trim() || undefined
        const next = agentId ? rememberCompletedBackgroundId(reconciled, agentId) : reconciled
        if (crossTurn) {
          next.event = current.event
          next.turnId = current.turnId
          if (current.status === 'working' && !activeWork(next)) {
            next.status = 'working'
            if (current.detail) next.detail = current.detail
            else delete next.detail
          }
        }
        return next
      }
      const agentId = input.agentId?.trim() || undefined
      if (!prev) return prev
      if (!agentId) return prev
      const index = activeIds.indexOf(agentId)
      // An unknown id while another known child is active is not enough to infer
      // completion-before-start; it may be a stale or foreign child notification.
      // Tombstone only an otherwise-untracked completion so a later duplicate start
      // cannot resurrect a child that already finished.
      if (index < 0) return activeIds.length === 0 ? rememberCompletedBackgroundId(prev, agentId) : prev
      const nextIds = activeIds.filter((id) => id !== agentId)
      const nextCount = Math.max(0, activeCount - 1)
      const reconciled = withBackgroundTracking(rememberCompletedBackgroundId({ ...prev, updatedAt: now }, agentId), nextCount, nextIds)
      // A provider-authorized completion may release its own known aggregate
      // identity, but it cannot decrement an aggregate count whose identities
      // were not supplied.
      if (reconciled.activeWorkIds?.includes(agentId)) {
        const remainingIds = reconciled.activeWorkIds.filter((id) => id !== agentId)
        reconciled.activeWorkIds = remainingIds.length > 0 ? remainingIds : undefined
        reconciled.activeWorkCount = Math.max(0, (reconciled.activeWorkCount ?? 0) - 1)
        if (reconciled.workSnapshot?.completeness === 'complete') {
          reconciled.workSnapshot = {
            ...reconciled.workSnapshot,
            activeCount: reconciled.activeWorkCount,
            ...(remainingIds.length > 0 ? { activeIds: remainingIds } : { activeIds: undefined }),
          }
        }
      }
      if (latched) return reconciled
      if (nextCount > 0) {
        if (prev.status === 'waiting' || prev.status === 'error') return reconciled
        return { ...reconciled, status: 'working', detail: 'background subagent' }
      }
      const remainingUnknownWork = reconciled.workSnapshot?.completeness === 'incomplete'
      if (activeWork(reconciled) || remainingUnknownWork) return reconciled
      const cleared = clearWork(reconciled)
      if (reconciled.workSnapshot?.completeness === 'complete' &&
        reconciled.workSnapshot.activeCount === 0 && reconciled.workSnapshot.scheduledCount === 0) {
        delete cleared.suspensionBlocked
      }
      if (prev.status === 'working' && prev.event === 'stop') {
        delete cleared.detail
        return { ...cleared, status: 'idle', sessionId: prev.sessionId, turnId: prev.turnId, event: 'stop', updatedAt: now }
      }
      return { ...cleared, updatedAt: now }
    }

    default: return prev
  }
}
