import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Tab } from '../../../../shared/types'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { TabBar } from './index'

beforeEach(() => {
  installMockIpc()
  usePanesStore.setState({
    tabs: [
      { id: 'one', focusedPaneId: '', customLabel: 'One' },
      { id: 'two', focusedPaneId: '', customLabel: 'Two' },
      { id: 'detached', focusedPaneId: '', customLabel: 'Away', detached: true },
    ] satisfies Tab[],
    activeTabId: 'one',
    sidebarOpen: true,
    isDetachedWindow: false,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TabBar - sidebar-first chrome', () => {
  it('keeps the primary chrome controls but renders no top tab surface', () => {
    const { container } = render(<TabBar />)

    expect(container.querySelector('.tab-strip')).toBeNull()
    expect(screen.getByTitle(/Collapse sidebar/)).toBeInTheDocument()
    expect(screen.queryByText('One')).toBeNull()
    expect(screen.queryByText('Two')).toBeNull()
    expect(screen.queryByText('Away')).toBeNull()
  })

  it('keeps detached chrome tab-free and does not expose the primary sidebar toggle', () => {
    usePanesStore.setState({ isDetachedWindow: true, sidebarOpen: true })
    render(<TabBar />)

    expect(screen.queryByTitle(/Collapse sidebar/)).toBeNull()
    expect(screen.queryByText('One')).toBeNull()
    expect(screen.queryByText('Away')).toBeNull()
  })
})
