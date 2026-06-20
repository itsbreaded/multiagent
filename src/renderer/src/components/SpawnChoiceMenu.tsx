import React, { useLayoutEffect, useRef, useState } from 'react'
import type { AgentKind, PaneType, SplitDirection } from '../../../shared/types'
import { menuStyles, ui } from '../styles/theme'
import { AgentIcon, ShellIcon } from './AgentIcon'
import splitRightIcon from '../assets/splitright.png'
import splitDownIcon from '../assets/splitdown.png'

export type SpawnChoice = {
  paneType: PaneType
  agentKind?: AgentKind
}

export const SPAWN_CHOICES: SpawnChoice[] = [
  { paneType: 'agent', agentKind: 'claude' },
  { paneType: 'agent', agentKind: 'codex' },
  { paneType: 'shell' },
]

interface SpawnChoiceMenuProps {
  x: number
  y: number
  currentDirLabel: string
  onClose: () => void
  onSpawn: (choice: SpawnChoice, direction: SplitDirection) => void
  onBrowse: (choice: SpawnChoice, direction: SplitDirection) => void
}

export function SpawnChoiceMenu({
  x,
  y,
  currentDirLabel,
  onClose,
  onSpawn,
  onBrowse,
}: SpawnChoiceMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({
    left: x,
    top: y,
    visible: false,
  })

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 6
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
      visible: true,
    })
  }, [x, y])

  return (
    <>
      <div
        style={menuStyles.backdrop}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        ref={menuRef}
        style={{
          ...menuStyles.panel,
          left: pos.left,
          top: pos.top,
          minWidth: 260,
          visibility: pos.visible ? 'visible' : 'hidden',
        }}
      >
        <MenuSection label={currentDirLabel} onSelect={onSpawn} />
        <div style={menuStyles.separator} />
        <MenuSection label="Choose directory" onSelect={onBrowse} />
      </div>
    </>
  )
}

function MenuSection({
  label,
  onSelect,
}: {
  label: string
  onSelect: (choice: SpawnChoice, direction: SplitDirection) => void
}): JSX.Element {
  return (
    <>
      <div style={menuStyles.label}>{label}</div>
      {SPAWN_CHOICES.map((choice) => (
        <SpawnChoiceRow
          key={`${label}:${spawnChoiceKey(choice)}`}
          choice={choice}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function SpawnChoiceRow({
  choice,
  onSelect,
}: {
  choice: SpawnChoice
  onSelect: (choice: SpawnChoice, direction: SplitDirection) => void
}): JSX.Element {
  return (
    <div
      style={{
        ...menuStyles.item,
        color: ui.color.text,
        cursor: 'default',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {choice.paneType === 'agent'
          ? <AgentIcon agentKind={choice.agentKind ?? 'claude'} size={16} />
          : <ShellIcon size={16} />}
        <span>{spawnChoiceLabel(choice)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <DirectionButton
          title="Split vertical"
          icon={splitRightIcon}
          alt="Split vertical"
          onClick={() => onSelect(choice, 'vertical')}
        />
        <DirectionButton
          title="Split horizontal"
          icon={splitDownIcon}
          alt="Split horizontal"
          onClick={() => onSelect(choice, 'horizontal')}
        />
      </span>
    </div>
  )
}

function DirectionButton({
  title,
  icon,
  alt,
  onClick,
}: {
  title: string
  icon: string
  alt: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 24,
        height: 22,
        border: 'none',
        borderRadius: ui.radius.sm,
        background: 'transparent',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.control }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
    >
      <img src={icon} alt={alt} style={{ width: 16, height: 16, display: 'block', opacity: 0.78 }} />
    </button>
  )
}

export function spawnChoiceLabel(choice: SpawnChoice): string {
  if (choice.paneType === 'shell') return 'Shell'
  return choice.agentKind === 'codex' ? 'Codex CLI' : 'Claude Code'
}

export function spawnChoiceKey(choice: SpawnChoice): string {
  return choice.paneType === 'shell' ? 'shell' : `agent:${choice.agentKind ?? 'claude'}`
}
