import { Terminal as XTerm } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import type { RendererCapabilities } from './capabilities'
import type { RendererBackendId, GpuAccelerationPref } from './resolveBackend'
import { resolveBackend } from './resolveBackend'
import { getCapabilities } from './capabilities'

export interface BackendHandle {
  dispose(): void
}

export interface RendererBackend {
  id: RendererBackendId
  label: string
  isViable(caps: RendererCapabilities): boolean
  attach(xterm: XTerm): BackendHandle | null
}

// Per-renderer-process demotion latch. Set to true on first WebGL context loss;
// prevents reattach thrash across panes. Each detached window has its own latch.
let webglDemoted = false

export function isWebglDemoted(): boolean {
  return webglDemoted
}

const DOM_BACKEND: RendererBackend = {
  id: 'dom',
  label: 'DOM',
  isViable: () => true,
  attach: () => ({ dispose() {} }),
}

const WEBGL_BACKEND: RendererBackend = {
  id: 'webgl',
  label: 'WebGL',
  isViable: (caps) => caps.webgl && !webglDemoted,
  attach: (xterm) => {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        webglDemoted = true
        try { addon.dispose() } catch { /* ignore */ }
      })
      xterm.loadAddon(addon)
      return {
        dispose() {
          try { addon.dispose() } catch { /* ignore */ }
        },
      }
    } catch {
      return null
    }
  },
}

const BACKENDS: Record<RendererBackendId, RendererBackend> = {
  dom: DOM_BACKEND,
  webgl: WEBGL_BACKEND,
}

/**
 * Resolve the preferred backend and attach it to an xterm instance.
 * Returns a BackendHandle for cleanup and the resolved backend id for diagnostics.
 * Falls back to DOM if the chosen backend cannot attach.
 */
export function applyBackend(
  xterm: XTerm,
  pref: GpuAccelerationPref,
  caps?: RendererCapabilities,
): { handle: BackendHandle; backendId: RendererBackendId } {
  const resolvedCaps = caps ?? getCapabilities()
  const id = resolveBackend(pref, resolvedCaps)
  const backend = BACKENDS[id]

  const handle = backend.attach(xterm)
  if (handle) return { handle, backendId: id }

  // Fallback to DOM if chosen backend failed to attach
  const fallback = DOM_BACKEND.attach(xterm)
  return { handle: fallback!, backendId: 'dom' }
}
