// Renderer-project test setup, run once per test file.
//
// - Registers @testing-library/jest-dom matchers (toBeInTheDocument, …).
// - Activates the root __mocks__/zustand.ts auto-reset wrapper so store state
//   never leaks between tests. Unlike Jest, Vitest does NOT auto-apply a
//   node_module __mocks__ file, so the explicit vi.mock('zustand') call here is
//   what makes the reset wrapper take effect. This is automatic *state reset*
//   only — components still exercise the real store behavior (we do not stub it).
// - Installs a no-op window.ipc so renderer modules that wire IPC listeners at
//   module load (e.g. the updater store's unguarded `window.ipc.on`) import
//   cleanly. on/send/invoke are vi.fn no-ops; component tests that assert
//   outbound calls install their own fresh mock per-test via installMockIpc().
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { installMockIpc } from './mockIpc'

vi.mock('zustand')
installMockIpc()
