// Renderer-project test setup, run once per test file.
//
// - Registers @testing-library/jest-dom matchers (toBeInTheDocument, …).
// - Activates the root __mocks__/zustand.ts auto-reset wrapper so store state
//   never leaks between tests. Unlike Jest, Vitest does NOT auto-apply a
//   node_module __mocks__ file, so the explicit vi.mock('zustand') call here is
//   what makes the reset wrapper take effect. This is automatic *state reset*
//   only — components still drive the real store behavior (we do not stub it).
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

vi.mock('zustand')
