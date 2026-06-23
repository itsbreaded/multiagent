import { useEffect } from 'react'
import { useUpdaterStore } from '../store/updater'
import { useSettingsStore } from '../store/settings'

export function UpdateBanner(): JSX.Element | null {
  const status = useUpdaterStore((s) => s.status)
  const dismissed = useUpdaterStore((s) => s.dismissed)
  const dismiss = useUpdaterStore((s) => s.dismiss)
  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled)

  // Keep main process in sync with the auto-update preference
  useEffect(() => {
    window.ipc.send('updater:set-enabled', autoUpdateEnabled)
  }, [autoUpdateEnabled])

  if (!status || status.state === 'error' || status.state === 'up-to-date') return null
  if (dismissed) return null

  let message: string
  let showRestart = false
  let showDownload = false

  if (status.state === 'available') {
    message = `Update v${status.version} available`
    showDownload = !autoUpdateEnabled
  } else if (status.state === 'downloading') {
    message = `Downloading update… ${status.percent}%`
  } else {
    message = `Update v${status.version} ready to install`
    showRestart = true
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        height: '28px',
        flexShrink: 0,
        backgroundColor: '#1a1b1e',
        fontSize: '12px',
        color: '#888',
      }}
    >
      <span>{message}</span>
      {showDownload && (
        <button
          onClick={() => window.ipc.send('updater:download')}
          style={actionButtonStyle}
        >
          Download
        </button>
      )}
      {showRestart && (
        <button
          onClick={() => window.ipc.send('updater:install')}
          style={actionButtonStyle}
        >
          Restart to install
        </button>
      )}
      {(showRestart || showDownload) && (
        <button
          onClick={dismiss}
          style={dismissButtonStyle}
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

const actionButtonStyle: React.CSSProperties = {
  padding: '1px 10px',
  backgroundColor: 'transparent',
  border: '1px solid #4ade80',
  borderRadius: '4px',
  color: '#4ade80',
  fontSize: '11px',
  cursor: 'pointer',
}

const dismissButtonStyle: React.CSSProperties = {
  padding: '1px 8px',
  backgroundColor: 'transparent',
  border: '1px solid #3a3b3e',
  borderRadius: '4px',
  color: '#555',
  fontSize: '11px',
  cursor: 'pointer',
}
