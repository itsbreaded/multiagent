import { useEffect, useState } from 'react'
import { BrowserToolbar } from './BrowserToolbar'

type BrowserState = 'hidden' | 'agent-controlled' | 'user-controlled'

interface BrowserPanelProps {
  visible: boolean
  onClose: () => void
}

export function BrowserPanel({ visible, onClose }: BrowserPanelProps) {
  const [state, setState] = useState<BrowserState>('hidden')
  const [currentUrl, setCurrentUrl] = useState('')

  useEffect(() => {
    // Subscribe to browser state changes from main process
    const unsub = window.ipc.on('browser:agent-active', (active: unknown) => {
      setState(active ? 'agent-controlled' : 'user-controlled')
    })
    return unsub
  }, [])

  // Keep currentUrl in sync - in practice the main process would push url updates
  // via a dedicated IPC event; for now it's managed locally
  void setCurrentUrl

  if (!visible) return null

  return (
    <div
      className="flex flex-col border-t border-[#2a2b2e]"
      style={{ height: '40%' }}
    >
      <BrowserToolbar
        url={currentUrl}
        state={state}
        onClose={onClose}
        onTakeControl={() => {
          setState('user-controlled')
          window.ipc.invoke('browser:toggle')
        }}
      />
      {state === 'agent-controlled' && (
        <div className="absolute inset-0 top-[36px] flex items-center justify-center pointer-events-none">
          <div className="bg-black/60 rounded-lg px-4 py-2 text-sm text-[#4ade80] flex items-center gap-2">
            <span className="animate-pulse">●</span>
            Agent is browsing
          </div>
        </div>
      )}
      {/*
        Note: actual browser content is rendered by Electron WebContentsView (native layer)
        positioned below this component. This React component is only the chrome/overlay.
      */}
      <div className="flex-1 bg-transparent" />
    </div>
  )
}
