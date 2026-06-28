// Manual mock for 'zustand', auto-mounted by the bare `vi.mock('zustand')` call
// in tests/setup.renderer.ts (Vitest does NOT auto-apply a node_module __mocks__
// file like Jest — the explicit vi.mock is what activates this).
//
// Follows the official Zustand auto-reset recipe
// (https://zustand.docs.pmnd.rs/learn/guides/testing), adapted for Vitest: the
// real module is pulled via top-level `await vi.importActual` (the Jest recipe's
// synchronous requireActual does not work under Vitest's hoisted vi.mock).
//
// Every store created via create/createStore snapshots its initial state and is
// reset in afterEach, so state never leaks between tests. This is automatic
// *state reset* only — components still exercise the real store behavior; we do
// not stub it.

import { afterEach, vi } from 'vitest'

const actual = await vi.importActual<typeof import('zustand')>('zustand')

const resets: Array<() => void> = []

interface Resettable {
  setState: (state: unknown, replace?: boolean) => void
  getState: () => unknown
}

function withReset<T extends Resettable>(created: T): T {
  const initial = created.getState()
  resets.push(() => created.setState(initial, true))
  return created
}

export const create = ((store: unknown) =>
  withReset(actual.create(store as never))) as typeof actual.create

export const createStore = ((store: unknown) =>
  withReset(actual.createStore(store as never))) as typeof actual.createStore

afterEach(() => {
  for (const reset of resets) reset()
  resets.length = 0
})
