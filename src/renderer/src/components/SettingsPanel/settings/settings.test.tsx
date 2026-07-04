import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSettingsStore } from '../../../store/settings'
import { GitBranchBadgesSetting } from './GitBranchBadgesSetting'
import { TabOverflowSetting } from './TabOverflowSetting'
import { ContrastRatioSetting } from './ContrastRatioSetting'

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
})
