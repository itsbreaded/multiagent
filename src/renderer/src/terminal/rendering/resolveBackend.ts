import type { RendererCapabilities } from './capabilities'

export type RendererBackendId = 'dom' | 'webgl'

export type GpuAccelerationPref = 'auto' | 'on' | 'off'

/**
 * Pure decision function — no side effects, trivially testable.
 *
 * - off  → dom (always)
 * - on   → webgl if any WebGL2 context exists, else dom
 * - auto → webgl only when webgl && !softwareRendering, else dom
 */
export function resolveBackend(
  pref: GpuAccelerationPref,
  caps: RendererCapabilities,
): RendererBackendId {
  if (pref === 'off') return 'dom'
  if (pref === 'on') return caps.webgl ? 'webgl' : 'dom'
  // auto
  return caps.webgl && !caps.softwareRendering ? 'webgl' : 'dom'
}
