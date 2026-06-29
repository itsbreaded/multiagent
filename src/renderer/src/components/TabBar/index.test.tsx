import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Tab } from '../../../../shared/types'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
import { TabBar } from './index'

beforeEach(() => {
  installMockIpc()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  usePanesStore.setState({
    tabs: [
      { id: 'one', focusedPaneId: '', customLabel: 'One' },
      { id: 'two', focusedPaneId: '', customLabel: 'Two' },
      { id: 'detached', focusedPaneId: '', customLabel: 'Away', detached: true },
    ] satisfies Tab[],
    activeTabId: 'one',
    sidebarOpen: true,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TabBar - overflow modes', () => {
  it('uses a single horizontally scrolling row in scroll mode', () => {
    useSettingsStore.setState({ tabOverflowMode: 'scroll' })
    const { container } = render(<TabBar />)
    const strip = container.querySelector<HTMLElement>('.tab-strip')!

    expect(strip.style.flexWrap).toBe('nowrap')
    expect(strip.style.overflowX).toBe('auto')
    expect(screen.getByTitle(/Collapse sidebar/)).toBeInTheDocument()
  })

  it('uses visible wrapping and moves left chrome out of the TabBar in wrap mode', () => {
    useSettingsStore.setState({ tabOverflowMode: 'wrap' })
    const { container } = render(<TabBar />)
    const strip = container.querySelector<HTMLElement>('.tab-strip')!

    expect(strip.style.flexWrap).toBe('wrap')
    expect(strip.style.overflowX).toBe('visible')
    expect(screen.queryByTitle(/Collapse sidebar/)).toBeNull()
  })

  it('renders local tab labels but omits detached tabs in either mode', () => {
    render(<TabBar />)

    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.queryByText('Away')).toBeNull()
  })
})
