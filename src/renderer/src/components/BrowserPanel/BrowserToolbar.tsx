interface BrowserToolbarProps {
  url: string
  state: 'hidden' | 'agent-controlled' | 'user-controlled'
  onClose: () => void
  onTakeControl: () => void
}

export function BrowserToolbar({ url, state, onClose, onTakeControl }: BrowserToolbarProps) {
  return (
    <div className="flex items-center gap-2 h-9 px-3 bg-[#1a1b1e] border-b border-[#2a2b2e] shrink-0">
      {/* State indicator */}
      {state === 'agent-controlled' && (
        <span className="text-xs text-[#4ade80] flex items-center gap-1">
          <span className="animate-pulse">●</span> Agent
        </span>
      )}
      {state === 'user-controlled' && (
        <span className="text-xs text-amber-400">● You</span>
      )}

      {/* URL bar (read-only) */}
      <div className="flex-1 bg-[#0e1011] rounded px-2 py-0.5 text-xs text-[#6b7280] font-mono truncate">
        {url || 'about:blank'}
      </div>

      {/* Take control button (only when agent is controlling) */}
      {state === 'agent-controlled' && (
        <button
          onClick={onTakeControl}
          className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
        >
          Take control
        </button>
      )}

      {/* Close */}
      <button
        onClick={onClose}
        className="text-[#6b7280] hover:text-white text-sm w-5 h-5 flex items-center justify-center"
      >
        ✕
      </button>
    </div>
  )
}
