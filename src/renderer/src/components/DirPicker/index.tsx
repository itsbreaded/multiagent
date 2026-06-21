import React, { useState, useEffect, useRef } from 'react'

interface DirPickerProps {
  title: string
  description?: string
  initial?: string
  confirmLabel?: string
  skipLabel?: string
  error?: string | null
  nameField?: boolean
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
  onConfirm,
  onSkip,
}: DirPickerProps): JSX.Element {
  const [value, setValue] = useState(initial)
  const [name, setName] = useState('')
  const [recentDirs, setRecentDirs] = useState<string[]>([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  // null = opened via focus/chevron → show all recents unfiltered
  // string = user typed → filter by this query
  const [filterQuery, setFilterQuery] = useState<string | null>(null)

  const nameRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const comboboxRef = useRef<HTMLDivElement>(null)
  const borderRef = useRef<HTMLDivElement>(null)
  const mouseDownOnOverlay = useRef(false)
  const dropdownOpenRef = useRef(false)

  function openDropdown(): void {
    dropdownOpenRef.current = true
    setDropdownOpen(true)
  }
  function closeDropdown(): void {
    dropdownOpenRef.current = false
    setDropdownOpen(false)
    setHighlightedIndex(-1)
  }

  useEffect(() => {
    if (nameField) {
      nameRef.current?.focus()
    } else {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [])

  useEffect(() => {
    if (!window.ipc) return
    void (async () => {
      try {
        const dirs = await window.ipc.invoke('dirs:recent-get') as string[]
        setRecentDirs(dirs)
      } catch {
        // ignore
      }
    })()
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function onMouseDown(e: MouseEvent): void {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        closeDropdown()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [dropdownOpen])

  // Escape: close dropdown first, then dismiss modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (dropdownOpenRef.current) {
          closeDropdown()
        } else {
          onSkip()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onSkip])

  async function browse(): Promise<void> {
    if (!window.ipc) return
    try {
      const picked = await window.ipc.invoke('dialog:pick-directory', title, value || initial) as string | null
      if (picked) {
        setValue(picked)
        closeDropdown()
      }
    } catch {
      // ignore
    }
  }

  function handleConfirm(): void {
    const trimmedDir = value.trim()
    const trimmedName = name.trim() || undefined
    if (trimmedDir && window.ipc) {
      void window.ipc.invoke('dirs:recent-add', trimmedDir)
    }
    onConfirm(trimmedDir, trimmedName)
  }

  const filteredRecents = filterQuery
    ? recentDirs.filter((d) => d.toLowerCase().includes(filterQuery.toLowerCase()))
    : recentDirs

  function selectRecent(dir: string): void {
    setValue(dir)
    setFilterQuery(null)
    closeDropdown()
    inputRef.current?.focus()
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!dropdownOpen && filteredRecents.length > 0) {
        openDropdown()
        setHighlightedIndex(0)
      } else {
        setHighlightedIndex((i) => Math.min(i + 1, filteredRecents.length - 1))
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (dropdownOpen && highlightedIndex >= 0 && filteredRecents[highlightedIndex]) {
        selectRecent(filteredRecents[highlightedIndex])
      } else {
        handleConfirm()
      }
    }
  }

  const showDropdown = dropdownOpen && recentDirs.length > 0

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
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget }}
      onClick={() => { if (mouseDownOnOverlay.current) onSkip() }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 520,
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
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
        <div style={{ padding: error ? '14px 18px 8px' : '14px 18px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          {/* Combobox wrapper */}
          <div ref={comboboxRef} style={{ flex: 1, position: 'relative' }}>
            {/* Single border container — focus ring applied here so it wraps input + chevron */}
            <div
              ref={borderRef}
              style={{
                display: 'flex',
                border: '1px solid #2a2b2e',
                borderRadius: 5,
                overflow: 'hidden',
                transition: 'border-color 0.1s',
              }}
            >
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => { setValue(e.target.value); setFilterQuery(e.target.value); if (recentDirs.length > 0) openDropdown() }}
                onFocus={() => {
                  if (borderRef.current) borderRef.current.style.borderColor = '#4ade80'
                  setFilterQuery(null)
                  if (recentDirs.length > 0) openDropdown()
                }}
                onBlur={() => {
                  if (borderRef.current) borderRef.current.style.borderColor = '#2a2b2e'
                }}
                onKeyDown={handleInputKeyDown}
                placeholder="e.g. C:\Users\you\projects\myapp"
                style={{
                  flex: 1,
                  background: '#141517',
                  border: 'none',
                  color: '#d4d4d4',
                  fontSize: 13,
                  padding: '7px 10px',
                  outline: 'none',
                  fontFamily: 'monospace',
                  caretColor: '#4ade80',
                  minWidth: 0,
                }}
              />
              {/* Chevron toggle — onMouseDown preventDefault keeps focus on the input */}
              <button
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { if (dropdownOpen) closeDropdown(); else if (recentDirs.length > 0) openDropdown() }}
                style={{
                  padding: '0 8px',
                  background: '#141517',
                  border: 'none',
                  borderLeft: '1px solid #2a2b2e',
                  color: '#6b7280',
                  cursor: recentDirs.length > 0 ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  transition: 'color 0.1s',
                }}
                onMouseEnter={(e) => { if (recentDirs.length > 0) (e.currentTarget as HTMLButtonElement).style.color = '#c9cdd1' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6b7280' }}
              >
                <svg
                  width="10"
                  height="6"
                  viewBox="0 0 10 6"
                  fill="none"
                  style={{ transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.1s' }}
                >
                  <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            {/* Dropdown */}
            {showDropdown && (
              <ul
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 3px)',
                  left: 0,
                  right: 0,
                  zIndex: 400,
                  margin: 0,
                  padding: '4px 0',
                  listStyle: 'none',
                  background: '#1c1d20',
                  border: '1px solid #2a2b2e',
                  borderRadius: 6,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  maxHeight: 220,
                  overflowY: 'auto',
                }}
                className="dark-scrollbar"
              >
                {filteredRecents.length > 0 ? (
                  filteredRecents.map((dir, i) => (
                    <li
                      key={dir}
                      onMouseDown={(e) => { e.preventDefault(); selectRecent(dir) }}
                      onMouseEnter={() => setHighlightedIndex(i)}
                      style={{
                        padding: '6px 12px',
                        fontSize: 12,
                        fontFamily: 'monospace',
                        color: highlightedIndex === i ? '#d4d4d4' : '#9ca3af',
                        background: highlightedIndex === i ? '#2a2b2e' : 'transparent',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        userSelect: 'none',
                      }}
                    >
                      {dir}
                    </li>
                  ))
                ) : (
                  <li
                    style={{
                      padding: '6px 12px',
                      fontSize: 12,
                      color: '#4b5563',
                      userSelect: 'none',
                    }}
                  >
                    No matching directories
                  </li>
                )}
              </ul>
            )}
          </div>

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
