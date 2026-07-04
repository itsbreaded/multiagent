import type React from 'react'
import { ui } from '../../styles/theme'

export function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ padding: '6px 14px 3px', fontSize: 10, fontWeight: 600, color: ui.color.textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{children}</div>
}
