export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  isMaximized: false,
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Coerce arbitrary parsed JSON into a fully-typed `WindowState`. Each field is
 * accepted only when it matches its declared type (`finite number` for the
 * coordinates/sizes, with width/height additionally `> 0`; `boolean` for
 * `isMaximized`); anything missing or wrong-typed falls back to the default for
 * that field. This is per-field coercion — valid siblings survive even when one
 * field is malformed, so a bad `width` does not reset a good `x`.
 */
export function coerceWindowState(parsed: unknown): WindowState {
  if (!isObject(parsed)) return { ...DEFAULT_WINDOW_STATE }
  const d = DEFAULT_WINDOW_STATE

  const x = typeof parsed['x'] === 'number' && Number.isFinite(parsed['x']) ? parsed['x'] : d.x
  const y = typeof parsed['y'] === 'number' && Number.isFinite(parsed['y']) ? parsed['y'] : d.y
  const width =
    typeof parsed['width'] === 'number' && Number.isFinite(parsed['width']) && parsed['width'] > 0
      ? parsed['width']
      : d.width
  const height =
    typeof parsed['height'] === 'number' && Number.isFinite(parsed['height']) && parsed['height'] > 0
      ? parsed['height']
      : d.height
  const isMaximized = typeof parsed['isMaximized'] === 'boolean' ? parsed['isMaximized'] : d.isMaximized

  return { x, y, width, height, isMaximized }
}
