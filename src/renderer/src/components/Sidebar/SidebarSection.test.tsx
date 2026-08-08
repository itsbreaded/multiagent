import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SidebarSection } from './SidebarSection'

describe('SidebarSection insertion indicators', () => {
  it('renders the bottom indicator after expanded section content', () => {
    const { container } = render(
      <SidebarSection title="Project" open sectionInsertBottom>
        <div data-testid="pane-row">Pane</div>
      </SidebarSection>
    )

    const pane = container.querySelector('[data-testid="pane-row"]')
    const indicator = container.querySelector('[data-sidebar-insertion-edge="bottom"]')

    expect(pane).not.toBeNull()
    expect(indicator).not.toBeNull()
    expect(pane!.compareDocumentPosition(indicator!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('SidebarSection long titles', () => {
  it('truncates the title while preserving the full label as a tooltip', () => {
    const title = 'A very long project folder name that should not push actions away'
    const { getByRole } = render(<SidebarSection title={title} />)
    const titleButton = getByRole('button', { name: title })

    expect(titleButton).toHaveAttribute('title', title)
    expect(titleButton).toHaveStyle({ overflow: 'hidden' })
    expect(titleButton.style.minWidth).toBe('0')
    expect(titleButton.style.textOverflow).toBe('ellipsis')
    expect(titleButton.style.whiteSpace).toBe('nowrap')
  })
})
