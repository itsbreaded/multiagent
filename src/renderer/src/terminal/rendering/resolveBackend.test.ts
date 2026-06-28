import { describe, it, expect } from 'vitest'
import { resolveBackend } from './resolveBackend'
import type { RendererCapabilities } from './capabilities'

// NOTE: we test resolveBackend() directly with canned caps and never call
// getCapabilities() here — that probes a real canvas via
// document.createElement('canvas').getContext('webgl2'), which returns null under
// happy-dom (webgl:false) and would make the assertions meaningless.

const HW = (overrides: Partial<RendererCapabilities> = {}): RendererCapabilities => ({
  platform: 'win32',
  webgl: true,
  softwareRendering: false,
  ...overrides,
})

describe('resolveBackend', () => {
  describe('off', () => {
    it('always resolves to dom', () => {
      expect(resolveBackend('off', HW())).toBe('dom')
      expect(resolveBackend('off', HW({ webgl: false }))).toBe('dom')
      expect(resolveBackend('off', HW({ softwareRendering: true }))).toBe('dom')
    })
  })

  describe('on', () => {
    it('uses webgl when any webgl context exists', () => {
      expect(resolveBackend('on', HW())).toBe('webgl')
    })
    it('falls back to dom when webgl is unavailable', () => {
      expect(resolveBackend('on', HW({ webgl: false }))).toBe('dom')
    })
    it('still uses webgl even when rendering is software-backed', () => {
      // 'on' is an explicit opt-in and ignores the SwiftShader/WARP trap.
      expect(resolveBackend('on', HW({ softwareRendering: true }))).toBe('webgl')
    })
  })

  describe('auto', () => {
    it('uses webgl on real hardware acceleration', () => {
      expect(resolveBackend('auto', HW())).toBe('webgl')
    })
    it('demotes to dom on software rendering (SwiftShader/WARP/llvmpipe CPU-spike trap)', () => {
      expect(resolveBackend('auto', HW({ softwareRendering: true }))).toBe('dom')
    })
    it('falls back to dom when webgl is unavailable', () => {
      expect(resolveBackend('auto', HW({ webgl: false }))).toBe('dom')
    })
    it('falls back to dom when webgl is unavailable regardless of software flag', () => {
      expect(resolveBackend('auto', HW({ webgl: false, softwareRendering: true }))).toBe('dom')
    })
  })
})
