import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DatabaseStatusBanner } from './DatabaseStatusBanner'
import { useDatabaseStatusStore } from '../store/databaseStatus'

afterEach(() => {
  cleanup()
  useDatabaseStatusStore.setState({ status: null })
})

describe('DatabaseStatusBanner', () => {
  it('renders unavailable feedback with semantic theme tokens', () => {
    useDatabaseStatusStore.setState({
      status: { available: false, code: 'database_unavailable', message: 'Search is unavailable.' },
    })

    render(<DatabaseStatusBanner />)

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Search is unavailable.')
    expect(banner.style.backgroundColor).toBe('var(--ui-color-panel)')
    expect(banner.style.borderBottom).toContain('var(--ui-color-danger)')
    expect(banner.style.color).toBe('var(--ui-color-danger)')
  })
})
