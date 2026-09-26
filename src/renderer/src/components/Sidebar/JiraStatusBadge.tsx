import React from 'react'
import type { JiraRowState } from '../../store/jira'
import { border, ui } from '../../styles/theme'

export function JiraStatusBadge({ row }: { row: JiraRowState }): JSX.Element {
  const statusText = row.phase === 'loading'
    ? (row.statusName ? `${row.statusName} (refreshing…)` : 'Jira…')
    : row.phase === 'unavailable'
      ? 'Jira unavailable'
      : row.phase === 'stale'
        ? `${row.statusName ?? 'Jira status'} (stale)`
        : (row.statusName ?? 'Jira status')
  const title = row.errorMessage
    ? `${statusText}: ${row.errorMessage}`
    : `${row.issueKey}: ${statusText}`
  const style: React.CSSProperties = {
    display: 'inline-block',
    maxWidth: 150,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '1px 5px',
    border: border.default,
    borderRadius: ui.radius.xs,
    color: row.phase === 'unavailable' ? ui.color.textDim : row.phase === 'stale' ? ui.color.accent : ui.color.textMuted,
    fontSize: 10,
    lineHeight: '14px',
    textDecoration: row.linkable ? 'underline' : 'none',
    cursor: row.linkable ? 'pointer' : 'default',
    opacity: row.phase === 'loading' ? 0.8 : 1,
  }

  if (!row.linkable || !row.issueUrl) {
    return <span title={title} aria-label={title} style={style}>{statusText}</span>
  }

  function openIssue(event: React.MouseEvent<HTMLAnchorElement>): void {
    event.preventDefault()
    event.stopPropagation()
    void window.ipc.invoke('jira:open-issue', row.issueKey).catch(() => {})
  }

  return (
    <a
      href={row.issueUrl}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={title}
      style={style}
      onClick={openIssue}
      onAuxClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {statusText}
    </a>
  )
}
