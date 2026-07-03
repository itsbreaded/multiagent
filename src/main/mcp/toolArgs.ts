/**
 * Dependency-free argument validators for the browser MCP tools.
 *
 * The MCP SDK ships JSON `inputSchema`s for documentation but does NOT validate
 * `arguments` against them — a malformed call flows straight into the handler.
 * These helpers throw `Error`s with actionable messages; the CallTool handler's
 * existing try/catch converts any throw into an `isError` tool result.
 *
 * Pure module: no Electron / SDK imports, so it is unit-testable in the node env.
 */

export type ToolArgs = Record<string, unknown> | undefined

export interface CookieInput {
  url: string
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  return typeof value
}

function hasOwn(args: ToolArgs, key: string): boolean {
  return !!args && Object.prototype.hasOwnProperty.call(args, key)
}

/**
 * Require a non-empty string for `key`.
 *
 * Empty strings are accepted (callers like selectors/text may legitimately be
 * short, and rejecting them is the caller's job). `undefined`/`null`/missing
 * keys and any non-string type throw.
 */
export function requireString(args: ToolArgs, key: string): string {
  const value = args?.[key]
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid arguments: "${key}" is required and must be a string (got ${describe(value)})`
    )
  }
  return value
}

/** Require a finite number (rejects NaN, Infinity, and non-number types). */
export function requireNumber(args: ToolArgs, key: string): number {
  const value = args?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Invalid arguments: "${key}" must be a finite number (got ${describe(value)})`
    )
  }
  return value
}

/** Require an array (of unknown shape — caller validates elements if needed). */
export function requireArray(args: ToolArgs, key: string): unknown[] {
  const value = args?.[key]
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid arguments: "${key}" must be an array (got ${describe(value)})`
    )
  }
  return value
}

/**
 * Optional string. Returns `undefined` when the key is absent. A present-but-
 * mistyped value is an error (not silently ignored).
 */
export function optionalString(args: ToolArgs, key: string): string | undefined {
  if (!hasOwn(args, key)) return undefined
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid arguments: "${key}" must be a string (got ${describe(value)})`
    )
  }
  return value
}

/**
 * Optional finite number. Returns `fallback` (or `undefined`) when the key is
 * absent. A present-but-mistyped value is an error.
 */
export function optionalNumber(
  args: ToolArgs,
  key: string,
  fallback?: number
): number | undefined {
  if (!hasOwn(args, key)) return fallback
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Invalid arguments: "${key}" must be a finite number (got ${describe(value)})`
    )
  }
  return value
}

/**
 * Optional boolean with explicit fallback. A present-but-mistyped value is an
 * error.
 */
export function optionalBoolean(args: ToolArgs, key: string, fallback: boolean): boolean {
  if (!hasOwn(args, key)) return fallback
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(
      `Invalid arguments: "${key}" must be a boolean (got ${describe(value)})`
    )
  }
  return value
}

/**
 * Optional string array (default `[]`). Non-array or array-with-non-strings is
 * an error.
 */
export function optionalStringArray(args: ToolArgs, key: string): string[] {
  if (!hasOwn(args, key)) return []
  const value = args?.[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid arguments: "${key}" must be an array (got ${describe(value)})`
    )
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new Error(
        `Invalid arguments: "${key}[${i}]" must be a string (got ${describe(value[i])})`
      )
    }
  }
  return value as string[]
}

/**
 * Validate the `cookies` argument and map snake_case wire fields to the
 * Electron `cookies.set()` shape. Indexed errors surface as `cookies[i].field`.
 *
 * Both snake_case (`http_only`, `expiration_date` — the documented wire shape
 * from the JSON schema) and camelCase (`httpOnly`, `expirationDate`) are
 * accepted; this preserves the previous spread-based behavior where camelCase
 * keys passed through unchanged.
 */
export function requireCookies(args: ToolArgs, key: string): CookieInput[] {
  const raw = requireArray(args, key)
  const out: CookieInput[] = []
  for (let i = 0; i < raw.length; i++) {
    const el = raw[i]
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      throw new Error(
        `Invalid arguments: "${key}[${i}]" must be an object (got ${describe(el)})`
      )
    }
    const obj = el as Record<string, unknown>

    const url = requireCookieString(obj, 'url', i, key)
    const name = requireCookieString(obj, 'name', i, key)
    const value = requireCookieString(obj, 'value', i, key)

    const domain = optionalCookieString(obj, 'domain', i, key)
    const path = optionalCookieString(obj, 'path', i, key)
    const secure = optionalCookieBoolean(obj, 'secure', i, key)
    const httpOnly = optionalCookieBoolean(obj, 'httpOnly', i, key)
    const httpOnlySnake = optionalCookieBoolean(obj, 'http_only', i, key)
    const expirationDate = optionalCookieNumber(obj, 'expirationDate', i, key)
    const expirationDateSnake = optionalCookieNumber(obj, 'expiration_date', i, key)

    out.push({
      url,
      name,
      value,
      ...(domain !== undefined ? { domain } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(secure !== undefined ? { secure } : {}),
      ...(httpOnly !== undefined ? { httpOnly } : {}),
      ...(httpOnlySnake !== undefined ? { httpOnly: httpOnlySnake } : {}),
      ...(expirationDate !== undefined ? { expirationDate } : {}),
      ...(expirationDateSnake !== undefined ? { expirationDate: expirationDateSnake } : {}),
    })
  }
  return out
}

function requireCookieString(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  parentKey: string
): string {
  const value = obj[field]
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid arguments: "${parentKey}[${index}].${field}" is required and must be a string (got ${describe(value)})`
    )
  }
  return value
}

function optionalCookieString(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  parentKey: string
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, field)) return undefined
  const value = obj[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid arguments: "${parentKey}[${index}].${field}" must be a string (got ${describe(value)})`
    )
  }
  return value
}

function optionalCookieBoolean(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  parentKey: string
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, field)) return undefined
  const value = obj[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(
      `Invalid arguments: "${parentKey}[${index}].${field}" must be a boolean (got ${describe(value)})`
    )
  }
  return value
}

function optionalCookieNumber(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  parentKey: string
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, field)) return undefined
  const value = obj[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Invalid arguments: "${parentKey}[${index}].${field}" must be a finite number (got ${describe(value)})`
    )
  }
  return value
}
