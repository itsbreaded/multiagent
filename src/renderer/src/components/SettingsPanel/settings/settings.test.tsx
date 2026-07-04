import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSettingsStore } from '../../../store/settings'
import { GitBranchBadgesSetting } from './GitBranchBadgesSetting'
import { TabOverflowSetting } from './TabOverflowSetting'
import { ContrastRatioSetting } from './ContrastRatioSetting'
import { ScrollbackSetting } from './ScrollbackSetting'
import { DEFAULT_TERMINAL_SCROLLBACK_LINES } from '../../../store/settings'

describe('store-connected setting controls', () => {
  it('updates checkbox and choice settings through real store actions', () => {
    render(<><GitBranchBadgesSetting /><TabOverflowSetting /></>)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(useSettingsStore.getState().showGitBranchBadges).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    expect(useSettingsStore.getState().tabOverflowMode).toBe('wrap')
  })

  it('normalizes draft input on blur', () => {
    render(<ContrastRatioSetting />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    expect(useSettingsStore.getState().terminalMinimumContrastRatio).toBe(21)
  })

  it('accepts comma-formatted scrollback and restores the default for an empty draft', () => {
    const first = render(<ScrollbackSetting />)
    let input = first.container.querySelector('input')!
    expect(input).toHaveAttribute('inputmode', 'numeric')
    fireEvent.change(input, { target: { value: '500,000' } })
    fireEvent.blur(input)
    expect(useSettingsStore.getState().terminalScrollbackLines).toBe(500_000)
    first.unmount()

    const second = render(<ScrollbackSetting />)
    input = second.container.querySelector('input')!
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(useSettingsStore.getState().terminalScrollbackLines).toBe(DEFAULT_TERMINAL_SCROLLBACK_LINES)
  })
})
