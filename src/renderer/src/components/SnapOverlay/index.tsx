import { useEffect, useState, useRef } from 'react'

interface SnapZone {
  targetWindowId: number
  side: 'left' | 'right' | 'top' | 'bottom'
  x: number
  y: number
  width: number
  height: number
}

export function SnapOverlay(): JSX.Element | null {
  const [zones, setZones] = useState<SnapZone[]>([])
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off = window.ipc.on('window:snap-zones', (raw: unknown) => {
      const incoming = raw as SnapZone[]
      setZones(incoming)

      // Auto-clear after 2s of no new snap-zone events
      if (clearTimer.current) clearTimeout(clearTimer.current)
      clearTimer.current = setTimeout(() => setZones([]), 2000)
    })
    return () => {
      off()
      if (clearTimer.current) clearTimeout(clearTimer.current)
    }
  }, [])

  if (zones.length === 0) return null

  return (
    <>
      {zones.map((zone, i) => {
        // Convert screen coordinates to window-relative coordinates
        const localX = zone.x - window.screenX
        const localY = zone.y - window.screenY

        const label = zone.side === 'left' ? '⇐' : zone.side === 'right' ? '⇒' : zone.side === 'top' ? '⇑' : '⇓'

        return (
          <div
            key={i}
            onClick={() => {
              window.ipc.invoke('window:snap-apply', zone.targetWindowId, zone.side).catch(() => {})
              setZones([])
            }}
            title={`Snap ${zone.side} — click to dock`}
            style={{
              position: 'fixed',
              left: localX,
              top: localY,
              width: zone.width,
              height: zone.height,
              backgroundColor: 'rgba(74, 222, 128, 0.25)',
              border: '2px solid #4ade80',
              borderRadius: 4,
              cursor: 'pointer',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#4ade80',
              fontSize: 18,
              fontWeight: 700,
              userSelect: 'none',
              transition: 'background-color 0.1s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(74, 222, 128, 0.45)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(74, 222, 128, 0.25)' }}
          >
            {label}
          </div>
        )
      })}
    </>
  )
}
