import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Tab } from '../../../../shared/types'
import { installMockIpc } from '../../../../../tests/mockIpc'
import { usePanesStore } from '../../store/panes'
import { useJiraMentionsStore } from '../../store/jiraMentions'
import jiraMentionsIcon from '../../assets/notifications.png'
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

  it('keeps detached chrome tab-free while exposing the same local controls', () => {
    usePanesStore.setState({ isDetachedWindow: true, sidebarOpen: true })
    render(<TabBar />)

    expect(screen.getByTitle(/Collapse sidebar/)).toBeInTheDocument()
    expect(screen.getByTitle(/Session browser/)).toBeInTheDocument()
    expect(screen.getByTitle(/Command palette/)).toBeInTheDocument()
    expect(screen.getByTitle('Settings')).toBeInTheDocument()
    expect(screen.queryByText('One')).toBeNull()
    expect(screen.queryByText('Away')).toBeNull()
  })

  it('uses the supplied notifications icon for the Jira mentions launcher', () => {
    useJiraMentionsStore.setState((state) => ({ projection: { ...state.projection, enabled: true } }))
    render(<TabBar />)

    const launcher = screen.getByTitle('Open Jira mentions')
    expect(launcher.querySelector('img')).toHaveAttribute('src', jiraMentionsIcon)
  })
})
