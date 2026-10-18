import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { makeLeaf } from '../../../../shared/paneTree'
import type { Tab } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { PaneGrid } from './index'

vi.mock('./PaneContainer', () => ({
  PaneContainer: () => <div data-testid="pane-container" />,
}))

vi.mock('./PaneSplitDropTarget', () => ({
  PaneSplitDropTarget: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

beforeEach(() => {
  const pane = makeLeaf('C:\\workspace')
  const otherPane = makeLeaf('C:\\worktree')
  const tab: Tab = { id: 'tab-1', rootNode: pane, focusedPaneId: pane.id, defaultCwd: pane.cwd }
  const otherTab: Tab = { id: 'tab-2', rootNode: otherPane, focusedPaneId: otherPane.id, defaultCwd: otherPane.cwd }
  usePanesStore.setState({
    tabs: [tab, otherTab],
    activeTabId: tab.id,
    activeDestination: { kind: 'feature', featureId: 'jira-mentions' },
    hydratedTabIds: { [tab.id]: true, [otherTab.id]: true },
    zoomedPaneId: null,
  })
})

afterEach(() => cleanup())

describe('PaneGrid destination visibility', () => {
  it('keeps the active project pane layer hidden on Jira and restores it when returning', () => {
    render(<PaneGrid />)

    const panes = screen.getAllByTestId('pane-container')
    const activeLayer = panes[0].closest('[aria-hidden]')
    const inactiveLayer = panes[1].closest('[aria-hidden]')
    expect(activeLayer).toHaveAttribute('aria-hidden', 'true')
    expect(activeLayer).toHaveStyle({ visibility: 'hidden', pointerEvents: 'none' })
    expect(inactiveLayer).toHaveAttribute('aria-hidden', 'true')
    expect(inactiveLayer).toHaveStyle({ visibility: 'hidden', pointerEvents: 'none' })

    act(() => usePanesStore.setState({ activeDestination: { kind: 'project', tabId: 'tab-1' } }))

    expect(screen.getAllByTestId('pane-container')[0]).toBe(panes[0])
    expect(activeLayer).toHaveAttribute('aria-hidden', 'false')
    expect(activeLayer).toHaveStyle({ visibility: 'visible', pointerEvents: 'auto' })
    expect(inactiveLayer).toHaveAttribute('aria-hidden', 'true')
    expect(inactiveLayer).toHaveStyle({ visibility: 'hidden', pointerEvents: 'none' })
  })
})
