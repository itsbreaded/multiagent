import { ui } from '../styles/theme'
import { useDatabaseStatusStore } from '../store/databaseStatus'

export function DatabaseStatusBanner(): JSX.Element | null {
  const status = useDatabaseStatusStore((state) => state.status)
  if (!status || status.available) return null

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 28,
        padding: '0 12px',
        flexShrink: 0,
        backgroundColor: ui.color.panel,
        borderBottom: `1px solid ${ui.color.danger}`,
        color: ui.color.danger,
        fontSize: 12,
      }}
    >
      {status.message ?? 'Session search and Jira mentions are unavailable.'}
    </div>
  )
}
