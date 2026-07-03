# 033 — Durable Persistence and Safe Config Loading

Covers two Tier-1 items from the code-improvement review: (1) non-atomic writes to `layout.json`, the app's primary state file, and (2) blind-cast loading of `agent-provider-settings.json` and `window-state.json`. Both are small, isolated main-process changes with no schema or IPC changes.

## Problem

The app persists three JSON files under `app.getPath('userData')`:

- `layout.json` — the entire pane/tab layout. Written non-atomically on every debounced `layout:save` and again during shutdown. A crash, power loss, or antivirus interruption mid-write truncates the file; on next launch `layout:load` swallows the parse error and returns `null`, and the user silently loses their whole layout. There is no backup for these two paths (only the cwd-repair path makes one).
- `agent-provider-settings.json` — loaded with `JSON.parse(raw) as AgentProviderSettings`, no validation. A partial, legacy, or hand-edited file passes the load and then crashes later at spawn time: `SessionSpawner.agentEnv()` calls `codexCfg?.envKey.trim()` (`src/main/sessions/SessionSpawner.ts:391`, `:422`, `:429-431`) and iterates `claudeCfg.extraEnvVars` / `codexCfg.extraEnvVars` — a config object missing `envKey` or with a non-array `extraEnvVars` throws a `TypeError` inside `pty:create-agent`, so every agent pane spawn fails with no recovery path short of deleting the file.
- `window-state.json` — same blind-cast pattern in `src/main/index.ts`. Non-numeric or missing fields flow into `new BrowserWindow({...})`; the display-visibility check partially masks bad `x`/`y` but not bad `width`/`height`/`isMaximized`.

An atomic-write helper (`writeJsonAtomic`) already exists in `handlers.ts` but is used only by the cwd-repair path.

## Current Behavior

All line numbers verified against the working tree at spec-writing time.

### Non-atomic layout writes

`src/main/ipc/handlers.ts:394-407` — the debounced renderer save:

```ts
ipcMain.handle('layout:save', (_e, tabs: unknown, /* ... */) => {
  try {
    fs.writeFileSync(layoutPath, JSON.stringify({
      tabs: normalizeTabsForLayout(tabs),
      sidebarWidth,
      ...
```

`src/main/ipc/handlers.ts:1060-1071` — inside `performShutdownSave()` (the primary-window `close` interception that merges detached-window snapshots):

```ts
try {
  fs.writeFileSync(layoutPath, JSON.stringify({
    tabs: normalizeTabsForLayout(mergedTabs),
    ...
```

`fs.writeFileSync` truncates then writes. Any interruption between truncate and completion leaves a zero-byte or partial file. `layout:load` (`handlers.ts:386-392`) catches the resulting `JSON.parse` failure and returns `null` — indistinguishable from a fresh install, so the renderer starts with an empty layout and the next debounced save overwrites whatever bytes survived.

The correct primitive already exists in the same file, `src/main/ipc/handlers.ts:1172-1176`:

```ts
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(value))
  fs.renameSync(tmpPath, filePath)
}
```

It is used only by `repairLayoutCwds` (`handlers.ts:1124`). It is a module-level function in a file that imports `electron`, so it is currently untestable in the node-env Vitest project.

### Blind-cast agent provider settings

`src/main/ipc/handlers.ts:499-506`:

```ts
function loadAgentProviderSettings(): AgentProviderSettings {
  try {
    const raw = fs.readFileSync(AGENT_PROVIDER_FILE, 'utf-8')
    return JSON.parse(raw) as AgentProviderSettings
  } catch {
    return defaultAgentProviderSettings()
  }
}
```

The result is applied globally at startup via `setAgentProviderSettings(loadAgentProviderSettings())` (`handlers.ts:509`) and returned raw to the renderer by `settings:get-agent-providers` (`handlers.ts:511`). `defaultAgentProviderSettings()` (`handlers.ts:483-497`) defines the full expected shape (see `AgentProviderSettings` / `ClaudeProviderConfig` / `CodexProviderConfig` in `src/shared/types.ts:43-76`), but nothing enforces it on the parsed file. The all-or-nothing `catch` only protects against unparseable JSON — a *parseable but partial* file (e.g. `{"claude":{"enabled":true}}`, or a file from an older app version missing later-added fields like `effortLevel` or `wireApi`) is returned as-is.

The save side, `settings:save-agent-providers` (`handlers.ts:513-516`), also uses a raw `fs.writeFileSync`.

### Blind-cast window state

`src/main/index.ts:27-41`:

```ts
function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), 'utf-8')
    const saved = JSON.parse(raw) as WindowState
    // Verify the saved position is still on a connected display
    const visible = screen.getAllDisplays().some((d) => { ... })
    return visible ? saved : DEFAULTS
  } catch {
    return DEFAULTS
  }
}
```

`saved.x/y/width/height/isMaximized` are never type-checked. Missing/`NaN` coordinates happen to fail the visibility comparison and fall back to `DEFAULTS`, but that is accidental; wrong-typed `width`/`height`/`isMaximized` pass straight through to `createWindow()` (`index.ts:65-79`). `saveWindowState` (`index.ts:43-57`) also writes non-atomically (`writeFileSync` at `:55`) — lower stakes than layout.json, but the same pattern for free once the helper is shared.

## Intended Behavior

1. Every write of `layout.json` — `layout:save`, `performShutdownSave`, and (already done) `repairLayoutCwds` — is atomic: write to a temp file in the same directory, then rename over the target. A crash at any point leaves either the previous complete file or the new complete file, never a truncated one.
2. `agent-provider-settings.json` is sanitized on load: every field of the result is guaranteed to have the type declared in `AgentProviderSettings`, with defaults filled in per-field for anything missing or wrong-typed. A partial or legacy file degrades gracefully instead of crashing agent spawns. `SessionSpawner.agentEnv()` is unchanged — it simply never receives a malformed object again.
3. `window-state.json` is coerced on load with the same per-field philosophy; the display-visibility check remains as-is on top of the coerced values. Both config saves (`agent-provider-settings.json`, `window-state.json`) also go through the atomic write helper.
4. The atomic-write helper and both sanitizers live in Electron-free modules so they are unit-testable under the node-env Vitest project (per the repo convention: extract pure logic into a sibling/shared module rather than `vi.mock`-ing Electron importers).

No schema changes: the bytes written to all three files are shaped exactly as today (`layout.json` and `window-state.json` compact `JSON.stringify`, `agent-provider-settings.json` keeps its current `JSON.stringify(settings, null, 2)` pretty-printing — see step 1 for the helper's serializer hook).

## Implementation Plan

### Step 1 — extract `writeJsonAtomic` to a shared main-process module

Create `src/main/atomicJson.ts` (sibling of `index.ts`; imports only `fs`/`path`, never `electron`):

```ts
export function writeJsonAtomic(filePath: string, value: unknown, space?: number): void
```

- Body is the existing implementation from `handlers.ts:1172-1176`, plus:
  - `space` optional param passed to `JSON.stringify(value, null, space)` so the agent-provider save keeps its current 2-space formatting and the other callers keep compact output.
  - On any throw after the temp file may exist, best-effort `fs.unlinkSync(tmpPath)` in a `catch`-and-rethrow (or `finally` guarded by an existence check) so failed writes do not accumulate `*.tmp.*` litter in userData.
- The temp path stays `${filePath}.tmp.${process.pid}.${Date.now()}` — same directory as the target, so the `renameSync` is a same-volume atomic replace (works over an existing file on Windows; this is the mechanism `repairLayoutCwds` already relies on).
- Delete the private `writeJsonAtomic` from `handlers.ts` and import the new module there. `repairLayoutCwds` keeps calling it unchanged.

### Step 2 — route both layout.json save paths through it

In `src/main/ipc/handlers.ts`:

- `layout:save` handler (`:394-407`): replace `fs.writeFileSync(layoutPath, JSON.stringify({...}))` with `writeJsonAtomic(layoutPath, {...})`. Keep the payload object, `normalizeTabsForLayout(tabs)`, the try/catch, and the `console.error('[MultiAgent] layout:save failed:', err)` log exactly as they are.
- `performShutdownSave()` (`:1060-1071`): same one-line substitution. Do not touch anything else in the function — the state collection, 1000ms timeouts, and detached-tab merge are the shutdown-save invariant documented in CLAUDE.md. The write remains synchronous, which matters here: shutdown proceeds immediately after this call.

### Step 3 — sanitized agent-provider settings loading

Create `src/main/ipc/agentProviderSettings.ts` (imports only `@shared/types`, no `electron`/`fs`):

- Move `defaultAgentProviderSettings()` here verbatim from `handlers.ts:483-497` and export it.
- Add `export function sanitizeAgentProviderSettings(parsed: unknown): AgentProviderSettings`:
  - Non-object / null / array input → `defaultAgentProviderSettings()`.
  - `claude` and `codex` are each sanitized by per-agent helpers (`sanitizeClaudeConfig(raw: unknown): ClaudeProviderConfig`, `sanitizeCodexConfig(raw: unknown): CodexProviderConfig`) that start from the corresponding default object and copy over each known field **only when its type matches**: `typeof === 'boolean'` for `enabled`, `typeof === 'string'` for every string field, membership check against the literal unions for `preset` (`'native' | 'deepseek' | 'alibaba' | 'custom'` claude; `'native' | 'alibaba-token' | 'alibaba-payg' | 'custom'` codex) and `wireApi` (`'responses' | 'chat'`) — an unknown preset falls back to `'native'`, unknown wireApi to `'responses'`.
  - `extraEnvVars`: keep only array elements that are objects with string `id`, string `key`, string `value`, boolean `enabled`; otherwise `[]`. (These are iterated and `.trim()`ed by `applyExtraEnv`/`removeExtraEnvKeys` in `SessionSpawner.ts:367-378`.)
  - `claudePresets` / `codexPresets` (optional draft maps, `types.ts:74-75`): if present and object, rebuild keeping only valid preset keys, each value run through the same per-agent sanitizer; if absent or invalid, omit the property (matches legacy files written before presets existed).
  - Unknown extra keys are dropped (the renderer settings panel always writes the full shape; see Risks).
- In `handlers.ts`, replace `loadAgentProviderSettings` (`:499-506`) body with:

  ```ts
  function loadAgentProviderSettings(): AgentProviderSettings {
    try {
      const raw = fs.readFileSync(AGENT_PROVIDER_FILE, 'utf-8')
      return sanitizeAgentProviderSettings(JSON.parse(raw))
    } catch {
      return defaultAgentProviderSettings()
    }
  }
  ```

  Delete the now-local `defaultAgentProviderSettings` and import both functions. Startup application (`setAgentProviderSettings(loadAgentProviderSettings())` at `:509`) and the `settings:get-agent-providers` handler are unchanged in shape.
- `settings:save-agent-providers` (`:513-516`): swap `fs.writeFileSync(AGENT_PROVIDER_FILE, JSON.stringify(settings, null, 2), 'utf-8')` for `writeJsonAtomic(AGENT_PROVIDER_FILE, settings, 2)`. Optionally run `sanitizeAgentProviderSettings(settings)` before persisting/applying so a compromised or buggy renderer payload cannot poison the file — cheap, recommended.

### Step 4 — coerced window state

Create `src/main/windowState.ts` (no `electron` import):

- Move the `WindowState` interface and `DEFAULTS` const out of `index.ts:13-21` and export both.
- Add `export function coerceWindowState(parsed: unknown): WindowState` — non-object → `DEFAULTS`; otherwise per-field: `x`/`y`/`width`/`height` accepted only when `typeof === 'number' && Number.isFinite(v)` (additionally `> 0` for width/height), `isMaximized` only when `typeof === 'boolean'`; anything else takes the `DEFAULTS` value for that field.
- In `src/main/index.ts`, `loadWindowState()` becomes: read + `JSON.parse`, `const saved = coerceWindowState(parsed)`, then the existing display-visibility check (unchanged, `index.ts:31-37`) over the coerced values, returning `visible ? saved : DEFAULTS`; the surrounding try/catch → `DEFAULTS` stays.
- `saveWindowState()` (`index.ts:43-57`): replace the `writeFileSync(windowStatePath(), JSON.stringify(next))` at `:55` with `writeJsonAtomic(windowStatePath(), next)`; keep the swallow-errors catch.

## Tests

Per the boy-scout rule, every touched surface gains tests. All three new test files land in the **main** Vitest project (node environment — `vitest.config.ts` includes `src/main/**/*.test.ts` there); use `fs.mkdtempSync(path.join(os.tmpdir(), ...))` for real-FS cases and clean up in `afterEach`. Remember `npm run typecheck` also type-checks tests — new main-process test files are covered by `tsconfig.node.json`'s include.

1. **`src/main/atomicJson.test.ts`** (new):
   - Round-trip: `writeJsonAtomic(p, obj)` then `JSON.parse(readFileSync(p))` deep-equals `obj`.
   - Overwrites an existing file (write twice, second value wins) — this is the rename-over-existing behavior the fix depends on.
   - Leaves no `*.tmp.*` siblings in the directory after a successful write.
   - `space` param: `writeJsonAtomic(p, obj, 2)` output equals `JSON.stringify(obj, null, 2)`; omitted → compact.
   - Failure cleanup: unserializable value (e.g. `{ a: 1n }` — `JSON.stringify` throws on BigInt) throws, target file (pre-seeded with old content) is untouched, and no temp file remains.
2. **`src/main/ipc/agentProviderSettings.test.ts`** (new):
   - `null`, `undefined`, `42`, `[]`, `'{}'`-the-string → exact `defaultAgentProviderSettings()`.
   - Partial file `{"claude":{"enabled":true}}` → `claude.enabled === true`, every other claude field at default, `codex` fully default — and specifically `typeof result.codex.envKey === 'string'` and `Array.isArray(result.claude.extraEnvVars)` (the two spawn-crash vectors).
   - Wrong-typed fields dropped: `{"codex":{"envKey":123,"extraEnvVars":"nope","preset":"bogus","wireApi":"soap"}}` → default `envKey`, `[]` extraEnvVars, `preset === 'native'`, `wireApi === 'responses'`.
   - `extraEnvVars` element filtering: mixed array of one valid entry and several malformed ones keeps only the valid entry.
   - Idempotence / round-trip: a fully valid `AgentProviderSettings` object passes through deep-equal unchanged (including populated `claudePresets`/`codexPresets`); invalid preset-map keys and values are dropped; absent maps stay absent.
3. **`src/main/windowState.test.ts`** (new):
   - Valid full state passes through unchanged.
   - Non-object → `DEFAULTS`.
   - Per-field coercion: string `width`, `NaN` `x`, negative `height`, truthy-string `isMaximized` each individually replaced by the `DEFAULTS` value while valid siblings survive.
4. **Extend nothing else**: `handlers.ts` and `index.ts` remain integration-only surfaces (global coverage floor 0 per `vitest.config.ts`); the logic worth guarding now lives in the three pure modules. Do **not** add `vi.mock('electron')` tests for the handlers. Optionally add the three new modules to a scoped coverage ratchet in `vitest.config.ts` once their baseline is measured (follow the existing `src/main/{pty/buildEnv.ts,...}` pattern at `vitest.config.ts:51-56`).

## Risks

- **Antivirus / indexer holding the target during `renameSync`** (Windows-specific transient `EPERM`). Today the failure mode is a truncated file; after the fix it is a thrown error caught by the existing try/catch, old file intact — strictly better. `repairLayoutCwds` has shipped on this exact helper without reports; do not add retry loops speculatively.
- **Temp-file litter in userData** if the process dies between temp write and rename. Bounded (one file per crash), and the cleanup-on-throw in Step 1 handles the non-crash error path. Acceptable; a startup sweep is out of scope.
- **Sanitizer strips unknown keys** from `agent-provider-settings.json`. If a *newer* app version adds fields and the user downgrades, the first save on the old version drops them. This matches the pre-existing save behavior (the renderer already writes only the known shape) and is accepted.
- **Behavioral change for previously-"working" malformed files**: a hand-edited file that happened to parse and half-work will now have its malformed fields silently reset to defaults. That is the intent; the alternative is the current spawn-time crash.
- **`performShutdownSave` timing**: the atomic write does one extra `renameSync` during window close. Negligible, and it stays synchronous — do not convert it to async fs, which could race window destruction.

## Verification Steps

Commands:

1. `npm run typecheck` — green.
2. `npm test` — green, including the three new test files.
3. `npm run test:e2e` — the startup spec covers cold layout restore, which exercises `layout:load` against a file produced by the new write path.

Manual checks (Windows, `npm run dev` or packaged build):

1. Arrange a distinctive layout (splits + multiple tabs), wait >1s for the debounced save, inspect `%APPDATA%\multiagent\layout.json` (dev userData dir) — valid JSON, same shape as before (`tabs`, `sidebarWidth`, `sidebarOpen`, `activeTabId`, `sidebarSectionOpen`, `sidebarPanelSizes`), no lingering `layout.json.tmp.*`.
2. Close the app with a detached window open and a just-made change in it; relaunch — layout including the detached-window change restores (shutdown-save flow intact).
3. Corrupt `agent-provider-settings.json` to `{"claude":{"enabled":true}}`, launch, open a new Claude pane and a new Codex pane — both spawn (no `TypeError` in the main-process console); open Settings → Providers and confirm defaults render for the missing fields.
4. Delete `window-state.json`, launch (defaults). Then write `{"width":"wide","x":true}` into it, launch — window opens at 1280x800 defaults, no crash; move/resize, quit, confirm the file is rewritten valid.
5. Truncation simulation: replace `layout.json` with an empty file, launch — app starts with an empty layout (existing behavior for a corrupt file, unchanged by this spec); confirm the subsequent save restores a valid file.

## Handoff Contract

### Non-negotiables

- **Do not change the `layout.json` schema** or the shape/order of fields written by `layout:save` / `performShutdownSave`; only the write mechanics change. `normalizeTabsForLayout` (forcing `detached: false`) must keep running on both paths.
- **Preserve the shutdown-save flow** exactly as documented in CLAUDE.md: single close interception, `layout:request-state` / `layout:collect-detached-state` with 1000ms timeouts, detached-snapshot merge, then one synchronous write. No new async hops inside `performShutdownSave` beyond what exists.
- **No new writes to user or project agent config files** (`~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`, ...). This spec touches only the app's own userData files.
- **No IPC channel changes** — `layout:save`, `layout:load`, `settings:get-agent-providers`, `settings:save-agent-providers` keep their `src/shared/types.ts` signatures.
- The three extracted modules (`atomicJson.ts`, `agentProviderSettings.ts`, `windowState.ts`) must not import `electron` — that is what makes them testable in the node project.
- Temp files must be created in the same directory as their target (same-volume rename), never in `%TEMP%`.
- Do not "fix" `layout:load` to prompt or restore backups — startup must remain prompt-free (CLAUDE.md startup-resume invariant). Atomicity removes the corruption source; recovery UX is out of scope.

### Definition of Done

- Zero remaining direct `fs.writeFileSync` calls targeting `layout.json`, `agent-provider-settings.json`, or `window-state.json` (grep `writeFileSync` in `src/main/` to confirm; only `atomicJson.ts`'s internal temp-file write remains).
- `loadAgentProviderSettings` and `loadWindowState` cannot return an object violating their declared types, for any file content.
- Three new test files pass and assert the behaviors listed under Tests; `npm run typecheck`, `npm test`, `npm run test:e2e` all green.
- Manual checks 1–4 performed on Windows.
- `handlers.ts` net-shrinks (helper + defaults moved out); no behavioral diff in any other handler.

## Out of Scope

- Backup rotation or corrupt-file recovery UI for `layout.json` (the timestamped `.bak` remains cwd-repair-only).
- Startup sweep of orphaned `*.tmp.*` files in userData.
- Retry/backoff around `renameSync` for antivirus contention.
- The other Tier-1 items from the backlog review (PTY leaks on tab close, session-poll perf, etc.).
- Typed `window.ipc` bridge and `IPCChannels` completeness (separate backlog items 20/27).
- Making `SessionIndex` (SQLite) or MCP settings writes atomic — SQLite has its own durability; `mcp:save-settings` can adopt `writeJsonAtomic` opportunistically if its file lives in userData, but it is not required here.
