import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DirPicker } from './index'
import { installMockIpc, type MockIpc } from '../../../../../tests/mockIpc'

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
})

afterEach(() => cleanup())

function renderPicker(onConfirm = vi.fn()): ReturnType<typeof render> {
  return render(
    <DirPicker
      title="Change project directory"
      initial="C:\\old"
      confirmLabel="Change"
      skipLabel="Cancel"
      validateDirectory
      onConfirm={onConfirm}
      onSkip={vi.fn()}
    />,
  )
}

describe('DirPicker directory validation', () => {
  it('uses the validated directory and records it as recent only after success', async () => {
    const onConfirm = vi.fn()
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'dirs:recent-get') return Promise.resolve([])
      if (channel === 'dirs:validate') {
        return Promise.resolve({ ok: true, directory: 'C:\\Code\\multiagent' })
      }
      return Promise.resolve(undefined)
    })
    renderPicker(onConfirm)

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./), { target: { value: '  "C:\\Code\\multiagent"  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('C:\\Code\\multiagent', undefined))
    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'dirs:recent-get')
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'dirs:validate', '  "C:\\Code\\multiagent"  ')
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'dirs:recent-add', 'C:\\Code\\multiagent')
  })

  it('keeps the form open and does not record or confirm an invalid directory', async () => {
    const onConfirm = vi.fn()
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'dirs:recent-get') return Promise.resolve([])
      if (channel === 'dirs:validate') {
        return Promise.resolve({ ok: false, error: 'The selected directory does not exist' })
      }
      return Promise.resolve(undefined)
    })
    renderPicker(onConfirm)

    fireEvent.click(screen.getByRole('button', { name: 'Change' }))

    expect(await screen.findByText('The selected directory does not exist')).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(ipc.invoke).not.toHaveBeenCalledWith('dirs:recent-add', expect.anything())
  })

  it('shows the validation error for empty quoted input', async () => {
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'dirs:recent-get') return Promise.resolve([])
      if (channel === 'dirs:validate') return Promise.resolve({ ok: false, error: 'Enter a directory path' })
      return Promise.resolve(undefined)
    })
    renderPicker()

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./), { target: { value: ' "" ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))

    expect(await screen.findByText('Enter a directory path')).toBeInTheDocument()
  })

  it('validates and records a directory selected through Browse', async () => {
    const onConfirm = vi.fn()
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'dirs:recent-get') return Promise.resolve([])
      if (channel === 'dialog:pick-directory') return Promise.resolve('C:\\Code\\multiagent')
      if (channel === 'dirs:validate') return Promise.resolve({ ok: true, directory: 'C:\\Code\\multiagent' })
      return Promise.resolve(undefined)
    })
    renderPicker(onConfirm)

    fireEvent.click(screen.getByRole('button', { name: 'Browse...' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/e\.g\./)).toHaveValue('C:\\Code\\multiagent'))
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('C:\\Code\\multiagent', undefined))
    expect(ipc.invoke).toHaveBeenCalledWith('dirs:recent-add', 'C:\\Code\\multiagent')
  })

  it('prevents duplicate submissions while validation is pending', async () => {
    let resolveValidation: ((value: { ok: true; directory: string }) => void) | undefined
    ipc.invoke.mockImplementation((channel: string) => {
      if (channel === 'dirs:recent-get') return Promise.resolve([])
      if (channel === 'dirs:validate') {
        return new Promise((resolve) => { resolveValidation = resolve })
      }
      return Promise.resolve(undefined)
    })
    const onConfirm = vi.fn()
    renderPicker(onConfirm)

    const change = screen.getByRole('button', { name: 'Change' })
    fireEvent.click(change)
    fireEvent.keyDown(screen.getByPlaceholderText(/e\.g\./), { key: 'Enter' })
    expect(ipc.invoke).toHaveBeenCalledTimes(2) // recents fetch + one validation
    expect(screen.getByRole('button', { name: 'Change...' })).toBeDisabled()

    resolveValidation?.({ ok: true, directory: 'C:\\old' })
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('C:\\old', undefined))
  })
})
