import React, { useState, useEffect, useRef } from 'react'

interface DirPickerProps {
  title: string
  description?: string
  initial?: string
  confirmLabel?: string
  skipLabel?: string
  error?: string | null
  nameField?: boolean
  autoBrowse?: boolean
  onConfirm: (dir: string, name?: string) => void
  onSkip: () => void
}

export function DirPicker({
  title,
  description,
  initial = '',
  confirmLabel = 'Set',
  skipLabel = 'Skip',
  error = null,
  nameField = false,
  autoBrowse = false,
  onConfirm,
  onSkip,
}: DirPickerProps): JSX.Element {
  const [value, setValue] = useState(initial)
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const autoBrowseStartedRef = useRef(false)

  useEffect(() => {
    if (nameField) {
      nameRef.current?.focus()
    } else {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onSkip()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onSkip])

  async function browse(): Promise<void> {
    if (!window.ipc) return
    try {
      const picked = await window.ipc.invoke('dialog:pick-directory', title, value || initial) as string | null
      if (picked) setValue(picked)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!autoBrowse || autoBrowseStartedRef.current) return
    autoBrowseStartedRef.current = true
    void browse()
  // `browse` intentionally reads the current value when the effect fires.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBrowse])

  function handleConfirm(): void {
    const trimmedDir = value.trim()
    const trimmedName = name.trim() || undefined
    onConfirm(trimmedDir, trimmedName)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
      onClick={onSkip}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 520,
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #2a2b2e' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#d4d4d4', marginBottom: description ? 4 : 0 }}>
            {title}
          </div>
          {description && (
            <div style={{ fontSize: 12, color: '#6b7280' }}>{description}</div>
          )}
        </div>

        {/* Tab name input row (optional) */}
        {nameField && (
          <div style={{ padding: '14px 18px 0' }}>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select() }
              }}
              placeholder="Tab name (optional)"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: '#141517',
                border: '1px solid #2a2b2e',
                borderRadius: 5,
                color: '#d4d4d4',
                fontSize: 13,
                padding: '7px 10px',
                outline: 'none',
                caretColor: '#4ade80',
              }}
              onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#4ade80' }}
              onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#2a2b2e' }}
            />
          </div>
        )}

        {/* Path input row */}
        <div style={{ padding: error ? '14px 18px 8px' : '14px 18px', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleConfirm() }
            }}
            placeholder="e.g. C:\Users\you\projects\myapp"
            style={{
              flex: 1,
              background: '#141517',
              border: '1px solid #2a2b2e',
              borderRadius: 5,
              color: '#d4d4d4',
              fontSize: 13,
              padding: '7px 10px',
              outline: 'none',
              fontFamily: 'monospace',
              caretColor: '#4ade80',
            }}
            onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#4ade80' }}
            onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = '#2a2b2e' }}
          />
          <button
            onClick={browse}
            style={{
              padding: '7px 12px',
              background: 'none',
              border: '1px solid #2a2b2e',
              borderRadius: 5,
              color: '#c9cdd1',
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#4a4b4e' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#2a2b2e' }}
          >
            Browse...
          </button>
        </div>

        {error && (
          <div style={{ padding: '0 18px 12px', color: '#f87171', fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Action buttons */}
        <div
          style={{
            padding: '0 18px 14px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            onClick={onSkip}
            style={{
              padding: '6px 14px',
              background: 'none',
              border: '1px solid #2a2b2e',
              borderRadius: 5,
              color: '#6b7280',
              fontSize: 12,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#c9cdd1' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6b7280' }}
          >
            {skipLabel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!nameField && !value.trim()}
            style={{
              padding: '6px 16px',
              background: 'none',
              border: `1px solid ${nameField || value.trim() ? '#4ade80' : '#2a2b2e'}`,
              borderRadius: 5,
              color: nameField || value.trim() ? '#4ade80' : '#3a3b3e',
              fontSize: 12,
              cursor: nameField || value.trim() ? 'pointer' : 'default',
              fontWeight: 600,
              transition: 'border-color 0.1s, color 0.1s',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
