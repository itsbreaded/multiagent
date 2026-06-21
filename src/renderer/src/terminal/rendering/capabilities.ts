// Renderer-side capability probe. The synchronous WebGL check is authoritative
// for backend resolution at pane-mount time. The async main-process GPU status
// only refines softwareRendering and is never on the critical path.

export interface RendererCapabilities {
  platform: 'win32' | 'darwin' | 'linux'
  webgl: boolean
  softwareRendering: boolean
  gpuRenderer?: string
}

const SOFTWARE_RENDERER_RE = /swiftshader|warp|llvmpipe|software|basic render/i

let cached: RendererCapabilities | null = null

function probeSyncWebGL(): { webgl: boolean; softwareRendering: boolean; gpuRenderer?: string } {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return { webgl: false, softwareRendering: false }

    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string
      : ''

    // Clean up the throwaway context
    const loseCtx = gl.getExtension('WEBGL_lose_context')
    loseCtx?.loseContext()

    const softwareRendering = SOFTWARE_RENDERER_RE.test(renderer)
    return { webgl: true, softwareRendering, gpuRenderer: renderer || undefined }
  } catch {
    return { webgl: false, softwareRendering: false }
  }
}

/** Get capabilities synchronously, probing once and caching the result. */
export function getCapabilities(): RendererCapabilities {
  if (cached) return cached

  const { webgl, softwareRendering, gpuRenderer } = probeSyncWebGL()
  const ua = navigator.userAgent
  const platform: 'win32' | 'darwin' | 'linux' =
    ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux'

  cached = { platform, webgl, softwareRendering, gpuRenderer }
  return cached
}

/**
 * Merge in the async result from the main process gpu:feature-status IPC.
 * Called once at renderer bootstrap — never on the critical pane-mount path.
 * Only refines softwareRendering (OR it in); does not reduce it.
 */
export function mergeGpuFeatureStatus(softwareOnly: boolean): void {
  if (!cached) {
    // Bootstrap call arrived before any pane was created; probe now so the
    // cached object exists before we merge.
    getCapabilities()
  }
  if (cached && softwareOnly) {
    cached = { ...cached, softwareRendering: true }
  }
}
