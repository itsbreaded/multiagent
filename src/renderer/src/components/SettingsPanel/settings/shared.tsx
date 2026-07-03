import type React from 'react'
import { ui } from '../../../styles/theme'

export function SettingControlRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }): JSX.Element {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '9px 14px', borderBottom: `1px solid ${ui.color.borderSubtle}` }}><div><div style={{ color: ui.color.text, fontSize: 12 }}>{title}</div><div style={{ color: ui.color.textDim, fontSize: 11, marginTop: 2 }}>{description}</div></div>{children}</div>
}
export const checkStyle = { display: 'flex', alignItems: 'center', gap: 8, color: ui.color.text, fontSize: 12 } as const
export const inputStyle = { width: 80, backgroundColor: '#0e0f11', border: `1px solid ${ui.color.textFaint}`, borderRadius: 4, color: '#d4d4d4', fontSize: 12, padding: '5px 7px', textAlign: 'right' } as const
export function ChoiceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return <button onClick={onClick} style={{ padding: '4px 12px', background: active ? ui.color.control : 'none', border: `1px solid ${active ? ui.color.accent : ui.color.border}`, borderRadius: ui.radius.sm, color: active ? ui.color.text : ui.color.textMuted, fontSize: 12, cursor: 'pointer', fontWeight: active ? 500 : 400 }}>{children}</button>
}
