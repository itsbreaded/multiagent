import type { AgentEventMeta, AgentLifecycleEvent } from '../../shared/types'
import type { AgentEventReport } from './agentSessionReportServer'

export type AgentEventForwardTarget = (
  ptyId: string,
  event: AgentLifecycleEvent,
  detail: string | undefined,
  turnId: string | undefined,
  agentId: string | undefined,
  meta: AgentEventMeta | undefined,
) => void

/** Preserve the validated report envelope across the main -> renderer IPC boundary. */
export function forwardAgentEvent(report: AgentEventReport, target: AgentEventForwardTarget): void {
  const meta: AgentEventMeta | undefined = report.sessionId || report.evidence
    ? {
        ...(report.sessionId ? { sessionId: report.sessionId } : {}),
        ...(report.evidence ? { evidence: report.evidence } : {}),
      }
    : undefined
  target(report.ptyId, report.event, report.detail, report.turnId, report.agentId, meta)
}
