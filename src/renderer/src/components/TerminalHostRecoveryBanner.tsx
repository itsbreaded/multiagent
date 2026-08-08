import { useTerminalHostStore } from '../store/terminalHost'
import { ui } from '../styles/theme'

export function TerminalHostRecoveryBanner(): JSX.Element | null {
  const status = useTerminalHostStore((s) => s.status)
  const restart = useTerminalHostStore((s) => s.restart)
  if (!status) return null

  const failed = status.state === 'failed'
  const message = failed
    ? 'Terminal host recovery failed. Restart MultiAgent to restore your terminals.'
    : 'Terminal host unavailable. Restoring your terminals…'

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        minHeight: 28,
        padding: '0 12px',
        flexShrink: 0,
        backgroundColor: ui.color.panel,
        borderBottom: `1px solid ${failed ? ui.color.danger : ui.color.border}`,
        color: failed ? ui.color.danger : ui.color.textMuted,
        fontSize: 12,
      }}
    >
      <span>{message}</span>
      {failed && (
        <button
          type="button"
          onClick={() => { void restart() }}
          style={{
            padding: '2px 10px',
            backgroundColor: 'transparent',
            border: `1px solid ${ui.color.accent}`,
            borderRadius: ui.radius.sm,
            color: ui.color.accent,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Restart MultiAgent
        </button>
      )}
    </div>
  )
}
